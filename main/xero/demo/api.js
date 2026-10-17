// The pretend Xero for demo accounts: an object with the AccountingApi's
// methods, taking the SDK's exact positional arguments and resolving to
// { response, body } in the shapes xero-node returns, answered from the
// generated Demo Company (./company.js) and its reports (./reports.js).
//
// A demo account (users.is_demo) never holds a Xero token. Its token is
// 'demo:<userId>' (DEMO_TOKEN_PREFIX, minted by utils/token-cache.js), its
// one organisation is DEMO_TENANT, and xero/api-client.js hands every module
// that would build the SDK `demoApiFor(userId)` instead, so the dashboard,
// the checks, posting and the status read-back run unchanged against it.
//
// Reads come from the company generated for today (Asia/Singapore) and are
// the same on every call. Writes — the contacts and invoices the app posts —
// are kept in memory per user and lost on restart, which is fine for a demo:
// created invoices are listed, found by ID, updated and read back by the
// status sync; an approved one is posted to the ledger so the reports see it.
//
// demoApiFor is called on every Xero call the app makes, so it is cheap: one
// facade per user, one company per day, both cached.

const crypto = require('crypto');
const { demoCompany, addDays, gstPercent, iso, parts } = require('./company');
const R = require('./reports');
const { compileWhere, compileOrder, dayOf } = require('./where');
const { _todayPartsInTz, _fmtISODate } = require('../periods');

const DEMO_TENANT = Object.freeze({ tenantId: 'demo-company', tenantName: 'Demo Company Pte Ltd' });
const DEMO_TOKEN_PREFIX = 'demo:';
const TIMEZONE = 'Asia/Singapore';
const PAGE_SIZE = 100;
const IDEMPOTENCY_MS = 6 * 60 * 1000;

function isDemoToken(token) {
  return typeof token === 'string' && token.startsWith(DEMO_TOKEN_PREFIX);
}
function userIdFromDemoToken(token) {
  return isDemoToken(token) ? token.slice(DEMO_TOKEN_PREFIX.length) : null;
}

const todayISO = () => _fmtISODate(_todayPartsInTz(TIMEZONE));
const company  = () => demoCompany(todayISO());

// ── Xero's answers and refusals ─────────────────────────────────────────────
const ok = body => ({ response: { statusCode: 200, headers: {} }, body });

// The SDK rejects with its ApiError serialised as a JSON string (xero-node
// 20, model/ApiError.js generateError), which xero-utils.js parses; so does
// this, with the same fields.
function refuse(statusCode, body, headers = {}) {
  const request = { headers: { 'xero-tenant-id': DEMO_TENANT.tenantId } };
  return JSON.stringify({ response: { statusCode, body, headers, request }, body });
}
function validationError(message, element = {}) {
  return refuse(400, {
    ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred',
    Elements: [{ ...element, ValidationErrors: [{ Message: message }] }],
  });
}
// A scope the connection does not have, as Xero answers it live (401 with
// an insufficient_scope challenge; xero-utils.js#isScopeError).
function scopeError() {
  return refuse(401, { Type: null, Title: 'Unauthorized', Status: 401, Detail: 'AuthorizationUnsuccessful' },
    { 'www-authenticate': 'Bearer error="insufficient_scope", error_description="The access token does not contain the required scope"' });
}

// ── Shapes ──────────────────────────────────────────────────────────────────
const dollars = cents => (cents === 0 ? 0 : cents / 100);
const isoDay  = day => (day ? `${day}T00:00:00` : undefined);
const utcDate = day => new Date(`${day}T00:00:00Z`);
const stamp   = day => new Date(`${day}T04:00:00Z`);
const contactRef = c => (c ? { contactID: c.contactID, name: c.name, hasValidationErrors: false } : undefined);
const accountRef = a => ({ accountID: a.accountID, code: a.code, name: a.name });

function lineItemsOf(lines) {
  return lines.map((l, i) => ({
    lineItemID: l.lineItemID || crypto.createHash('sha1').update(`${l.description}|${l.code}|${l.net}|${i}`).digest('hex').slice(0, 36),
    description: l.description, quantity: l.quantity ?? 1, unitAmount: dollars(l.unitAmount ?? l.net), accountCode: l.code,
    taxType: l.taxType, taxAmount: dollars(l.tax), lineAmount: dollars(l.net), tracking: [],
    ...(l.discountRate ? { discountRate: l.discountRate } : {}),
  }));
}

function paymentShape(p, co) {
  const inv = p.invoice;
  return {
    paymentID: p.paymentID, date: utcDate(p.date), amount: dollars(p.amount), reference: p.reference || '', currencyRate: 1,
    paymentType: p.paymentType, status: 'AUTHORISED', isReconciled: p.date <= addDays(co.todayISO, -3),
    updatedDateUTC: stamp(p.date), hasAccount: true, hasValidationErrors: false,
    account: accountRef(co.byCode.get(p.bankCode)),
    invoice: { invoiceID: inv.invoiceID, invoiceNumber: inv.invoiceNumber, type: inv.type, contact: contactRef(inv.contact), currencyCode: 'SGD', hasErrors: false },
  };
}

function invoiceShape(inv, co, { summaryOnly = false } = {}) {
  const out = {
    type: inv.type, invoiceID: inv.invoiceID, invoiceNumber: inv.invoiceNumber, reference: inv.reference || '',
    contact: contactRef(inv.contact), date: isoDay(inv.date), dueDate: isoDay(inv.dueDate), status: inv.status,
    lineAmountTypes: inv.lineAmountTypes || 'Exclusive', subTotal: dollars(inv.subTotal), totalTax: dollars(inv.totalTax), total: dollars(inv.total),
    amountDue: dollars(inv.amountDue), amountPaid: dollars(inv.amountPaid), amountCredited: dollars(inv.amountCredited),
    currencyCode: 'SGD', currencyRate: 1, updatedDateUTC: inv.updatedDateUTC instanceof Date ? inv.updatedDateUTC : stamp(inv.updatedDateUTC),
    hasAttachments: false, hasErrors: false, isDiscounted: false, sentToContact: inv.status !== 'DRAFT',
    ...(inv.expectedPaymentDate ? { expectedPaymentDate: isoDay(inv.expectedPaymentDate) } : {}),
    ...(inv.plannedPaymentDate ? { plannedPaymentDate: isoDay(inv.plannedPaymentDate) } : {}),
    ...(inv.repeatingInvoiceID ? { repeatingInvoiceID: inv.repeatingInvoiceID } : {}),
    ...(inv.brandingThemeID ? { brandingThemeID: inv.brandingThemeID } : {}),
  };
  // Like Xero, a summary answer leaves out the line items, the payments and
  // FullyPaidOnDate (confirmed live: none of a real organisation's paid
  // invoices carried it in a summaryOnly list).
  if (summaryOnly) return out;
  return {
    ...out,
    lineItems: lineItemsOf(inv.lines),
    fullyPaidOnDate: inv.fullyPaidOnDate ? utcDate(inv.fullyPaidOnDate) : null,
    payments: (inv.payments || []).map(p => ({ paymentID: p.paymentID, date: utcDate(p.date), amount: dollars(p.amount), currencyRate: 1, hasAccount: true, hasValidationErrors: false })),
    creditNotes: [], prepayments: [], overpayments: [], attachments: [],
  };
}

function bankTransactionShape(t, co) {
  return {
    bankTransactionID: t.bankTransactionID, type: t.type, status: 'AUTHORISED', date: utcDate(t.date), reference: t.reference || '',
    contact: contactRef(t.contact), bankAccount: accountRef(co.byCode.get(t.bankCode)), lineAmountTypes: 'Exclusive',
    lineItems: lineItemsOf(t.lines).map(l => ({ ...l, accountID: co.byCode.get(l.accountCode)?.accountID })),
    subTotal: dollars(t.subTotal), totalTax: dollars(t.totalTax), total: dollars(t.total), isReconciled: !!t.isReconciled,
    currencyCode: 'SGD', currencyRate: 1, updatedDateUTC: stamp(t.date), hasAttachments: false,
    ...(t.prepaymentID ? { prepaymentID: t.prepaymentID } : {}), ...(t.overpaymentID ? { overpaymentID: t.overpaymentID } : {}),
  };
}

function bankTransferShape(t, co) {
  return {
    bankTransferID: t.bankTransferID, fromBankAccount: accountRef(co.byCode.get(t.fromBankCode)), toBankAccount: accountRef(co.byCode.get(t.toBankCode)),
    amount: dollars(t.amount), date: isoDay(t.date), currencyRate: 1, reference: t.reference || '',
    fromBankTransactionID: t.fromBankTransactionID, toBankTransactionID: t.toBankTransactionID,
    fromIsReconciled: true, toIsReconciled: true, hasAttachments: false, createdDateUTC: stamp(t.date),
  };
}

function creditNoteShape(cn) {
  return {
    creditNoteID: cn.creditNoteID, creditNoteNumber: cn.creditNoteNumber, type: cn.type, status: cn.status, contact: contactRef(cn.contact),
    date: isoDay(cn.date), reference: cn.reference || '', lineAmountTypes: 'Exclusive', lineItems: lineItemsOf(cn.lines),
    subTotal: dollars(cn.subTotal), totalTax: dollars(cn.totalTax), total: dollars(cn.total),
    remainingCredit: dollars(cn.remainingCredit), appliedAmount: dollars(cn.appliedAmount), currencyCode: 'SGD', currencyRate: 1,
    updatedDateUTC: stamp(cn.updatedDateUTC), sentToContact: false, hasAttachments: false, hasErrors: false,
    ...(cn.fullyPaidOnDate ? { fullyPaidOnDate: utcDate(cn.fullyPaidOnDate) } : {}),
    allocations: cn.allocations.map(a => ({ amount: dollars(a.amount), date: isoDay(a.date), invoice: { invoiceID: a.invoice.invoiceID, invoiceNumber: a.invoice.invoiceNumber } })),
  };
}

function repeatingShape(t) {
  const s = t.schedule;
  return {
    repeatingInvoiceID: t.repeatingInvoiceID, iD: t.repeatingInvoiceID, type: t.type, contact: contactRef(t.contact), status: t.status,
    reference: t.reference || '', lineAmountTypes: 'Exclusive', lineItems: lineItemsOf(t.lines),
    subTotal: dollars(t.subTotal), totalTax: dollars(t.totalTax), total: dollars(t.total), currencyCode: 'SGD', hasAttachments: false,
    schedule: {
      period: s.period, unit: s.unit, dueDate: s.dueDate, dueDateType: s.dueDateType,
      startDate: isoDay(s.startDate), nextScheduledDate: isoDay(s.nextScheduledDate), ...(s.endDate ? { endDate: isoDay(s.endDate) } : {}),
    },
  };
}

function quoteShape(q) {
  return {
    quoteID: q.quoteID, quoteNumber: q.quoteNumber, reference: q.reference || '', title: q.title, status: q.status, contact: contactRef(q.contact),
    date: isoDay(q.date), dateString: q.date, expiryDate: isoDay(q.expiryDate), expiryDateString: q.expiryDate,
    lineAmountTypes: 'EXCLUSIVE', lineItems: lineItemsOf(q.lines), subTotal: dollars(q.subTotal), totalTax: dollars(q.totalTax), total: dollars(q.total),
    currencyCode: 'SGD', currencyRate: 1, updatedDateUTC: stamp(q.date),
  };
}

function accountShape(a) {
  const { isPnl, ...rest } = a;
  void isPnl;
  return rest;
}

function contactShape(c, { summaryOnly = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(c)) if (!k.startsWith('_')) out[k] = v;
  if (!summaryOnly) return out;
  const { contactID, contactStatus, name, emailAddress, isCustomer, isSupplier, updatedDateUTC, firstName, lastName, hasAttachments } = out;
  return { contactID, contactStatus, name, emailAddress, isCustomer, isSupplier, updatedDateUTC, firstName, lastName, hasAttachments, hasValidationErrors: false };
}

// ── Lists: where, order, paging ─────────────────────────────────────────────
// The fields each endpoint may be filtered or ordered by, as functions of
// the shaped record. Anything else is refused by where.js.
const F = {
  invoices: {
    Date: r => r.date, DueDate: r => r.dueDate, Status: r => r.status, Type: r => r.type, AmountDue: r => r.amountDue,
    AmountPaid: r => r.amountPaid, AmountCredited: r => r.amountCredited, Total: r => r.total, InvoiceNumber: r => r.invoiceNumber,
    Reference: r => r.reference, InvoiceID: r => r.invoiceID, CurrencyCode: r => r.currencyCode, UpdatedDateUTC: r => r.updatedDateUTC,
    'Contact.ContactID': r => r.contact?.contactID, 'Contact.Name': r => r.contact?.name, FullyPaidOnDate: r => r.fullyPaidOnDate,
  },
  payments: {
    Date: r => r.date, Status: r => r.status, PaymentType: r => r.paymentType, Amount: r => r.amount, Reference: r => r.reference,
    IsReconciled: r => r.isReconciled, UpdatedDateUTC: r => r.updatedDateUTC, PaymentID: r => r.paymentID,
    'Account.AccountID': r => r.account?.accountID, 'Invoice.InvoiceID': r => r.invoice?.invoiceID,
  },
  bankTransactions: {
    Date: r => r.date, Status: r => r.status, Type: r => r.type, Total: r => r.total, Reference: r => r.reference, IsReconciled: r => r.isReconciled,
    UpdatedDateUTC: r => r.updatedDateUTC, BankTransactionID: r => r.bankTransactionID,
    'BankAccount.AccountID': r => r.bankAccount?.accountID, 'Contact.ContactID': r => r.contact?.contactID,
  },
  bankTransfers: {
    Date: r => r.date, Amount: r => r.amount, 'FromBankAccount.AccountID': r => r.fromBankAccount?.accountID, 'ToBankAccount.AccountID': r => r.toBankAccount?.accountID,
  },
  creditNotes: {
    Date: r => r.date, Status: r => r.status, Type: r => r.type, RemainingCredit: r => r.remainingCredit, Total: r => r.total,
    CreditNoteNumber: r => r.creditNoteNumber, UpdatedDateUTC: r => r.updatedDateUTC, 'Contact.ContactID': r => r.contact?.contactID,
  },
  repeatingInvoices: { Status: r => r.status, Type: r => r.type, 'Contact.ContactID': r => r.contact?.contactID, Reference: r => r.reference },
  accounts: {
    Type: r => r.type, Code: r => r.code, Name: r => r.name, Status: r => r.status, SystemAccount: r => r.systemAccount, Class: r => r._class,
    TaxType: r => r.taxType, BankAccountNumber: r => r.bankAccountNumber, CurrencyCode: r => r.currencyCode,
    EnablePaymentsToAccount: r => r.enablePaymentsToAccount, AccountID: r => r.accountID,
  },
  contacts: {
    Name: r => r.name, EmailAddress: r => r.emailAddress, ContactStatus: r => r.contactStatus, IsCustomer: r => r.isCustomer,
    IsSupplier: r => r.isSupplier, ContactID: r => r.contactID, UpdatedDateUTC: r => r.updatedDateUTC, ContactNumber: r => r.contactNumber,
  },
  taxRates: { TaxType: r => r.taxType, Name: r => r.name, Status: r => r.status, CanApplyToExpenses: r => r.canApplyToExpenses, CanApplyToRevenue: r => r.canApplyToRevenue },
};

// Xero's own order when none is asked for.
const idOrder = key => (a, b) => String(a[key]).localeCompare(String(b[key]));
function select(list, { where, order, fields, defaultOrder, page, pageSize, unpagedLimit = null, since = null }) {
  let out = list;
  if (since) {
    const t = since instanceof Date ? since.getTime() : new Date(since).getTime();
    out = out.filter(r => r.updatedDateUTC && r.updatedDateUTC.getTime() >= t);
  }
  const pred = compileWhere(where, fields);
  out = out.filter(pred);
  // A stable sort: records that tie keep the order they were made in.
  const cmp = compileOrder(order, fields) || defaultOrder;
  out = [...out].sort(cmp);
  if (page !== undefined && page !== null) {
    const size = Math.min(Math.max(Number(pageSize) || PAGE_SIZE, 1), 1000);
    const p = Math.max(Number(page) || 1, 1);
    return out.slice((p - 1) * size, p * size);
  }
  return unpagedLimit ? out.slice(0, unpagedLimit) : out;
}

// ── Per-user state: what the app has created ────────────────────────────────
const _facades = new Map();   // userId -> facade

function _state() {
  return { contacts: [], invoices: new Map(), idempotency: new Map(), version: 0, seq: 0, ledger: null };
}

// The ledger with the user's approved documents posted to it: the company's
// lines plus a journal for each created invoice that has been approved.
// Memoised on the company and the state's version.
function ledgerFor(co, state) {
  const approved = [...state.invoices.values()].filter(i => i.status === 'AUTHORISED' || i.status === 'PAID');
  if (!approved.length) return { lines: co.lines, cashLines: co.cashLines };
  if (state.ledger && state.ledger.company === co && state.ledger.version === state.version) return state.ledger;
  const extra = [];
  for (const inv of approved) {
    const ar = inv.type === 'ACCREC';
    extra.push({ date: inv.date, code: ar ? '610' : '800', cents: ar ? inv.total : -inv.total, kind: ar ? 'invoice' : 'bill' });
    for (const l of inv.lines) if (l.code) extra.push({ date: inv.date, code: l.code, cents: ar ? -l.net : l.net, kind: ar ? 'invoice' : 'bill' });
    if (inv.totalTax) extra.push({ date: inv.date, code: '820', cents: ar ? -inv.totalTax : inv.totalTax, kind: ar ? 'invoice' : 'bill' });
  }
  const lines = [...co.lines, ...extra].sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
  state.ledger = { company: co, version: state.version, lines, cashLines: co.cashLines };
  return state.ledger;
}

function demoApiFor(userId) {
  const key = String(userId);
  if (!_facades.has(key)) _facades.set(key, buildFacade(key, _state()));
  return _facades.get(key);
}

// ── Building a document the app sent ────────────────────────────────────────
function taxRateFor(taxType, co) {
  if (!taxType || taxType === 'NONE') return 0;
  const rate = co.taxRates.find(r => r.taxType === taxType);
  if (!rate) throw validationError(`The TaxType code '${taxType}' does not exist or cannot be used for this type of transaction.`);
  return rate.status === 'ACTIVE' ? rate.displayTaxRate : gstPercent(co.todayISO);
}

function buildInvoice(sent, co, state, existing = null) {
  if (sent.currencyCode && sent.currencyCode !== 'SGD') {
    throw validationError(`Organisation is not subscribed to currency ${sent.currencyCode}`);
  }
  const type = sent.type || existing?.type;
  if (type !== 'ACCREC' && type !== 'ACCPAY') throw validationError('Invoice type must be ACCREC or ACCPAY');
  const contactId = String(sent.contact?.contactID || existing?.contact?.contactID || '').toLowerCase();
  const contact = [...co.contacts.all, ...state.contacts].find(c => c.contactID.toLowerCase() === contactId);
  if (!contact) throw validationError('The Contact with the specified ContactID could not be found.');
  const status = String(sent.status || existing?.status || 'DRAFT').toUpperCase();
  if (!['DRAFT', 'SUBMITTED', 'AUTHORISED', 'VOIDED', 'DELETED'].includes(status)) throw validationError(`Invoice status '${status}' is not valid`);
  const date = dayOf(sent.date) || existing?.date || co.todayISO;
  const dueDate = dayOf(sent.dueDate) || existing?.dueDate || addDays(date, 30);
  const inclusive = String(sent.lineAmountTypes || existing?.lineAmountTypes || 'Exclusive').toLowerCase() === 'inclusive';
  // An update that sends no lines keeps the ones it has, read back in the
  // shape they were sent in (dollars, accountCode).
  const items = Array.isArray(sent.lineItems) ? sent.lineItems : lineItemsOf(existing?.lines || []);
  const lines = [];
  for (const li of items) {
    const quantity = li.quantity === undefined || li.quantity === null ? 1 : Number(li.quantity);
    const unit = Math.round(Number(li.unitAmount || 0) * 100);
    const discount = Number(li.discountRate || 0);
    const gross = Math.round(quantity * unit * (1 - discount / 100));
    if (!gross && !li.accountCode) { lines.push({ description: li.description || '', code: null, net: 0, tax: 0, taxType: 'NONE', quantity, unitAmount: 0 }); continue; }
    const code = String(li.accountCode || existing?.lines?.find(l => l.code)?.code || '');
    if (!co.byCode.has(code)) throw validationError(`Account code '${code}' is not a valid code for this document.`);
    const pct = taxRateFor(li.taxType || 'NONE', co);
    const tax = inclusive ? Math.round(gross - gross / (1 + pct / 100)) : Math.round(gross * pct / 100);
    const net = inclusive ? gross - tax : gross;
    lines.push({ description: li.description || '', code, net, tax, taxType: li.taxType || 'NONE', quantity, unitAmount: unit, discountRate: discount || undefined });
  }
  const subTotal = lines.reduce((s, l) => s + l.net, 0), totalTax = lines.reduce((s, l) => s + l.tax, 0);
  const number = sent.invoiceNumber || existing?.invoiceNumber || `INV-DEMO-${String(++state.seq).padStart(3, '0')}`;
  return {
    ...(existing || {}),
    invoiceID: existing?.invoiceID || crypto.randomUUID(), type, status, contact, invoiceNumber: number, reference: sent.reference ?? existing?.reference ?? '',
    date, dueDate, lineAmountTypes: inclusive ? 'Inclusive' : 'Exclusive', lines, subTotal, totalTax, total: subTotal + totalTax,
    amountPaid: existing?.amountPaid || 0, amountCredited: existing?.amountCredited || 0, amountDue: subTotal + totalTax - (existing?.amountPaid || 0) - (existing?.amountCredited || 0),
    fullyPaidOnDate: existing?.fullyPaidOnDate || null, payments: existing?.payments || [], updatedDateUTC: new Date(),
    brandingThemeID: sent.brandingThemeID || existing?.brandingThemeID || null, created: true,
  };
}

// ── The facade ──────────────────────────────────────────────────────────────
function buildFacade(userId, state) {
  const allInvoices = co => [...co.invoices, ...state.invoices.values()];

  const facade = {
    // The seam writes the token onto the SDK client; harmless here.
    accessToken: `${DEMO_TOKEN_PREFIX}${userId}`,

    async getOrganisations() {
      return ok({ organisations: [company().organisation] });
    },

    async getAccounts(tenantId, ifModifiedSince, where, order) {
      const list = company().accounts.map(accountShape);
      return ok({ accounts: select(list, { where, order, fields: F.accounts, defaultOrder: idOrder('code'), since: ifModifiedSince }) });
    },

    async getTaxRates(tenantId, where, order) {
      return ok({ taxRates: select(company().taxRates, { where, order, fields: F.taxRates, defaultOrder: idOrder('name') }) });
    },

    async getBrandingThemes() {
      return ok({ brandingThemes: company().brandingThemes });
    },

    // getContacts(tenant, ifModifiedSince, where, order, iDs, page, includeArchived, summaryOnly, searchTerm, pageSize)
    async getContacts(tenantId, ifModifiedSince, where, order, iDs, page, includeArchived, summaryOnly, searchTerm, pageSize) {
      const co = company();
      let list = [...co.contacts.all, ...state.contacts];
      if (Array.isArray(iDs) && iDs.length) { const want = new Set(iDs.map(s => String(s).toLowerCase())); list = list.filter(c => want.has(c.contactID.toLowerCase())); }
      if (searchTerm) {
        const q = String(searchTerm).toLowerCase();
        list = list.filter(c => [c.name, c.emailAddress, c.contactNumber].some(v => String(v || '').toLowerCase().includes(q)));
      }
      const shaped = list.map(c => contactShape(c, { summaryOnly: !!summaryOnly }));
      return ok({ contacts: select(shaped, { where, order, fields: F.contacts, defaultOrder: idOrder('name'), page, pageSize, since: ifModifiedSince }) });
    },

    // createContacts(tenant, { contacts }, summarizeErrors, idempotencyKey)
    async createContacts(tenantId, body) {
      const co = company();
      const created = [];
      for (const sent of (body && body.contacts) || []) {
        const name = String(sent.name || '').trim();
        if (!name) throw validationError('Name is a required field', sent);
        const taken = [...co.contacts.all, ...state.contacts].find(c => c.name.toLowerCase() === name.toLowerCase());
        if (taken) throw validationError(`The contact name ${name} is already assigned to another contact. The contact name must be unique across all active contacts.`, sent);
        const c = {
          contactID: crypto.randomUUID(), contactStatus: 'ACTIVE', name, emailAddress: sent.emailAddress || '',
          firstName: sent.firstName || '', lastName: sent.lastName || '', isCustomer: !!sent.isCustomer, isSupplier: !!sent.isSupplier,
          accountsReceivableTaxType: sent.accountsReceivableTaxType || null, accountsPayableTaxType: sent.accountsPayableTaxType || null,
          salesDefaultAccountCode: sent.salesDefaultAccountCode || null, purchasesDefaultAccountCode: sent.purchasesDefaultAccountCode || null,
          defaultCurrency: 'SGD', addresses: sent.addresses || [], phones: sent.phones || [], contactPersons: [], hasAttachments: false, hasValidationErrors: false,
          updatedDateUTC: new Date(),
        };
        state.contacts.push(c);
        state.version++;
        created.push(contactShape(c));
      }
      return ok({ contacts: created });
    },

    // getInvoices(tenant, ifModifiedSince, where, order, iDs, invoiceNumbers, contactIDs, statuses, page,
    //             includeArchived, createdByMyApp, unitdp, summaryOnly, pageSize, searchTerm)
    async getInvoices(tenantId, ifModifiedSince, where, order, iDs, invoiceNumbers, contactIDs, statuses, page, includeArchived, createdByMyApp, unitdp, summaryOnly, pageSize) {
      const co = company();
      if (summaryOnly && /^\s*DueDate\b/i.test(String(order || ''))) {
        throw validationError('Ordering by DueDate is unavailable on this endpoint when using the summaryOnly flag');
      }
      let list = allInvoices(co);
      const byIds = Array.isArray(iDs) && iDs.length > 0;
      if (byIds) { const want = new Set(iDs.map(s => String(s).toLowerCase())); list = list.filter(i => want.has(i.invoiceID.toLowerCase())); }
      if (Array.isArray(invoiceNumbers) && invoiceNumbers.length) { const want = new Set(invoiceNumbers.map(String)); list = list.filter(i => want.has(i.invoiceNumber)); }
      if (Array.isArray(contactIDs) && contactIDs.length) { const want = new Set(contactIDs.map(s => String(s).toLowerCase())); list = list.filter(i => want.has(String(i.contact?.contactID).toLowerCase())); }
      if (Array.isArray(statuses) && statuses.length) { const want = new Set(statuses.map(s => String(s).toUpperCase())); list = list.filter(i => want.has(i.status)); }
      const shaped = list.map(i => invoiceShape(i, co, { summaryOnly: !!summaryOnly }));
      const defaultOrder = (a, b) => a.updatedDateUTC - b.updatedDateUTC;
      // Without `page` Xero answers at most a hundred invoices; asked by ID it answers them all.
      return ok({ invoices: select(shaped, { where, order, fields: F.invoices, defaultOrder, page, pageSize, since: ifModifiedSince, unpagedLimit: byIds ? null : PAGE_SIZE }) });
    },

    async getInvoice(tenantId, invoiceID) {
      const co = company();
      const inv = allInvoices(co).find(i => i.invoiceID.toLowerCase() === String(invoiceID).toLowerCase());
      if (!inv) throw refuse(404, { Type: null, Title: 'Not Found', Status: 404, Detail: 'The resource you are looking for cannot be found' });
      return ok({ invoices: [invoiceShape(inv, co)] });
    },

    // createInvoices(tenant, { invoices }, summarizeErrors, unitdp, idempotencyKey, allowBackorders)
    async createInvoices(tenantId, body, summarizeErrors, unitdp, idempotencyKey) {
      const co = company();
      if (idempotencyKey) {
        const seen = state.idempotency.get(idempotencyKey);
        if (seen && Date.now() - seen.at < IDEMPOTENCY_MS) return ok({ invoices: seen.ids.map(id => invoiceShape(state.invoices.get(id), co)) });
      }
      const made = [];
      for (const sent of (body && body.invoices) || []) {
        const inv = buildInvoice(sent, co, state);
        state.invoices.set(inv.invoiceID, inv);
        made.push(inv.invoiceID);
      }
      state.version++;
      if (idempotencyKey) state.idempotency.set(idempotencyKey, { at: Date.now(), ids: made });
      return ok({ invoices: made.map(id => invoiceShape(state.invoices.get(id), co)) });
    },

    // updateInvoice(tenant, invoiceID, { invoices: [invoice] }, unitdp, idempotencyKey, allowBackorders)
    async updateInvoice(tenantId, invoiceID, body) {
      const co = company();
      const id = [...state.invoices.keys()].find(k => k.toLowerCase() === String(invoiceID).toLowerCase());
      const existing = id ? state.invoices.get(id) : null;
      if (!existing) {
        if (co.invoices.some(i => i.invoiceID.toLowerCase() === String(invoiceID).toLowerCase())) throw validationError('Invoice not of valid status for modification');
        throw refuse(404, { Type: null, Title: 'Not Found', Status: 404, Detail: 'The resource you are looking for cannot be found' });
      }
      if (existing.status === 'PAID' || existing.status === 'VOIDED' || existing.status === 'DELETED') throw validationError('Invoice not of valid status for modification');
      const sent = ((body && body.invoices) || [])[0] || {};
      const next = buildInvoice(sent, co, state, existing);
      if (existing.status === 'AUTHORISED' && next.status === 'DRAFT') throw validationError('Invoice not of valid status for modification');
      state.invoices.set(existing.invoiceID, next);
      state.version++;
      return ok({ invoices: [invoiceShape(next, co)] });
    },

    async getInvoiceAttachments() {
      return ok({ attachments: [] });
    },

    // getPayments(tenant, ifModifiedSince, where, order, page, pageSize)
    async getPayments(tenantId, ifModifiedSince, where, order, page, pageSize) {
      const co = company();
      const list = co.payments.map(p => paymentShape(p, co));
      const defaultOrder = (a, b) => a.updatedDateUTC - b.updatedDateUTC;
      return ok({ payments: select(list, { where, order, fields: F.payments, defaultOrder, page, pageSize, since: ifModifiedSince }) });
    },

    // getBankTransactions(tenant, ifModifiedSince, where, order, page, unitdp, pageSize)
    async getBankTransactions(tenantId, ifModifiedSince, where, order, page, unitdp, pageSize) {
      const co = company();
      const list = co.bankTransactions.map(t => bankTransactionShape(t, co));
      const defaultOrder = (a, b) => a.updatedDateUTC - b.updatedDateUTC;
      return ok({ bankTransactions: select(list, { where, order, fields: F.bankTransactions, defaultOrder, page, pageSize, since: ifModifiedSince }) });
    },

    // getBankTransfers(tenant, ifModifiedSince, where, order, includeDeleted)
    async getBankTransfers(tenantId, ifModifiedSince, where, order) {
      const co = company();
      const list = co.bankTransfers.map(t => bankTransferShape(t, co));
      return ok({ bankTransfers: select(list, { where, order, fields: F.bankTransfers, defaultOrder: idOrder('date'), since: ifModifiedSince }) });
    },

    // getCreditNotes(tenant, ifModifiedSince, where, order, page, unitdp, pageSize)
    async getCreditNotes(tenantId, ifModifiedSince, where, order, page, unitdp, pageSize) {
      const list = company().creditNotes.map(creditNoteShape);
      const defaultOrder = (a, b) => a.updatedDateUTC - b.updatedDateUTC;
      return ok({ creditNotes: select(list, { where, order, fields: F.creditNotes, defaultOrder, page, pageSize, since: ifModifiedSince }) });
    },

    // getRepeatingInvoices(tenant, where, order)
    async getRepeatingInvoices(tenantId, where, order) {
      const list = company().repeatingInvoices.map(repeatingShape);
      return ok({ repeatingInvoices: select(list, { where, order, fields: F.repeatingInvoices, defaultOrder: idOrder('repeatingInvoiceID') }) });
    },

    // getQuotes(tenant, ifModifiedSince, dateFrom, dateTo, expiryDateFrom, expiryDateTo, contactID, status, page, order, quoteNumber)
    async getQuotes(tenantId, ifModifiedSince, dateFrom, dateTo, expiryDateFrom, expiryDateTo, contactID, status, page, order, quoteNumber) {
      let list = company().quotes.map(quoteShape);
      const day = v => (v ? dayOf(v) : null);
      if (dateFrom)       list = list.filter(q => q.dateString >= day(dateFrom));
      if (dateTo)         list = list.filter(q => q.dateString <= day(dateTo));
      if (expiryDateFrom) list = list.filter(q => q.expiryDateString >= day(expiryDateFrom));
      if (expiryDateTo)   list = list.filter(q => q.expiryDateString <= day(expiryDateTo));
      if (contactID)      list = list.filter(q => q.contact?.contactID.toLowerCase() === String(contactID).toLowerCase());
      if (status)         list = list.filter(q => q.status === String(status).toUpperCase());
      if (quoteNumber)    list = list.filter(q => q.quoteNumber === quoteNumber);
      if (ifModifiedSince) list = list.filter(q => q.updatedDateUTC >= new Date(ifModifiedSince));
      const fields = { Date: q => q.dateString, Status: q => q.status, ExpiryDate: q => q.expiryDateString, QuoteNumber: q => q.quoteNumber, Total: q => q.total };
      const cmp = compileOrder(order, fields) || idOrder('quoteNumber');
      list = [...list].sort(cmp);
      if (page !== undefined && page !== null) { const p = Math.max(Number(page) || 1, 1); list = list.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE); }
      return ok({ quotes: list });
    },

    // getBudgets(tenant, iDs, dateTo, dateFrom)
    async getBudgets(tenantId, iDs, dateTo, dateFrom) {
      const co = company();
      const b = co.budget;
      if (Array.isArray(iDs) && iDs.length && !iDs.some(id => String(id).toLowerCase() === b.budgetID.toLowerCase())) return ok({ budgets: [] });
      const out = { budgetID: b.budgetID, type: b.type, description: b.description, updatedDateUTC: b.updatedDateUTC, budgetLines: [] };
      if (Array.isArray(iDs) && iDs.length) {
        const from = dateFrom ? dayOf(dateFrom).slice(0, 7) : null, to = dateTo ? dayOf(dateTo).slice(0, 7) : null;
        const byAccount = new Map();
        for (const [key, month] of b.months) {
          if ((from && key < from) || (to && key > to)) continue;
          for (const [code, cents] of month) {
            if (!byAccount.has(code)) byAccount.set(code, []);
            const a = co.byCode.get(code);
            const amount = dollars(a.type === 'REVENUE' || a.type === 'OTHERINCOME' ? -cents : cents);
            byAccount.get(code).push({ period: key, amount, unitAmount: amount, notes: '' });
          }
        }
        out.budgetLines = [...byAccount].map(([code, balances]) => ({ accountID: co.byCode.get(code).accountID, accountCode: code, budgetBalances: balances }));
      }
      return ok({ budgets: [out] });
    },

    // getReportBudgetSummary(tenant, date, periods, timeframe)
    async getReportBudgetSummary(tenantId, date, periods, timeframe) {
      return ok(R.budgetSummary(company(), { date: dayOf(date), periods, timeframe }));
    },

    // getReportProfitAndLoss(tenant, fromDate, toDate, periods, timeframe, tc1, tc2, to1, to2, standardLayout, paymentsOnly)
    async getReportProfitAndLoss(tenantId, fromDate, toDate, periods, timeframe, trackingCategoryID, trackingCategoryID2, trackingOptionID, trackingOptionID2, standardLayout, paymentsOnly) {
      const co = company();
      const ledger = ledgerFor(co, state);
      if (periods !== undefined && periods !== null && (Number(periods) < 1 || Number(periods) > 11)) throw validationError('Periods must be between 1 and 11');
      return ok(R.profitAndLoss(co, paymentsOnly ? ledger.cashLines : ledger.lines, { fromDate: dayOf(fromDate), toDate: dayOf(toDate), periods, timeframe }));
    },

    // getReportBalanceSheet(tenant, date, periods, timeframe, to1, to2, standardLayout, paymentsOnly)
    async getReportBalanceSheet(tenantId, date, periods, timeframe, trackingOptionID1, trackingOptionID2, standardLayout, paymentsOnly) {
      const co = company();
      const ledger = ledgerFor(co, state);
      return ok(R.balanceSheet(co, paymentsOnly ? ledger.cashLines : ledger.lines, { date: dayOf(date), periods, timeframe }));
    },

    // getReportTrialBalance(tenant, date, paymentsOnly)
    async getReportTrialBalance(tenantId, date, paymentsOnly) {
      const co = company();
      const ledger = ledgerFor(co, state);
      return ok(R.trialBalance(co, paymentsOnly ? ledger.cashLines : ledger.lines, { date: dayOf(date) }));
    },

    // getReportBankSummary(tenant, fromDate, toDate)
    async getReportBankSummary(tenantId, fromDate, toDate) {
      const co = company();
      const from = dayOf(fromDate), to = dayOf(toDate);
      if (from && to) {
        const days = Math.round((Date.UTC(parts(to).y, parts(to).m - 1, parts(to).d) - Date.UTC(parts(from).y, parts(from).m - 1, parts(from).d)) / 86400000);
        if (days > 365) throw validationError('The fromDate and toDate parameters must be with 365 days of each other');
      }
      return ok(R.bankSummary(co, ledgerFor(co, state).lines, { fromDate: from, toDate: to }));
    },

    // The journals scope is one this app's Xero apps are refused, so the
    // Demo Company refuses it the way Xero does.
    async getJournals() {
      throw scopeError();
    },
  };
  return facade;
}

// Kept off the public exports (the seam codes against exactly five); the
// tests reach it through require('./api')._internals.
Object.defineProperty(module.exports, '_internals', {
  enumerable: false,
  value: { _facades, ledgerFor, buildInvoice, invoiceShape, select, todayISO, company, iso, F },
});

module.exports.DEMO_TENANT         = DEMO_TENANT;
module.exports.DEMO_TOKEN_PREFIX   = DEMO_TOKEN_PREFIX;
module.exports.isDemoToken         = isDemoToken;
module.exports.userIdFromDemoToken = userIdFromDemoToken;
module.exports.demoApiFor          = demoApiFor;
