// What a new password must pass, as the server checks it (main/utils/users.js
// passwordProblem): twelve to 128 characters, not the account's own email,
// not one of the passwords everyone tries first. A copy here lets a form say
// which rule is broken before anything is sent, and keep its button off until
// the password would pass. The server's answer always wins: this is the hint,
// not the check, and the messages are the server's own so a refusal reads the
// same whichever side said it. The server's list of common passwords is
// some 49,000 long (main/utils/common-passwords.txt); this one is the few a
// person is likeliest to try, so a password this file lets through can still
// be refused when it is sent — never the other way round
// (main/scripts/password-rules-parity.test.js).
//
// Imports nothing, so main/scripts/account-ui.test.js runs it as it is.

// Every account's, demo accounts' included: their short permanent password
// went (users.js passwordProblem). Counted as the server counts: in Unicode
// NFC and by character, so an emoji is one, not the two units JavaScript's
// length says.
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// Twelve characters or more that a person types on purpose and a guesser tries
// first. Shorter favourites ("password", "123456") already fail the length
// rule. Compared in lower case.
const COMMON_PASSWORDS = [
  'password1234', 'password12345', 'password123!', 'password123456', 'passwordpassword', 'password2024', 'password2025', 'password2026',
  'p@ssword1234', 'passw0rd1234', 'p@ssw0rd1234', 'password@123', 'changeme1234', 'temppassword', 'temporary123', 'temppassword1',
  '123456789012', '1234567890123', '12345678901234', '123456789abc', 'abcdefghijkl', 'abc123abc123', 'abcd12345678',
  'qwertyuiop12', 'qwertyuiopas', 'qwerty123456', 'qwertyqwerty', 'asdfghjkl123', 'zxcvbnm12345', '1q2w3e4r5t6y', '1qaz2wsx3edc',
  'administrator', 'adminadmin123', 'admin1234567', 'letmeinletmein', 'welcome12345', 'welcome123456', 'iloveyou1234',
  'superman1234', 'football1234', 'baseball1234', 'trustno1trustno1', 'monkey123456', 'dragon123456', 'master123456',
  'sunshine1234', 'princess1234', 'computer1234', 'internet1234', 'whatever1234',
];

// One character the whole way ("aaaaaaaaaaaa"), or digits each one more (or
// one less) than the last, wrapping 9 to 0 ("123456789012", "987654321098"),
// are as common as any word.
function isPattern(lower) {
  if (/^(.)\1+$/u.test(lower)) return true;
  if (!/^\d{2,}$/.test(lower)) return false;
  const step = (lower.charCodeAt(1) - lower.charCodeAt(0) + 10) % 10;
  if (step !== 1 && step !== 9) return false;
  for (let i = 2; i < lower.length; i++) {
    if ((lower.charCodeAt(i) - lower.charCodeAt(i - 1) + 10) % 10 !== step) return false;
  }
  return true;
}

// Nothing but the words of this app and its maker once the digits and symbols
// are out ("Xero2026!", "invoiceinvoice"): the first guess at a password here.
const CONTEXT_ONLY = /^(?:xero|flovon|financial|finance|automation|invoice|invoices|accounting)+$/;
function isContextWords(lower) {
  return CONTEXT_ONLY.test(lower.replace(/\P{L}/gu, ''));
}

// The rule a password breaks, in the server's words, or null when it passes.
// `email` is the account's address, which the password may not be — nor the
// part of it before the @, which is what people type. Compared in NFC and
// lower case and otherwise as typed, as the server compares them.
export function passwordProblem(password, email) {
  const min = PASSWORD_MIN_LENGTH;
  if (typeof password !== 'string') return `Password must be at least ${min} characters`;
  const pw     = password.normalize('NFC');
  const length = [...pw].length;
  if (length < min) return `Password must be at least ${min} characters`;
  if (length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  const lower = pw.toLowerCase();
  if (typeof email === 'string' && email.trim()) {
    const addr = email.trim().normalize('NFC').toLowerCase();
    if (lower === addr || lower === addr.split('@')[0]) return 'Password must not be your email address';
  }
  if (COMMON_PASSWORDS.includes(lower) || isPattern(lower) || isContextWords(lower)) {
    return 'That password is too common; choose another';
  }
  return null;
}

// The placeholder under a new-password field.
export function passwordHint() {
  return `Min. ${PASSWORD_MIN_LENGTH} characters`;
}

// What the set-password screen says, by why the account must choose a new
// password (passwordChangeReason from /api/auth/me and the sign-in): a
// temporary one from an administrator, or its own one that the rules now
// refuse. The current-password field is labelled to match.
export function setPasswordText(reason) {
  return reason === 'rules'
    ? { intro: 'Your password no longer meets the password rules. Choose a new one to go on.', current: 'Current password' }
    : { intro: 'Your administrator gave you a temporary password. Choose your own to go on.', current: 'Temporary password' };
}
