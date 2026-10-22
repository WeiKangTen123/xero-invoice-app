const express = require('express');
const router  = express.Router();
const rateLimit = require('express-rate-limit');
const {
  hasUsers, findByEmail, createUser, validatePassword, verifiedPasswordHash, passwordProblem, setPassword, invalidateSessions,
  requirePasswordChange,
  lockStatus, recordFailedLogin, recordSuccessfulLogin, temporaryPasswordExpired, LOCK_AFTER_FAILURES,
  getUserConfig, DEFAULT_TIMEZONE,
} = require('../utils/users');
// Session tokens are signed in one place, auth-middleware.js#signSession,
// which sets how long they last (24 hours, renewed while in use).
const { requireAuth, signSession, SESSION_TOKEN_HEADER } = require('../middleware/auth-middleware');
const asyncHandler = require('../middleware/async-handler');
const logger   = require('../utils/logger');
const auditLog = require('../utils/audit-log');
const sessions = require('../utils/sessions');
const notify   = require('../utils/notify');

// What a locked account is told, whatever the password. The body carries
// when the lock ends and the whole minutes left, for the form to say so.
const LOCKED_MESSAGE = 'Too many failed attempts. This account is locked.';

// Where a request came from, as the sign-in records keep it: the address
// (req.ip, the client's own behind the proxy: index.js sets trust proxy, and
// the rate limits key on the same) and the browser's description of itself,
// cut to 300 characters (sessions.userAgentOf), so a person can tell their
// own laptop from someone else's in the list.
function clientOf(req) {
  return { ip: req.ip || null, ua: sessions.userAgentOf(req) };
}

// A sign-in's session (utils/sessions.js): its id is the `sid` every token
// of this sign-in carries, renewals included.
function startSessionFor(user, req) {
  const { ip, ua } = clientOf(req);
  return sessions.startSession(user.id, { ip, userAgent: ua });
}

// Posts a security alert to Slack (notify.js#notifySecurity), and never lets
// it reach the sign-in that raised it: not an error, not a rejection.
function securityAlert(text) {
  try {
    return Promise.resolve(notify.notifySecurity(text)).catch(() => false);
  } catch (_) {
    return Promise.resolve(false);
  }
}

// An attempt on a locked account is recorded at most once a minute per
// account. It is turned away before the password is checked, so a guesser
// can make as many as the per-IP limit allows each of their addresses, and a
// row for each would bury the rest of the trail; one a minute still shows
// that the guessing went on, and from where.
const LOCKED_ATTEMPT_EVERY_MS = 60 * 1000;

function recordLockedAttempt(row, client) {
  auditLog.safely(() => {
    const since = new Date(Date.now() - LOCKED_ATTEMPT_EVERY_MS).toISOString();
    if (auditLog.recordedSince({ targetUserId: row.id, action: 'login.refused', since, match: { reason: 'locked' } })) return;
    auditLog.recordAdminEvent({ actor: null, target: row, action: 'login.refused', details: { reason: 'locked', ...client } });
  }, 'Locked sign-in attempt');
}

// ── New-country alert ────────────────────────────────────────────────────────
// Slack is told when an account signs in from a country none of its sign-ins
// of the last 90 days came from: the one sign of a stolen password that the
// lockout never sees, since whoever holds it gets it right first time.
// Nothing more is stored for this. The countries of the earlier sign-ins are
// looked up from the addresses already kept (at most the 20 most recent), so
// the check costs no new personal data. Best effort throughout: with no
// lookup (utils/geoip.js missing or failing), no country for this address (a
// private one, or not in the database), or no earlier sign-in with a country
// to compare with, nothing is said.
const NEW_COUNTRY_DAYS = 90;
const NEW_COUNTRY_MAX_ADDRESSES = 20;

// The addresses of the account's earlier sign-ins, read before this one is
// recorded so it is not compared with itself.
function earlierSignInAddresses(userId) {
  try {
    const since = new Date(Date.now() - NEW_COUNTRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    return auditLog.signInAddressesSince(userId, since, { limit: NEW_COUNTRY_MAX_ADDRESSES });
  } catch (_) {
    return [];
  }
}

// Resolves whether an alert went. Never rejects; run after the response, so
// neither a lookup nor Slack can slow a sign-in.
async function alertNewCountry(user, ip, earlier) {
  try {
    if (!ip || !earlier.length) return false;
    // The lookup module is another part of the app, required here rather
    // than at load so that without it sign-in works exactly as before. Its
    // lookups answer only from databases already open, and it closes them
    // when idle, so they are opened first (ready(): off the main thread, and
    // after the response, so no sign-in waits on it).
    let geoip;
    try { geoip = require('../utils/geoip'); } catch (_) { return false; }
    const lookupIp = geoip && geoip.lookupIp;
    if (typeof lookupIp !== 'function') return false;
    if (typeof geoip.ready === 'function') await geoip.ready();
    const where = async addr => {
      try {
        const found = await lookupIp(addr);
        return found && !found.private && (found.countryCode || found.country) ? found : null;
      } catch (_) { return null; }
    };
    const country = w => String(w.countryCode || w.country).toUpperCase();
    const here = await where(ip);
    if (!here) return false;
    // Newest first, and done at the first match: the everyday sign-in is from
    // where the last one was, and takes one lookup more than its own.
    let known = false;
    for (const addr of earlier) {
      const there = await where(addr);
      if (!there) continue;
      if (country(there) === country(here)) return false;
      known = true;
    }
    if (!known) return false;
    return await securityAlert(
      `🌏 ${user.email} signed in from ${here.country || here.countryCode} for the first time in ${NEW_COUNTRY_DAYS} days (IP ${ip})`);
  } catch (err) {
    logger.warn('New-country sign-in check failed', { error: err.message });
    return false;
  }
}

// Ends every other session of the account and returns the id of this one,
// for the token the caller hands back. The cutoff the caller has just moved
// (users.js) already refuses the other sessions' tokens; this is so the
// sessions say they ended, and why, rather than stay in the list until they
// run out. A token from before sessions were kept has none, and this device
// gets one now, so its new token is like any other. Never fails the request:
// at worst the token handed back has no sid, which is still accepted.
function keepOnlyThisSession(req, reason) {
  let sid = req.user.sid || null;
  try {
    if (!sid) sid = startSessionFor(req.user, req);
    sessions.endAllSessions(req.user.id, reason, { except: sid });
  } catch (err) {
    logger.warn('Could not end the other sessions', { userId: req.user.id, reason, error: err.message });
  }
  return sid;
}

// Strict rate limiter for authentication endpoints: max 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 10,
  keyGenerator: req => req.ip,
  message: { error: 'Too many login or registration attempts from this IP. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Five tries per signed-in account per 15 minutes, counted whatever the
// outcome. Keyed by the account rather than the IP: whoever this stops already
// holds a session — a borrowed laptop, a copied token — and is guessing the
// current password to take the account over for good. It runs after
// requireAuth, which is what puts the account on the request.
const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: req => `change-password:${req.user.id}`,
  message: { error: 'Too many password change attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Check if any users have been created yet (frontend uses this to show Register vs Login)
router.get('/status', (_req, res) => {
  res.json({ hasUsers: hasUsers() });
});

// Self-registration creates the FIRST account, which becomes admin. After
// that it is closed: admins add users on the Admin page. ALLOW_REGISTRATION=true
// reopens it. It used to be the other way round — open unless the flag said
// "false" — and the flag was documented nowhere, so the public URL took anyone.
// Returns a JWT immediately so the user lands on Setup without a second login step.
router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const problem = passwordProblem(password, email);
    if (problem) return res.status(400).json({ error: problem });

    if (hasUsers() && process.env.ALLOW_REGISTRATION !== 'true') {
      return res.status(403).json({ error: 'Public registration is disabled. Contact your administrator.' });
    }

    const user  = await createUser(email, password, 'auto');
    const token = signSession(user, { sid: startSessionFor(user, req) });
    logger.info('User registered', { email, role: user.role });
    res.status(201).json({ success: true, user, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Login. The per-account lockout (users.js#lockAfterFailure) stands in front
// of the password check: a locked account answers 423 to every attempt, right
// password or wrong, and nothing is counted or written until the lock ends.
// Each outcome goes in the audit trail with the address and browser it came
// from (clientOf), so a person can see their own sign-ins on the Account page
// and an admin can see a guesser at work. The address typed is kept for a
// failure; the password never. A sign-in that goes through starts a session
// (utils/sessions.js), whose id the token carries.
router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const client = clientOf(req);
    const { ip } = client;
    const typed  = String(email).slice(0, 200);
    const row    = findByEmail(typed);
    if (!row) {
      // The same answer as a wrong password, so the form does not say which
      // addresses exist. Recorded all the same: someone trying addresses is
      // worth seeing, and the account it names does not exist to be shown it.
      auditLog.recordAdminEvent({ actor: null, target: null, action: 'login.failed', details: { email: typed, ...client } });
      logger.info('Sign-in failed', { email: typed, ip, reason: 'no such account' });
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const lock = lockStatus(row);
    if (lock) {
      recordLockedAttempt(row, client);
      logger.info('Sign-in refused: account locked', { email: row.email, ip, lockedUntil: lock.lockedUntil });
      return res.status(423).json({ error: LOCKED_MESSAGE, ...lock });
    }
    const user = await validatePassword(typed, password);
    if (!user) {
      const next = recordFailedLogin(row.id);
      auditLog.recordAdminEvent({ actor: null, target: row, action: 'login.failed', details: { email: typed, ...client } });
      logger.info('Sign-in failed', { email: row.email, ip, failedLogins: next ? next.failed_logins : null });
      if (next && next.locked) {
        // This failure is the one that locked the account: said now, not on
        // the next attempt, so the person (or the guesser) learns at once.
        auditLog.recordAdminEvent({
          actor: null, target: row, action: 'login.locked',
          details: { ...client, lockedUntil: next.locked_until, lockMinutes: next.lockMinutes, failures: LOCK_AFTER_FAILURES },
        });
        logger.warn('Account locked after failed sign-ins', { email: row.email, ip, lockedUntil: next.locked_until, lockMinutes: next.lockMinutes });
        // And to Slack, where someone is watching: a lock is either a person
        // who has forgotten their password or someone guessing it.
        securityAlert(`🔒 ${row.email} locked for ${next.lockMinutes} min after ${LOCK_AFTER_FAILURES} failed sign-ins (IP ${ip || 'unknown'})`);
        return res.status(423).json({ error: LOCKED_MESSAGE, lockedUntil: next.locked_until, lockMinutes: next.lockMinutes });
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    // Said only once the password is right, so the message reaches the account's
    // owner and does not tell a guesser which addresses exist. Recorded, as
    // refused rather than failed: the password was right, and someone holding
    // it trying a disabled account is worth an admin seeing.
    if (user.disabledAt) {
      auditLog.recordAdminEvent({ actor: null, target: row, action: 'login.refused', details: { reason: 'disabled', ...client } });
      logger.info('Sign-in refused: account disabled', { email: row.email, ip });
      return res.status(403).json({ error: 'This account has been disabled. Contact your administrator.' });
    }
    // A temporary password that has run out is right and still refused. Not a
    // failure: it is not a guess, and counting it would lock out the person
    // the admin is about to help. Recorded as refused, so the admin can see
    // they tried.
    if (temporaryPasswordExpired(row)) {
      auditLog.recordAdminEvent({ actor: null, target: row, action: 'login.refused', details: { reason: 'expired_temporary', ...client } });
      logger.info('Sign-in refused: temporary password expired', { email: row.email, ip });
      return res.status(401).json({ error: 'This temporary password has expired. Ask your administrator for a new one.' });
    }

    // The one moment the password itself is in hand: one the rules now refuse
    // (set before they tightened, or a demo account's short one from before
    // that exception went) still signs in, and is then the only thing the
    // account can change, the same gate as a temporary password.
    let signedIn = user;
    if (!user.mustChangePassword && passwordProblem(password, user.email)) {
      requirePasswordChange(user.id);
      signedIn = { ...user, mustChangePassword: true, passwordChangeReason: 'rules' };
      logger.info('Password no longer meets the rules: a new one is required', { email: user.email });
    }

    const earlier = earlierSignInAddresses(user.id);
    recordSuccessfulLogin(user.id);
    auditLog.recordAdminEvent({ actor: user, target: user, action: 'login.success', details: { ...client } });
    const token = signSession(signedIn, { sid: startSessionFor(signedIn, req) });
    logger.info('User logged in', { email: user.email, role: user.role, ip });
    // `user` is sanitized (users.js), so it carries mustChangePassword: the
    // client goes straight to the change-password screen when it is set.
    res.json({ token, user: signedIn });
    alertNewCountry(user, ip, earlier).catch(() => {});
  } catch (err) {
    logger.error('Login error', { error: err.message });
    res.status(500).json({ error: 'Login failed' });
  }
}));

// POST /api/auth/logout — ends this session, stops this user's mailbox
// watcher and revokes their phone-capture links.
//
// Logout was purely client-side (drop the token, forget the user), so the server
// never learned about it, the watcher kept polling for an account nobody was
// signed into, and a copy of the token kept working for the rest of its day.
// The session is ended first (utils/sessions.js), so this token and every
// renewal of it are refused from now on; a token from before sessions were
// kept has no session to end and runs out on its own. The sign-out goes in
// the trail beside the sign-ins, with the address and browser.
//
// Deliberately best-effort: a failure to stop must not block the user from
// logging out, so it never returns an error for that.
//
// stop() is called whether or not isRunning() says so: a watcher waiting out a
// reconnect backoff has no connection, so isRunning() is false, and skipping
// the stop left its pending reconnect to start it again after logout.
router.post('/logout', requireAuth, (req, res) => {
  if (req.user.sid) {
    try {
      sessions.endSession(req.user.sid, 'logout');
    } catch (err) {
      logger.warn('Logout: could not end the session', { userId: req.user.id, error: err.message });
    }
  }
  // A renewal requireAuth made for this request is of the session just
  // ended, and no use to anyone.
  res.removeHeader(SESSION_TOKEN_HEADER);
  const self = { id: req.user.id, email: req.user.email };
  auditLog.recordAdminEvent({ actor: self, target: self, action: 'logout', details: clientOf(req) });
  // A QR code left on screen is an upload link into this account that needs no
  // sign-in, so it must not outlive the session that made it. Done first and
  // on its own, so a watcher that fails to stop cannot leave the links working.
  try {
    const revoked = require('../utils/pairing').revokeForUser(req.user.id);
    if (revoked) logger.info('Logout — phone capture links revoked', { userId: req.user.id, count: revoked });
  } catch (err) {
    logger.warn('Logout: could not revoke phone capture links', { userId: req.user.id, error: err.message });
  }
  try {
    const registry = require('../email/watcher-registry');
    const wasRunning = registry.isRunning(req.user.id);
    registry.stop(req.user.id);
    try { require('../utils/process-state').forUser(req.user.id).notifyStopped(); } catch (_) {}
    if (wasRunning) logger.info('Logout — mailbox watcher stopped', { userId: req.user.id });
    res.json({ ok: true, watcherStopped: wasRunning });
  } catch (err) {
    logger.warn('Logout: could not stop watcher', { userId: req.user.id, error: err.message });
    res.json({ ok: true, watcherStopped: false });
  }
});

// req.user carries mustChangePassword (auth-middleware.js), so a page
// reloaded mid-change still lands on the change-password screen.
router.get('/me', requireAuth, (req, res) => {
  const config = getUserConfig(req.user.id);
  res.json({ user: { ...req.user, timezone: config.TIMEZONE || DEFAULT_TIMEZONE } });
});

// GET /api/auth/sign-ins — the caller's own sign-in history, newest first:
// successes, wrong passwords and locks, each with the address it came from.
// So a person can see for themselves whether anyone else has been at their
// account, without asking an admin to read the Events tab.
router.get('/sign-ins', requireAuth, (req, res) => {
  res.json({ events: auditLog.listSignInEvents(req.user.id) });
});

// POST /api/auth/sign-out-everywhere — every other session this account
// holds is ended, by the same cutoff an admin's sign-out moves
// (routes/admin.js), but by the person themselves: for a laptop left signed
// in somewhere. This session is kept by the fresh token in the body, exactly
// as a password change keeps it, and that token carries this session's sid;
// the others' rows are ended as signed_out_everywhere. The renewal
// requireAuth may have added is from before the cutoff and is dropped.
router.post('/sign-out-everywhere', requireAuth, (req, res) => {
  invalidateSessions(req.user.id);
  const sid  = keepOnlyThisSession(req, 'signed_out_everywhere');
  const self = { id: req.user.id, email: req.user.email };
  auditLog.recordAdminEvent({ actor: self, target: self, action: 'user.sign_out' });
  const token = signSession(req.user, { sid });
  res.removeHeader(SESSION_TOKEN_HEADER);
  logger.info('User signed out everywhere', { email: req.user.email });
  res.json({ token });
});

// POST /api/auth/change-password — the signed-in user sets their own password.
// The current one is required, so an unattended signed-in browser cannot lock
// its owner out. Every other session is signed out by the cutoff setPassword
// moves (auth-middleware.js) and ended as password_changed; THIS one is kept
// by returning a fresh token with its sid, which the client stores in place
// of the old one.
//
// A wrong current password is a 400, not a 401: the client treats every 401
// as an expired session and bounces to the login page.
//
// Also how a temporary password (one an admin set) is replaced: the current
// password asked for is the temporary one, and setPassword takes the
// temporary marks off, which opens the rest of the app (auth-middleware.js).
router.post('/change-password', requireAuth, changePasswordLimiter, asyncHandler(async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    const problem = passwordProblem(newPassword, req.user.email);
    if (problem) return res.status(400).json({ error: problem });
    const verifiedHash = await verifiedPasswordHash(req.user.id, currentPassword);
    if (!verifiedHash) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    // Keeping the same password is no change: and for a temporary one, the
    // administrator who typed it would go on knowing it.
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'Choose a password different from your current one' });
    }
    // Written only over the password just checked. A change that landed in
    // between — an admin's reset, or this account in another tab — wins, and
    // this says so rather than silently replacing it.
    if (!(await setPassword(req.user.id, newPassword, { ifCurrentHash: verifiedHash }))) {
      return res.status(409).json({ error: 'Your password was changed elsewhere (for example, reset by an administrator) while this was being saved, so this change was not applied. Sign in with the current password and try again.' });
    }
    // In the admin trail beside resets, so a password's history is in one
    // place: that it changed and who changed it. Never the password itself.
    auditLog.recordAdminEvent({
      actor: { id: req.user.id, email: req.user.email }, target: { id: req.user.id, email: req.user.email },
      action: 'password.change',
    });
    const token = signSession(req.user, { sid: keepOnlyThisSession(req, 'password_changed') });
    // requireAuth may have renewed the token this request arrived with. That
    // renewal predates the cutoff setPassword has just moved, so it is already
    // dead; the token in the body is this session's, and the only one sent.
    res.removeHeader(SESSION_TOKEN_HEADER);
    logger.info('Password changed', { email: req.user.email });
    res.json({ success: true, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

module.exports = router;
