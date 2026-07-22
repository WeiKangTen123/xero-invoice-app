const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('admin routes', () => {
  let app, users, jwtSecret, adminUser;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    const adminRoutes = require('./admin');

    adminUser = await users.createUser('admin@test.com', 'password123', 'auto'); // first user -> admin

    app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes);
  });

  function tokenFor(user) {
    return jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
  }

  test('GET /users requires authentication', async () => {
    await request(app).get('/api/admin/users').expect(401);
  });

  test('GET /users returns all users for an admin', async () => {
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .expect(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].email).toBe('admin@test.com');
  });

  test('POST /users creates a new user', async () => {
    const res = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ email: 'new@test.com', password: 'password123', role: 'user' })
      .expect(201);
    expect(res.body.user.email).toBe('new@test.com');
    expect(res.body.user.role).toBe('user');
  });

  test('DELETE /users/:id blocks deleting your own account', async () => {
    await request(app)
      .delete(`/api/admin/users/${adminUser.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .expect(400);
  });

  test('GET /monitoring returns system + per-user stats', async () => {
    const res = await request(app)
      .get('/api/admin/monitoring')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .expect(200);

    expect(res.body.system.totalUsers).toBe(1);
    expect(typeof res.body.system.uptimeSeconds).toBe('number');
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0]).toMatchObject({
      email:          'admin@test.com',
      watcherRunning: false,
      xeroConnected:  false,
      imapConfigured: false,
    });
    expect(res.body.users[0].queue).toEqual({ pending: 0, processing: 0, dead: 0, jobs: [] });
    expect(res.body.users[0].invoices).toEqual({ pending: 0, submitting: 0, posted: 0, error: 0, reviewNeeded: 0 });
  });
});
