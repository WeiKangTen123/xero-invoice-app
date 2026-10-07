// Sessions are signed with JWT_SECRET and nothing else. Outside production a
// missing secret used to fall back to a string published in this repository,
// so anyone could sign a token the server would accept.
const jwt = require('jsonwebtoken');

describe('auth-middleware secrets', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, JWT_SECRET: process.env.JWT_SECRET };
  let auth;
  beforeEach(() => {
    jest.resetModules();
    auth = require('./auth-middleware');
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test.each(['development', 'production', undefined])('with no JWT_SECRET and NODE_ENV=%s there is no secret to fall back on', NODE_ENV => {
    if (NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = NODE_ENV;
    delete process.env.JWT_SECRET;
    expect(() => auth.jwtSecret()).toThrow(/JWT_SECRET is not set/);
    // A token signed with the old public fallback is refused, not accepted.
    const forged = jwt.sign({ id: 'someone', role: 'admin' }, 'dev-secret-change-in-production');
    expect(auth.sessionUser(forged)).toEqual({ error: 'Invalid or expired token' });
  });

  test('the test suite keeps a fallback of its own, so it runs on a checkout with no .env', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    expect(auth.jwtSecret()).toBeTruthy();
    expect(auth.jwtSecret()).not.toBe('dev-secret-change-in-production');
    process.env.JWT_SECRET = 'from-the-environment';
    expect(auth.jwtSecret()).toBe('from-the-environment');
  });

  test('jwtSecretProblem: missing is fatal; short or published is only a warning', () => {
    expect(auth.jwtSecretProblem(undefined)).toEqual({ fatal: expect.stringMatching(/^JWT_SECRET is not set/) });
    expect(auth.jwtSecretProblem('')).toEqual({ fatal: expect.stringMatching(/^JWT_SECRET is not set/) });
    expect(auth.jwtSecretProblem('x'.repeat(31))).toEqual({ warning: expect.stringMatching(/only 31 characters; use at least 32/) });
    expect(auth.jwtSecretProblem('dev-secret-change-in-production')).toEqual({ warning: expect.stringMatching(/published in this repository/) });
    expect(auth.jwtSecretProblem('change_this_to_a_long_random_string')).toEqual({ warning: expect.stringMatching(/published in this repository/) });
    expect(auth.jwtSecretProblem('x'.repeat(32))).toEqual({});
  });
});
