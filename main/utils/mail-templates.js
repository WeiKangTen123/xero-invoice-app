// The emails the app sends (utils/mailer.js), each as { subject, text, html }:
// the same message twice, plain text for a reader that shows only that, and
// simple HTML with its styles inline (mail readers drop <style> blocks and
// stylesheets). Every value put into the HTML is escaped.
//
// What every one of them keeps to:
//   * no password and no token in the subject, which shows in notification
//     previews and mail server logs; the link is in the body only, and no
//     email ever carries a password at all
//   * the app's name and the address it was sent to, so a person with
//     several accounts knows which one, and a misdirected mail says so
//   * one button, and the same link written out beneath it for a reader
//     that will not show buttons
//   * when the link stops working, in Singapore time, where this app's
//     users are ("29 Oct 2026, 14:05 SGT")
//   * what to do if the person did not ask for it
const APP_NAME = 'Financial Automation';

const NOT_ASKED = "Didn't ask for this? Ignore this email or tell your administrator.";

// Month names spelled here rather than by Intl, whose short form for
// September differs between ICU versions ("Sep" or "Sept").
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// An instant as Singapore's clock shows it: "29 Oct 2026, 14:05 SGT".
function formatSgt(at) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(p => [p.type, p.value]));
  return `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}:${parts.minute} SGT`;
}

// How long from `now` until `at`, in the largest whole unit that fits:
// "30 minutes", "24 hours", "7 days". Rounded, since a link issued a moment
// ago has a lifetime a few milliseconds short of its round figure.
function _howLong(at, now = Date.now()) {
  const ms = Date.parse(at instanceof Date ? at.toISOString() : at) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60000);
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes < 120) return plural(Math.max(1, minutes), 'minute');
  const hours = Math.round(minutes / 60);
  if (hours <= 48) return plural(hours, 'hour');
  return plural(Math.round(hours / 24), 'day');
}

function _expiry(expiresAt, now) {
  const when = formatSgt(expiresAt);
  const left = _howLong(expiresAt, now);
  return left ? `${when} (in ${left})` : when;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// One email's HTML: a heading, paragraphs (already escaped), one button and
// its link written out, and the closing line. Table layout and inline
// styles, which every mail reader shows the same.
function _html({ heading, paragraphs, button, link, footer }) {
  const p = text => `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#1f2937;">${text}</p>`;
  const action = link ? `
        <p style="margin:24px 0;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 22px;background:#13b5ea;color:#ffffff;text-decoration:none;font-weight:600;border-radius:6px;font-size:15px;">${escapeHtml(button)}</a></p>
        <p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#4b5563;">Or copy this link into your browser:<br><a href="${escapeHtml(link)}" style="color:#0b7fab;word-break:break-all;">${escapeHtml(link)}</a></p>` : '';
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:8px;padding:32px;">
        <tr><td>
        <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#0b7fab;letter-spacing:0.02em;">${escapeHtml(APP_NAME)}</p>
        <h1 style="margin:0 0 20px;font-size:20px;line-height:1.3;color:#111827;">${escapeHtml(heading)}</h1>
        ${paragraphs.map(p).join('\n        ')}${action}
        <p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.5;color:#6b7280;">${escapeHtml(footer)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// The plain-text twin: the same words, the link on a line of its own.
function _text({ heading, lines, link, footer }) {
  return [heading, '', ...lines.flatMap(l => [l, '']), ...(link ? [link, ''] : []), footer, '', `— ${APP_NAME}`].join('\n');
}

// An admin's invite to a new account. `invitedBy` is the admin's address, or
// null when they are gone.
function invite({ to, link, expiresAt, invitedBy = null, now = Date.now() }) {
  const who = invitedBy || 'An administrator';
  const when = _expiry(expiresAt, now);
  const heading = `You're invited to ${APP_NAME}`;
  const intro = `${who} has invited you to ${APP_NAME}, with the account ${to}.`;
  const ask = 'Choose your password to finish setting up your account:';
  const expiry = `This link works once and expires on ${when}.`;
  return {
    subject: heading,
    text: _text({ heading, lines: [intro, ask], link, footer: `${expiry}\n\n${NOT_ASKED}` }),
    html: _html({
      heading, link, button: 'Choose your password',
      paragraphs: [
        `<strong>${escapeHtml(who)}</strong> has invited you to ${escapeHtml(APP_NAME)}, with the account <strong>${escapeHtml(to)}</strong>.`,
        escapeHtml(ask), escapeHtml(expiry),
      ],
      footer: NOT_ASKED,
    }),
  };
}

// A link to set a new password: asked for on the sign-in page (requestedBy
// null), or sent by an admin (their address).
function reset({ to, link, expiresAt, requestedBy = null, now = Date.now() }) {
  const when = _expiry(expiresAt, now);
  const heading = `Reset your ${APP_NAME} password`;
  const intro = requestedBy
    ? `${requestedBy} has sent you a link to set a new password for ${to} on ${APP_NAME}.`
    : `Someone asked to reset the password for ${to} on ${APP_NAME}.`;
  const ask = 'Choose a new password here:';
  const expiry = `This link works once and expires on ${when}. Your current password keeps working until you choose a new one.`;
  return {
    subject: heading,
    text: _text({ heading, lines: [intro, ask], link, footer: `${expiry}\n\n${NOT_ASKED}` }),
    html: _html({
      heading, link, button: 'Set a new password',
      paragraphs: [
        requestedBy
          ? `<strong>${escapeHtml(requestedBy)}</strong> has sent you a link to set a new password for <strong>${escapeHtml(to)}</strong> on ${escapeHtml(APP_NAME)}.`
          : `Someone asked to reset the password for <strong>${escapeHtml(to)}</strong> on ${escapeHtml(APP_NAME)}.`,
        escapeHtml(ask), escapeHtml(expiry),
      ],
      footer: NOT_ASKED,
    }),
  };
}

// After a reset link was used: that the password changed, when, and that
// every session was signed out. Not the "ignore this" line: a change the
// person did not make is the one thing they must not ignore.
function passwordChanged({ to, at = new Date(), signInUrl = null }) {
  const heading = `Your ${APP_NAME} password was changed`;
  const what = `The password for ${to} on ${APP_NAME} was changed on ${formatSgt(at)}.`;
  const sessions = 'Every session on every device was signed out; sign in again with the new password.';
  const warning = "Didn't do this? Tell your administrator straight away: someone may have access to your email.";
  return {
    subject: heading,
    text: _text({ heading, lines: [what, sessions], link: signInUrl, footer: warning }),
    html: _html({
      heading, link: signInUrl, button: 'Sign in',
      paragraphs: [
        `The password for <strong>${escapeHtml(to)}</strong> on ${escapeHtml(APP_NAME)} was changed on ${escapeHtml(formatSgt(at))}.`,
        escapeHtml(sessions),
      ],
      footer: warning,
    }),
  };
}

// Setup -> Email -> Send test email: proof the settings work, to the admin
// who pressed it.
function test({ to, appUrl = null }) {
  const heading = `${APP_NAME} can send email`;
  const what = `This is a test from ${APP_NAME}, sent to ${to}. Invites and password reset links will be sent the same way.`;
  const footer = appUrl ? `Links in them will start with ${appUrl}.` : 'Set the app address (APP_BASE_URL) in Setup so links can be made.';
  return {
    subject: `Test email from ${APP_NAME}`,
    text: _text({ heading, lines: [what], link: null, footer }),
    html: _html({ heading, link: null, paragraphs: [escapeHtml(what)], footer }),
  };
}

module.exports = { invite, reset, passwordChanged, test, formatSgt, escapeHtml, APP_NAME, NOT_ASKED };
