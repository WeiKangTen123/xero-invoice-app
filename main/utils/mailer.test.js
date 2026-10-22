// The server's own email (utils/mailer.js) and what it sends
// (utils/mail-templates.js). No mail leaves the test: a send goes through
// nodemailer's jsonTransport, which builds the message and returns it.
const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM_NAME', 'APP_BASE_URL', 'XERO_OAUTH_REDIRECT_URI'];
const TOKEN = 'A'.repeat(20) + 'b_c-' + 'D'.repeat(19);   // 43 base64url characters

describe('utils/mailer', () => {
  let mailer, saved;

  beforeEach(() => {
    jest.resetModules();
    saved = Object.fromEntries(SMTP_KEYS.map(k => [k, process.env[k]]));
    for (const k of SMTP_KEYS) delete process.env[k];
    mailer = require('./mailer');
  });
  afterEach(() => {
    for (const k of SMTP_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    jest.restoreAllMocks();
  });

  const configure = (extra = {}) => Object.assign(process.env, {
    SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'robot@firm.test', SMTP_PASS: 'abcd efgh ijkl mnop', ...extra,
  });

  // Sends through jsonTransport and keeps each message as nodemailer built it.
  function captureMail() {
    const json = require('nodemailer').createTransport({ jsonTransport: true });
    const sent = [];
    mailer._setTransportForTests({ sendMail: async msg => { const info = await json.sendMail(msg); sent.push(JSON.parse(info.message)); return info; } });
    return sent;
  }

  test('configured only with a server, an account and its password, read at the time of asking', () => {
    expect(mailer.isConfigured()).toBe(false);
    configure();
    expect(mailer.isConfigured()).toBe(true);
    delete process.env.SMTP_PASS;
    expect(mailer.isConfigured()).toBe(false);
    configure({ SMTP_HOST: '   ' });
    expect(mailer.isConfigured()).toBe(false);
  });

  test('port 465 unless a valid one is set; sender name defaults', () => {
    configure();
    expect(mailer.settings()).toMatchObject({ host: 'smtp.gmail.com', port: 465, user: 'robot@firm.test', fromName: 'Financial Automation' });
    configure({ SMTP_PORT: '587', SMTP_FROM_NAME: 'Acme Books' });
    expect(mailer.settings()).toMatchObject({ port: 587, fromName: 'Acme Books' });
    for (const bad of ['abc', '0', '70000', '-1']) {
      process.env.SMTP_PORT = bad;
      expect(mailer.settings().port).toBe(465);
    }
  });

  test('the app address is APP_BASE_URL, else the origin of the Xero redirect, never anything else', () => {
    expect(mailer.appBaseUrl()).toBeNull();
    expect(mailer.linkFor(TOKEN)).toBeNull();
    process.env.XERO_OAUTH_REDIRECT_URI = 'https://books.firm.test/api/xero/oauth/callback';
    expect(mailer.appBaseUrl()).toBe('https://books.firm.test');
    process.env.APP_BASE_URL = 'https://app.firm.test/some/path/';
    expect(mailer.appBaseUrl()).toBe('https://app.firm.test');
    process.env.APP_BASE_URL = 'javascript:alert(1)';
    expect(mailer.appBaseUrl()).toBe('https://books.firm.test');
    process.env.XERO_OAUTH_REDIRECT_URI = 'not a url';
    expect(mailer.appBaseUrl()).toBeNull();
  });

  test('a link carries the token in its fragment, which no server sees', () => {
    process.env.APP_BASE_URL = 'https://app.firm.test';
    expect(mailer.linkFor(TOKEN)).toBe(`https://app.firm.test/set-password#t=${TOKEN}`);
    expect(new URL(mailer.linkFor(TOKEN)).search).toBe('');
  });

  test('sends from "name" <the account>, both text and HTML', async () => {
    configure({ SMTP_FROM_NAME: 'Acme "Books"' });
    const sent = captureMail();
    expect(await mailer.send({ to: 'ana@co.test', subject: 'Hello', text: 'plain', html: '<p>rich</p>' })).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { name: 'Acme "Books"', address: 'robot@firm.test' }, to: [{ address: 'ana@co.test', name: '' }],
      subject: 'Hello', text: 'plain', html: '<p>rich</p>',
    });
  });

  test('not configured: nothing is tried, and it says so', async () => {
    const sendMail = jest.fn();
    mailer._setTransportForTests({ sendMail });
    expect(await mailer.send({ to: 'ana@co.test', subject: 'x', text: 'y' })).toEqual({ sent: false, error: expect.stringMatching(/not set up/) });
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('a failed send resolves with the error, never throws, and never repeats the password', async () => {
    configure();
    const warn = jest.spyOn(require('./logger'), 'warn').mockImplementation(() => {});
    mailer._setTransportForTests({
      sendMail: async () => { throw Object.assign(new Error('Invalid login: 535 bad credentials for abcd efgh ijkl mnop\r\n'), { code: 'EAUTH' }); },
    });
    const res = await mailer.send({ to: 'ana@co.test', subject: 'x', text: 'y' });
    expect(res).toEqual({ sent: false, error: 'Invalid login: 535 bad credentials for [password]' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('abcd efgh ijkl mnop');
    expect(warn).toHaveBeenCalledWith('Email could not be sent', expect.objectContaining({ to: 'ana@co.test', code: 'EAUTH' }));
  });

  test('the real SMTP transport: TLS from the start on 465, STARTTLS required on any other port', async () => {
    configure();
    // The copy of nodemailer the mailer loaded (after resetModules), so no
    // connection is ever made.
    const create = jest.spyOn(require('nodemailer'), 'createTransport').mockReturnValue({ sendMail: async () => ({}) });
    await mailer.send({ to: 'a@b.test', subject: 's', text: 't' });
    expect(create.mock.calls[0][0]).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: true, requireTLS: false, auth: { user: 'robot@firm.test', pass: 'abcd efgh ijkl mnop' } });
    process.env.SMTP_PORT = '587';
    await mailer.send({ to: 'a@b.test', subject: 's', text: 't' });
    expect(create.mock.calls[1][0]).toMatchObject({ port: 587, secure: false, requireTLS: true });
  });
});

describe('utils/mail-templates', () => {
  const t = require('./mail-templates');
  const LINK = `https://app.firm.test/set-password#t=${TOKEN}`;
  const NOW  = Date.parse('2026-10-22T06:05:00.000Z');   // 14:05 in Singapore

  test('times are Singapore time, as people there read them', () => {
    expect(t.formatSgt('2026-10-29T06:05:00.000Z')).toBe('29 Oct 2026, 14:05 SGT');
    expect(t.formatSgt('2026-09-01T16:30:00.000Z')).toBe('2 Sep 2026, 00:30 SGT');
    expect(t.formatSgt('not a date')).toBe('');
  });

  test('the invite: who invited whom, to what, until when, with one button and the plain link', () => {
    const mail = t.invite({ to: 'ana@co.test', link: LINK, expiresAt: new Date(NOW + 7 * 86400000).toISOString(), invitedBy: 'boss@firm.test', now: NOW });
    expect(mail.subject).toBe("You're invited to Financial Automation");
    expect(mail.text).toContain('boss@firm.test has invited you to Financial Automation, with the account ana@co.test.');
    expect(mail.text).toContain('expires on 29 Oct 2026, 14:05 SGT (in 7 days)');
    expect(mail.text).toContain(LINK);
    expect(mail.text).toContain("Didn't ask for this? Ignore this email or tell your administrator.");
    expect(mail.html).toContain('>Choose your password</a>');
    expect(mail.html.match(/href="https:\/\/app\.firm\.test\/set-password#t=/g)).toHaveLength(2);   // the button and the written-out link
    expect(mail.html).toContain('29 Oct 2026, 14:05 SGT (in 7 days)');
    expect(mail.html).toContain('Didn&#39;t ask for this?');
    expect(t.invite({ to: 'ana@co.test', link: LINK, expiresAt: new Date(NOW + 86400000).toISOString(), now: NOW }).text)
      .toContain('An administrator has invited you');
  });

  test('the reset, asked for or sent by an admin, says how long it lasts', () => {
    const own = t.reset({ to: 'ana@co.test', link: LINK, expiresAt: new Date(NOW + 30 * 60000).toISOString(), now: NOW });
    expect(own.subject).toBe('Reset your Financial Automation password');
    expect(own.text).toContain('Someone asked to reset the password for ana@co.test on Financial Automation.');
    expect(own.text).toContain('expires on 22 Oct 2026, 14:35 SGT (in 30 minutes)');
    expect(own.html).toContain('>Set a new password</a>');
    const admins = t.reset({ to: 'ana@co.test', link: LINK, expiresAt: new Date(NOW + 86400000).toISOString(), requestedBy: 'boss@firm.test', now: NOW });
    expect(admins.text).toContain('boss@firm.test has sent you a link to set a new password for ana@co.test');
    expect(admins.text).toContain('(in 24 hours)');
  });

  test('the password-changed notice says when, and that every session was signed out', () => {
    const mail = t.passwordChanged({ to: 'ana@co.test', at: new Date(NOW), signInUrl: 'https://app.firm.test/login' });
    expect(mail.subject).toBe('Your Financial Automation password was changed');
    expect(mail.text).toContain('The password for ana@co.test on Financial Automation was changed on 22 Oct 2026, 14:05 SGT.');
    expect(mail.text).toMatch(/signed out/);
    expect(mail.html).toContain('href="https://app.firm.test/login"');
    expect(mail.text).toMatch(/Didn't do this\? Tell your administrator/);
  });

  test('no token in any subject, no password anywhere, and every value escaped in the HTML', () => {
    const sneaky = 'x"><script>alert(1)</script>@co.test';
    const mails = [
      t.invite({ to: sneaky, link: LINK, expiresAt: new Date(NOW + 86400000).toISOString(), invitedBy: '<b>boss</b>', now: NOW }),
      t.reset({ to: sneaky, link: LINK, expiresAt: new Date(NOW + 86400000).toISOString(), requestedBy: '<b>boss</b>', now: NOW }),
      t.passwordChanged({ to: sneaky, at: new Date(NOW), signInUrl: 'https://app.firm.test/login' }),
      t.test({ to: sneaky, appUrl: 'https://app.firm.test' }),
    ];
    for (const mail of mails) {
      expect(Object.keys(mail).sort()).toEqual(['html', 'subject', 'text']);
      expect(mail.subject).not.toContain(TOKEN);
      expect(mail.subject).not.toMatch(/set-password|#t=/);
      expect(mail.html).not.toContain('<script>');
      expect(mail.html).not.toContain('<b>boss</b>');
      expect(`${mail.subject}${mail.text}${mail.html}`).not.toMatch(/password:\s|temporary password/i);
    }
  });
});
