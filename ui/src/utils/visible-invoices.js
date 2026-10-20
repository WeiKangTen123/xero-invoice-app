// The AR & AP list's rows in the order it shows them, numbered as its #
// column numbers them, for the Invoice Assistant: "#5", "row 5" or "ref 5" in
// a question means that row. The list stores it whenever what it shows
// changes, and the chat sends it with every message, from the review page
// too, where "#5" still means the list you came from. Kept in memory only, and
// only for half an hour: an older list is not what anyone means by "#5".
//
// No imports, so main/scripts/chat-ui.test.js can load the file whole.

// The server reads at most this many.
export const VISIBLE_MAX    = 200;
export const VISIBLE_TTL_MS = 30 * 60 * 1000;

let stored = { rows: [], at: 0 };

// rows: [{ id, invoiceNumber, vendorName }] in display order. Numbered before
// anything is dropped, so n is always the row's place on screen.
export function setVisibleInvoices(rows, now = Date.now()) {
  const list = Array.isArray(rows) ? rows.slice(0, VISIBLE_MAX) : [];
  stored = {
    rows: list.map((r, i) => ({ n: i + 1, id: r && r.id != null ? String(r.id) : '' })).filter(r => r.id),
    at: now,
  };
}

// [{ n, id }], or [] once it is older than half an hour.
export function getVisibleInvoices(now = Date.now()) {
  if (!stored.rows.length || now - stored.at > VISIBLE_TTL_MS) return [];
  return stored.rows.map(r => ({ ...r }));
}

export function clearVisibleInvoices() {
  stored = { rows: [], at: 0 };
}
