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
