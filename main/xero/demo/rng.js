// A small seeded random source for the Demo Company. Everything the generator
// invents comes through one of these, seeded by what the thing IS (the year,
// the month, the customer, the invoice's position in its month), never by
// when it was asked for: the same invoice has the same amount on every call,
// on every server, on every day, and generating one more month at the end of
// the history changes nothing before it.

// FNV-1a over the seed text, so a seed can be a readable label.
function hashSeed(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// mulberry32: tiny, fast, good enough for invented figures.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = '0123456789abcdef';

function rngFor(...parts) {
  const next = mulberry32(hashSeed(parts.join('|')));
  const rng = {
    next,
    // An integer from lo to hi, both inclusive.
    int(lo, hi) { return lo + Math.floor(next() * (hi - lo + 1)); },
    float(lo, hi) { return lo + next() * (hi - lo); },
    pick(list) { return list[Math.floor(next() * list.length)]; },
    chance(p) { return next() < p; },
    // `base` moved by up to ±pct (0.2 = twenty per cent either way).
    jitter(base, pct) { return base * (1 + (next() * 2 - 1) * pct); },
    // A GUID in the shape Xero's IDs have, from the stream.
    guid() {
      let out = '';
      for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
        else if (i === 14) out += '4';
        else if (i === 19) out += HEX[8 + Math.floor(next() * 4)];
        else out += HEX[Math.floor(next() * 16)];
      }
      return out;
    },
  };
  return rng;
}

// One GUID for a named thing, the same every time.
function guidFor(...parts) {
  return rngFor('guid', ...parts).guid();
}

module.exports = { hashSeed, mulberry32, rngFor, guidFor };
