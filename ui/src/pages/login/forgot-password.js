// The forgot-password page (pages/ForgotPassword.jsx): an address in, a
// reset link out by email. The page cannot be rendered on every machine this
// is worked on, so its words and its timing live here, import nothing, and
// main/scripts/forgot-password-ui.test.js runs them as they are.
//
// The server answers the same whether or not an account uses the address
// (POST /auth/forgot-password → 200 { success: true } always), so nobody can
// learn from this page who has an account. The page says it the same way:
// "if an account uses it".

// Send another link waits this long after the last one, so a person who
// cannot see the email yet does not fill the inbox, or spend the server's
// limit, before the first has had time to arrive.
export const RESEND_SECONDS = 60;

// Seconds until Send another link comes on: 0 once it is on.
export function resendWait(sentAt, now = Date.now()) {
  const at = Number(sentAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((at + RESEND_SECONDS * 1000 - Number(now)) / 1000));
}

export function resendLabel(wait) {
  return wait > 0 ? `Send another link (${wait} s)` : 'Send another link';
}

// Why the address cannot be sent yet, or null. Only what is plainly not an
// address: the server decides the rest, and says nothing either way.
export function emailProblem(email) {
  const e = typeof email === 'string' ? email.trim() : '';
  if (!e) return 'Enter your email address';
  if (!/^[^\s@]+@[^\s@]+$/.test(e)) return 'Enter the whole address, such as you@company.com';
  return null;
}

// The page before and after the link is sent.
export const FORM_TEXT = {
  title:    'Reset your password',
  subtitle: 'We\'ll email you a link to set a new one.',
  button:   'Email me a link',
  back:     '← Back to sign in',
};

export function sentText(email) {
  const e = typeof email === 'string' ? email.trim() : '';
  return {
    title: 'Check your email',
    text:  `If an account uses ${e || 'that address'}, we've sent it a link. It works once, for 30 minutes.`,
    hint:  'Nothing? Check spam, or',
  };
}
