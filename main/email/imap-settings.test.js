const {
  hostForEmail, resolveImapSettings, automaticImapValues,
  DEFAULT_PORT, DEFAULT_POLL_MS, MIN_POLL_MS, DEFAULT_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS,
} = require('./imap-settings');

describe('email/imap-settings — which mailbox settings a person must actually type', () => {
  describe('the server host is read from the address', () => {
    test('the common providers are known', () => {
      expect(hostForEmail('someone@gmail.com')).toBe('imap.gmail.com');
      expect(hostForEmail('SOMEONE@GoogleMail.com')).toBe('imap.gmail.com');
      expect(hostForEmail('someone@outlook.com')).toBe('outlook.office365.com');
      expect(hostForEmail('someone@live.com')).toBe('outlook.office365.com');
      expect(hostForEmail('someone@hotmail.com')).toBe('outlook.office365.com');
      expect(hostForEmail('someone@yahoo.com')).toBe('imap.mail.yahoo.com');
      expect(hostForEmail('someone@icloud.com')).toBe('imap.mail.me.com');
    });

    test('an unknown domain answers null rather than guessing a server that will not answer', () => {
      expect(hostForEmail('someone@acme-corp.example')).toBeNull();
      expect(hostForEmail('not an address')).toBeNull();
      expect(hostForEmail('')).toBeNull();
      expect(hostForEmail(null)).toBeNull();
    });
  });

  describe('resolving what the watcher will use', () => {
    const login = 'person@gmail.com';

    test('an empty configuration still yields everything but the password', () => {
      const s = resolveImapSettings({}, login);
      expect(s).toMatchObject({
        host: 'imap.gmail.com', port: DEFAULT_PORT, user: login, password: null,
        pollMs: DEFAULT_POLL_MS, lookbackDays: DEFAULT_LOOKBACK_DAYS, filterFrom: null,
      });
    });

    test('a password is the one thing that cannot be worked out', () => {
      expect(resolveImapSettings({}, login).ready).toBe(false);
      expect(resolveImapSettings({ IMAP_PASS: 'app-password' }, login).ready).toBe(true);
    });

    test('a company mailbox with no known host is not ready until the host is given', () => {
      const noHost = resolveImapSettings({ IMAP_PASS: 'pw' }, 'finance@acme-corp.example');
      expect(noHost.host).toBeNull();
      expect(noHost.ready).toBe(false);
      expect(resolveImapSettings({ IMAP_PASS: 'pw', IMAP_HOST: 'mail.acme-corp.example' }, 'finance@acme-corp.example').ready).toBe(true);
    });

    test('anything typed by hand wins over the automatic value', () => {
      const s = resolveImapSettings({
        IMAP_HOST: 'mail.example.com', IMAP_PORT: '143', IMAP_USER: 'shared@example.com',
        IMAP_PASS: 'pw', IMAP_FILTER_FROM: 'billing@supplier.com',
        IMAP_POLL_INTERVAL_MS: '120000', IMAP_LOOKBACK_DAYS: '30',
      }, login);
      expect(s).toMatchObject({
        host: 'mail.example.com', port: 143, user: 'shared@example.com', password: 'pw',
        filterFrom: 'billing@supplier.com', pollMs: 120000, lookbackDays: 30,
      });
    });

    test('a shared mailbox address decides the host, not the login', () => {
      expect(resolveImapSettings({ IMAP_USER: 'ap@outlook.com' }, login).host).toBe('outlook.office365.com');
    });

    test('nonsense numbers fall back instead of breaking the connection', () => {
      const s = resolveImapSettings({ IMAP_PORT: 'abc', IMAP_POLL_INTERVAL_MS: '0', IMAP_LOOKBACK_DAYS: '-5' }, login);
      expect(s.port).toBe(DEFAULT_PORT);
      expect(s.pollMs).toBe(DEFAULT_POLL_MS);
      expect(s.lookbackDays).toBe(DEFAULT_LOOKBACK_DAYS);
    });

    test('polling is floored and the lookback capped, whatever was typed', () => {
      expect(resolveImapSettings({ IMAP_POLL_INTERVAL_MS: '1000' }, login).pollMs).toBe(MIN_POLL_MS);
      expect(resolveImapSettings({ IMAP_LOOKBACK_DAYS: '9999' }, login).lookbackDays).toBe(MAX_LOOKBACK_DAYS);
    });

    test('it says which values it worked out, so a form can show them as automatic', () => {
      const s = resolveImapSettings({ IMAP_PORT: '993' }, login);
      expect(s.automatic).toEqual(expect.arrayContaining(['IMAP_HOST', 'IMAP_USER']));
      expect(s.automatic).not.toContain('IMAP_PORT');
    });
  });

  describe('what the setup form should offer', () => {
    test('every automatic field comes back as the text that will be used', () => {
      expect(automaticImapValues('person@gmail.com')).toEqual({
        IMAP_HOST: 'imap.gmail.com',
        IMAP_PORT: String(DEFAULT_PORT),
        IMAP_USER: 'person@gmail.com',
        IMAP_POLL_INTERVAL_MS: String(DEFAULT_POLL_MS),
        IMAP_LOOKBACK_DAYS: String(DEFAULT_LOOKBACK_DAYS),
      });
    });

    test('an unknown provider offers no host, so the form must ask for it', () => {
      expect(automaticImapValues('finance@acme-corp.example').IMAP_HOST).toBeNull();
    });
  });
});
