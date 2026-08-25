const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { hasUsers, createUser, validatePassword, getUserConfig, DEFAULT_TIMEZONE } = require('../utils/users');
const { requireAuth, jwtSecret } = require('../middleware/auth-middleware');
const logger  = require('../utils/logger');

// Check if any users have been created yet (frontend uses this to show Register vs Login)
router.get('/status', (_req, res) => {
  res.json({ hasUsers: hasUsers() });
});

// Self-registration — open to anyone, no auth required.
// First person to register becomes admin automatically.
// All subsequent registrations get the 'user' role.
// Admins can promote users via POST /api/admin/users.
// Returns a JWT immediately so the user lands on Setup without a second login step.
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
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
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = await validatePassword(email, password);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

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

module.exports = router;
