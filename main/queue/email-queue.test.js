// The file-based inbound queue. Two things it must never do: throw on a mail
// whose Date header is unreadable (the mail was lost), and delete a job that
// has failed its last attempt (the mail was lost silently and the queue's
// "dead" count was always zero).
const fs   = require('fs');
const path = require('path');
const q    = require('./email-queue');

const USER = `eq-${Date.now()}`;
afterAll(() => { try { fs.rmSync(path.join(__dirname, '../data/users', USER), { recursive: true, force: true }); } catch {} });

const parsed = over => ({ from: { text: 'a@b.c' }, subject: 's', text: 'body', attachments: [], ...over });

test('an email whose Date header is unreadable still queues', () => {
  const job = q.enqueue(USER, parsed({ date: new Date('garbage') }));
  expect(job.email.date).toBeNull();
  expect(q.getPending(USER).some(j => j.id === job.id)).toBe(true);
});

test('a job that fails its last attempt is kept as dead, not deleted', () => {
  const job = q.enqueue(USER, parsed({ date: new Date('2026-09-10T00:00:00Z') }));
  const max = q.MAX_ATTEMPTS ?? 3;
  for (let i = 0; i < max; i++) { q.markProcessing(USER, job.id); q.markFailed(USER, job.id, 'boom'); }
  const stats = q.getStats(USER);
  expect(stats.dead).toBe(1);
  const dead = stats.jobs.find(j => j.id === job.id);
  expect(dead.status).toBe('dead');
  expect(q.getPending(USER).some(j => j.id === job.id)).toBe(false);   // never retried again
});

const logger = require('../utils/logger');
const dirOf  = user => path.join(require('../utils/paths').usersDir(), user, 'email-queue');
const readJob = (user, id) => JSON.parse(fs.readFileSync(path.join(dirOf(user), `${id}.que`), 'utf8'));

// A mail that crashes the process mid-run used to be rerun on every boot with
// its attempts stuck at 1 (only pending -> processing counted), until pm2 gave
// up restarting and the app was down for everyone.
describe('every claim of a job is an attempt', () => {
  test('claims that never report back are counted, and the job goes dead after the limit', () => {
    const job = q.enqueue(USER, parsed());
    for (let i = 1; i <= q.MAX_ATTEMPTS; i++) {
      const claimed = q.markProcessing(USER, job.id);          // ...and the process dies here
      expect(claimed.attempts).toBe(i);
      expect(readJob(USER, job.id)).toMatchObject({ status: 'processing', attempts: i });   // on disk before the work
    }
    expect(q.markProcessing(USER, job.id)).toBeNull();           // the next boot does not run it
    const dead = readJob(USER, job.id);
    expect(dead.status).toBe('dead');
    expect(dead.lastError).toMatch(/never finished/);
    expect(q.getPending(USER).some(j => j.id === job.id)).toBe(false);
    expect(q.getStats(USER).jobs.find(j => j.id === job.id).status).toBe('dead');
  });

  test('a claim that cannot be written throws, so the job is not run uncounted', () => {
    const job = q.enqueue(USER, parsed());
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EROFS'); });
    try { expect(() => q.markProcessing(USER, job.id)).toThrow('EROFS'); } finally { spy.mockRestore(); }
    expect(readJob(USER, job.id)).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

describe('a failed job waits before its retry', () => {
  test('one minute after the first failure, five after the second, then dead', () => {
    const job = q.enqueue(USER, parsed());
    const t0 = Date.now();
    q.markProcessing(USER, job.id); q.markFailed(USER, job.id, 'rate limited');
    let j = readJob(USER, job.id);
    expect(j.status).toBe('pending');
    expect(Date.parse(j.nextAttemptAt) - t0).toBeGreaterThanOrEqual(60 * 1000);
    expect(Date.parse(j.nextAttemptAt) - t0).toBeLessThan(65 * 1000);
    expect(q.isDue(j, t0)).toBe(false);
    expect(q.isDue(j, t0 + 61 * 1000)).toBe(true);

    q.markProcessing(USER, job.id);
    expect(readJob(USER, job.id).nextAttemptAt).toBeUndefined();   // a claim clears the wait
    q.markFailed(USER, job.id, 'rate limited');
    j = readJob(USER, job.id);
    expect(Date.parse(j.nextAttemptAt) - Date.now()).toBeGreaterThan(4 * 60 * 1000);

    q.markProcessing(USER, job.id); q.markFailed(USER, job.id, 'rate limited');
    expect(readJob(USER, job.id)).toMatchObject({ status: 'dead', lastError: 'rate limited' });
  });

  test('an unreadable retry time does not park a job for ever', () => {
    expect(q.isDue({ nextAttemptAt: 'garbage' })).toBe(true);
    expect(q.isDue({})).toBe(true);
  });
});

describe('attachment size cap', () => {
  test('a PDF over the cap is left out with a logged reason; the rest of the mail queues', () => {
    const warn  = jest.spyOn(logger, 'warn');
    const big   = Buffer.alloc(q.MAX_ATTACHMENT_BYTES + 1, 0x41);
    const small = Buffer.from('%PDF-1.4 small');
    const job = q.enqueue(USER, parsed({ attachments: [
      { filename: 'brochure.pdf', contentType: 'application/pdf', content: big, size: big.length },
      { filename: 'bill.pdf',     contentType: 'application/pdf', content: small, size: small.length },
    ] }));
    expect(job.email.attachments.map(a => a.filename)).toEqual(['bill.pdf']);
    expect(job.email.skippedAttachments).toEqual([
      { filename: 'brochure.pdf', bytes: big.length, reason: expect.stringMatching(/15 MB limit/) },
    ]);
    expect(fs.readdirSync(dirOf(USER)).filter(f => f.startsWith(`${job.id}-`))).toEqual([`${job.id}-1.pdf`]);
    expect(q.reconstructEmail(USER, job).attachments.map(a => a.filename)).toEqual(['bill.pdf']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/too large/), expect.objectContaining({ jobId: job.id }));
    warn.mockRestore();
  });

  test('exactly at the cap is accepted', () => {
    const edge = Buffer.alloc(q.MAX_ATTACHMENT_BYTES, 0x41);
    const job  = q.enqueue(USER, parsed({ attachments: [{ filename: 'edge.pdf', contentType: 'application/pdf', content: edge }] }));
    expect(job.email.attachments).toHaveLength(1);
    expect(job.email.skippedAttachments).toBeUndefined();
  });
});

describe('queue files are written whole and never lost silently', () => {
  test('a write that dies midway leaves the previous job file intact and no temp file', () => {
    const job  = q.enqueue(USER, parsed());
    const real = fs.writeFileSync;
    const spy  = jest.spyOn(fs, 'writeFileSync').mockImplementation((file, data, ...rest) => {
      real(file, String(data).slice(0, 15), ...rest);           // half a file reaches the disk...
      throw new Error('ENOSPC');                                  // ...and the process dies
    });
    try { q.markFailed(USER, job.id, 'boom'); } finally { spy.mockRestore(); }
    expect(readJob(USER, job.id)).toMatchObject({ id: job.id, status: 'pending', attempts: 0 });
    expect(fs.readdirSync(dirOf(USER)).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  test('writes go to a temporary file renamed over the job', () => {
    const job = q.enqueue(USER, parsed());
    const spy = jest.spyOn(fs, 'renameSync');
    q.markProcessing(USER, job.id);
    const file = path.join(dirOf(USER), `${job.id}.que`);
    expect(spy).toHaveBeenCalledWith(`${file}.tmp`, file);
    spy.mockRestore();
  });

  test('a corrupt job file is set aside, kept and logged, not skipped in silence', () => {
    const error = jest.spyOn(logger, 'error');
    const dir   = dirOf(USER);
    fs.mkdirSync(dir, { recursive: true });
    const cut = '{ "id": "17000cut", "status": "pend';
    fs.writeFileSync(path.join(dir, '17000cut.que'), cut);

    expect(q.getPending(USER).some(j => j.id === '17000cut')).toBe(false);
    const aside = fs.readdirSync(dir).filter(f => f.startsWith('17000cut.que.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), 'utf8')).toBe(cut);   // kept as it was
    expect(fs.existsSync(path.join(dir, '17000cut.que'))).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/set aside/), expect.objectContaining({ file: path.join(dir, aside[0]) }));

    // Logged once: it is no longer a .que file, so later reads do not see it.
    error.mockClear();
    q.getStats(USER);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
