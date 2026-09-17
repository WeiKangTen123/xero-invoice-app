// One place that says what a status or a document type looks like. The list
// page, the review page and the dashboard table each carried their own copy,
// and they had drifted: the review page knew 'submitting' and the list did
// not; the dashboard table knew no 'EXPENSE' and printed the raw word.
//
// `label` is the short form for a table cell; `long` is for a page heading.
export const STATUS_META = {
  pending:         { cls: 'badge-yellow', label: 'Pending',         long: '⏳ Pending Review' },
  submitting:      { cls: 'badge-blue',   label: '⟳ Submitting…',   long: '⟳ Submitting to Xero…' },
  reviewed:        { cls: 'badge-blue',   label: '● Ready to Post', long: '✓ Reviewed' },
  posted:          { cls: 'badge-green',  label: '✓ Posted',        long: '✓ Posted to Xero' },
  reported:        { cls: 'badge-red',    label: '⚠ Reported',      long: '⚠ Issue Reported' },
  error:           { cls: 'badge-red',    label: '✕ Error',         long: '✕ Submission Error' },
  duplicate:       { cls: 'badge-purple', label: '⚠ Duplicate',     long: '⚠ Duplicate' },
  'review-needed': { cls: 'badge-yellow', label: '⚠ Needs Review',  long: '⚠ Needs Review' },
};

export const TYPE_META = {
  ACCPAY:  { cls: 'badge-blue',   label: 'Bill',          long: 'Bill (ACCPAY)' },
  ACCREC:  { cls: 'badge-purple', label: 'Invoice',       long: 'Invoice (ACCREC)' },
  EXPENSE: { cls: 'badge-yellow', label: 'Expense Claim', long: 'Expense Claim' },
};

// Statuses that mean "a person has to look at this".
export const ATTENTION_STATUSES = ['review-needed', 'error'];

const unknown = v => ({ cls: 'badge-gray', label: v || '—', long: v || '—' });
export function statusMeta(status) { return STATUS_META[status] || unknown(status); }
export function typeMeta(type)     { return TYPE_META[type]     || unknown(type); }
