// Passwords everyone has heard of, refused wherever a password is chosen
// (users.js#passwordProblem). The length rule turns away most of them on its
// own; this is for the long ones a guesser tries first ("qwerty123456",
// "1q2w3e4r5t6y") and for honesty about what the rule is: a published list,
// not a feeling about what looks weak.
//
// The list is common-passwords.txt beside this file: the top 3,000 of the
// xato.net 10-million list as SecLists publishes it, plus the 12-character-
// and-longer entries from the rest of its top 10,000 (the header of the file
// says exactly which). One password a line, lowercased; lines starting with #
// are comments. Read once, on first use, so requiring this module costs
// nothing at boot.
const fs   = require('fs');
const path = require('path');

const LIST_PATH = path.join(__dirname, 'common-passwords.txt');

let _list = null;
function _load() {
  if (_list) return _list;
  const set = new Set();
  for (const line of fs.readFileSync(LIST_PATH, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    set.add(line.toLowerCase());
  }
  _list = set;
  return set;
}

// Case-insensitive: "Password1" is "password1". Nothing else is normalised —
// a space or a trailing dot is a different password, as it is to bcrypt.
function isCommonPassword(password) {
  if (typeof password !== 'string' || !password) return false;
  return _load().has(password.toLowerCase());
}

// How many entries the list holds, for a test to pin that the file is whole.
function commonPasswordCount() {
  return _load().size;
}

module.exports = { isCommonPassword, commonPasswordCount, LIST_PATH };
