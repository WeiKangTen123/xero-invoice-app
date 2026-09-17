// Base64 can carry a data: prefix depending on how the client built it. Decode
// strictly: a string that isn't valid base64 must fail here, not produce a
// truncated file that looks stored but won't open. One copy — it had been
// pasted into the receipts, claims and invoices routes.
function decodeBase64(data) {
  if (typeof data !== 'string' || !data) return null;
  const raw = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw.replace(/\s/g, ''))) return null;
  const buf = Buffer.from(raw, 'base64');
  return buf.length ? buf : null;
}

module.exports = { decodeBase64 };
