// deploy.sh proves a deploy by comparing the server's checkout with the local
// commit. That says what is on disk, not what is running: health now names
// the commit the process was started from, so the check can look at that.
const request = require('supertest');
const express = require('express');
const { serverFor } = require('../scripts/test-server');

test('health names the running commit, so a deploy can prove what is live', async () => {
  const app = express();
  app.get('/dashboard/health', require('./dashboard').health);
  const { body } = await request(serverFor(app)).get('/dashboard/health').expect(200);
  expect(body.status).toBe('healthy');
  expect(body.commit).toMatch(/^[0-9a-f]{7,40}$/);
});

test('DEPLOY_SHA, when set by the deploy, wins over the checkout', () => {
  jest.resetModules();
  process.env.DEPLOY_SHA = 'abc1234';
  try {
    const res = { json: jest.fn() };
    require('./dashboard').health({}, res);
    expect(res.json.mock.calls[0][0].commit).toBe('abc1234');
  } finally { delete process.env.DEPLOY_SHA; }
});
