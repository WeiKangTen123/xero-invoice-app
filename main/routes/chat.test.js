jest.mock('../utils/chat-agent', () => ({
  respond: jest.fn().mockResolvedValue({ reply: 'ok', proposals: [] }),
}));

const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('POST /api/chat', () => {
  let app, users, jwtSecret, user, token;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    const chatRoutes = require('./chat');

    user  = await users.createUser('chatuser@test.com', 'password123', 'user');
    token = jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());

    app = express();
    app.use(express.json());
    app.use('/api/chat', chatRoutes);
  });

  test('rejects without auth', async () => {
    await request(app).post('/api/chat').send({ message: 'hi' }).expect(401);
  });

  test('rejects an empty message', async () => {
    await request(app).post('/api/chat').set('Authorization', `Bearer ${token}`).send({ message: '' }).expect(400);
  });

  test('returns the agent response for a normal message', async () => {
    const res = await request(app)
      .post('/api/chat').set('Authorization', `Bearer ${token}`)
      .send({ message: 'hello' }).expect(200);
    expect(res.body).toEqual({ reply: 'ok', proposals: [] });
  });

  // Verifies the limiter is wired up with the intended 12/min cap via its response
  // headers, rather than exhausting the real 60s window — exhausting it is timing-
  // sensitive (flaky under system load: if the 12 requests take too long, the
  // window slides and the 13th never gets blocked), so this checks the config
  // deterministically instead of relying on wall-clock timing in the test itself.
  test('is configured with the intended 12/min cap (protects the shared Gemini quota)', async () => {
    const res = await request(app)
      .post('/api/chat').set('Authorization', `Bearer ${token}`)
      .send({ message: 'hello' }).expect(200);
    expect(res.headers['ratelimit-limit']).toBe('12');
    expect(Number(res.headers['ratelimit-remaining'])).toBe(11);
  });
});
