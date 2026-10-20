// What Setup says about stored secrets and Gemini keys. Imports nothing, so
// main/scripts/setup-secrets-ui.test.js runs it as it is.

// A stored secret is shown, not left as an empty box with a grey "Saved" in
// it, which read as unset: the server's dots and last four characters
// (routes/setup.js maskSecret), a Saved tag, and Change. Typing a new one
// replaces it; Cancel (or leaving the box blank) keeps the stored one.
// `meta` is the server's { isSet, masked, account }.
export function secretView(meta, value, editing) {
  if (!meta?.isSet || editing || String(value || '') !== '') return { mode: 'edit' };
  return { mode: 'saved', masked: meta.masked || '••••••••••••' };
}

// The line under a stored secret: whose it is, for the mailbox password.
export function secretNote(name, meta) {
  if (name === 'IMAP_PASS' && meta?.account) return `Mailbox password for ${meta.account}`;
  return '';
}

// The box's placeholder while a stored secret is being changed.
export const CHANGE_PLACEHOLDER = 'Enter a new one — Cancel keeps the saved one';

// The line beside Cancel while a stored secret is being changed: whose it
// is, and its last four characters when the server could spare them.
export function changeNote(name, meta) {
  const last = String(meta?.masked || '').slice(-4);
  const ends = !last || /^•+$/.test(last) ? '' : ` (saved one ends ${last})`;
  const who  = secretNote(name, meta);
  return who ? `${who}${ends}` : `The saved one${ends ? ends.replace(' (saved one', ' (it') : ''} stays if you cancel`;
}

// The Gemini list with nothing in it: whether reading invoices still has a
// key to use (the server's shared one) or none at all.
export function keyListEmptyText(serverKey) {
  return serverKey
    ? "No keys of your own: invoice reading uses this server's shared key"
    : "No API keys added yet: invoice reading won't work until you add one";
}

// A key saved in the old single-key field. Used only while no key is added.
export function legacyKeyText(key) {
  return key?.inUse ? 'saved earlier · in use' : 'saved earlier · not used';
}
export function legacyKeyTitle(key) {
  return key?.inUse
    ? 'Saved in the old single-key field. Used because no other key is added.'
    : 'Saved in the old single-key field. Not used while the keys above are added; remove it to tidy up.';
}
