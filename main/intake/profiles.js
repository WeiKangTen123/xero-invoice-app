// What differs between a bill, an invoice and an expense claim — and nothing
// else. Everything that is the same about them lives in the pipeline; this is
// the whole list of what is not.
//
// Keys are the invoiceType values the store already uses, so a profile is
// looked up from a row without translation.

const PROFILES = {
  // A supplier's invoice to us. Arrives as a PDF by email, or uploaded.
  ACCPAY: {
    kind:        'bill',
    label:       'Bill',
    xeroType:    'ACCPAY',
    contactRole: 'supplier',
    // Emailed bills are the automated path and may post straight to Xero if
    // the user has turned that on. A bill someone uploaded by hand is in front
    // of them: it waits for their review and never auto-posts.
    initialStatus: source => (source === 'email' || source === 'pdf' ? 'pending' : 'review-needed'),
    autoPost:      source => source === 'email' || source === 'pdf',
    dedup:         { byHash: true, byNumber: true, byFields: true },
    canSplit:      false,
  },
  // Our invoice to a customer. Composed from the AR template, a form, or a
  // spreadsheet row — never a PDF, since Xero produces that after posting.
  ACCREC: {
    kind:        'invoice',
    label:       'Invoice',
    xeroType:    'ACCREC',
    contactRole: 'customer',
    // The AR template arriving by email is the automated path. One composed in
    // the form or read from a spreadsheet was typed by a person moments ago and
    // waits for that person's review, exactly as an uploaded bill does.
    initialStatus: source => (source === 'email' ? 'pending' : 'review-needed'),
    autoPost:      source => source === 'email',
    dedup:         { byHash: false, byNumber: true, byFields: true },
    canSplit:      false,
  },
  // A receipt an employee is claiming back. Posts to Xero as a bill, but is
  // read by a vision model, may split into several records from one photo,
  // and is never posted without a person looking at it first.
  EXPENSE: {
    kind:        'claim',
    label:       'Expense claim',
    xeroType:    'ACCPAY',
    contactRole: 'supplier',
    initialStatus: () => 'review-needed',
    autoPost:      () => false,
    dedup:         { byHash: true, byNumber: false, byFields: true },
    canSplit:      true,
  },
};

function profileFor(invoiceType) {
  const p = PROFILES[invoiceType];
  if (!p) throw new Error(`No intake profile for invoiceType "${invoiceType}"`);
  return p;
}

module.exports = { PROFILES, profileFor };
