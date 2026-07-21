/**
 * post-pdfs-to-xero.js
 * Reads all PDFs in /PDF, parses them, posts to Xero as ACCPAY (Bill) Drafts,
 * and writes a full result report to testing/xero-pdf-invoice-summary.md
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const pdfParse  = require('pdf-parse');
const fs        = require('fs');
const path      = require('path');
const { autoConnect }       = require('../xero/connect');
const db                    = require('../db/tokens');
const { createDraftInvoice } = require('../xero/invoices');

const PDF_DIR  = path.join(__dirname, '../PDF');
const OUT_FILE = path.join(__dirname, 'xero-pdf-invoice-summary.md');

// ── Date helpers ──────────────────────────────────────────────────────────────

function localDateStr(d) {
  if (!d || isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function toISO(raw) {
  if (!raw) return null;
  // Remove trailing notes like "(service date)"
  raw = raw.replace(/\(.*?\)/g, '').trim();
  // Handle YYYY/MM/DD
  raw = raw.replace(/(\d{4})\/(\d{2})\/(\d{2})/, '$1-$2-$3');
  const d = new Date(raw);
  return isNaN(d) ? null : localDateStr(d);
}

function addDays(isoStr, days) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

// ── Extraction helpers (same logic as parse-pdfs.js, refined) ─────────────────

function get(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function detectCurrency(text) {
  if (/PayNow|paynow/i.test(text))   return 'SGD';
  if (/Amount\s*\(SGD\)/i.test(text)) return 'SGD';
  if (/SGD/.test(text))               return 'SGD';
  if (/USD/.test(text))               return 'USD';
  return process.env.DEFAULT_CURRENCY || 'USD';
}

function extractVendor(text) {
  const thiti = get(text, /^Name\s+(.+?)DATE/m);
  if (thiti) return thiti.replace(/\s+/g, ' ').trim();
  if (/Branworks Pte Ltd/i.test(text)) return 'Branworks Pte Ltd';
  const exciter = text.match(/Exciter K\.K\./);
  if (exciter) return 'Exciter K.K.';
  // Supercatkei: PDF starts with line-item table — vendor is in payment block, not first lines
  if (/DescriptionQuantityUnit Price/i.test(text)) {
    return get(text, /Account Name:\s*(.+)/i) || 'Unknown Vendor';
  }
  // Kind Living — first non-empty line
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 5)) {
    if (/^[A-Z][a-zA-Z\s\.\,\&]{3,50}$/.test(line) &&
        !/invoice|bill|description|quantity|amount|thank/i.test(line)) {
      return line;
    }
  }
  return 'Unknown Vendor';
}

function extractInvoiceNumber(text, filename) {
  // Thitipat — no invoice number, use filename prefix
  if (/Name\s+Miss Thitipat/i.test(text)) {
    return path.basename(filename, '.pdf').split(' ')[0];
  }
  return (
    get(text, /Invoice\s*#\s*(\d{4,})/i) ||
    get(text, /Invoice[:\s#]+([A-Z]{2,}[-]\d{3,})/i) ||
    // Kind Living / Cats&Cuddles: "Invoice: 2026-01"
    get(text, /Invoice[:\s#]*(\d{4}-\d{2,})/i) ||
    get(text, /Invoice[:\s]+(\d{4,})/i) ||
    // Exciter: "EX-㾲㾲..." — garbled font but valid as a string, grab it as-is
    get(text, /\n(EX-\S+)/m) ||
    // INV-XXXX from filename (e.g. "Invoice INV-0200 (1).pdf")
    get(path.basename(filename), /\b([A-Z]{2,}-\d{3,})\b/i) ||
    path.basename(filename, '.pdf').replace(/[^A-Z0-9\-]/gi, '-').slice(0, 20)
  );
}

function extractInvoiceDate(text) {
  const thiti = get(text, /DATE\s+([A-Za-z]+ \d+, \d{4})/);
  if (thiti) return thiti;
  const bran = get(text, /Branworks Pte Ltd\s*([A-Za-z]+ \d+, \d{4})/);
  if (bran) return bran;
  // Exciter
  const exciter = get(text, /Date of Issue\s*(\d{4}\/\d{2}\/\d{2})/);
  if (exciter) return exciter;
  // INV-0200: "Invoice\n...\n10 Feb 2026" — the invoice date is before due date
  const invDate = get(text, /(?:invoice\s*date|date\s*of\s*invoice)[:\s]+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
  if (invDate) return invDate;
  // Kind Living: service date
  const kind = get(text, /on ([A-Za-z]+ \d+ \d{4})/);
  if (kind) return kind;
  return null;
}

function extractDueDate(text) {
  return (
    get(text, /[Dd]ue\s*[Dd]ate[:\s]*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/) ||
    get(text, /[Dd]ue\s*[Dd]ate[:\s]*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/) ||
    get(text, /振込期日[:\s]*(\S+)/) ||
    null
  );
}

function extractTotal(text) {
  // Thitipat: "TOTAL                  USD 300"
  const thiti = get(text, /^TOTAL\s+USD\s+([\d,]+)/m);
  if (thiti) return parseFloat(thiti.replace(/,/g, ''));
  // Branworks: "Total2450.00$" or "Total400.00$"
  const bran = get(text, /^Total([\d,]+\.?\d{2})\$\s*$/m);
  if (bran) return parseFloat(bran.replace(/,/g, ''));
  // Exciter: "total$465.43" — may have Japanese text before it on the same line, no ^ anchor
  const ex = get(text, /total\$([\d,]+\.?\d{2})/i);
  if (ex) return parseFloat(ex.replace(/,/g, ''));
  // Kind Living SGD: "SGD 637.38"
  const kindSGD = get(text, /SGD\s+([\d,]+\.?\d{2})/);
  if (kindSGD) return parseFloat(kindSGD.replace(/,/g, ''));
  // Kind Living USD: "USD $500"
  const kindUSD = get(text, /USD\s*\$\s*([\d,]+)/);
  if (kindUSD) return parseFloat(kindUSD.replace(/,/g, ''));
  // Supercatkei: "Invoice Total SGD4,000.00"
  const supercat = get(text, /Invoice Total SGD([\d,]+\.?\d{2})/);
  if (supercat) return parseFloat(supercat.replace(/,/g, ''));
  // Generic
  const gen = get(text, /(?:grand\s+)?total[:\s]*(?:SGD|USD)?\s*([\d,]+\.?\d{2})/i);
  return gen ? parseFloat(gen.replace(/,/g, '')) : null;
}

function extractLineItems(text, total, currency) {
  // Thitipat
  if (/Name\s+Miss Thitipat/i.test(text)) {
    const proj = get(text, /Project\s*:\s*(.+?)(?:\n\s*USD|\n\s*$)/s);
    const note = get(text, /Being fees for the following:([\s\S]+?)(?:TOTAL|$)/i);
    const desc = proj ? `Project: ${proj.replace(/\s+/g, ' ').trim()}` : 'Translation & PR services';
    const noteClean = note ? note.replace(/\n/g, ' ').replace(/\d+\.\s*/g, '').trim().slice(0, 200) : '';
    return [{ description: desc + (noteClean ? `\n${noteClean}` : ''), unitAmount: total || 0 }];
  }

  // Branworks: lines between DESCRIPTIONAMOUNT and Total
  const branBlock = text.match(/DESCRIPTIONAMOUNT\n([\s\S]+?)^Total/m);
  if (branBlock) {
    const items = [];
    // Branworks amounts end with "$" and are on the same line as description
    // Raw: "Accounting - April 2026300.00$               "
    // The year and amount are fused: need to split on last sequence of digits + $
    const lineRe = /^(.+?)\s+([\d,]+\.?\d{2})\$\s*$/gm;
    let m;
    while ((m = lineRe.exec(branBlock[1])) !== null) {
      let desc = m[1].trim();
      let amtStr = m[2].replace(/,/g, '');
      // PDF fuses year into amount: "2026300.00" = year "2026" + amount "300.00" — strip it
      if (/^20\d{2}\d/.test(amtStr)) amtStr = amtStr.slice(4);
      const amt = parseFloat(amtStr);
      if (!desc || /out of pocket/i.test(desc) || amt === 0) continue;
      desc = desc.replace(/\s*20\d\d$/, '').trim();
      items.push({ description: desc, unitAmount: amt });
    }
    if (items.length) return items;
  }

  // Supercatkei: PDF starts with table header; item spans two lines
  if (/DescriptionQuantityUnit Price/i.test(text)) {
    const line1 = get(text, /DescriptionQuantityUnit PriceTaxAmount SGD\n(.+?)\n/);
    const line2 = get(text, /DescriptionQuantityUnit PriceTaxAmount SGD\n.+?\n(.+?)\n/);
    const raw = [line1, line2].filter(Boolean).join(' ');
    // Strip trailing "1.00 4,000.00 No Tax 4,000.00" quantity/price columns
    const descClean = raw.replace(/\s+\d+\.\d{2}[\s\S]*$/, '').replace(/\s+/g, ' ').trim();
    return [{ description: descClean || 'Production fee', unitAmount: total || 0 }];
  }

  // Exciter
  if (/Exciter K\.K\./i.test(text)) {
    const desc = get(text, /outstanding from (.+)/i) || 'outstanding from Mediacorp fees';
    return [{ description: desc.trim(), unitAmount: total || 0 }];
  }

  // Kind Living
  if (/Kind Living/i.test(text)) {
    const desc = get(text, /for (private filming session[^\n]+)/i) || 'Filming session';
    return [{ description: desc.trim(), unitAmount: total || 0 }];
  }

  // Fallback: single line
  return [{ description: 'Invoice total', unitAmount: total || 0 }];
}

// ── Parse one PDF ─────────────────────────────────────────────────────────────

async function parsePDF(filepath) {
  const filename = path.basename(filepath);
  const buf  = fs.readFileSync(filepath);
  const data = await pdfParse(buf);
  const text = data.text;

  const vendor      = extractVendor(text);
  const invoiceNo   = extractInvoiceNumber(text, filename);
  const rawDate     = extractInvoiceDate(text);
  const rawDue      = extractDueDate(text);
  const currency    = detectCurrency(text);
  const total       = extractTotal(text);
  const lineItems   = extractLineItems(text, total, currency);

  const invoiceDate = toISO(rawDate) || localDateStr(new Date());
  const dueDate     = toISO(rawDue) || addDays(invoiceDate, 30);

  return {
    filename,
    // Human-readable for MD report
    extracted: { vendor, invoiceNo, rawDate, rawDue, currency, total },
    // Xero invoiceData shape
    invoiceData: {
      invoiceType:    'ACCPAY',
      contactName:    vendor,
      vendorName:     vendor,
      sourceEmail:    '',
      invoiceNumber:  invoiceNo,
      invoiceDate,
      dueDate,
      currency:       currency === 'SGD' ? 'USD' : currency, // SGD→USD: Demo Company not subscribed to SGD
      totalAmount:    total,
      lineAmountTypes:'Exclusive',
      accountCode:    process.env.DEFAULT_ACCOUNT_CODE || '200',
      lineItems:      lineItems.map(li => ({
        description:  li.description,
        unitAmount:   li.unitAmount,
        discountRate: 0,
        taxType:      'NONE',
      })),
      description: filename,
    }
  };
}

// ── Post to Xero ──────────────────────────────────────────────────────────────

async function postToXero(tenantId, invoiceData) {
  const result = await createDraftInvoice(tenantId, invoiceData);
  return { invoiceID: result.invoiceID, invoiceNumber: result.invoiceNumber, status: result.status };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Connecting to Xero...');
  await autoConnect();
  const tenants = await db.getAllTenants();
  if (!tenants.length) throw new Error('No Xero tenants found');
  const tenantId   = tenants[0].tenant_id;
  const tenantName = tenants[0].tenant_name;
  console.log(`Tenant: ${tenantName}\n`);

  const files = fs.readdirSync(PDF_DIR).filter(f => f.endsWith('.pdf')).sort();
  const rows  = [];

  for (const f of files) {
    process.stdout.write(`Processing: ${f} ... `);
    try {
      const { filename, extracted, invoiceData } = await parsePDF(path.join(PDF_DIR, f));
      let xero = null, errMsg = null;
      try {
        xero = await postToXero(tenantId, invoiceData);
        console.log(`✅  Invoice ${xero.invoiceID}`);
      } catch (e) {
        // xero-node throws a JSON string, not an Error object
        let parsed = e;
        try { if (typeof e === 'string') parsed = JSON.parse(e); } catch(_) {}
        errMsg = parsed?.response?.body?.Elements?.[0]?.ValidationErrors?.map(v => v.Message).join('; ')
               || parsed?.body?.Elements?.[0]?.ValidationErrors?.map(v => v.Message).join('; ')
               || parsed?.response?.body?.Message
               || e?.response?.body?.Message
               || (typeof e === 'string' ? e.slice(0, 300) : e.message)
               || 'unknown error';
        console.log(`❌  ${errMsg}`);
      }
      rows.push({ filename, extracted, invoiceData, xero, errMsg });
    } catch (e) {
      console.log(`❌  Parse error: ${e.message}`);
      rows.push({ filename: f, extracted: null, invoiceData: null, xero: null, errMsg: `Parse error: ${e.message}` });
    }
  }

  // ── Build MD report ───────────────────────────────────────────────────────────
  const md = [];
  md.push('# Xero PDF Bill Upload — Results');
  md.push('');
  md.push(`_Generated: ${new Date().toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })} SGT_`);
  md.push(`_Xero Tenant: **${tenantName}**_`);
  md.push('');

  const passed = rows.filter(r => r.xero);
  const failed = rows.filter(r => !r.xero);
  md.push(`**${passed.length} / ${rows.length} uploaded successfully**`);
  md.push('');
  md.push('---');
  md.push('');

  for (const r of rows) {
    const status = r.xero ? '✅ Created' : '❌ Failed';
    md.push(`## ${status} — ${r.filename}`);
    md.push('');

    if (!r.extracted) {
      md.push(`> Parse error: ${r.errMsg}`);
      md.push('');
      md.push('---');
      md.push('');
      continue;
    }

    const e  = r.extracted;
    const id = r.invoiceData;

    md.push('**Extracted → Xero mapping:**');
    md.push('');
    md.push('| Field | Extracted | Sent to Xero |');
    md.push('|---|---|---|');
    md.push(`| Type | — | ACCPAY (Bill) |`);
    md.push(`| Contact / Vendor | ${e.vendor} | ${id.contactName} |`);
    md.push(`| Invoice Number | ${e.invoiceNo} | ${id.invoiceNumber} |`);
    md.push(`| Invoice Date | ${e.rawDate || '(not found)'} | ${id.invoiceDate} |`);
    md.push(`| Due Date | ${e.rawDue || '(default +30d)'} | ${id.dueDate} |`);
    md.push(`| Currency | ${e.currency} | ${id.currency} |`);
    md.push(`| Total | ${e.total} | ${id.totalAmount} |`);
    md.push(`| Tax Type | No Tax (0%) | CAN030 via ZERO_TAX_RATE |`);
    md.push('');

    md.push('**Line Items sent:**');
    md.push('');
    md.push('| Description | Amount |');
    md.push('|---|---|');
    for (const li of id.lineItems) {
      md.push(`| ${li.description.replace(/\n/g, ' ')} | ${id.currency} ${li.unitAmount} |`);
    }
    md.push('');

    if (r.xero) {
      md.push(`**Xero Result:** Draft Bill created — \`${r.xero.invoiceID}\``);
    } else {
      md.push(`**Xero Error:** ${r.errMsg}`);
    }

    md.push('');
    md.push('---');
    md.push('');
  }

  // ── Summary table ─────────────────────────────────────────────────────────────
  md.push('## Upload Summary');
  md.push('');
  md.push('| File | Vendor | Total | Currency | Xero Invoice ID | Status |');
  md.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    const id  = r.xero?.invoiceID || '—';
    const st  = r.xero ? '✅' : '❌';
    const ven = r.extracted?.vendor || '—';
    const tot = r.extracted?.total  || '—';
    const cur = r.extracted?.currency || '—';
    md.push(`| ${r.filename} | ${ven} | ${tot} | ${cur} | ${id} | ${st} |`);
  }

  fs.writeFileSync(OUT_FILE, md.join('\n'), 'utf8');
  console.log('\n✅  Report written to:', OUT_FILE);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
