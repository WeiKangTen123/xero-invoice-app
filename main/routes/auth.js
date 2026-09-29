const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { hasUsers, createUser, validatePassword, passwordProblem, setPassword, getUserConfig, DEFAULT_TIMEZONE } = require('../utils/users');
const { requireAuth, jwtSecret } = require('../middleware/auth-middleware');
const logger  = require('../utils/logger');

// Strict rate limiter for authentication endpoints: max 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 10,
  keyGenerator: req => req.ip,
  message: { error: 'Too many login or registration attempts from this IP. Please try again in 15 minutes.' },
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
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });

    if (hasUsers() && process.env.ALLOW_REGISTRATION !== 'true') {
      return res.status(403).json({ error: 'Public registration is disabled. Contact your administrator.' });
    }

    const user  = await createUser(email, password, 'auto');
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      jwtSecret(),
      { expiresIn: '7d' }
    );
    logger.info('User registered', { email, role: user.role });
    res.status(201).json({ success: true, user, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Login
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = await validatePassword(email, password);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    // Said only once the password is right, so the message reaches the account's
    // owner and does not tell a guesser which addresses exist.
    if (user.disabledAt) {
      return res.status(403).json({ error: 'This account has been disabled. Contact your administrator.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      jwtSecret(),
      { expiresIn: '7d' }
    );
    logger.info('User logged in', { email: user.email, role: user.role });
    res.json({ token, user });
  } catch (err) {
    logger.error('Login error', { error: err.message });
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current user (validate token)
// POST /api/auth/logout — stops this user's mailbox watcher.
//
// Logout was purely client-side (drop the token, forget the user), so the server
// never learned about it and the watcher kept polling for an account nobody was
// signed into. The JWT itself is stateless and can't be revoked here; this is
// about not leaving a mailbox connection running for someone who has left.
//
// Deliberately best-effort: a failure to stop must not block the user from
// logging out, so it never returns an error for that.
router.post('/logout', requireAuth, (req, res) => {
  try {
    const registry = require('../email/watcher-registry');
    const wasRunning = registry.isRunning(req.user.id);
    if (wasRunning) {
      registry.stop(req.user.id);
      try { require('../utils/process-state').forUser(req.user.id).notifyStopped(); } catch (_) {}
      logger.info('Logout — mailbox watcher stopped', { userId: req.user.id });
    }
    res.json({ ok: true, watcherStopped: wasRunning });
  } catch (err) {
    logger.warn('Logout: could not stop watcher', { userId: req.user.id, error: err.message });
    res.json({ ok: true, watcherStopped: false });
  }
});

router.get('/me', requireAuth, (req, res) => {
  const config = getUserConfig(req.user.id);
  res.json({ user: { ...req.user, timezone: config.TIMEZONE || DEFAULT_TIMEZONE } });
});

// POST /api/auth/change-password — the signed-in user sets their own password.
// The current one is required, so an unattended signed-in browser cannot lock
// its owner out. Every other session is signed out by the cutoff setPassword
// moves (auth-middleware.js); THIS one is kept by returning a fresh token,
// which the client stores in place of the old one.
//
// A wrong current password is a 400, not a 401: the client treats every 401
// as an expired session and bounces to the login page.
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    const problem = passwordProblem(newPassword);
    if (problem) return res.status(400).json({ error: problem });
    if (!(await validatePassword(req.user.email, currentPassword))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    await setPassword(req.user.id, newPassword);
    const token = jwt.sign(
      { id: req.user.id, email: req.user.email, role: req.user.role },
      jwtSecret(),
      { expiresIn: '7d' }
    );
    logger.info('Password changed', { email: req.user.email });
    res.json({ success: true, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
