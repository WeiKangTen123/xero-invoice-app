const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('routes/auth', () => {
  let app, users, jwtSecret;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    const authRoutes = require('./auth');

    app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
  });

  function tokenFor(user) {
    return jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
  }

  describe('GET /me', () => {
    test('defaults timezone to Asia/Singapore when the user has never set one', async () => {
      const u = await users.createUser('notz@test.com', 'password123', 'user');
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokenFor(u)}`)
        .expect(200);
      expect(res.body.user.timezone).toBe('Asia/Singapore');
    });

    test('returns the user-configured timezone once set', async () => {
      const u = await users.createUser('withtz@test.com', 'password123', 'user');
      users.saveUserConfig(u.id, { TIMEZONE: 'America/New_York' });
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokenFor(u)}`)
        .expect(200);
      expect(res.body.user.timezone).toBe('America/New_York');
    });
  });

  // Proves the requireAuth -> touchLastSeen wiring actually works end to end
  // (not just that touchLastSeen itself works in isolation, which utils/users.test.js
  // already covers) — a real authenticated request through a real route.
  test('any authenticated request updates last_seen_at, independent of which route', async () => {
    const u = await users.createUser('presence@test.com', 'password123', 'user');
    expect(users.findById(u.id).last_seen_at).toBeFalsy();

    await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokenFor(u)}`)
      .expect(200);

    const after = users.findById(u.id);
    expect(after.last_seen_at).toBeTruthy();
    expect(users.isOnline(after.last_seen_at)).toBe(true);
  });

  test('an invalid token does not touch last_seen_at and is rejected', async () => {
    const u = await users.createUser('badtoken@test.com', 'password123', 'user');
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
    expect(users.findById(u.id).last_seen_at).toBeFalsy();
  });
});
