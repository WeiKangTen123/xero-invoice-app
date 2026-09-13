const fs   = require('fs');
const path = require('path');

// The runner was built for claim imports and is now shared. These pin the two
// things that make it shareable — any job type, any payload keys — and that
// nothing already on disk stops working.
describe('jobs — a generic runner', () => {
  let jobs, userId;
  const created = [];
  const bufs = n => Array.from({ length: n }, (_, i) => ({ name: `f${i}.pdf`, buffer: Buffer.from(`pdf-${i}`) }));

  beforeEach(() => {
    jest.resetModules();
    jobs = require('./index');
    userId = `jobs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    created.push(userId);
  });
  afterEach(() => { jobs._worker._reset(); });
  afterAll(() => {
    for (const id of created) {
      try { fs.rmSync(path.join(__dirname, '../data/users', id), { recursive: true, force: true }); } catch {}
    }
  });

  test('a job of a new type with its own payload keys round-trips through disk', () => {
    const { job, error } = jobs.enqueue(userId, { type: 'bill-import', label: 'March bills', payload: { pdfs: bufs(3) } });
    expect(error).toBeUndefined();
    expect(job.type).toBe('bill-import');
    expect(job.payload.pdfs).toHaveLength(3);

    const back = jobs.readPayload(userId, jobs.get(userId, job.id));
    expect(Object.keys(back)).toEqual(['pdfs']);
    expect(back.pdfs.map(f => f.buffer.toString())).toEqual(['pdf-0', 'pdf-1', 'pdf-2']);
  });

  test('the old { archives, forms } call still means a claim import', () => {
    const { job } = jobs.enqueue(userId, { archives: bufs(1), forms: [] });
    expect(job.type).toBe('claim-import');
    expect(job.label).toBe('Expense claim');
    const back = jobs.readPayload(userId, job);
    expect(back.archives).toHaveLength(1);
    expect(back.forms).toEqual([]);
  });

  test('the worker runs whatever handler is registered for the type', async () => {
    const seen = [];
    jobs.registerJobType('echo', {
      defaultDeps: () => ({ tag: 'default' }),
      run({ job, payload, deps }) {
        seen.push({ id: job.id, keys: Object.keys(payload), tag: deps.tag });
        deps.onSettle({ id: job.id, stage: 'done', error: null, result: { ok: true }, receiptsTotal: 0, receiptsRead: 0, rowsTotal: 0 });
      },
    });
    const { job } = jobs.enqueue(userId, { type: 'echo', label: 'x', payload: { things: bufs(2) } });
    jobs.startWorker(userId);
    await new Promise(r => setTimeout(r, 50));
    expect(seen).toEqual([{ id: job.id, keys: ['things'], tag: 'default' }]);
    expect(jobs.get(userId, job.id).stage).toBe('done');
  });

  test('a job whose type has no handler is set aside with a reason, not retried into poison', async () => {
    const { job } = jobs.enqueue(userId, { type: 'nobody-registered-this', label: 'x', payload: { a: [] } });
    jobs.startWorker(userId);
    await new Promise(r => setTimeout(r, 50));
    const after = jobs.get(userId, job.id);
    expect(after.stage).toBe('failed');
    expect(after.error).toMatch(/No handler is registered for job type "nobody-registered-this"/);
  });

  test('a job written before types existed is treated as a claim import', async () => {
    const ran = [];
    jobs.registerJobType('claim-import', { run: ({ job, payload, deps }) => { ran.push([job.id, Object.keys(payload).sort()]); deps.onSettle({ id: job.id, stage: 'done' }); } });
    const { job } = jobs.enqueue(userId, { archives: bufs(1), forms: [] });
    // Simulate a legacy file: strip the type field on disk.
    const file = path.join(__dirname, '../data/users', userId, 'claim-queue', `${job.id}.que`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')); delete raw.type; fs.writeFileSync(file, JSON.stringify(raw));
    expect(jobs.get(userId, job.id).type).toBeUndefined();

    jobs.startWorker(userId);
    await new Promise(r => setTimeout(r, 50));
    expect(ran).toEqual([[job.id, ['archives', 'forms']]]);
  });

  test('registering a handler without a run function is refused', () => {
    expect(() => jobs.registerJobType('bad', {})).toThrow(/needs a run function/);
  });
});
