const { AccountingApi }              = require('xero-node');
const fs                             = require('fs');
const path                           = require('path');
const crypto                         = require('crypto');
const axios                          = require('axios');
const { resolveContact, cleanContactName, NO_NAME_MSG } = require('./contacts');
const { withRetry, xeroErrMsg, _parseXeroErr } = require('./xero-utils');
const logger                         = require('../utils/logger');

// Per-tenant base currency cache — avoids an extra Xero API call on every invoice.
// Populated lazily on first currency mismatch, persists for the server lifetime.
const _orgBaseCurrencyCache = new Map();

// `fallback` is what a failed lookup answers. The error message for an
// unsubscribed currency can live with a guess; deciding whether to send an
// exchange rate cannot, so that caller passes null and sends none.
async function getOrgBaseCurrency(accountingApi, tenantId, fallback = 'USD') {
  if (_orgBaseCurrencyCache.has(tenantId)) return _orgBaseCurrencyCache.get(tenantId);
  try {
    const res      = await accountingApi.getOrganisations(tenantId);
    const currency = res.body.organisations?.[0]?.baseCurrency;
    if (!currency) return fallback;
    _orgBaseCurrencyCache.set(tenantId, currency);
    logger.info('Xero org base currency detected', { tenantId, baseCurrency: currency });
    return currency;
  } catch (err) {
    logger.warn('Could not fetch org base currency', { error: xeroErrMsg(err), fallback });
    return fallback;
  }
}

// Per-tenant cache of the org's own configured tax rates — avoids an extra Xero
// API call on every invoice. Populated lazily, persists for the server lifetime.
const _orgTaxRatesCache = new Map();

async function getOrgTaxRates(accountingApi, tenantId) {
  if (_orgTaxRatesCache.has(tenantId)) return _orgTaxRatesCache.get(tenantId);
  try {
    const res   = await accountingApi.getTaxRates(tenantId);
    const rates = (res.body.taxRates || []).filter(r => r.status === 'ACTIVE');
    _orgTaxRatesCache.set(tenantId, rates);
    logger.info('Xero org tax rates loaded', { tenantId, count: rates.length });
    return rates;
  } catch (err) {
    logger.warn('Could not fetch org tax rates — tax will be posted as a flat line item', { error: xeroErrMsg(err) });
    return [];
  }
}

// An account's default tax type, asked for only when several org rates fit a
// document equally well. Kept for a while rather than for the server's life:
// a person who fixes an account's tax type in Xero expects the next bill to
// follow it.
const ACCOUNT_TAX_TTL_MS = 15 * 60 * 1000;
const _accountTaxTypeCache = new Map();

async function getAccountTaxType(accountingApi, tenantId, accountCode) {
  if (!accountCode) return null;
  const key = `${tenantId}|${accountCode}`;
  const hit = _accountTaxTypeCache.get(key);
  if (hit && Date.now() - hit.at < ACCOUNT_TAX_TTL_MS) return hit.taxType;
  try {
    const where = `Code=="${String(accountCode).replace(/"/g, '')}"`;
    const res   = await withRetry(() => accountingApi.getAccounts(tenantId, undefined, where));
    const taxType = res.body.accounts?.[0]?.taxType || null;
    _accountTaxTypeCache.set(key, { at: Date.now(), taxType });
    return taxType;
  } catch (err) {
    logger.warn('Could not read the account\'s default tax type', { tenantId, accountCode, error: xeroErrMsg(err) });
    return null;
  }
}

// Matches the invoice's actual detected tax (subTotal/taxAmount — real dollar
// figures from parser.js, dynamic per invoice) against the connected Xero org's
// own configured tax rates, instead of guessing a hardcoded TaxType code (which
// varies per org/country and hard-fails the whole invoice if it doesn't exist on
// that org). If no confident match is found, the caller falls back to posting the
// tax as its own flat line item so the total still reconciles — just without
// proper per-line GST categorisation in Xero's own reports.
const TAX_RATE_TOLERANCE_PCT = 0.75;

// Several rates can share a percentage — a Singapore org has standard-rated
// purchases, imports, blocked input tax and more, all at 9% — and the first
// one Xero listed used to win. The contact's own default tax type is the best
// evidence of which one this document is, then the account's; only when
// neither is among the tied rates does the first one still win.
async function _preferredRate(ties, prefer, accountingApi, tenantId) {
  if (prefer.contactTaxType) {
    const byContact = ties.find(r => r.taxType === prefer.contactTaxType);
    if (byContact) return { rate: byContact, why: 'contact default' };
  }
  if (prefer.accountCode) {
    const accountTaxType = await getAccountTaxType(accountingApi, tenantId, prefer.accountCode);
    const byAccount = accountTaxType && ties.find(r => r.taxType === accountTaxType);
    if (byAccount) return { rate: byAccount, why: 'account default' };
  }
  return { rate: ties[0], why: 'first listed' };
}

async function resolveTaxType(accountingApi, tenantId, invoiceData, zeroRate, prefer = {}) {
  const subTotal  = Number(invoiceData.subTotal)  || 0;
  const taxAmount = Number(invoiceData.taxAmount) || 0;

  if (subTotal <= 0 || taxAmount <= 0) return { taxType: zeroRate, applied: true, unmatchedTaxAmount: 0 };

  const effectiveRate = (taxAmount / subTotal) * 100;
  // Below this, treat as effectively tax-free rather than risk matching an
  // unrelated 0%-ish rate whose semantics (zero-rated vs exempt vs GST-free)
  // can't be told apart from dollar figures alone.
  if (effectiveRate < 0.1) return { taxType: zeroRate, applied: true, unmatchedTaxAmount: 0 };

  const rates     = await getOrgTaxRates(accountingApi, tenantId);
  const isExpense = invoiceData.invoiceType !== 'ACCREC'; // ACCPAY (bill) is this app's primary case
  const candidates = rates.filter(r => isExpense ? r.canApplyToExpenses : r.canApplyToRevenue);

  const diffOf = r => Math.abs((r.displayTaxRate || 0) - effectiveRate);
  let bestDiff = Infinity;
  for (const r of candidates) bestDiff = Math.min(bestDiff, diffOf(r));

  if (bestDiff <= TAX_RATE_TOLERANCE_PCT) {
    const ties = candidates.filter(r => Math.abs(diffOf(r) - bestDiff) < 1e-9);
    const { rate: best, why } = ties.length > 1
      ? await _preferredRate(ties, prefer, accountingApi, tenantId)
      : { rate: ties[0], why: 'only match' };
    logger.info('Matched invoice tax to org tax rate', {
      tenantId, effectiveRate: effectiveRate.toFixed(2), matched: best.name, taxType: best.taxType,
      tied: ties.length, chosenBy: why,
    });
    return { taxType: best.taxType, applied: true, unmatchedTaxAmount: 0 };
  }

  logger.warn('No matching org tax rate for detected tax — posting as a flat line item', {
    tenantId, effectiveRate: effectiveRate.toFixed(2), taxAmount,
  });
  return { taxType: zeroRate, applied: false, unmatchedTaxAmount: taxAmount };
}

// Themes change rarely and every sales invoice asks, so the list is kept for
// a while per org instead of fetched on every send.
const BRANDING_TTL_MS = 15 * 60 * 1000;
const _brandingThemesCache = new Map();

async function getBrandingThemeID(accountingApi, tenantId, themeName) {
  if (!themeName) return undefined;
  try {
    let entry = _brandingThemesCache.get(tenantId);
    if (!entry || Date.now() - entry.at >= BRANDING_TTL_MS) {
      const res = await accountingApi.getBrandingThemes(tenantId);
      entry = { at: Date.now(), themes: res.body.brandingThemes || [] };
      _brandingThemesCache.set(tenantId, entry);
    }
    const match = entry.themes.find(t => t.name?.toLowerCase() === themeName.toLowerCase());
    if (match) {
      logger.info('Branding theme found', { themeName, themeID: match.brandingThemeID });
      return match.brandingThemeID;
    }
    logger.warn('Branding theme not found, using default', { themeName });
  } catch (err) {
    logger.warn('Could not fetch branding themes', { error: xeroErrMsg(err) });
  }
  return undefined;
}

// The money figures the lines are built from. A row with no subtotal but a
// total (a claim line typed on a form, a receipt the reader gave only a total
// for) used to go out as a zero line; the total less any tax stands in.
function _figures(invoiceData) {
  const total = Number(invoiceData.totalAmount) || 0;
  let tax     = Math.max(Number(invoiceData.taxAmount) || 0, 0);
  let sub     = Number(invoiceData.subTotal) || 0;
  if (sub <= 0 && total > 0) {
    if (total - tax > 0) sub = total - tax;
    else { sub = total; tax = 0; }
  }
  return { total, sub, tax };
}

// Every non-zero line item is tagged with ONE resolved tax type for the whole
// invoice (see resolveTaxType) — invoices from this app carry a single overall
// tax rate, not a per-line mix, so there's no meaningful per-item signal to
// resolve independently.
//
// With Inclusive line amounts the tax is already inside each line and Xero
// works it out from the tax type, so the flat "Tax / GST" line that makes an
// exclusive bill reconcile would count it twice, and the single fallback line
// carries the total rather than the subtotal.
async function buildLineItems(invoiceData, userConfig, accountingApi, tenantId, prefer = {}) {
  // An empty list is no lines at all, the same as null. Every stored row reads
  // back with an array, so a row with nothing itemised used to reach Xero with
  // no lines and a zero total.
  const hasLines     = Array.isArray(invoiceData.lineItems) && invoiceData.lineItems.length > 0;
  const rawLineItems = hasLines ? [...invoiceData.lineItems] : null;

  if (invoiceData.paymentReference && rawLineItems) {
    const paymentLines = 'Payment details:\n' + invoiceData.paymentReference.replace(/\s*\|\s*/g, '\n');
    rawLineItems.push({ description: paymentLines, unitAmount: 0 });
  }

  const defaults    = require('../utils/users').defaultsFrom(userConfig);
  const zeroRate    = defaults.zeroTaxRate;
  // The account, first that is set: the document's own, then the default the
  // contact carries in Xero for this kind of document (a supplier set up to
  // post to Rent should not land in General Expenses), then Setup's default.
  // The contact's default never overrides an account the document names.
  const { contactAccountCode, ...taxPrefer } = prefer;
  const accountCode = invoiceData.accountCode || contactAccountCode
    || defaults.accountCode[invoiceData.invoiceType === 'ACCREC' ? 'invoice' : 'bill'];
  const inclusive   = invoiceData.lineAmountTypes === 'Inclusive';
  const { total, sub, tax } = _figures(invoiceData);

  const { taxType, applied, unmatchedTaxAmount } = await resolveTaxType(
    accountingApi, tenantId, { ...invoiceData, subTotal: sub, taxAmount: tax }, zeroRate,
    { accountCode, ...taxPrefer });

  let items;
  if (rawLineItems) {
    items = rawLineItems.map(item => {
      const amount = parseFloat(item.unitAmount) || 0;
      if (amount === 0) return { description: item.description };
      return {
        description: item.description,
        accountCode,
        taxType,
        quantity:    1.0,
        unitAmount:  amount,
        ...(parseFloat(item.discountRate) > 0 && { discountRate: parseFloat(item.discountRate) }),
      };
    });
  } else {
    // Fallback single-line item when no line items were extracted
    items = [{
      description: invoiceData.description,
      quantity:    1.0,
      unitAmount:  inclusive ? (total > 0 ? total : sub + tax) : sub,
      accountCode,
      taxType,
    }];
  }

  // No org tax rate confidently matched the invoice's detected tax — rather than
  // silently dropping it (the previous behaviour), post it as its own flat-dollar
  // line so the Xero total still reconciles to the real invoice total. Not
  // categorised as GST in Xero's own reports, but never silently wrong either.
  if (!applied && unmatchedTaxAmount > 0 && !inclusive) {
    items.push({
      description: 'Tax / GST',
      accountCode,
      taxType:    zeroRate,
      quantity:   1.0,
      unitAmount: unmatchedTaxAmount,
    });
  }

  return items;
}

function _referenceField(invoiceData) {
  if (invoiceData.projectName) return invoiceData.projectName;
  const s = invoiceData.description || '';
  return s.includes('|') ? s.split('|').pop().trim() : s;
}

const NO_MERCHANT_MSG = 'This claim has no merchant name, so Xero has no one to put it under. '
  + 'Add the merchant, or set "Your name for expense claims" in Setup so claims are owed to you, then send it again.';

// A claim posted to the claimant still has to say where the money went: the
// merchant leads each line's text unless the text already names it.
function _withMerchant(invoiceData, merchant) {
  const mention = text => {
    const t = String(text || '').trim();
    if (t.toLowerCase().includes(merchant.toLowerCase())) return t;
    return t ? `${merchant}: ${t}` : merchant;
  };
  const lines = Array.isArray(invoiceData.lineItems) ? invoiceData.lineItems : null;
  return {
    ...invoiceData,
    description: mention(invoiceData.description),
    lineItems: lines && lines.length
      ? lines.map(li => ((parseFloat(li.unitAmount) || 0) === 0 ? li : { ...li, description: mention(li.description) }))
      : invoiceData.lineItems,
  };
}

// Who the document is with in Xero, and the lines to send. An expense claim is
// money the company owes the person who paid, so with a payee name set in
// Setup it goes to that person and the merchant moves into the lines. Without
// one it goes to the merchant as before. Nothing to name it by is refused here
// rather than posted to a made-up contact.
function _contactFor(invoiceData, userConfig) {
  const isClaim  = invoiceData.invoiceType === 'EXPENSE';
  const payee    = isClaim ? cleanContactName(userConfig.CLAIM_PAYEE_NAME) : null;
  const merchant = cleanContactName(invoiceData.contactName) || cleanContactName(invoiceData.vendorName);

  if (payee) {
    return {
      // The merchant's email, address and phone are not the claimant's.
      details: { vendorName: payee, invoiceType: invoiceData.invoiceType },
      data:    merchant ? _withMerchant(invoiceData, merchant) : invoiceData,
      payee:   true,
    };
  }
  if (!merchant) throw new Error(isClaim ? NO_MERCHANT_MSG : NO_NAME_MSG);
  return {
    details: {
      vendorName:  merchant,
      sourceEmail: invoiceData.contactEmail || invoiceData.sourceEmail,
      email:       invoiceData.contactEmail || invoiceData.vendorEmail || '',
      address:     invoiceData.contactAddress || '',
      phone:       invoiceData.vendorPhone    || '',
      invoiceType: invoiceData.invoiceType,
    },
    data:  invoiceData,
    payee: false,
  };
}

// Builds the Xero invoice body + resolves the contact — shared by create and update,
// since both send the same shape to their respective Xero endpoints.
async function _buildInvoiceBody(userId, tenantId, invoiceData, accountingApi) {
  const { getUserConfig, defaultsFrom } = require('../utils/users');
  const userConfig = getUserConfig(userId);

  const currencyCode = invoiceData.currency || defaultsFrom(userConfig).currency;
  // Xero answers a symbol ("S$") with a validation error that does not say
  // which field; this says it plainly before anything is sent.
  if (!/^[A-Z]{3}$/.test(String(currencyCode))) {
    throw new Error(`The currency "${currencyCode}" is not a three-letter currency code. Change it to one (for example SGD) and send it again.`);
  }

  const { details, data, payee } = _contactFor(invoiceData, userConfig);
  const contact  = await resolveContact(userId, tenantId, details);
  const isACCREC = data.invoiceType === 'ACCREC';

  // A branding theme is how this org presents a sales invoice; a bill or a
  // claim is someone else's document and has none of ours.
  const brandingThemeID = isACCREC
    ? await getBrandingThemeID(accountingApi, tenantId, data.brandingThemeName)
    : undefined;
  const lineItems = await buildLineItems(data, userConfig, accountingApi, tenantId, {
    contactTaxType:     isACCREC ? contact.accountsReceivableTaxType : contact.accountsPayableTaxType,
    contactAccountCode: isACCREC ? contact.salesDefaultAccountCode   : contact.purchasesDefaultAccountCode,
  });
  const lineAmountTypes = data.lineAmountTypes === 'Inclusive' ? 'Inclusive' : 'Exclusive';

  // A claim form gives its own exchange rate. Xero takes one only on a
  // document in a currency other than the org's own, and uses its daily rate
  // when none is sent; if the org's currency cannot be read, none is sent.
  let currencyRate;
  const rate = Number(data.currencyRate);
  if (rate > 0) {
    const base = await getOrgBaseCurrency(accountingApi, tenantId, null);
    if (base && base !== currencyCode) currencyRate = rate;
  }

  return {
    currencyCode,
    payee,
    invoiceBody: {
      invoices: [{
        type:          isACCREC ? 'ACCREC' : 'ACCPAY',
        status:        'DRAFT',
        contact:       { contactID: contact.contactID },
        date:          data.invoiceDate,
        dueDate:       data.dueDate,
        invoiceNumber: data.invoiceNumber,
        reference:     _referenceField(data),
        currencyCode,
        ...(currencyRate && { currencyRate }),
        lineAmountTypes,
        ...(brandingThemeID && { brandingThemeID }),
        lineItems,
      }]
    },
  };
}

// Submits, and turns Xero's "not subscribed to currency" into a clear error.
//
// This used to retry with the org's base currency stamped on the SAME amounts:
// USD 1,000 became SGD 1,000 in a Xero draft, with only a warn log to say so.
// A currency the org has not enabled is a decision for a person — enable it
// in Xero, or change the invoice — never a silent relabel.
async function _submitWithCurrencyRetry(submitFn, accountingApi, tenantId, invoiceBody, currencyCode, userId) {
  try {
    return await withRetry(() => submitFn(invoiceBody));
  } catch (err) {
    const msg = xeroErrMsg(err);
    if (!msg.includes('not subscribed to currency')) throw err;
    const baseCurrency = await getOrgBaseCurrency(accountingApi, tenantId);
    logger.warn('Currency not subscribed by the Xero org — invoice refused, not relabelled', { attempted: currencyCode, base: baseCurrency, userId });
    throw new Error(`Xero org (base ${baseCurrency}) is not subscribed to ${currencyCode} — enable the currency in Xero or change the invoice's currency`);
  }
}

// Xero's Idempotency-Key: a create repeated with the same key inside Xero's
// six-minute window returns the invoice the first one made instead of making a
// second draft. That is the case of a send whose answer never arrived — a
// dropped connection, a timeout, a restart mid-request — retried by withRetry,
// the boot retry or a person.
//
// The key is the local invoice and the org it goes to, plus a digest of the
// exact body. The same row re-sent unchanged builds the same body and so the
// same key. A row a person corrected after Xero refused it builds a different
// one, so the correction is not answered with the refusal Xero kept for the
// old key. Null without a local id: nothing to tie a retry to.
function createIdempotencyKey(localId, tenantId, invoiceBody) {
  if (!localId) return null;
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify([String(tenantId), invoiceBody]))
    .digest('hex').slice(0, 16);
  return `create-${String(localId).slice(0, 64)}-${digest}`;
}

// ── Attachments ─────────────────────────────────────────────────────────────
//
// Uploaded with axios, not the SDK. xero-node 7.0.0's
// createInvoiceAttachmentByFileName gathers the file into an array of chunks
// and hands that array to axios as the request body, and axios serialises an
// array as JSON: Xero is sent `[{"type":"Buffer","data":[...]}]`, not the file
// (see invoices-attach.test.js). The endpoint takes the raw bytes with their
// own Content-Type.

const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

function _safeFilename(name) {
  return String(name).replace(/[^A-Za-z0-9 ._()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// What this row has to attach: a bill's PDF, a claim's receipt, or both. A
// file the row says it has but the disk no longer holds is reported rather
// than skipped in silence. A split receipt's siblings share one file, so each
// of them carries the whole photo or PDF, which is the evidence for all of them.
function _attachmentsFor(userId, invoiceData) {
  const files = [];
  const missing = [];
  const localId = invoiceData._invoiceStoreId;

  if (localId && (invoiceData.pdfFilename || invoiceData.hasPdf)) {
    const pdfPath = require('../utils/pdf-store').forUser(userId).getPath(localId);
    if (pdfPath) {
      const name = _safeFilename(invoiceData.pdfFilename || '') || `${_safeFilename(invoiceData.invoiceNumber || '') || 'document'}.pdf`;
      files.push({ name, mime: 'application/pdf', read: () => fs.readFileSync(pdfPath) });
    } else if (invoiceData.hasPdf) {
      missing.push('the PDF is no longer on the server');
    }
  }

  if (invoiceData.receiptFile) {
    const receiptStore = require('../utils/receipt-store');
    const buffer = receiptStore.forUser(userId).read(invoiceData.receiptFile);
    if (buffer) {
      const fileExt = path.extname(String(invoiceData.receiptFile)).slice(1).toLowerCase();
      const mime    = invoiceData.receiptMime || EXT_MIME[fileExt] || 'application/octet-stream';
      const ext     = receiptStore.extensionFor(mime) || fileExt || 'bin';
      const label   = [invoiceData.invoiceNumber, cleanContactName(invoiceData.vendorName)].filter(Boolean).join(' ');
      files.push({ name: `${_safeFilename(`Receipt ${label}`) || 'Receipt'}.${ext}`, mime, read: () => buffer });
    } else {
      missing.push('the receipt file is no longer on the server');
    }
  }
  return { files, missing };
}

// axios reports the HTTP status as response.status; the shared Xero helpers
// read statusCode. Copied across so withRetry sees a 429 and waits.
function _asXeroError(err) {
  if (err?.response && err.response.statusCode === undefined) err.response.statusCode = err.response.status;
  return err;
}

async function _uploadAttachment(cache, tenantId, invoiceID, file) {
  const token = await cache.getValidToken(tenantId);
  const url = `https://api.xero.com/api.xro/2.0/Invoices/${encodeURIComponent(invoiceID)}/Attachments/${encodeURIComponent(file.name)}`;
  await withRetry(() => axios.put(url, file.read(), {
    headers: {
      Authorization:    `Bearer ${token}`,
      'xero-tenant-id': tenantId,
      'Content-Type':   file.mime,
      Accept:           'application/json',
    },
    // No timeout here: sdk-guard.js gives every xero.com request one.
  }).catch(err => { throw _asXeroError(err); }));
}

// A token without accounting.attachments: Xero answers 401 with an
// insufficient_scope challenge, or 403. Read from an axios error (the upload)
// or the SDK's serialised one (the attachment list) alike.
function _isPermissionError(err) {
  const { status, wwwAuthenticate } = _parseXeroErr(_asXeroError(err));
  return status === 401 || status === 403 || /insufficient_scope/i.test(wwwAuthenticate || '');
}

function _httpErrMsg(err) {
  let body = err?.response?.data ?? err?.response?.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { /* plain text */ } }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 200);
  return body?.Elements?.[0]?.ValidationErrors?.[0]?.Message || body?.Detail || body?.Message
    || (err?.response?.status ? `Xero answered ${err.response.status}` : xeroErrMsg(err));
}

function _attachFailedNote(reason) {
  return `Sent to Xero, but the attachment failed: ${reason}.`;
}

function _permissionNote(userId) {
  const custom = require('../utils/users').getUserConfig(userId).XERO_CONNECTION_TYPE === 'custom';
  return _attachFailedNote(custom
    ? 'Xero did not allow it. Reconnect Xero in Setup to allow attachments (sign in with your Xero Web app; '
      + 'a Custom Connection is not given that permission), then send this again to attach the file'
    : 'Xero did not allow it. Reconnect Xero in Setup to allow attachments, then send this again to attach the file');
}

// Attaches what the row has. Never throws: the document is in Xero by now,
// so a refused attachment is a note on the row, not a failed send. With
// `onlyMissing` (a correction), files Xero already holds by name are skipped,
// which is how an attachment refused the first time arrives once Xero has
// been reconnected and the row is sent again.
async function _attachFiles(userId, tenantId, invoiceID, invoiceData, accountingApi, { onlyMissing = false } = {}) {
  const notes = [];
  let attachments;
  try {
    attachments = _attachmentsFor(userId, invoiceData);
  } catch (err) {
    return [_attachFailedNote(`the file could not be read (${err.message})`)];
  }
  const { files, missing } = attachments;
  for (const reason of missing) notes.push(_attachFailedNote(reason));
  if (!files.length) return notes;

  const cache = require('../utils/token-cache').forUser(userId);
  let pending = files;
  if (onlyMissing) {
    try {
      const res = await withRetry(() => accountingApi.getInvoiceAttachments(tenantId, invoiceID));
      const held = new Set((res.body.attachments || []).map(a => String(a.fileName || '').toLowerCase()));
      pending = files.filter(f => !held.has(f.name.toLowerCase()));
    } catch (err) {
      notes.push(_isPermissionError(err)
        ? _permissionNote(userId)
        : _attachFailedNote(`could not check what Xero already holds (${xeroErrMsg(err)})`));
      return notes;
    }
  }

  for (const file of pending) {
    try {
      await _uploadAttachment(cache, tenantId, invoiceID, file);
      logger.info('File attached to Xero invoice', { invoiceID, file: file.name, mime: file.mime });
    } catch (err) {
      logger.warn('Failed to attach file to Xero', { error: _httpErrMsg(err), invoiceID, file: file.name });
      // One permission note covers every file; Xero's answer will not differ.
      if (_isPermissionError(err)) { notes.push(_permissionNote(userId)); break; }
      notes.push(_attachFailedNote(_httpErrMsg(err)));
    }
  }
  return notes;
}

// Xero computes its own total from the lines and tax types. A total that comes
// back different from the document's means something was read or sent wrong,
// and nothing would say so until the books did.
function _totalNote(saved, invoiceData, currencyCode) {
  const source = Number(invoiceData.totalAmount);
  if (saved?.total === undefined || saved?.total === null || !(source > 0)) return null;
  const xeroTotal = Number(saved.total);
  if (!Number.isFinite(xeroTotal)) return null;
  if (Math.abs(Math.round(xeroTotal * 100) - Math.round(source * 100)) <= 1) return null;
  return `Sent to Xero, but Xero's total is ${currencyCode} ${xeroTotal.toFixed(2)} where the document says `
    + `${currencyCode} ${source.toFixed(2)}. Check the lines and tax in Xero.`;
}

// Notes go on the local row (invoice-store keeps them through the send's
// closing update). A failure to write one must not turn a document that is
// in Xero into a failed send, so it is logged and dropped.
function _recordNotes(userId, invoiceData, notes, invoiceID) {
  if (!notes.length) return;
  logger.warn('Sent to Xero with notes', { userId, invoiceID, notes });
  const localId = invoiceData._invoiceStoreId;
  if (!localId) return;
  try {
    require('../utils/invoice-store').forUser(userId).addPostingNote(localId, notes.join(' '));
  } catch (err) {
    logger.warn('Could not record the note on the row', { userId, localId, error: err.message });
  }
}

// The delivery address goes in a second call — best-effort, non-fatal if Xero
// rejects it.
async function _setDeliveryAddress(cache, tenantId, invoiceID, address) {
  const freshToken = await cache.getValidToken(tenantId);
  await axios.post(
    `https://api.xero.com/api.xro/2.0/Invoices/${invoiceID}`,
    {
      InvoiceID:        invoiceID,
      InvoiceAddresses: [{ InvoiceAddressType: 'TO', AddressLine1: address }],
    },
    {
      headers: {
        Authorization:    `Bearer ${freshToken}`,
        'xero-tenant-id': tenantId,
        'Content-Type':   'application/json',
      },
    }
  );
}

// Create a fresh AccountingApi instance per call so concurrent users cannot
// contaminate each other's token state on a shared singleton.
async function createDraftInvoice(userId, tenantId, invoiceData) {
  const cache                = require('../utils/token-cache').forUser(userId);
  const token                = await cache.getValidToken(tenantId);
  const accountingApi        = new AccountingApi();
  accountingApi.accessToken  = token;

  const { invoiceBody, currencyCode, payee } = await _buildInvoiceBody(userId, tenantId, invoiceData, accountingApi);
  const idempotencyKey = createIdempotencyKey(invoiceData._invoiceStoreId || invoiceData.id, tenantId, invoiceBody);

  // createInvoices(xeroTenantId, invoices, summarizeErrors?, unitdp?, idempotencyKey?)
  const result = await _submitWithCurrencyRetry(
    body => accountingApi.createInvoices(tenantId, body, undefined, undefined, idempotencyKey || undefined),
    accountingApi, tenantId, invoiceBody, currencyCode, userId, invoiceData
  );
  const created = result.body.invoices[0];

  // A claim sent to the claimant has no address of the merchant's to carry.
  if (invoiceData.contactAddress && !payee) {
    try {
      await _setDeliveryAddress(cache, tenantId, created.invoiceID, invoiceData.contactAddress);
      logger.info('Delivery address set on invoice', { invoiceID: created.invoiceID });
    } catch (err) {
      logger.warn('Delivery address not set', { error: err?.response?.data?.Message || err.message });
    }
  }

  const notes = await _attachFiles(userId, tenantId, created.invoiceID, invoiceData, accountingApi);
  const totalNote = _totalNote(created, invoiceData, currencyCode);
  if (totalNote) notes.push(totalNote);
  _recordNotes(userId, invoiceData, notes, created.invoiceID);

  logger.info('Draft invoice created', {
    tenantId,
    invoiceID:   created.invoiceID,
    vendor:      invoiceData.contactName || invoiceData.vendorName,
    amount:      invoiceData.totalAmount,
    invoiceType: invoiceData.invoiceType,
    lineItems:   invoiceBody.invoices[0].lineItems.length,
    currency:    currencyCode,
    userId,
  });

  return created;
}

// Updates an existing Xero invoice in place (PUT /Invoices/{InvoiceID}) instead of
// creating a new one — used when re-posting a correction to an invoice that was
// already sent to Xero, so it doesn't create a duplicate bill.
// Only works while the invoice is still editable on the Xero side (DRAFT/SUBMITTED
// status there) — if it's since been approved/paid in Xero itself, this will throw
// and the caller surfaces the Xero error as-is.
async function updateDraftInvoice(userId, tenantId, xeroInvoiceId, invoiceData) {
  const cache                = require('../utils/token-cache').forUser(userId);
  const token                = await cache.getValidToken(tenantId);
  const accountingApi        = new AccountingApi();
  accountingApi.accessToken  = token;

  const { invoiceBody, currencyCode, payee } = await _buildInvoiceBody(userId, tenantId, invoiceData, accountingApi);

  const result = await _submitWithCurrencyRetry(
    body => accountingApi.updateInvoice(tenantId, xeroInvoiceId, body),
    accountingApi, tenantId, invoiceBody, currencyCode, userId, invoiceData
  );
  const updated = result.body.invoices[0];

  // Re-apply delivery address — best-effort, non-fatal.
  if (invoiceData.contactAddress && !payee) {
    try {
      await _setDeliveryAddress(cache, tenantId, xeroInvoiceId, invoiceData.contactAddress);
    } catch (err) {
      logger.warn('Delivery address not updated', { error: err?.response?.data?.Message || err.message });
    }
  }

  // Only files Xero does not already hold, so a correction never piles up
  // copies, and one refused on the first send arrives now.
  const notes = await _attachFiles(userId, tenantId, xeroInvoiceId, invoiceData, accountingApi, { onlyMissing: true });
  const totalNote = _totalNote(updated, invoiceData, currencyCode);
  if (totalNote) notes.push(totalNote);
  _recordNotes(userId, invoiceData, notes, xeroInvoiceId);

  logger.info('Draft invoice updated', {
    tenantId,
    invoiceID:   updated.invoiceID,
    vendor:      invoiceData.contactName || invoiceData.vendorName,
    amount:      invoiceData.totalAmount,
    currency:    currencyCode,
    userId,
  });

  return updated;
}

module.exports = {
  _submitWithCurrencyRetry,
  createDraftInvoice, updateDraftInvoice,
  // Exposed for tests only — internal to the create/update flow above.
  buildLineItems, resolveTaxType, getOrgTaxRates, createIdempotencyKey,
  NO_MERCHANT_MSG,
};
