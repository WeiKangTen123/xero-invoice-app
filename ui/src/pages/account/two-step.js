// 2-step sign-in on the screen side: what a code field keeps of what is typed
// or pasted, the secret grouped for typing by hand, the recovery codes as a
// text file, which state the Account page's card is in and what it says, and
// the "Confirm it's you" dialog's words. The pages cannot be rendered on every
// machine this is worked on, so these live here, import nothing, and
// main/scripts/mfa-ui.test.js runs them as they are.

// ── Codes ────────────────────────────────────────────────────────────────────
// The code an authenticator app shows: six digits, new every thirty seconds.
export const CODE_LENGTH = 6;

// What a code field keeps: digits only, six at most. Apps show the code as
// "123 456" and copy it that way; pasted, it is 123456.
export function sanitizeCode(value) {
  return String(value ?? '').replace(/\D/g, '').slice(0, CODE_LENGTH);
}

// Six digits: the button that sends a code is off until then.
export function isFullCode(value) {
  return typeof value === 'string' && /^\d{6}$/.test(value);
}

// A recovery code as typed: letters, digits and dashes, nothing else (a space
// or a line break picked up in a copy is dropped). Long enough for any code,
// never a paragraph.
export function sanitizeRecoveryCode(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
}

// The recovery code as sent: xxxx-xxxx-xxxx, however the twelve characters
// were grouped when typed ("abcd efgh ijkl", "abcdefghijkl"); anything else
// as typed, for the server to judge.
export function recoveryCodeForSend(value) {
  const typed = sanitizeRecoveryCode(value);
  const bare  = typed.replace(/-/g, '');
  return bare.length === 12 ? `${bare.slice(0, 4)}-${bare.slice(4, 8)}-${bare.slice(8)}` : typed;
}

// Something that could be a recovery code: the button is off until then.
export function isRecoveryCode(value) {
  return sanitizeRecoveryCode(value).replace(/-/g, '').length >= 8;
}

// ── Setting it up ────────────────────────────────────────────────────────────
// The secret behind the QR code, for an app that cannot scan: in fours, as
// the apps' own "enter a setup key" fields show it. The spaces are only for
// reading; Copy copies the secret without them.
export function groupSecret(secret) {
  const s = String(secret ?? '').replace(/[\s-]/g, '').toUpperCase();
  return (s.match(/.{1,4}/g) || []).join(' ');
}

export const SETUP_STEPS = [
  'Open Google Authenticator, Microsoft Authenticator or 1Password.',
  'Scan the code.',
  'Enter the 6-digit code it shows.',
];

// ── Recovery codes ───────────────────────────────────────────────────────────
// The codes as the server sent them (ten, each used once), blanks dropped.
export function recoveryList(codes) {
  return Array.isArray(codes)
    ? codes.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim())
    : [];
}

// Copy all: one code a line.
export function copyAllText(codes) {
  return recoveryList(codes).join('\n');
}

export const RECOVERY_FILE_NAME = 'financial-automation-recovery-codes.txt';

// Download .txt: what the codes are, for which account, when they were
// made, how to use them, and the codes numbered. `made` is the date as the
// page formats it; either may be left out.
export function recoveryCodesText(codes, { email = '', made = '' } = {}) {
  const lines = ['Financial Automation: 2-step sign-in recovery codes'];
  if (email) lines.push(`Account: ${email}`);
  if (made)  lines.push(`Made: ${made}`);
  lines.push(
    '',
    'Each code signs you in once, in place of the 6-digit code from your authenticator app.',
    'Keep them somewhere safe, away from your phone. Making new codes stops these from working.',
    '',
  );
  recoveryList(codes).forEach((c, i) => lines.push(`${String(i + 1).padStart(2, ' ')}. ${c}`));
  return `${lines.join('\n')}\n`;
}

// "7 recovery codes left", with a nudge once few are left; '' when the
// server did not say.
export function codesLeftText(n) {
  if (n === null || n === undefined || n === '') return '';
  const left = Number(n);
  if (!Number.isFinite(left) || left < 0) return '';
  if (left === 0) return 'No recovery codes left. Make new ones: without them, a lost phone locks you out.';
  const text = `${left} recovery code${left === 1 ? '' : 's'} left`;
  return left <= 2 ? `${text}. Make new ones soon.` : text;
}

// The colour that line is said in: red with none left, yellow with two or
// fewer, plain otherwise.
export function codesLeftTone(n) {
  const left = Number(n);
  if (n === null || n === undefined || n === '' || !Number.isFinite(left)) return null;
  if (left <= 0) return 'red';
  return left <= 2 ? 'yellow' : null;
}

// ── The Account page's card ──────────────────────────────────────────────────
// Off, then (Set up) the QR code and a code to type, then the recovery codes,
// shown once, then on. The status comes from GET /api/auth/mfa ({ enabled,
// enabledAt, required, recoveryCodesLeft }).
export const TWO_STEP_LOADING = 'loading';
export const TWO_STEP_OFF     = 'off';
export const TWO_STEP_SETUP   = 'setup';
export const TWO_STEP_CODES   = 'codes';
export const TWO_STEP_ON      = 'on';
export const TWO_STEP_FAILED  = 'failed';

export function stateFromStatus(status) {
  return status && status.enabled === true ? TWO_STEP_ON : TWO_STEP_OFF;
}

// Set-up mode: an admin without 2-step sign-in may do nothing else until it
// is on (the server answers 403 mfa_setup_required), so the Account page is
// headed for it. The user says so (mfaSetupRequired, from /api/auth/me, so a
// reload lands the same way) or the address does (?setup-2-step=1, where the
// API client and the route guard send them); an address left over once it is
// on means nothing.
export function twoStepSetupMode(search, user) {
  if (user && user.mfaSetupRequired === true) return true;
  if (user && user.mfaEnabled === true) return false;
  try {
    return new URLSearchParams(search || '').get('setup-2-step') === '1';
  } catch (_) {
    return false;
  }
}

// Whether the card offers Turn off: not to an admin, who must keep it on
// (the server refuses them too). The status says so (`required`); the role
// says the same before it has come.
export function canTurnOff(status, user) {
  if (status && status.required === true) return false;
  return !(user && user.role === 'admin');
}

// "On since 22 Oct 2026", from the date as the page formats it.
export function onSinceText(day) {
  return day && day !== '—' ? `On since ${day}` : 'On';
}

export const SETUP_REQUIRED_TITLE = 'Set up 2-step sign-in to continue';
export const SETUP_REQUIRED_INTRO = 'Admins sign in with a password and a code from an authenticator app on their phone. '
  + 'Set it up to go on: it takes a minute.';
export const OFF_TEXT = 'Sign in with your password and a 6-digit code from an app on your phone, '
  + 'so a password that leaks is not enough to get in.';
export const REQUIRED_FOR_ADMINS = 'Required for admins.';

// ── Confirm it's you ─────────────────────────────────────────────────────────
// Some admin actions (inviting or promoting an admin; a reset link, password
// reset or deletion of an admin; resetting someone's 2-step sign-in) ask the
// person at the keyboard to prove it is them first (403 reauth_required). With
// 2-step sign-in on, a code from the app; the password either way.
export function reauthText(useCode) {
  return useCode
    ? { intro: 'Enter the 6-digit code from your authenticator app to continue.', label: 'Code from your app', toggle: 'Use your password instead', button: 'Confirm' }
    : { intro: 'Enter your password to continue.', label: 'Password', toggle: 'Use a code from your app instead', button: 'Confirm' };
}

// What POST /api/auth/reauth is sent.
export function reauthBody(useCode, value) {
  return useCode ? { code: sanitizeCode(value) } : { password: String(value ?? '') };
}

// The Confirm button is off until there is something to send.
export function reauthReady(useCode, value) {
  return useCode ? isFullCode(value) : typeof value === 'string' && value.length > 0;
}
