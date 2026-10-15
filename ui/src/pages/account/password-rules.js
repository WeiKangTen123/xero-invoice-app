// What a new password must pass, as the server checks it (main/utils/users.js
// passwordProblem): at least twelve characters, not the account's own email,
// not one of the passwords everyone tries first. A copy here lets a form say
// which rule is broken before anything is sent, and keep its button off until
// the password would pass. The server's answer always wins: this is the hint,
// not the check, and the messages are the server's own so a refusal reads the
// same whichever side said it.
//
// Imports nothing, so main/scripts/account-ui.test.js runs it as it is.

export const PASSWORD_MIN_LENGTH = 12;

// Twelve characters or more that a person types on purpose and a guesser tries
// first. Shorter favourites ("password", "123456") already fail the length
// rule. Compared in lower case.
const COMMON_PASSWORDS = [
  'password1234', 'password12345', 'password123!', 'password123456', 'passwordpassword', 'password2024', 'password2025', 'password2026',
  'p@ssword1234', 'passw0rd1234', 'p@ssw0rd1234', 'changeme1234', 'temppassword', 'temporary123', 'temppassword1',
  '123456789012', '1234567890123', '12345678901234', '123456789abc', 'abcdefghijkl', 'abc123abc123', 'abcd12345678',
  'qwertyuiop12', 'qwertyuiopas', 'qwerty123456', 'qwertyqwerty', 'asdfghjkl123', 'zxcvbnm12345', '1q2w3e4r5t6y', '1qaz2wsx3edc',
  'administrator', 'adminadmin123', 'admin1234567', 'letmeinletmein', 'welcome12345', 'welcome123456', 'iloveyou1234',
  'superman1234', 'football1234', 'baseball1234', 'trustno1trustno1', 'monkey123456', 'dragon123456', 'master123456',
  'sunshine1234', 'princess1234', 'computer1234', 'internet1234', 'whatever1234',
];

// One character the whole way ("aaaaaaaaaaaa"), or digits in a straight run
// up or down ("123456789012", "987654321098"), are as common as any word.
function isPattern(lower) {
  if (/^(.)\1+$/.test(lower)) return true;
  if (!/^\d+$/.test(lower)) return false;
  const up = '01234567890123456789', down = '98765432109876543210';
  return up.includes(lower) || down.includes(lower);
}

// The rule a password breaks, in the server's words, or null when it passes.
// `email` is the account's address, which the password may not be — nor the
// part of it before the @, which is what people type. Compared in lower case
// and otherwise as typed, as the server compares them.
export function passwordProblem(password, email) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  const lower = password.toLowerCase();
  if (typeof email === 'string' && email.trim()) {
    const addr = email.toLowerCase().trim();
    if (lower === addr || lower === addr.split('@')[0]) return 'Password must not be your email address';
  }
  if (COMMON_PASSWORDS.includes(lower) || isPattern(lower)) {
    return 'That password is too common; choose another';
  }
  return null;
}

// The placeholder under a new-password field.
export function passwordHint() {
  return `Min. ${PASSWORD_MIN_LENGTH} characters`;
}
