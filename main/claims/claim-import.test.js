// sharp is mocked so an oversized photo can be shrunk on any machine (this
// checkout's build is for a Mac). Receipts under 3MB never reach it, so every
// other test here is unaffected. Each toBuffer() returns the next queued size.
jest.mock('sharp', () => {
  const sharp = jest.fn(() => {
    const chain = {};
    ['rotate', 'resize', 'flatten', 'jpeg'].forEach(m => { chain[m] = jest.fn(() => chain); });
    chain.toBuffer = jest.fn(async () => Buffer.alloc(sharp.outputs.length ? sharp.outputs.shift() : 1000));
    return chain;
  });
  sharp.concurrency = jest.fn();
  sharp.outputs = [];
  return sharp;
});

const zlib = require('zlib');
const ExcelJS = require('exceljs');
const claimImport = require('./claim-import');

// Everything slow or stateful is injected, so the whole job runs in
// milliseconds with no model, no database and no disk.
function makeZip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const crc = zlib.crc32 ? zlib.crc32(body) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(body.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

async function makeForm(rows) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('C');
  ws.getCell('A1').value = 'BLACKSTAR';
  const h = ws.getRow(7);
  h.getCell(1).value = 'No'; h.getCell(2).value = 'DATE'; h.getCell(3).value = 'DESCRIPTION OF EXPENSES';
  h.getCell(8).value = 'Currency'; h.getCell(9).value = 'Amount'; h.getCell(10).value = 'Exchange Rate';
  h.getCell(13).value = 'LOCAL TRAVEL COST\n(SGD)';
  rows.forEach((r, i) => {
    const x = ws.getRow(9 + i);
    x.getCell(1).value = r.no; x.getCell(2).value = new Date(r.date + 'T00:00:00Z');
    x.getCell(3).value = r.description; x.getCell(8).value = 'SGD'; x.getCell(9).value = r.amount;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const settle = async job => { for (let i = 0; i < 200 && !['done','failed','cancelled'].includes(job.stage); i++) await new Promise(r => setTimeout(r, 5)); return job; };

function deps({ reads = {}, onCreate } = {}) {
  return {
    // waitMs 0: the four-second throttle is for the real model's quota, not tests.
    waitMs: 0,
    // The job now reads in batches: one call for several images, returning an
    // array the same length as the input.
    parseReceipts: jest.fn(async (userId, images) => images.map(() => null)),
    storeReceipt: jest.fn(async () => 'stored.jpg'),
    createRecord: jest.fn(async ({ row }) => { onCreate && onCreate(row); return { id: 'rec-' + row.no }; }),
    suggest: jest.fn(async () => []),
  };
}

describe('claims/claim-import', () => {
  beforeEach(() => claimImport._reset());

  test('runs every stage and reports a reconciliation', async () => {
    const zip = makeZip([{ name: 'c/a.png', data: JPEG }, { name: 'c/b.png', data: JPEG }]);
    const form = await makeForm([
      { no: 1, date: '2026-02-23', description: 'Grab to meeting', amount: 15.8 },
      { no: 2, date: '2026-02-26', description: 'Taxi home', amount: 56.7 },
    ]);
    const seen = [];
    const d = {
      ...deps({ onCreate: r => seen.push(r.no) }),
      parseReceipts: jest.fn(async () => ([
        { merchant: 'Grab', date: '2026-02-23', total: 15.8, currency: 'SGD' },
        { merchant: 'CDG',  date: '2026-02-26', total: 56.7, currency: 'SGD' },
      ])),
    };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [{ name: 'f.xlsx', buffer: form }] }, d);
    await settle(job);

    expect(job.stage).toBe('done');
    expect(job.result.summary).toMatchObject({ total: 2, matched: 2, verified: 2, discrepancies: 0 });
    expect(seen.sort()).toEqual(['1', '2']);
  });

  test('an amount mismatch reaches the reconciliation, with the numbers', async () => {
    const zip = makeZip([{ name: 'c/a.png', data: JPEG }]);
    const form = await makeForm([{ no: 1, date: '2026-02-26', description: 'Home to Apple', amount: 30.6 }]);
    const d = { ...deps(), parseReceipts: jest.fn(async () => ([{ merchant: 'CDG', date: '2026-02-26', total: 36.0 }])) };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [{ name: 'f.xlsx', buffer: form }] }, d);
    await settle(job);

    expect(job.result.summary.discrepancies).toBe(1);
    expect(job.result.discrepancies[0]).toMatchObject({ rowNo: '1', claimed: 30.6, onReceipt: 36, difference: 5.4 });
  });

  test('a claim line with no receipt still becomes a record for somebody to resolve', async () => {
    const form = await makeForm([{ no: 1, date: '2026-02-23', description: 'Taxi to airport', amount: 500 }]);
    const seen = [];
    const job = claimImport.startImport(
      { userId: 'u1', archives: [], forms: [{ name: 'f.xlsx', buffer: form }] },
      deps({ onCreate: r => seen.push(r.no) }));
    await settle(job);

    expect(job.result.summary.missingReceipts).toBe(1);
    expect(job.result.missingReceipts[0].description).toBe('Taxi to airport');
    expect(seen).toEqual(['1']);   // created, not dropped
  });

  test('one unreadable receipt does not stop the rest', async () => {
    const zip = makeZip([{ name: 'c/a.png', data: JPEG }, { name: 'c/b.png', data: JPEG }]);
    const form = await makeForm([{ no: 1, date: '2026-02-23', description: 'Grab', amount: 15.8 }]);
    const d = { ...deps(),
      // one unreadable, one fine — the batch reader returns null in place.
      parseReceipts: jest.fn(async () => ([null, { merchant: 'Grab', date: '2026-02-23', total: 15.8 }])) };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [{ name: 'f.xlsx', buffer: form }] }, d);
    await settle(job);

    expect(job.stage).toBe('done');
    expect(job.result.summary.unreadable).toBe(1);
    expect(job.result.summary.verified).toBe(1);
  });

  test('progress counts up as receipts are read', async () => {
    const zip = makeZip([{ name: 'c/a.png', data: JPEG }, { name: 'c/b.png', data: JPEG }, { name: 'c/c.png', data: JPEG }]);
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, deps());
    await settle(job);
    expect(job.receiptsTotal).toBe(3);
    expect(job.receiptsRead).toBe(3);
  });

  test('a job belongs to the user who started it', async () => {
    const job = claimImport.startImport({ userId: 'u1', archives: [], forms: [] }, deps());
    await settle(job);
    expect(claimImport.getJob(job.id, 'u1')).toBeTruthy();
    expect(claimImport.getJob(job.id, 'u2')).toBeNull();
    expect(claimImport.listJobs('u2')).toEqual([]);
  });

  test('an absurdly large archive is refused rather than run up a bill', async () => {
    const many = Array.from({ length: claimImport.MAX_RECEIPTS + 1 }, (_, i) => ({ name: `c/${i}.png`, data: JPEG }));
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: makeZip(many) }], forms: [] }, deps());
    await settle(job);
    expect(job.stage).toBe('failed');
    expect(job.error).toMatch(/more than one claim should hold/);
  });

  test('a corrupt spreadsheet is reported without stopping the receipts', async () => {
    const zip = makeZip([{ name: 'c/a.png', data: JPEG }]);
    const d = { ...deps(), parseReceipts: jest.fn(async () => ([{ merchant: 'Grab', date: '2026-02-23', total: 15.8 }])) };
    const job = claimImport.startImport(
      { userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [{ name: 'bad.xlsx', buffer: Buffer.from('nope') }] }, d);
    await settle(job);
    expect(job.stage).toBe('done');
    expect(job.result.formErrors[0]).toMatch(/not a readable spreadsheet/);
    expect(job.result.summary.extraReceipts).toBe(1);   // a receipt with no claim line
  });

  test('a job can be cancelled mid-read', async () => {
    const zip = makeZip(Array.from({ length: 6 }, (_, i) => ({ name: `c/${i}.png`, data: JPEG })));
    const d = { ...deps(), waitMs: 20, batch: 1, parseReceipts: jest.fn(async (u, imgs) => imgs.map(() => ({ merchant: 'x', date: '2026-01-01', total: 1 }))) };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, d);
    await new Promise(r => setTimeout(r, 30));
    claimImport.cancel(job.id, 'u1');
    await settle(job);
    expect(job.stage).toBe('cancelled');
    expect(job.receiptsRead).toBeLessThan(6);
  });
});

// ── A claim with no spreadsheet ─────────────────────────────────────────────
// The commonest case, and the one that produced nothing: a zip of receipts with
// no form matched nothing, so no records were created and the import reported
// success having imported zero claims.
describe('claims/claim-import — receipts without a claim form', () => {
  beforeEach(() => claimImport._reset());

  test('a zip of receipts and no form still becomes one claim each', async () => {
    const zip = makeZip([
      { name: 'c/a.png', data: JPEG }, { name: 'c/b.png', data: JPEG }, { name: 'c/c.png', data: JPEG },
    ]);
    const seen = [];
    const d = {
      waitMs: 0,
      storeReceipt: jest.fn(async () => 'stored.jpg'),
      createRecord: jest.fn(async ({ row, receipt }) => { seen.push({ amount: row.amount, merchant: receipt && receipt.merchant }); return { id: 'r' + seen.length }; }),
      suggest: jest.fn(async () => []),
      parseReceipts: jest.fn(async () => ([
        { merchant: 'Grab',  date: '2026-02-23', total: 15.8, currency: 'SGD' },
        { merchant: 'Gojek', date: '2026-03-10', total: 25,   currency: 'SGD' },
        { merchant: 'CDG',   date: '2026-04-17', total: 21.8, currency: 'SGD' },
      ])),
    };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, d);
    await settle(job);

    expect(job.stage).toBe('done');
    expect(seen).toHaveLength(3);                                   // not zero
    expect(seen.map(s => s.amount).sort((a, b) => a - b)).toEqual([15.8, 21.8, 25]);
    expect(seen.map(s => s.merchant).sort()).toEqual(['CDG', 'Gojek', 'Grab']);
  });

  test('the figures come from what the model read, not left blank', async () => {
    const zip = makeZip([{ name: 'c/a.png', data: JPEG }]);
    let captured = null;
    const d = {
      waitMs: 0,
      storeReceipt: jest.fn(async () => 'stored.jpg'),
      createRecord: jest.fn(async (args) => { captured = args; return { id: 'r1' }; }),
      suggest: jest.fn(async () => []),
      parseReceipts: jest.fn(async () => ([{ merchant: 'Isetan', date: '2015-05-01', total: 6.6, currency: 'SGD' }])),
    };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, d);
    await settle(job);

    expect(captured.row).toMatchObject({ date: '2015-05-01', amount: 6.6, currency: 'SGD', description: 'Isetan' });
    expect(captured.receipt.buffer).toBeInstanceOf(Buffer);   // the image is stored with it
  });

  test('an unreadable receipt with no form still becomes a claim to type by hand', async () => {
    const zip = makeZip([{ name: 'c/blurry.png', data: JPEG }]);
    let captured = null;
    const d = {
      waitMs: 0,
      storeReceipt: jest.fn(async () => 'stored.jpg'),
      createRecord: jest.fn(async (args) => { captured = args; return { id: 'r1' }; }),
      suggest: jest.fn(async () => []),
      parseReceipts: jest.fn(async (u, imgs) => imgs.map(() => null)),
    };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, d);
    await settle(job);

    expect(captured).not.toBeNull();
    // Falls back to the filename so the row is identifiable in the list.
    expect(captured.row.description).toBe('blurry.png');
  });
});

// ── Batching ────────────────────────────────────────────────────────────────
// Nine receipts one at a time is nine round trips, each throttled for the
// per-minute quota. Batching is what makes a large claim finish in a minute.
describe('claims/claim-import — reads in batches', () => {
  beforeEach(() => claimImport._reset());

  test('nine receipts take three calls, not nine', async () => {
    const zip = makeZip(Array.from({ length: 9 }, (_, i) => ({ name: `c/${i}.png`, data: JPEG })));
    const parseReceipts = jest.fn(async (u, imgs) => imgs.map((_, i) => ({ merchant: 'M' + i, date: '2026-02-23', total: i + 1 })));
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] },
      { waitMs: 0, batch: 4, parseReceipts, storeReceipt: async () => 'f.jpg', createRecord: async () => ({ id: 'r' }), suggest: async () => [] });
    await settle(job);

    expect(parseReceipts).toHaveBeenCalledTimes(3);      // 4 + 4 + 1
    expect(parseReceipts.mock.calls[0][1]).toHaveLength(4);
    expect(parseReceipts.mock.calls[2][1]).toHaveLength(1);
    expect(job.receiptsRead).toBe(9);
  });

  test('a whole batch failing loses none of its receipts', async () => {
    const zip = makeZip(Array.from({ length: 4 }, (_, i) => ({ name: `c/${i}.png`, data: JPEG })));
    const created = [];
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] },
      { waitMs: 0, batch: 4,
        parseReceipts: jest.fn(async () => { throw new Error('quota'); }),
        storeReceipt: async () => 'f.jpg',
        createRecord: async ({ row }) => { created.push(row.description); return { id: 'r' + created.length }; },
        suggest: async () => [] });
    await settle(job);

    expect(job.stage).toBe('done');
    expect(job.result.summary.unreadable).toBe(4);
    expect(created).toHaveLength(4);                     // still four claims to type by hand
  });

  test('progress advances by batch, and lands exactly on the total', async () => {
    const zip = makeZip(Array.from({ length: 7 }, (_, i) => ({ name: `c/${i}.png`, data: JPEG })));
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] },
      { waitMs: 0, batch: 3,
        parseReceipts: jest.fn(async (u, imgs) => imgs.map(() => ({ merchant: 'x', date: '2026-01-01', total: 1 }))),
        storeReceipt: async () => 'f.jpg', createRecord: async () => ({ id: 'r' }), suggest: async () => [] });
    await settle(job);
    // 3 + 3 + 1: the last partial batch must not report 9 of 7.
    expect(job.receiptsRead).toBe(7);
    expect(job.receiptsTotal).toBe(7);
  });
});

describe('pacing', () => {
  test('reads are not paced here — gemini-client paces every caller at 15 a minute', () => {
    // Two throttles on one call chain hide each other; the client's sliding
    // window is the one that knows the quota, so the import adds none.
    expect(claimImport.READ_INTERVAL_MS).toBe(0);
  });
});

// ── Receipts too large for Xero ─────────────────────────────────────────────
// An archive entry may be up to 15MB, but Xero attaches at most 3MB and
// receipt-store refuses anything larger. The photo used to be lost with only a
// log line to say so.
describe('claims/claim-import — receipts over the 3MB attachment limit', () => {
  beforeEach(() => { claimImport._reset(); require('sharp').outputs.length = 0; });
  const MB = 1024 * 1024;

  test('an oversized photo is shrunk before it is read and before it is stored', async () => {
    require('sharp').outputs.push(600 * 1024, 600 * 1024);   // once to read, once to store
    const zip = makeZip([{ name: 'c/IMG_0001.png', data: Buffer.alloc(Math.round(3.5 * MB)) }]);
    let captured = null;
    const parseReceipts = jest.fn(async (u, imgs) => imgs.map(() => ({ merchant: 'Grab', date: '2026-02-23', total: 15.8 })));
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] },
      { ...deps(), parseReceipts, createRecord: jest.fn(async args => { captured = args; return { id: 'r1' }; }) });
    await settle(job);

    expect(job.stage).toBe('done');
    // The model was sent the small copy, as a JPEG.
    expect(parseReceipts.mock.calls[0][1][0].buffer.length).toBe(600 * 1024);
    expect(parseReceipts.mock.calls[0][1][0].mime).toBe('image/jpeg');
    // And the record is stored with it, under the limit.
    expect(captured.receipt.buffer.length).toBeLessThanOrEqual(3 * MB);
    expect(captured.receipt.mime).toBe('image/jpeg');
    expect(job.result.summary.shrunk).toBe(1);
    expect(job.result.notStored).toEqual([]);
  });

  test('a file that cannot be brought under 3MB still becomes a claim, and the reason reaches the row', async () => {
    // A PDF cannot be re-encoded here. The claim is created anyway; only the
    // attachment is missing, and the store error claim-record writes onto the
    // row says why in words a person can act on.
    const zip = makeZip([{ name: 'c/hotel.pdf', data: Buffer.alloc(Math.round(3.5 * MB)) }]);
    let storeError = null;
    const createRecord = jest.fn(async ({ receipt, store }) => {
      try { await store('u1', 'id1', receipt.buffer, receipt.mime); } catch (err) { storeError = err.message; }
      return { id: 'r1' };
    });
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] },
      { ...deps(), createRecord, parseReceipts: jest.fn(async (u, imgs) => imgs.map(() => ({ merchant: 'Hotel', date: '2026-02-23', total: 420 }))) });
    await settle(job);

    expect(job.stage).toBe('done');
    expect(createRecord).toHaveBeenCalledTimes(1);
    expect(createRecord.mock.calls[0][0].row).toMatchObject({ amount: 420 });
    expect(storeError).toMatch(/PDF is 3\.5MB, over Xero's 3\.0MB attachment limit/);
    expect(job.result.summary.notStored).toBe(1);
    expect(job.result.notStored[0]).toMatchObject({ file: 'c/hotel.pdf', reason: expect.stringMatching(/3\.0MB/) });
  });

  test('a receipt within the limit is stored by the ordinary store', async () => {
    const zip = makeZip([{ name: 'c/a.jpg', data: JPEG }]);
    const d = deps();
    let usedStore = null;
    d.createRecord = jest.fn(async ({ store }) => { usedStore = store; return { id: 'r1' }; });
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, d);
    await settle(job);
    expect(usedStore).toBe(d.storeReceipt);
  });
});

// ── Holding an archive in memory ────────────────────────────────────────────
describe('claims/claim-import — archive size and memory', () => {
  beforeEach(() => claimImport._reset());

  test('an archive that unpacks past the size cap is refused whole, not half imported', async () => {
    const zip = makeZip([{ name: 'c/a.jpg', data: JPEG }, { name: 'c/b.jpg', data: JPEG }]);
    const d = { ...deps(), maxArchiveBytes: JPEG.length + 1 };   // room for one entry, not two
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, d);
    await settle(job);

    expect(job.stage).toBe('failed');
    expect(job.error).toMatch(/more than one claim should hold/);
    expect(d.parseReceipts).not.toHaveBeenCalled();
    expect(d.createRecord).not.toHaveBeenCalled();
  });

  test('receipts are extracted a batch at a time, not all up front', async () => {
    // Each extraction passes through fitReceipt, so its order against the
    // model calls shows when bytes are pulled: one batch, read, the next.
    const events = [];
    const zip = makeZip(Array.from({ length: 4 }, (_, i) => ({ name: `c/${i}.jpg`, data: Buffer.from([0xff, 0xd8, i]) })));
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, {
      ...deps(), batch: 2,
      fitReceipt: async (buffer, mime) => { events.push(`load ${buffer[2]}`); return { buffer, mime, shrunk: false, reason: null }; },
      parseReceipts: jest.fn(async (u, imgs) => { events.push(`read ${imgs.length}`); return imgs.map(() => null); }),
    });
    await settle(job);

    expect(job.stage).toBe('done');
    expect(events.slice(0, 6)).toEqual(['load 0', 'load 1', 'read 2', 'load 2', 'load 3', 'read 2']);
  });
});

// ── What a person should look at again ──────────────────────────────────────
// The matcher's `weak` flag and a suggested category were worked out and then
// thrown away, so a receipt paired on a near date alone looked as settled as
// one that agreed on everything.
describe('claims/claim-import — review reasons', () => {
  beforeEach(() => claimImport._reset());

  async function run({ formRows, reads, suggestions = [] }) {
    const zip = makeZip(reads.map((_, i) => ({ name: `c/${i}.png`, data: Buffer.from([0xff, 0xd8, i]) })));
    const form = await makeForm(formRows);
    const createRecord = jest.fn(async ({ row, receipt }) => ({ id: `rec-${row.no || (receipt && receipt.file)}` }));
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [{ name: 'f.xlsx', buffer: form }] },
      { ...deps(), createRecord, parseReceipts: jest.fn(async () => reads), suggest: jest.fn(async () => suggestions) });
    await settle(job);
    return { job, createRecord };
  }

  test('a receipt paired on a near date and the amount is flagged weak, with the evidence named', async () => {
    const { job, createRecord } = await run({
      formRows: [{ no: 1, date: '2026-02-23', description: 'Taxi home', amount: 15.8 }],
      reads: [{ merchant: 'CDG', date: '2026-02-24', total: 15.8 }],
    });
    const args = createRecord.mock.calls[0][0];
    expect(args.reviewReason).toMatch(/claim line 1 on a day apart and same amount only/);
    expect(job.result.summary.needsReview).toBe(1);
    expect(job.result.needsReview[0]).toMatchObject({ id: 'rec-1', rowNo: '1', file: 'c/0.png' });
  });

  test('a receipt that agrees on date and amount needs no second look', async () => {
    const { job, createRecord } = await run({
      formRows: [{ no: 1, date: '2026-02-23', description: 'Taxi home', amount: 15.8 }],
      reads: [{ merchant: 'CDG', date: '2026-02-23', total: 15.8 }],
    });
    expect(createRecord.mock.calls[0][0].reviewReason).toBeNull();
    expect(job.result.needsReview).toEqual([]);
  });

  test('a date a day apart is not, on its own, a match', async () => {
    // MIN_SCORE used to equal the near-date score, so any receipt from the day
    // before was pinned to the claim line.
    const { job } = await run({
      formRows: [{ no: 1, date: '2026-02-23', description: 'Taxi home', amount: 15.8 }],
      reads: [{ merchant: 'Cold Storage', date: '2026-02-24', total: 99.9 }],
    });
    expect(job.result.summary.matched).toBe(0);
    expect(job.result.missingReceipts).toHaveLength(1);
    expect(job.result.extraReceipts).toHaveLength(1);
  });

  test('a category the model suggested is passed on to be confirmed', async () => {
    const { job, createRecord } = await run({
      formRows: [{ no: 1, date: '2026-02-23', description: 'Taxi home', amount: 15.8 }],
      reads: [{ merchant: 'CDG', date: '2026-02-23', total: 15.8 }],
      suggestions: [{ rowNo: '1', category: 'LOCAL TRAVEL COST (SGD)' }],
    });
    const args = createRecord.mock.calls[0][0];
    expect(args.categorySuggested).toBe(true);
    expect(args.reviewReason).toMatch(/"LOCAL TRAVEL COST \(SGD\)" was suggested, not chosen by the claimant/);
    expect(job.result.needsReview).toHaveLength(1);
  });
});
