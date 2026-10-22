// Passwords everyone has heard of, refused wherever a password is chosen
// (users.js#passwordProblem). The length rule turns away most of them on its
// own; this is for the long ones a guesser tries first ("qwerty123456",
// "1q2w3e4r5t6y") and for honesty about what the rule is: a published list,
// not a feeling about what looks weak.
//
// The list is common-passwords.txt beside this file. Source: SecLists
// (https://github.com/danielmiessler/SecLists, MIT licence, Copyright (c)
// 2018 Daniel Miessler), which publishes Mark Burnett's xato.net list of ten
// million leaked passwords ranked by how often each was used. Kept from it:
// the top 3,000 whatever their length, every entry of 12 or more characters
// in the rest of the top 10,000, and every entry of 12 to 64 characters in
// the top 1,000,000 — about 49,000 lines and 700 KB, read into a Set once, on
// first use, so requiring this module costs nothing at boot. Shorter entries
// past the top 3,000 would never be reached (the length rule refuses them
// first) and longer ones are not passwords anyone guesses. The header of the
// file says exactly which lists and which commit. One password a line,
// lowercased; lines starting with # are comments.
//
// Two shapes are refused as well, because a guesser tries them whatever any
// list says: one character the whole way ("aaaaaaaaaaaa"), or digits counting
// straight up or down ("123456789012", "987654321098"); and passwords made of
// nothing but the words of this app and its maker once the digits and symbols
// are taken out ("Xero2026!", "invoiceinvoice", "Financial-Automation-1"),
// the first thing anyone guessing a password for this app would try.
//
// ui/src/pages/account/password-rules.js mirrors these rules, with a short
// list in place of this one, so a form can say what is wrong before anything
// is sent; the answer here is the one that counts.
const fs   = require('fs');
const path = require('path');

const LIST_PATH = path.join(__dirname, 'common-passwords.txt');

let _list = null;
function _load() {
  if (_list) return _list;
  const set = new Set();
  for (const line of fs.readFileSync(LIST_PATH, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    set.add(_fold(line));
  }
  _list = set;
  return set;
}

// The form a password is compared in: Unicode NFC (so "é" typed as one
// character or as "e" and an accent is the same password) and lower case
// ("Password1" is "password1"). Nothing else is normalised: a space or a
// trailing dot is a different password.
function _fold(password) {
  return password.normalize('NFC').toLowerCase();
}

// One character repeated, or a run of digits each one more (or one less) than
// the last, wrapping 9 to 0: "1234567890123" and "0987654321" are both runs.
function isPattern(password) {
  if (typeof password !== 'string' || password.length < 2) return false;
  const pw = _fold(password);
  if (/^(.)\1+$/u.test(pw)) return true;
  if (!/^\d+$/.test(pw)) return false;
  const step = (pw.charCodeAt(1) - pw.charCodeAt(0) + 10) % 10;
  if (step !== 1 && step !== 9) return false;
  for (let i = 2; i < pw.length; i++) {
    if ((pw.charCodeAt(i) - pw.charCodeAt(i - 1) + 10) % 10 !== step) return false;
  }
  return true;
}

// The words of this app and its maker. A password that is only these, once
// everything but letters is taken out, is refused: one of them, several, or
// one over and over.
const CONTEXT_WORDS = ['xero', 'flovon', 'financial', 'finance', 'automation', 'invoice', 'invoices', 'accounting'];
const CONTEXT_ONLY  = new RegExp(`^(?:${CONTEXT_WORDS.join('|')})+$`);

function isContextWords(password) {
  if (typeof password !== 'string') return false;
  return CONTEXT_ONLY.test(_fold(password).replace(/\P{L}/gu, ''));
}

// On the published list, or one of the shapes above.
function isCommonPassword(password) {
  if (typeof password !== 'string' || !password) return false;
  return _load().has(_fold(password)) || isPattern(password) || isContextWords(password);
}

// How many entries the list holds, for a test to pin that the file is whole.
function commonPasswordCount() {
  return _load().size;
}

module.exports = { isCommonPassword, isPattern, isContextWords, commonPasswordCount, CONTEXT_WORDS, LIST_PATH };
