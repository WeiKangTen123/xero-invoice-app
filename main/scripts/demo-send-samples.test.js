// The demo sender: arguments, the SMTP server for a mailbox, the order of sends,
// the send loop against a mocked nodemailer, and marking each sent email unread
// against a mocked IMAP mailbox. No mail leaves the machine and the app's
// database is never opened: the generator, the mailer and imap are mocked, and
// the app (users, mailbox settings) is passed in as a stub.
const path = require('path');
const { EventEmitter } = require('events');

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
jest.mock('imap', () => jest.fn());
// The generator is written separately and may not exist yet.
jest.mock('../xero/demo/samples', () => ({ buildSamples: jest.fn(), writeSamples: jest.fn() }), { virtual: true });

const nodemailer = require('nodemailer');
const Imap = require('imap');
const generator = require('../xero/demo/samples');
const { parseArgs, smtpFor, planSends, main, DEFAULT_GAP_S } = require('./demo-send-samples');

const pdf = Buffer.alloc(2048, 1);
const jpg = Buffer.alloc(1024, 2);
const SAMPLES = {
  emails: [
    { kind: 'ar', id: 'ar-one', subject: 'AR one', text: 'Client / Customer : One', attachments: [] },
    { kind: 'ap', id: 'ap-one', subject: 'AP one', text: 'Bill attached', attachments: [{ filename: 'one.pdf', contentType: 'application/pdf', content: pdf }] },
    { kind: 'ar', id: 'ar-two', subject: 'AR two', text: 'Client / Customer : Two', attachments: [] },
    { kind: 'ap-photo', id: 'ap-photo', subject: 'AP photo', text: 'Photo attached', attachments: [{ filename: 'p.jpg', contentType: 'image/jpeg', content: jpg }] },
  ],
  receipts: [{ id: 'receipt-one', filename: 'r.jpg', contentType: 'image/jpeg', content: jpg, expected: {} }],
};

const GMAIL = { host: 'imap.gmail.com', port: 993, user: 'owner@gmail.com', password: 'abcd efgh ijkl mnop', ready: true };
const TLS = { rejectUnauthorized: true, servername: 'imap.gmail.com' };

// A Gmail-like INBOX: what is sent to it arrives already read (\Seen).
let inbox, imaps;
class FakeImap extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    imaps.push(this);
    this.openBox = jest.fn((name, readOnly, cb) => cb(null, { name, uidnext: inbox.nextUid }));
    this.search = jest.fn((criteria, cb) => {
      if (inbox.searchError) return cb(inbox.searchError);
      const [[, field, value]] = criteria;
      const hits = inbox.messages.filter(m => (field === 'X-Demo-Sample'
        ? inbox.headerSearch && m.id === value
        : field === 'MESSAGE-ID' && m.messageId === value));
      return cb(null, hits.map(m => m.uid));
    });
    this.delFlags = jest.fn((uids, flags, cb) => {
      for (const m of inbox.messages) if (uids.includes(m.uid)) m.seen = false;
      cb(null);
    });
    this.end = jest.fn();
  }
  connect() {
    Promise.resolve().then(() => (inbox.connectError ? this.emit('error', inbox.connectError) : this.emit('ready')));
  }
}

let transport, out, err, app, sentCount;

function deps(mailbox = GMAIL) {
  app = {
    findUser: jest.fn(email => (email === 'owner@gmail.com' ? { id: 'u1', email } : null)),
    mailbox: jest.fn(() => mailbox),
    tlsOptions: jest.fn(() => TLS),
  };
  return {
    loadApp: jest.fn(() => app),
    print: line => out.push(line),
    printErr: line => err.push(line),
  };
}

// Delivers to the fake INBOX, as Gmail files a message sent to yourself.
async function deliver(msg) {
  const messageId = `<m${++sentCount}@gmail.com>`;
  const id = msg.headers['X-Demo-Sample'];
  if (!inbox.lost.includes(id)) inbox.messages.push({ uid: inbox.nextUid++, id, messageId, seen: true });
  return { messageId };
}

beforeEach(() => {
  jest.clearAllMocks();
  out = []; err = []; imaps = []; sentCount = 0;
  inbox = { messages: [], nextUid: 100, headerSearch: true, lost: [], searchError: null, connectError: null };
  Imap.mockImplementation(options => new FakeImap(options));
  transport = {
    verify: jest.fn().mockResolvedValue(true),
    sendMail: jest.fn(deliver),
    close: jest.fn(),
  };
  nodemailer.createTransport.mockReturnValue(transport);
  generator.buildSamples.mockResolvedValue(SAMPLES);
  generator.writeSamples.mockResolvedValue(['/tmp/demo/emails/one.pdf', '/tmp/demo/receipts/r.jpg']);
});

afterEach(() => { jest.useRealTimers(); });

describe('parseArgs', () => {
  test('defaults', () => {
    expect(parseArgs(['--email', 'owner@gmail.com'])).toEqual({
      email: 'owner@gmail.com', to: null, only: null, gap: DEFAULT_GAP_S,
      write: null, sendToo: false, dryRun: false, leaveRead: false, seed: null, help: false,
    });
    expect(DEFAULT_GAP_S).toBe(30);
  });

  test('every option, in both spellings', () => {
    const a = parseArgs(['--email=owner@gmail.com', '--to', 'x@y.com', '--only', 'ar, AP-photo,ar', '--gap=2.5',
      '--write', 'out', '--send-too', '--dry-run', '--leave-read', '--seed', 'take 2']);
    expect(a).toMatchObject({ email: 'owner@gmail.com', to: 'x@y.com', only: ['ar', 'ap-photo'], gap: 2.5,
      write: 'out', sendToo: true, dryRun: true, leaveRead: true, seed: 'take 2' });
    expect(parseArgs(['--email', 'a@b.c', '--gap', '0']).gap).toBe(0);
  });

  test('a bad gap is refused', () => {
    for (const gap of ['-5', 'abc', '30s', '', '1e3']) {
      expect(() => parseArgs(['--email', 'a@b.c', '--gap', gap])).toThrow(/--gap/);
    }
    expect(() => parseArgs(['--email', 'a@b.c', '--gap'])).toThrow(/--gap needs a value/);
  });

  test('an unknown kind, an unknown flag, a missing or malformed email are refused', () => {
    expect(() => parseArgs(['--email', 'a@b.c', '--only', 'ar,receipt'])).toThrow(/--only takes ar, ap, ap-photo \(not receipt\)/);
    expect(() => parseArgs(['--email', 'a@b.c', '--only', ','])).toThrow(/--only/);
    expect(() => parseArgs(['--email', 'a@b.c', '--fast'])).toThrow(/unknown argument: --fast/);
    expect(() => parseArgs([])).toThrow(/--email is required/);
    expect(() => parseArgs(['--email', 'nobody'])).toThrow(/does not look like/);
    expect(() => parseArgs(['--email', 'a@b.c', '--to', 'nobody'])).toThrow(/--to does not look like/);
    expect(() => parseArgs(['--email', 'a@b.c', '--send-too'])).toThrow(/--send-too only goes with --write/);
  });

  test('--write alone needs no account; --write --send-too does', () => {
    expect(parseArgs(['--write', 'out']).email).toBeNull();
    expect(() => parseArgs(['--write', 'out', '--send-too'])).toThrow(/--email is required/);
  });

  test('--help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});

describe('smtpFor', () => {
  test('a Gmail mailbox sends through smtp.gmail.com:465 over TLS, signed in as the watcher signs in', () => {
    expect(smtpFor(GMAIL)).toEqual({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: 'owner@gmail.com', pass: 'abcd efgh ijkl mnop' },
    });
  });

  test('a custom imap. host becomes smtp. on 465', () => {
    expect(smtpFor({ host: 'IMAP.Example.com', user: 'me@example.com', password: 'pw' })).toEqual({
      host: 'smtp.example.com', port: 465, secure: true, auth: { user: 'me@example.com', pass: 'pw' },
    });
  });

  test('a host without imap. is used as it is', () => {
    expect(smtpFor({ host: 'mail.example.com', user: 'u', password: 'p' }).host).toBe('mail.example.com');
  });

  test('Outlook sends on 587 with STARTTLS required', () => {
    expect(smtpFor({ host: 'outlook.office365.com', user: 'u', password: 'p' })).toMatchObject({
      host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true,
    });
  });

  test('no host is refused', () => {
    expect(() => smtpFor({ user: 'u', password: 'p' })).toThrow(/no server/);
  });
});

describe('planSends', () => {
  test('keeps the generator order', () => {
    expect(planSends(SAMPLES, null).map(e => e.id)).toEqual(['ar-one', 'ap-one', 'ar-two', 'ap-photo']);
    expect(planSends(SAMPLES, []).map(e => e.id)).toEqual(['ar-one', 'ap-one', 'ar-two', 'ap-photo']);
  });

  test('narrows to the kinds asked for, still in order', () => {
    expect(planSends(SAMPLES, ['ap-photo', 'ar']).map(e => e.id)).toEqual(['ar-one', 'ar-two', 'ap-photo']);
    expect(planSends(SAMPLES, ['ap']).map(e => e.id)).toEqual(['ap-one']);
  });

  test('nothing to send from nothing', () => {
    expect(planSends({}, null)).toEqual([]);
    expect(planSends(null, ['ar'])).toEqual([]);
  });
});

describe('main', () => {
  test('--help prints usage and touches neither the app nor the generator', async () => {
    const d = deps();
    expect(await main(['--help'], d)).toBe(0);
    expect(out.join('\n')).toMatch(/Usage: node main\/scripts\/demo-send-samples\.js --email/);
    expect(out.join('\n')).toMatch(/gcloud compute ssh xero-automation .*--email weikangten@gmail\.com --gap 30"/);
    expect(d.loadApp).not.toHaveBeenCalled();
    expect(generator.buildSamples).not.toHaveBeenCalled();
    expect(Imap).not.toHaveBeenCalled();
  });

  test('a bad argument prints the problem with usage and exits 2', async () => {
    const d = deps();
    expect(await main(['--email', 'owner@gmail.com', '--gap', 'soon'], d)).toBe(2);
    expect(err[0]).toMatch(/--gap must be a number/);
    expect(d.loadApp).not.toHaveBeenCalled();
  });

  test('sends one email per sample, in order, from the mailbox to itself with the sample header', async () => {
    const d = deps();
    expect(await main(['--email', 'owner@gmail.com', '--gap', '0', '--seed', 'take 2'], d)).toBe(0);

    expect(app.findUser).toHaveBeenCalledWith('owner@gmail.com');
    expect(app.mailbox).toHaveBeenCalledWith('u1');
    expect(generator.buildSamples).toHaveBeenCalledWith({ seed: 'take 2' });
    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: 'owner@gmail.com', pass: 'abcd efgh ijkl mnop' },
    });
    expect(transport.verify).toHaveBeenCalledTimes(1);
    expect(transport.sendMail).toHaveBeenCalledTimes(4);

    const sent = transport.sendMail.mock.calls.map(c => c[0]);
    expect(sent.map(m => m.subject)).toEqual(['AR one', 'AP one', 'AR two', 'AP photo']);
    for (const m of sent) {
      expect(m.from).toEqual({ name: 'Demo samples', address: 'owner@gmail.com' });
      expect(m.to).toBe('owner@gmail.com');
    }
    expect(sent[0]).toEqual({
      from: { name: 'Demo samples', address: 'owner@gmail.com' }, to: 'owner@gmail.com',
      subject: 'AR one', text: 'Client / Customer : One', attachments: [], headers: { 'X-Demo-Sample': 'ar-one' },
    });
    expect(sent[1].attachments).toEqual([{ filename: 'one.pdf', contentType: 'application/pdf', content: pdf }]);
    expect(sent[1].headers).toEqual({ 'X-Demo-Sample': 'ap-one' });
    expect(sent[3].attachments[0]).toMatchObject({ filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(transport.close).toHaveBeenCalled();

    const text = out.join('\n');
    expect(text).toContain("The demo account's sender filter must be owner@gmail.com, and the owner's own watcher must be stopped, or it will take these emails first.");
    expect(out.filter(l => /^\d\d:\d\d:\d\d {2}\S+ +(AR|AP) /.test(l))).toHaveLength(4);
    expect(text).toMatch(/\d\d:\d\d:\d\d {2}ap {8}AP one {2}\(2\.0 KB\)/);
    expect(out[out.length - 1]).toMatch(/^Sent 4 of 4 \(3\.1 KB\) to owner@gmail\.com in \d+s; 4 marked unread\.$/);
    expect(text).not.toContain('abcd efgh');
  });

  describe('marking each sent email unread', () => {
    test('one IMAP connection as the watcher makes it, INBOX opened read-write, closed at the end', async () => {
      expect(await main(['--email', 'owner@gmail.com', '--gap', '0'], deps())).toBe(0);
      expect(Imap).toHaveBeenCalledTimes(1);
      expect(Imap).toHaveBeenCalledWith({
        user: 'owner@gmail.com', password: 'abcd efgh ijkl mnop', host: 'imap.gmail.com', port: 993,
        tls: true, tlsOptions: TLS, keepalive: true, authTimeout: 10000,
      });
      expect(app.tlsOptions).toHaveBeenCalledWith('imap.gmail.com');
      const [imap] = imaps;
      expect(imap.openBox).toHaveBeenCalledWith('INBOX', false, expect.any(Function));
      expect(imap.end).toHaveBeenCalledTimes(1);
      // The SMTP sign-in is checked first, then the INBOX opened, before anything is sent.
      expect(transport.verify.mock.invocationCallOrder[0]).toBeLessThan(imap.openBox.mock.invocationCallOrder[0]);
      expect(imap.openBox.mock.invocationCallOrder[0]).toBeLessThan(transport.sendMail.mock.invocationCallOrder[0]);
    });

    test('finds each message by its X-Demo-Sample header and removes \\Seen from it', async () => {
      expect(await main(['--email', 'owner@gmail.com', '--gap', '0'], deps())).toBe(0);
      const [imap] = imaps;
      expect(imap.search.mock.calls.map(c => c[0])).toEqual(
        ['ar-one', 'ap-one', 'ar-two', 'ap-photo'].map(id => [['HEADER', 'X-Demo-Sample', id]]));
      expect(imap.delFlags.mock.calls.map(c => [c[0], c[1]])).toEqual(
        [[[100], ['\\Seen']], [[101], ['\\Seen']], [[102], ['\\Seen']], [[103], ['\\Seen']]]);
      expect(inbox.messages.every(m => !m.seen)).toBe(true);
      expect(out.filter(l => / marked unread$/.test(l))).toHaveLength(4);
      // Each send is followed by its own mark.
      for (let i = 0; i < 3; i++) {
        expect(imap.delFlags.mock.invocationCallOrder[i]).toBeLessThan(transport.sendMail.mock.invocationCallOrder[i + 1]);
      }
    });

    test('falls back to the Message-ID where the header search finds nothing', async () => {
      inbox.headerSearch = false;
      expect(await main(['--email', 'owner@gmail.com', '--gap', '0', '--only', 'ap'], deps())).toBe(0);
      const [imap] = imaps;
      expect(imap.search.mock.calls.map(c => c[0])).toEqual([
        [['HEADER', 'X-Demo-Sample', 'ap-one']], [['HEADER', 'MESSAGE-ID', '<m1@gmail.com>']],
      ]);
      expect(imap.delFlags).toHaveBeenCalledWith([100], ['\\Seen'], expect.any(Function));
    });

    test('an earlier take with the same sample id is left alone', async () => {
      inbox.messages.push({ uid: 7, id: 'ap-one', messageId: '<old@gmail.com>', seen: true });
      expect(await main(['--email', 'owner@gmail.com', '--gap', '0', '--only', 'ap'], deps())).toBe(0);
      expect(imaps[0].delFlags).toHaveBeenCalledTimes(1);
      expect(imaps[0].delFlags).toHaveBeenCalledWith([100], ['\\Seen'], expect.any(Function));
      expect(inbox.messages.find(m => m.uid === 7).seen).toBe(true);
    });

    test('not found after ~10 s of retries: a warning naming the subject, and the run carries on', async () => {
      jest.useFakeTimers();
      inbox.lost = ['ar-one'];
      const run = main(['--email', 'owner@gmail.com', '--gap', '30', '--only', 'ar'], deps());

      await jest.advanceTimersByTimeAsync(0);
      const [imap] = imaps;
      expect(imap.search).toHaveBeenCalledTimes(2);           // header, then Message-ID
      await jest.advanceTimersByTimeAsync(9999);
      expect(err).toEqual([]);
      await jest.advanceTimersByTimeAsync(1);
      const headerSearches = imap.search.mock.calls.filter(c => c[0][0][1] === 'X-Demo-Sample');
      expect(headerSearches).toHaveLength(6);
      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(/ar {8}WARNING: "AR one" was not found in the INBOX within 10s\. .*mark it unread/);

      // The gap runs from the first send, not from the end of the search.
      expect(transport.sendMail).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(20000);
      expect(transport.sendMail).toHaveBeenCalledTimes(2);

      expect(await run).toBe(0);
      expect(imap.delFlags).toHaveBeenCalledTimes(1);
      expect(imap.delFlags).toHaveBeenCalledWith([100], ['\\Seen'], expect.any(Function));
      expect(out[out.length - 1]).toMatch(/; 1 marked unread, 1 not found\.$/);
      expect(imap.end).toHaveBeenCalled();
    });

    test('a search that fails is retried, then warned about with the reason', async () => {
      jest.useFakeTimers();
      inbox.searchError = new Error('NO [UNAVAILABLE] try later');
      const run = main(['--email', 'owner@gmail.com', '--gap', '0', '--only', 'ap'], deps());
      await jest.advanceTimersByTimeAsync(10000);
      expect(await run).toBe(0);
      expect(imaps[0].search).toHaveBeenCalledTimes(6);
      expect(err[0]).toMatch(/"AP one" was not found in the INBOX within 10s \(NO \[UNAVAILABLE\] try later\)/);
    });

    test('--leave-read sends without any IMAP connection', async () => {
      expect(await main(['--email', 'owner@gmail.com', '--gap', '0', '--leave-read'], deps())).toBe(0);
      expect(transport.sendMail).toHaveBeenCalledTimes(4);
      expect(Imap).not.toHaveBeenCalled();
      expect(out.join('\n')).toMatch(/left as the mailbox files them \(--leave-read\)/);
      expect(out[out.length - 1]).toMatch(/^Sent 4 of 4 .* in \d+s\.$/);
    });

    test('mail sent to another address is not marked in this mailbox', async () => {
      expect(await main(['--email', 'owner@gmail.com', '--gap', '0', '--to', 'demo@example.com'], deps())).toBe(0);
      expect(Imap).not.toHaveBeenCalled();
      expect(out.join('\n')).toMatch(/not marked unread: demo@example\.com is not the mailbox owner@gmail\.com/);
    });

    test('an INBOX that cannot be opened stops the run before anything is sent', async () => {
      inbox.connectError = Object.assign(new Error('Invalid credentials (Failure)'), { source: 'authentication' });
      expect(await main(['--email', 'owner@gmail.com', '--gap', '0'], deps())).toBe(1);
      expect(transport.sendMail).not.toHaveBeenCalled();
      expect(err[0]).toMatch(/Could not open the INBOX at imap\.gmail\.com as owner@gmail\.com .*Invalid credentials.*Nothing was sent.*--leave-read/);
      expect(imaps[0].end).toHaveBeenCalled();
      expect(transport.close).toHaveBeenCalled();
    });
  });

  test('--to and --only', async () => {
    expect(await main(['--email', 'owner@gmail.com', '--gap', '0', '--to', 'demo@example.com', '--only', 'ap,ap-photo'], deps())).toBe(0);
    const sent = transport.sendMail.mock.calls.map(c => c[0]);
    expect(sent.map(m => m.headers['X-Demo-Sample'])).toEqual(['ap-one', 'ap-photo']);
    expect(sent.every(m => m.to === 'demo@example.com' && m.from.address === 'owner@gmail.com')).toBe(true);
  });

  test('waits the gap between sends, not before the first', async () => {
    jest.useFakeTimers();
    const run = main(['--email', 'owner@gmail.com', '--gap', '30', '--only', 'ar,ap'], deps());

    await jest.advanceTimersByTimeAsync(0);
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(29999);
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(transport.sendMail).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(29999);
    expect(transport.sendMail).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(transport.sendMail).toHaveBeenCalledTimes(3);

    expect(await run).toBe(0);
    expect(out[out.length - 1]).toMatch(/^Sent 3 of 3 .* in 1m 00s; 3 marked unread\.$/);
  });

  test('--dry-run builds and prints the plan but connects to nothing', async () => {
    expect(await main(['--email', 'owner@gmail.com', '--dry-run'], deps())).toBe(0);
    expect(generator.buildSamples).toHaveBeenCalled();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(Imap).not.toHaveBeenCalled();
    const text = out.join('\n');
    expect(text).toMatch(/via {3}smtp\.gmail\.com:465/);
    expect(text).toMatch(/then {2}each marked unread in INBOX at imap\.gmail\.com:993/);
    expect(text).toMatch(/\+ {4}0s {2}ar {8}AR one/);
    expect(text).toMatch(/\+1m 30s {2}ap-photo {2}AP photo/);
    expect(out[out.length - 1]).toMatch(/Nothing was sent\.$/);
  });

  test('--write writes the samples and sends nothing, without needing an account', async () => {
    const d = deps();
    expect(await main(['--write', 'demo-out'], d)).toBe(0);
    expect(generator.writeSamples).toHaveBeenCalledWith(path.resolve('demo-out'), SAMPLES);
    expect(d.loadApp).not.toHaveBeenCalled();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(Imap).not.toHaveBeenCalled();
    expect(out[0]).toBe(`Wrote 2 files to ${path.resolve('demo-out')}`);
  });

  test('--write --send-too writes and then sends', async () => {
    expect(await main(['--email', 'owner@gmail.com', '--write', 'demo-out', '--send-too', '--gap', '0'], deps())).toBe(0);
    expect(generator.writeSamples).toHaveBeenCalled();
    expect(transport.sendMail).toHaveBeenCalledTimes(4);
  });

  test('refuses an account with no mailbox password, before building anything', async () => {
    expect(await main(['--email', 'owner@gmail.com'], deps({ ...GMAIL, password: null, ready: false }))).toBe(1);
    expect(err[0]).toMatch(/owner@gmail\.com has no mailbox app password saved\. .*Nothing was sent\./);
    expect(generator.buildSamples).not.toHaveBeenCalled();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(Imap).not.toHaveBeenCalled();
  });

  test('refuses an unknown account', async () => {
    expect(await main(['--email', 'stranger@gmail.com'], deps())).toBe(1);
    expect(err[0]).toMatch(/No app account signs in as stranger@gmail\.com/);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  test('a failed sign-in sends nothing', async () => {
    transport.verify.mockRejectedValue(new Error('535 Username and Password not accepted'));
    expect(await main(['--email', 'owner@gmail.com', '--gap', '0'], deps())).toBe(1);
    expect(err[0]).toMatch(/Could not sign in to smtp\.gmail\.com as owner@gmail\.com: 535 .*Nothing was sent\./);
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(Imap).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalled();
  });

  test('a failed send stops the run, says how far it got and closes both connections', async () => {
    transport.sendMail
      .mockImplementationOnce(deliver)
      .mockRejectedValueOnce(new Error('552 message too large'));
    expect(await main(['--email', 'owner@gmail.com', '--gap', '0'], deps())).toBe(1);
    expect(transport.sendMail).toHaveBeenCalledTimes(2);
    expect(err.join('\n')).toMatch(/FAILED {2}AP one: 552 message too large/);
    expect(err.join('\n')).toMatch(/Stopped: sent 1 of 4 .*; 1 marked unread\./);
    expect(transport.close).toHaveBeenCalled();
    expect(imaps[0].end).toHaveBeenCalled();
  });
});
