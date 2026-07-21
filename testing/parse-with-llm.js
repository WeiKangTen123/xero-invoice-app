/**
 * parse-with-llm.js
 * Reads all PDFs in /PDF, extracts text with pdf-parse, sends to OpenRouter LLM
 * to extract invoice fields, posts to Xero as ACCPAY Bills, writes MD report.
 *
 * No hardcoded vendor patterns — works for any new PDF automatically.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const pdfParse  = require('pdf-parse');
const fs        = require('fs');
const path      = require('path');
const axios     = require('axios');
const { autoConnect }        = require('../xero/connect');
const db                     = require('../db/tokens');
const { createDraftInvoice } = require('../xero/invoices');

const PDF_DIR  = path.join(__dirname, '../PDF');
const OUT_FILE = path.join(__dirname, 'llm-invoice-summary.md');

// ── LLM provider: Gemini > Nvidia > OpenRouter ────────────────────────────────
const PROVIDER = process.env.Gemini_API_KEY ? 'gemini'
               : process.env.Nvidia_API_KEY ? 'nvidia'
               : 'openrouter';

const LLM_URL = {
  gemini:      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  nvidia:      'https://integrate.api.nvidia.com/v1/chat/completions',
  openrouter:  'https://openrouter.ai/api/v1/chat/completions',
}[PROVIDER];

const LLM_KEY = {
  gemini:      process.env.Gemini_API_KEY,
  nvidia:      process.env.Nvidia_API_KEY,
  openrouter:  process.env.OPENROUTER_API_KEY,
}[PROVIDER];

const LLM_MODEL = {
  gemini:      'gemini-3.1-flash-lite',
  nvidia:      'qwen/qwen3-next-80b-a3b-instruct',
  openrouter:  process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free',
}[PROVIDER];

// ── LLM call ─────────────────────────────────────────────────────────────────

async function extractWithLLM(pdfText, filename, attempt = 1) {
  const prompt = `You are an invoice data extractor. Return ONLY valid JSON, no explanation, no markdown.

Extract these fields:
- vendorName: seller/service provider name (NOT the buyer — buyer is blcklb Pte Ltd or similar)
- vendorAddress: vendor's full street address (null if not found)
- vendorEmail: vendor's email address (null if not found)
- vendorPhone: vendor's phone number (null if not found)
- invoiceNumber: invoice reference number (null if not found or garbled — keep garbled chars as-is)
- invoiceDate: YYYY-MM-DD (null if not found)
- dueDate: YYYY-MM-DD (null if not stated)
- currency: SGD if PayNow or SGD keyword present, otherwise USD
- lineItems: array of { description, amount } — description must include FULL text: main line PLUS any sub-text below it (e.g. "Being fees for the following: 1. Translate... 2. Monitor..."), joined with newlines
- totalAmount: total due as a plain number (no commas, no symbols)
- paymentReference: combine all payment details into one string — PayNow ID, bank account number, bank name, SWIFT code, beneficiary name — format: "PayNow: 202016196Z" or "Bank: OCBC | Acct: 601-493935-001 | Swift: OCBCSGSG | Beneficiary: Denise Teo" — null if none
- projectName: artist or project name this invoice relates to (e.g. "Rol3ert", "James Blake", "Cavetown") — null if not applicable

Invoice filename: ${filename}

Invoice text:
${pdfText.slice(0, 3000)}`;

  const response = await axios.post(
    LLM_URL,
    {
      model:       LLM_MODEL,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens:  800,
    },
    {
      headers: {
        Authorization:  `Bearer ${LLM_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    }
  );

  // Log rate limit headers (first call only — tells us the quota)
  const h = response.headers;
  const rateInfo = [
    h['x-ratelimit-limit-requests']     && `limit=${h['x-ratelimit-limit-requests']}`,
    h['x-ratelimit-remaining-requests'] && `remaining=${h['x-ratelimit-remaining-requests']}`,
    h['x-ratelimit-reset-requests']     && `reset=${h['x-ratelimit-reset-requests']}`,
    h['x-ratelimit-limit-tokens']       && `token-limit=${h['x-ratelimit-limit-tokens']}`,
  ].filter(Boolean).join(' | ');
  if (rateInfo) console.log(`   [rate] ${rateInfo}`);

  const raw = response.data.choices[0].message.content.trim();

  // Strip <thought>...</thought> blocks (thinking models like Gemma 4)
  const noThought = raw.replace(/<thought>[\s\S]*?<\/thought>/g, '').trim();
  // Strip markdown code fences if model wrapped in ```json ... ```
  const cleaned = noThought.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(cleaned);
}

// Wrapper with retry on 429
async function extractWithRetry(pdfText, filename) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await extractWithLLM(pdfText, filename);
    } catch (e) {
      if (e.response?.status === 429 && attempt < 4) {
        const wait = attempt * 15000; // 15s, 30s, 45s
        process.stdout.write(`[429 rate limit — waiting ${wait/1000}s] `);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function addDays(isoStr, days) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Connecting to Xero...');
  await autoConnect();
  const tenants = await db.getAllTenants();
  if (!tenants.length) throw new Error('No Xero tenants found');
  const tenantId   = tenants[0].tenant_id;
  const tenantName = tenants[0].tenant_name;
  console.log(`Tenant: ${tenantName}`);
  console.log(`Model:  ${LLM_MODEL}  [${PROVIDER}]\n`);

  const files = fs.readdirSync(PDF_DIR).filter(f => f.endsWith('.pdf')).sort();
  const rows  = [];

  for (const f of files) {
    process.stdout.write(`[LLM] ${f} ... `);
    try {
      // 1. Extract PDF text
      const buf  = fs.readFileSync(path.join(PDF_DIR, f));
      const data = await pdfParse(buf);

      // 2. Ask LLM to parse
      let parsed;
      try {
        parsed = await extractWithRetry(data.text, f);
      } catch (llmErr) {
        throw new Error(`LLM parse failed: ${llmErr.message}`);
      }

      console.log(`parsed ✅ → ${parsed.vendorName} | ${parsed.invoiceNumber} | ${parsed.currency} ${parsed.totalAmount}`);

      // 3. Build invoiceData for Xero
      const invoiceDate   = parsed.invoiceDate || new Date().toISOString().split('T')[0];
      const dueDate       = parsed.dueDate || addDays(invoiceDate, 30);
      const currency      = parsed.currency === 'SGD' ? 'USD' : (parsed.currency || 'USD'); // SGD→USD for Demo Company
      // Fallback invoice number: use filename prefix (e.g. "040526-1") when LLM returns null
      const invoiceNumber = parsed.invoiceNumber || path.basename(f, '.pdf').split(' ')[0];

      const invoiceData = {
        invoiceType:      'ACCPAY',
        contactName:      parsed.vendorName,
        vendorName:       parsed.vendorName,
        contactAddress:   parsed.vendorAddress  || '',
        contactEmail:     parsed.vendorEmail    || '',
        vendorPhone:      parsed.vendorPhone    || '',
        invoiceNumber,
        invoiceDate,
        dueDate,
        currency,
        totalAmount:      parsed.totalAmount,
        lineAmountTypes:  'Exclusive',
        accountCode:      process.env.DEFAULT_ACCOUNT_CODE || '200',
        projectName:      parsed.projectName    || '',
        paymentReference: parsed.paymentReference || '',
        lineItems:        (parsed.lineItems || []).map(li => ({
          description:    li.description,
          unitAmount:     parseFloat(li.amount) || 0,
          discountRate:   0,
          taxType:        'NONE',
        })),
        description: f,
      };

      // 4. Post to Xero
      let xeroResult = null, errMsg = null;
      try {
        const created = await createDraftInvoice(tenantId, invoiceData);
        xeroResult = { invoiceID: created.invoiceID };
        console.log(`   → Xero ✅ ${created.invoiceID}`);
      } catch (e) {
        let body;
        try { body = typeof e === 'string' ? JSON.parse(e) : e; } catch(_) {}
        errMsg = body?.response?.body?.Elements?.[0]?.ValidationErrors?.map(v => v.Message).join('; ')
               || body?.body?.Elements?.[0]?.ValidationErrors?.map(v => v.Message).join('; ')
               || (typeof e === 'string' ? e.slice(0, 200) : e.message)
               || 'unknown error';
        console.log(`   → Xero ❌ ${errMsg}`);
      }

      rows.push({ filename: f, parsed, invoiceData, xeroResult, errMsg });

    } catch (e) {
      console.log(`❌ ${e.message}`);
      rows.push({ filename: f, parsed: null, invoiceData: null, xeroResult: null, errMsg: e.message });
    }

    // Delay between PDFs to respect free tier rate limit
    await new Promise(r => setTimeout(r, 8000));
  }

  // ── Build MD report ───────────────────────────────────────────────────────────
  const md = [];
  md.push('# LLM Invoice Parser — Results');
  md.push('');
  md.push(`_Generated: ${new Date().toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })} SGT_`);
  md.push(`_Model: **${LLM_MODEL}** (${PROVIDER})_`);
  md.push(`_Tenant: **${tenantName}**_`);
  md.push('');

  const passed = rows.filter(r => r.xeroResult);
  const failed = rows.filter(r => !r.xeroResult);
  md.push(`**${passed.length} / ${rows.length} uploaded successfully**`);
  md.push('');
  md.push('---');
  md.push('');

  for (const r of rows) {
    const status = r.xeroResult ? '✅ Created' : '❌ Failed';
    md.push(`## ${status} — ${r.filename}`);
    md.push('');

    if (!r.parsed) {
      md.push(`> Error: ${r.errMsg}`);
      md.push('');
      md.push('---');
      md.push('');
      continue;
    }

    const p = r.parsed;
    md.push('**LLM extracted:**');
    md.push('');
    md.push('| Field | Value |');
    md.push('|---|---|');
    md.push(`| Vendor | ${p.vendorName} |`);
    md.push(`| Vendor Address | ${p.vendorAddress || '—'} |`);
    md.push(`| Vendor Email | ${p.vendorEmail || '—'} |`);
    md.push(`| Vendor Phone | ${p.vendorPhone || '—'} |`);
    md.push(`| Invoice # | ${p.invoiceNumber || '(none)'} |`);
    md.push(`| Invoice Date | ${p.invoiceDate} |`);
    md.push(`| Due Date | ${p.dueDate || '(not found → +30d)'} |`);
    md.push(`| Currency | ${p.currency} |`);
    md.push(`| Total | ${p.totalAmount} |`);
    md.push(`| Project / Artist | ${p.projectName || '—'} |`);
    md.push(`| Payment Reference | ${p.paymentReference || '—'} |`);
    md.push('');
    md.push('**Line Items:**');
    md.push('');
    md.push('| Description | Amount |');
    md.push('|---|---|');
    for (const li of (p.lineItems || [])) {
      md.push(`| ${String(li.description).replace(/\n/g, ' ')} | ${li.amount} |`);
    }
    md.push('');

    if (r.xeroResult) {
      md.push(`**Xero:** Draft Bill \`${r.xeroResult.invoiceID}\``);
    } else {
      md.push(`**Xero Error:** ${r.errMsg}`);
    }

    md.push('');
    md.push('---');
    md.push('');
  }

  // Summary table
  md.push('## Summary');
  md.push('');
  md.push('| File | Vendor | Total | Currency | Xero ID | Status |');
  md.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    const st  = r.xeroResult ? '✅' : '❌';
    const ven = r.parsed?.vendorName || '—';
    const tot = r.parsed?.totalAmount || '—';
    const cur = r.parsed?.currency || '—';
    const id  = r.xeroResult?.invoiceID || (r.errMsg || 'error');
    md.push(`| ${r.filename} | ${ven} | ${tot} | ${cur} | ${id} | ${st} |`);
  }

  fs.writeFileSync(OUT_FILE, md.join('\n'), 'utf8');
  console.log('\n✅ Report written to:', OUT_FILE);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
