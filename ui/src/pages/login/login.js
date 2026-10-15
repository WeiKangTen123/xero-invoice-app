// The sign-in screen's decisions that need no React: what the alert says when
// the server answers 423 (the account is locked after too many wrong
// passwords), and the countdown on the button while the lock lasts. The page
// cannot be rendered on every machine this is worked on, so they live here,
// import nothing, and main/scripts/login-ui.test.js runs them as they are.

// A time in ms from whatever the caller holds: a Date, a number, an ISO
// string. NaN for anything unreadable.
function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return NaN;
}

// HH:MM, 24-hour, in the browser's own time: the person reading it is the one
// waiting, wherever they are, so no account timezone applies. `timeZone` is
// for tests, which cannot rely on the machine's clock setting.
export function clockTime(ms, timeZone) {
  try {
    const opts = { hour: '2-digit', minute: '2-digit', hour12: false };
    if (timeZone) opts.timeZone = timeZone;
    return new Intl.DateTimeFormat('en-GB', opts).format(new Date(ms));
  } catch (_) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

// When the lock ends, from the 423 body: its lockedUntil, or now plus its
// lockMinutes for a server that sent only that. null when it sent neither.
function lockEnd(body, nowMs) {
  const until = toMs(body?.lockedUntil);
  if (Number.isFinite(until)) return until;
  const minutes = Number(body?.lockMinutes);
  if (Number.isFinite(minutes) && minutes > 0) return nowMs + minutes * 60000;
  return null;
}

// The 423 body read into the alert: when the lock ends (ms), how many whole
// minutes that is from now (never less than one while it lasts), the clock
// time, and the sentence. null when there is no lock left to wait out, so a
// stale body never locks the form.
export function lockMessage(body, now = Date.now(), opts = {}) {
  const nowMs = Number.isFinite(toMs(now)) ? toMs(now) : Date.now();
  const until = lockEnd(body, nowMs);
  if (until === null || until <= nowMs) return null;
  const minutes = Math.max(1, Math.ceil((until - nowMs) / 60000));
  const time = clockTime(until, opts.timeZone);
  return {
    until,
    minutes,
    time,
    text: `Too many failed attempts. This account is locked until ${time} (${minutes} minute${minutes === 1 ? '' : 's'}). `
        + 'If this wasn\'t you, or you can\'t wait, ask your administrator to unlock it.',
  };
}

// The button while the lock lasts: still locked, and m:ss to go. Once the
// moment has passed the button is a Sign in button again.
export function lockCountdown(until, now = Date.now()) {
  const left = toMs(until) - toMs(now);
  if (!Number.isFinite(left) || left <= 0) return { locked: false, text: '' };
  const total = Math.ceil(left / 1000);
  const m = Math.floor(total / 60), s = total % 60;
  return { locked: true, text: `${m}:${String(s).padStart(2, '0')}` };
}
