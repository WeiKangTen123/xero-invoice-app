const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { hasUsers, createUser, validatePassword } = require('../utils/users');
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
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
