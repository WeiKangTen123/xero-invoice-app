const crypto = require('crypto');

// Record ids: a millisecond timestamp (so ids sort by creation) plus eight
// random base-36 characters. The previous form — three characters from
// Math.random behind the same millisecond — was written in six places and
// left the loops that create split siblings a thin collision margin, and
// invoice-store.add() answers null on a collision that nobody checked.
function newId() {
  let tail = '';
  while (tail.length < 8) tail += crypto.randomBytes(8).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `${Date.now()}${tail.slice(0, 8)}`;
}

module.exports = { newId };
