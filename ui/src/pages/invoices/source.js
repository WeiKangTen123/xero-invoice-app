// Where a record came from, in words: the AR & AP list's Source badge, the
// review page's note where a document would be, and the Automation page's
// recent table.
//
// The list and the review page used to read "no PDF and no photo" as "from an
// email", so an invoice typed into the form or imported from a spreadsheet
// showed "✉ Email" and "extracted from email text". They are labelled by the
// record's own source now.
//
// Mileage and per diem claims are labelled by their kind before any of this
// (components/receipts/allowance.js claimSourceBadge).
//
// Imports nothing, so main/scripts/invoice-source-ui.test.js can run it as it
// is.

// The source codes the server writes (main/intake, main/email/parser.js,
// main/routes/receipts.js, main/claims), in words.
export const SOURCE_WORDS = {
  pdf:           'PDF',
  email:         'Email',
  'email-image': 'Email photo',
  upload:        'Upload',
  phone:         'Phone',
  claim:         'Claim import',
  form:          'Form',
  spreadsheet:   'Spreadsheet',
  import:        'Spreadsheet',
};

const isForm        = inv => !!inv && inv.source === 'form';
const isSpreadsheet = inv => !!inv && (inv.source === 'spreadsheet' || inv.source === 'import');

// "PDF", "Form": a source code in words. A code this file does not know is
// shown as it is rather than hidden; none at all is a dash.
export function sourceWords(source) {
  if (!source) return '—';
  return SOURCE_WORDS[source] || String(source);
}

// The list's Source badge: { className, text, short, title }. `short` is the
// phone's, the icon alone.
export function sourceBadge(inv) {
  if (inv && inv.receiptFile) {
    return inv.source === 'phone'
      ? { className: 'badge badge-yellow', text: '📱 Phone',   short: '📱', title: 'Captured with phone' }
      : { className: 'badge badge-yellow', text: '🧾 Receipt', short: '🧾', title: 'Receipt photo' };
  }
  if (inv && inv.hasPdf)    return { className: 'badge badge-green', text: '📄 PDF',         short: '📄', title: 'PDF document' };
  if (isForm(inv))          return { className: 'badge badge-blue',  text: '📝 Form',        short: '📝', title: 'Entered in the form' };
  if (isSpreadsheet(inv))   return { className: 'badge badge-blue',  text: '📊 Spreadsheet', short: '📊', title: 'Imported from a spreadsheet' };
  return { className: 'badge badge-gray', text: '✉ Email', short: '✉', title: 'Read from the text of an email' };
}

// The review page's card where the document would be, for a record with no
// PDF, photo or allowance to show: { icon, title, sub }.
export function sourceCard(inv) {
  if (isForm(inv)) {
    return { icon: '📝', title: 'Entered in the form', sub: 'No document: this was typed in on the form' };
  }
  if (isSpreadsheet(inv)) {
    return { icon: '📊', title: 'Imported from a spreadsheet', sub: 'No document: this was read from a row of an imported spreadsheet' };
  }
  return { icon: '✉', title: 'Email Body', sub: 'No PDF attachment — invoice was extracted from email text' };
}

// The review page's "Source:" line, for anything but a mileage or per diem
// claim (which the page names by its kind).
export function sourceLine(inv) {
  const source = inv && inv.source;
  if (source === 'claim')  return 'Expense Claim (Imported)';
  if (source === 'phone')  return 'Mobile Camera Upload';
  if (source === 'upload') return 'Direct Receipt Upload';
  if (source === 'pdf')    return 'PDF Attachment';
  if (isForm(inv))         return 'Entered in the form';
  if (isSpreadsheet(inv))  return 'Imported from a spreadsheet';
  return inv && inv.receiptFile ? 'Receipt Upload' : 'Email Body';
}
