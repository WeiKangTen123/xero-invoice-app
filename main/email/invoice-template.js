// The AR invoice-request template, declared in one place.
//
// Until this file existed the template lived nowhere but inside the regexes in
// parseTemplateFormat — about ten patterns that happened to match a document
// nobody had written down. That is how three of them were wrong for months
// without anyone noticing (see parser.test.js, "the AR template, as actually
// sent"). Declaring it means the regex parser, the LLM verifier and the tests
// all read the same definition, and a test can check that the regexes still
// recognise every label here rather than drifting silently.
//
// Field `key`s are the names parseTemplateFormat returns. `label` is the text
// as it appears in the email, before the colon. `meaning` is written for the
// verifier's prompt and for the next person who has to edit the template.

const HEADER_FIELDS = [
  { key: 'contactName',     label: 'Client / Customer',            required: true,
    meaning: 'the customer being invoiced — a company or person name' },
  { key: 'contactEmail',    label: 'Email',                        required: false,
    meaning: "the customer's email address" },
  { key: 'contactAddress',  label: 'Address',                      required: false,
    meaning: "the customer's postal address; may run over several lines" },
  { key: 'currency',        label: 'Currency',                     required: false,
    meaning: 'a 3-letter ISO currency code; a branding theme name may follow it after a comma, in either order' },
  { key: 'paymentTerms',    label: 'Payment Terms / Payment Date', required: false,
    meaning: 'either "N days" (counted from the invoice date) or an explicit due date' },
  { key: 'lineAmountTypes', label: 'Tax inclusive / exclusive',    required: false,
    meaning: 'whether the line amounts already include tax' },
  // Added after the fact, so optional: older emails do not carry them. When
  // absent the parser dates the invoice from the email and numbers it
  // INV-<timestamp>. Put both on the template you send and they are read.
  { key: 'invoiceNumber',   label: 'Invoice Number',               required: false,
    meaning: 'your reference for this invoice; if absent one is generated' },
  { key: 'invoiceDate',     label: 'Invoice Date',                 required: false,
    meaning: "the invoice's own date; if absent the email's date is used" },
];

// One block per charge. The template numbers them ("1. Description / Details :")
// and the four labels appear in this order, each on its own line.
const LINE_ITEM_FIELDS = [
  { key: 'description',  label: 'Description / Details', required: true,
    meaning: 'what is being charged for; may span several lines and include project metadata and bullet points' },
  { key: 'unitAmount',   label: 'Amount',                required: true,
    meaning: 'a number, which may be written with a currency code or symbol in front of it (e.g. "SGD1000", "S$1,250.50")' },
  { key: 'discountRate', label: 'Discount',              required: false,
    meaning: 'a percentage; usually left blank' },
  { key: 'taxPercent',   label: 'Tax (If applicable)',   required: false,
    meaning: 'a tax rate such as "GST 9%"; usually left blank, in which case no tax applies' },
];

// The template as prose, for the verifier's prompt.
function describe() {
  const line = f => `  - "${f.label} :" — ${f.meaning}${f.required ? '' : ' (optional)'}`;
  return [
    'The email follows a fixed template. Header fields, one per line:',
    ...HEADER_FIELDS.map(line),
    '',
    'Then one or more numbered line items ("1. Description / Details :", "2. …"), each with these four lines in this order:',
    ...LINE_ITEM_FIELDS.map(line),
    '',
    'Invoice Number and Invoice Date are optional and may be absent from older emails; a date may still be mentioned in passing.',
  ].join('\n');
}

module.exports = { HEADER_FIELDS, LINE_ITEM_FIELDS, describe };
