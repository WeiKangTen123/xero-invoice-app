const express = require('express');
const router  = express.Router();
const rateLimit = require('express-rate-limit');
const {
  hasUsers, findById, findByEmail, normalizeEmail, emailProblem, createUser, validatePassword, verifyDummy,
  verifiedPasswordHash, passwordProblem, setPassword, invalidateSessions,
  requirePasswordChange, hashPassword, setPasswordHash, unlockAccount, isInvited,
  lockStatus, recordFailedLogin, recordSuccessfulLogin, temporaryPasswordExpired, LOCK_AFTER_FAILURES,
  getUserConfig, DEFAULT_TIMEZONE,
} = require('../utils/users');
// Session tokens are signed in one place, auth-middleware.js#signSession,
// which sets how long they last (two hours, renewed while in use, and never
// past twelve hours from the sign-in).
const { requireAuth, signSession, SESSION_TOKEN_HEADER } = require('../middleware/auth-middleware');
const asyncHandler = require('../middleware/async-handler');
const logger   = require('../utils/logger');
const auditLog = require('../utils/audit-log');
const sessions = require('../utils/sessions');
const notify   = require('../utils/notify');
const authTokens = require('../utils/auth-tokens');
const mailer     = require('../utils/mailer');
const mailTemplates = require('../utils/mail-templates');

// What a locked account is told, whatever the password. The body carries
// when the lock ends and the whole minutes left, for the form to say so.
const LOCKED_MESSAGE = 'Too many failed attempts. This account is locked.';

// What a sign-in or registration missing either half, or sending something
// other than text for one, is told. A number for a password used to reach the
// hash, which threw: a 500 for an address with an account and a 401 for one
// without, which told a stranger which addresses exist.
const CREDENTIALS_REQUIRED = 'Email and password are required';

// Both halves present, and both text.
function credentialsFrom(body) {
  const { email, password } = body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) return null;
  return { email, password };
}

const REGISTRATION_CLOSED = 'Public registration is disabled. Contact your administrator.';

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
// account. It is turned away without counting, so a guesser can make as many
// as the per-IP limit allows each of their addresses, and a row for each
// would bury the rest of the trail; one a minute still shows that the
// guessing went on, and from where.
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

// ── A lock does not keep the owner out at a known address ───────────────────
// Five wrong passwords lock an account for everyone, so anyone who knows an
// address could keep its owner out with five guesses each time the lock ends.
// The right password is let through from an address this account signed in
// from in the last 90 days (a login.success in the trail): the owner at their
// desk gets in, while the lock goes on turning everyone else away, and is left
// standing for them (recordSuccessfulLogin clears nothing while it is in
// force). A wrong password from a known address is turned away like any
// other, and counts nothing while the lock lasts; the per-IP limit is what
// slows someone guessing from behind the same address as the owner.
const KNOWN_ADDRESS_DAYS = 90;
const KNOWN_ADDRESS_MAX  = 1000;

function signedInFromBefore(userId, ip) {
  if (!ip) return false;
  try {
    const since = new Date(Date.now() - KNOWN_ADDRESS_DAYS * 24 * 60 * 60 * 1000).toISOString();
    return auditLog.signInAddressesSince(userId, since, { limit: KNOWN_ADDRESS_MAX }).includes(String(ip));
  } catch (_) {
    return false;
  }
}

// The 423 for a locked account, recorded (at most once a minute) and logged.
function refuseLocked(res, row, client, lock) {
  recordLockedAttempt(row, client);
  logger.info('Sign-in refused: account locked', { email: row.email, ip: client.ip, lockedUntil: lock?.lockedUntil });
  return res.status(423).json({ error: LOCKED_MESSAGE, ...(lock || {}) });
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
// run out. A token with no session (the test suite's: auth-middleware.js
// refuses any other) gets one now, so its new token is like any other. Never
// fails the request: at worst the token handed back has no sid, and this
// device is asked to sign in again at its next request.
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

// Strict rate limiter for authentication endpoints: at most 10 failed
// attempts per 15 minutes per IP. Only failures count (any answer of 400 or
// more: a wrong password, a lock, a refused registration). Every attempt used
// to, and an office behind one address was shut out after its tenth sign-in
// of the morning.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 10,
  skipSuccessfulRequests: true,
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

// Asking for a reset link (POST /forgot-password): five a quarter hour from
// one address, counted whatever the outcome, since every answer is the same
// success. It stops one address mailing reset links to a list of others;
// the limit per account (resetAllowed below) stops many addresses mailing one
// person.
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: req => req.ip,
  message: { error: 'Too many requests from this address. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Opening and using an invite or reset link (POST /link-info, /set-password):
// twenty failures a quarter hour per address — a link not found, used or run
// out, or a password the rules refuse. A token is 256 random bits, so this is
// not what keeps one from being guessed; it keeps anyone from trying.
const linkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  keyGenerator: req => req.ip,
  message: { error: 'Too many attempts from this address. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/auth/status — whether any account exists (the sign-in page shows
// first-run registration when none does), and whether the server can send
// email with links in it (`mail`), which is when the page offers "Forgot your
// password?".
router.get('/status', (_req, res) => {
  res.json({ hasUsers: hasUsers(), mail: mailer.isConfigured() && !!mailer.appBaseUrl() });
});

// Self-registration creates the FIRST account, which becomes admin. After
// that it is closed: admins add users on the Admin page. ALLOW_REGISTRATION=true
// reopens it. It used to be the other way round — open unless the flag said
// "false" — and the flag was documented nowhere, so the public URL took anyone.
// Returns a JWT immediately so the user lands on Setup without a second login step.
//
// Whether this may be the first account is asked twice: here, cheaply, so a
// closed form costs no hash; and again inside the transaction that inserts
// (users.js createUser, firstOnly), which is the answer that counts. Asked
// only here, before the slow hash, three registrations at once all got in.
// Each refusal has its own status (403 closed, 409 taken, 400 a bad address);
// anything else is a 500 that says nothing of why, which goes to the log.
router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  try {
    const creds = credentialsFrom(req.body);
    if (!creds) return res.status(400).json({ error: CREDENTIALS_REQUIRED });
    const { email, password } = creds;
    const badEmail = emailProblem(email);
    if (badEmail) return res.status(400).json({ error: badEmail });
    const problem = passwordProblem(password, email);
    if (problem) return res.status(400).json({ error: problem });

    const open = process.env.ALLOW_REGISTRATION === 'true';
    if (!open && hasUsers()) return res.status(403).json({ error: REGISTRATION_CLOSED });

    let user;
    try {
      user = await createUser(email, password, 'auto', { firstOnly: !open });
    } catch (err) {
      if (err.code === 'REGISTRATION_CLOSED') return res.status(403).json({ error: REGISTRATION_CLOSED });
      if (err.code === 'EMAIL_INVALID')       return res.status(400).json({ error: err.message });
      if (err.code === 'EMAIL_EXISTS')        return res.status(409).json({ error: 'An account with this email already exists' });
      throw err;
    }
    const client = clientOf(req);
    // In the trail beside the accounts admins make, with where it came from:
    // the first account is the one that holds every other.
    auditLog.recordAdminEvent({ actor: user, target: user, action: 'user.register', details: { role: user.role, ...client } });
    const token = signSession(user, { sid: startSessionFor(user, req) });
    logger.info('User registered', { email: user.email, role: user.role, ip: client.ip });
    res.status(201).json({ success: true, user, token });
  } catch (err) {
    logger.error('Registration failed', { error: err.message });
    res.status(500).json({ error: 'Could not create the account' });
  }
}));

// Login. The per-account lockout (users.js#lockAfterFailure) stands in front
// of the sign-in: a locked account answers 423 to every attempt, right
// password or wrong, and nothing is counted or written until the lock ends,
// except the right password from an address the account has signed in from
// before (signedInFromBefore). Each outcome goes in the audit trail with the
// address and browser it came from (clientOf), so a person can see their own
// sign-ins on the Account page and an admin can see a guesser at work. The
// address typed is kept for a failure; the password never. A sign-in that
// goes through starts a session (utils/sessions.js), whose id the token
// carries.
//
// Every attempt with both halves costs one password check, whether the
// address has an account or not (verifyDummy) and whether it is locked or
// not, so how long the answer takes does not say which addresses exist: an
// unknown one used to answer in 4 ms and a known one in 79.
router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  try {
    const creds = credentialsFrom(req.body);
    if (!creds) return res.status(400).json({ error: CREDENTIALS_REQUIRED });
    const { password } = creds;
    const client  = clientOf(req);
    const { ip }  = client;
    // Looked up whole (an address cut short could name someone else's
    // account); kept in the trail cut to 200 characters.
    const address = normalizeEmail(creds.email);
    const typed   = address.slice(0, 200);
    const row     = findByEmail(address);
    if (!row) {
      await verifyDummy(password);
      // The same answer as a wrong password, so the form does not say which
      // addresses exist. Recorded all the same: someone trying addresses is
      // worth seeing, and the account it names does not exist to be shown it.
      auditLog.recordAdminEvent({ actor: null, target: null, action: 'login.failed', details: { email: typed, ...client } });
      logger.info('Sign-in failed', { email: typed, ip, reason: 'no such account' });
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    // Read before the slow check, so a lock that lands during it (a guess
    // sent alongside this one) is caught by recordSuccessfulLogin below.
    const lock = lockStatus(row);
    const user = await validatePassword(address, password);
    let viaKnownAddress = false;
    if (lock) {
      if (!user || !signedInFromBefore(row.id, ip)) return refuseLocked(res, row, client, lock);
      viaKnownAddress = true;
    }
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

    const earlier = earlierSignInAddresses(user.id);
    // Clears the lockout record, unless a lock is in force: the lock read
    // above was taken before the slow check, and a wrong guess sent alongside
    // this one may have locked the account since. Then this is refused as
    // locked like any attempt made after it, unless it is the owner at a
    // known address; a lock in force is never cleared by it either way.
    if (!recordSuccessfulLogin(user.id) && !viaKnownAddress) {
      if (!signedInFromBefore(user.id, ip)) return refuseLocked(res, row, client, lockStatus(findById(user.id)));
      viaKnownAddress = true;
    }
    if (viaKnownAddress) {
      logger.info('Signed in to a locked account from an address it has signed in from before', { email: user.email, ip });
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

    auditLog.recordAdminEvent({
      actor: user, target: user, action: 'login.success', details: viaKnownAddress ? { ...client, viaKnownAddress: true } : { ...client },
    });
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

// ── Invite and reset links ───────────────────────────────────────────────────
// A person chooses a password through a single-use link (utils/auth-tokens.js)
// sent by email (utils/mailer.js): an admin's invite to a new account, or a
// reset asked for here or sent by an admin. The link opens the set-password
// page with the token in its fragment, which the page posts to link-info (to
// say whose link it is) and set-password (to use it).

// Work done after the answer has gone (sending mail, telling Slack), so the
// answer does not wait on a mail server, and for forgot-password so it takes
// the same time whether there is an account or not. Never rejects; a failure
// is logged. `settled` lets the tests wait for it.
const _afterResponse = new Set();
function afterResponse(what, work) {
  const job = new Promise(resolve => setImmediate(resolve))
    .then(work)
    .catch(err => logger.error(`${what} failed`, { error: err && err.message }))
    .finally(() => _afterResponse.delete(job));
  _afterResponse.add(job);
  return job;
}
router.settled = () => Promise.all([..._afterResponse]);

// Reset links asked for one address: at most three an hour, whoever asks.
// Past that a request is quietly ignored (the answer is the same success), so
// nobody can fill a person's inbox with them. Kept in memory, like the rate
// limits: a restart starts the count again.
const RESET_REQUESTS_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;
const _resetRequests = new Map(); // address -> ms of each recent request

function resetAllowed(address, now = Date.now()) {
  const recent = (_resetRequests.get(address) || []).filter(at => now - at < HOUR_MS);
  const allowed = recent.length < RESET_REQUESTS_PER_HOUR;
  if (allowed) recent.push(now);
  _resetRequests.set(address, recent);
  // Swept as it grows, so addresses asked for once do not stay for the life
  // of the process.
  if (_resetRequests.size > 1000) {
    for (const [key, times] of _resetRequests) if (!times.some(at => now - at < HOUR_MS)) _resetRequests.delete(key);
  }
  return allowed;
}

// What a link that cannot be used is told (410), by why: the page shows it
// as it is. An invite that has run out needs an admin; a reset, a new
// request from the sign-in page.
const LINK_MESSAGES = {
  expiredInvite: 'This invite has expired. Ask your administrator to send a new one.',
  expiredReset:  'This link has expired. Request a new one.',
  used:          'This link has already been used. If you set your password, sign in.',
  invalid:       "This link isn't valid any more. Ask your administrator for a new one.",
};
function linkRefusal(link) {
  if (link.reason === 'expired') {
    return { error: link.purpose === 'invite' ? LINK_MESSAGES.expiredInvite : LINK_MESSAGES.expiredReset, reason: 'expired' };
  }
  if (link.reason === 'used') return { error: LINK_MESSAGES.used, reason: 'used' };
  return { error: LINK_MESSAGES.invalid, reason: 'invalid' };
}

// Sends a reset link to `email` if it should go: the account exists, is not
// disabled, has a password to reset (an invite not yet accepted has none:
// its invite link is the way in), and the server can send mail with links in
// it. The request is in the trail whenever the account exists, with where it
// came from and whether a link went; the account itself is never changed or
// locked by it. Its current password keeps working until a new one is set.
async function sendResetLink(email, client) {
  const address = normalizeEmail(email);
  if (!address || emailProblem(address)) return;
  if (!resetAllowed(address)) {
    logger.info('Reset request ignored: three already in the last hour for this address', { email: address.slice(0, 200), ip: client.ip });
    return;
  }
  const row = findByEmail(address);
  if (!row) {
    logger.info('Reset requested for an address with no account', { email: address.slice(0, 200), ip: client.ip });
    return;
  }
  let reason = null;
  if (row.disabled_at) reason = 'disabled';
  else if (isInvited(row)) reason = 'invited';
  else if (!mailer.isConfigured() || !mailer.appBaseUrl()) reason = 'mail_off';

  let emailed = false;
  if (!reason) {
    const now = Date.now();
    const raw = authTokens.issue(row.id, 'reset', { ttlMs: authTokens.RESET_TTL_MS, now });
    const expiresAt = new Date(now + authTokens.RESET_TTL_MS).toISOString();
    const sent = await mailer.send({ to: row.email, ...mailTemplates.reset({ to: row.email, link: mailer.linkFor(raw), expiresAt, now }) });
    emailed = sent.sent;
    // A link nobody received is no use to anyone; it goes.
    if (!emailed) { reason = 'send_failed'; authTokens.revoke(row.id, 'reset'); }
  }
  auditLog.recordAdminEvent({
    actor: null, target: row, action: 'password.reset_requested', details: { ...client, emailed, ...(reason ? { reason } : {}) },
  });
  logger.info('Password reset requested', { email: row.email, ip: client.ip, emailed, reason });
}

// POST /api/auth/forgot-password { email } — always { success: true }, at
// once, whether or not the address has an account (OWASP: the answer must
// not say which addresses exist, by its words or by its speed). The work is
// done after the answer has gone (sendResetLink).
router.post('/forgot-password', forgotPasswordLimiter, (req, res) => {
  const email  = req.body ? req.body.email : undefined;
  const client = clientOf(req);
  res.json({ success: true });
  afterResponse('Password reset request', () => sendResetLink(email, client));
});

// POST /api/auth/link-info { token } — whose link this is, before the page
// asks for a password: { purpose: 'invite' | 'reset', email, invitedBy (the
// admin who made it, or null), expiresAt }. A link that cannot be used is a
// 410 with why (linkRefusal). Uses nothing up.
router.post('/link-info', linkLimiter, (req, res) => {
  const link = authTokens.peek(req.body ? req.body.token : undefined);
  if (!link.ok) return res.status(410).json(linkRefusal(link));
  const maker = link.createdBy ? findById(link.createdBy) : null;
  res.json({ purpose: link.purpose, email: link.email, invitedBy: maker ? maker.email : null, expiresAt: link.expiresAt });
});

// POST /api/auth/set-password { token, password } — sets the password the
// link was for, and uses the link up. The password meets the same rules as
// everywhere (passwordProblem, with the account's address); it is hashed
// first, since that is slow, and then the link is used up and the password
// written in one transaction (auth-tokens.js#consume), so two tabs with the
// same link cannot both get through. With it: the temporary marks come off,
// the account is unlocked (the person resetting is often the one locked out),
// and every session is signed out, the cutoff moved and the rows ended as
// password_reset or invite_accepted.
//
// Does not sign the person in: they sign in with the new password, which
// proves it was typed as meant, and the sign-in is recorded like any other.
// Answers { success: true, email } for the sign-in form to fill in. Then an
// accepted invite is told to the admins on Slack, and a reset is confirmed to
// the person by email, as OWASP asks: if they did not do it, they know.
router.post('/set-password', linkLimiter, asyncHandler(async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof token !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'A link and a new password are required' });
  }
  const link = authTokens.peek(token);
  if (!link.ok) return res.status(410).json(linkRefusal(link));
  const problem = passwordProblem(password, link.email);
  if (problem) return res.status(400).json({ error: problem });

  const hash   = await hashPassword(password);
  const reason = link.purpose === 'invite' ? 'invite_accepted' : 'password_reset';
  const done = authTokens.consume(token, row => {
    setPasswordHash(row.user_id, hash);
    unlockAccount(row.user_id);
    invalidateSessions(row.user_id);
    return sessions.endAllSessions(row.user_id, reason);
  });
  if (!done.ok) return res.status(410).json(linkRefusal(done));

  const client = clientOf(req);
  const self   = { id: done.userId, email: done.email };
  auditLog.recordAdminEvent({ actor: self, target: self, action: 'password.set_via_link', details: { purpose: done.purpose, ...client } });
  logger.info('Password set from a link', { email: done.email, purpose: done.purpose, sessionsEnded: done.result, ip: client.ip });
  res.json({ success: true, email: done.email });

  if (done.purpose === 'invite') {
    afterResponse('Invite accepted notice', () => notify.notifyNotice(`✅ ${done.email} accepted their invite`));
  } else if (mailer.isConfigured()) {
    const base = mailer.appBaseUrl();
    afterResponse('Password changed email', () => mailer.send({
      to: done.email, ...mailTemplates.passwordChanged({ to: done.email, at: new Date(), signInUrl: base ? `${base}/login` : null }),
    }));
  }
}));

module.exports = router;
