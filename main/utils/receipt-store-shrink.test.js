// sharp is a native library, and this checkout's build is for a Mac. Mocked
// here so the shrink logic can be tested on any machine: what is under test is
// which steps are tried and what comes back, not libvips itself.
jest.mock('sharp', () => {
  const sharp = jest.fn(() => {
    const chain = {};
    ['rotate', 'resize', 'flatten', 'jpeg'].forEach(m => { chain[m] = jest.fn(() => chain); });
    chain.toBuffer = jest.fn(async () => {
      const next = sharp.outputs.length ? sharp.outputs.shift() : 1000;
      if (next instanceof Error) throw next;
      return Buffer.alloc(next);
    });
    sharp.chains.push(chain);
    return chain;
  });
  sharp.concurrency = jest.fn();
  sharp.chains = [];
  sharp.outputs = [];
  return sharp;
});

const sharp = require('sharp');
const { fitToLimit, MAX_BYTES, SHRINK_STEPS } = require('./receipt-store');

const MB = 1024 * 1024;

beforeEach(() => {
  sharp.mockClear();
  sharp.chains.length = 0;
  sharp.outputs.length = 0;
});

describe('utils/receipt-store — fitting a receipt under Xero\'s 3MB limit', () => {
  test('a receipt already under the limit is returned untouched, without the image library', async () => {
    const small = Buffer.alloc(200 * 1024);
    const r = await fitToLimit(small, 'image/jpeg');
    expect(r).toEqual({ buffer: small, mime: 'image/jpeg', shrunk: false, reason: null });
    expect(sharp).not.toHaveBeenCalled();
  });

  test('an oversized photo is re-encoded to fit, the way a zip import needs', async () => {
    // A 15MB camera original was refused by save() and the receipt was lost.
    sharp.outputs.push(900 * 1024);
    const r = await fitToLimit(Buffer.alloc(9 * MB), 'image/jpeg');
    expect(r.shrunk).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.mime).toBe('image/jpeg');
    expect(r.buffer.length).toBeLessThanOrEqual(MAX_BYTES);
    const chain = sharp.chains[0];
    expect(chain.rotate).toHaveBeenCalled();   // phone EXIF orientation is applied, not lost
    expect(chain.resize).toHaveBeenCalledWith(expect.objectContaining({ fit: 'inside', withoutEnlargement: true }));
  });

  test('a PNG comes back as a JPEG, flattened onto white', async () => {
    // JPEG has no transparency: without the flatten, a transparent screenshot
    // turns black and so does its text.
    const r = await fitToLimit(Buffer.alloc(5 * MB), 'image/png');
    expect(r.mime).toBe('image/jpeg');
    expect(sharp.chains[0].flatten).toHaveBeenCalledWith({ background: '#ffffff' });
  });

  test('the gentlest step is tried first, and smaller ones only when it is not enough', async () => {
    sharp.outputs.push(4 * MB, 3.5 * MB, 2 * MB);
    const r = await fitToLimit(Buffer.alloc(12 * MB), 'image/jpeg');
    expect(r.shrunk).toBe(true);
    expect(r.buffer.length).toBe(2 * MB);
    expect(sharp.chains.map(c => c.resize.mock.calls[0][0].width)).toEqual(SHRINK_STEPS.slice(0, 3).map(s => s.edge));
  });

  test('a photo that will not come under the limit is returned as it was, with a reason', async () => {
    sharp.outputs.push(...SHRINK_STEPS.map(() => 4 * MB));
    const original = Buffer.alloc(14 * MB);
    const r = await fitToLimit(original, 'image/jpeg');
    expect(r.shrunk).toBe(false);
    expect(r.buffer).toBe(original);
    expect(r.reason).toMatch(/14\.0MB, over Xero's 3\.0MB attachment limit/);
    expect(r.reason).toMatch(/could not be shrunk/);
  });

  test('a photo the library cannot decode says so rather than throwing', async () => {
    sharp.outputs.push(new Error('Input buffer contains unsupported image format'));
    const r = await fitToLimit(Buffer.alloc(4 * MB), 'image/jpeg');
    expect(r.shrunk).toBe(false);
    expect(r.reason).toMatch(/could not be decoded/);
  });

  test('a PDF over the limit is left alone, and the reason says why', async () => {
    // There is no renderer to re-encode a PDF, and dropping pages to make it
    // fit would be worse than not attaching it.
    const r = await fitToLimit(Buffer.alloc(4 * MB), 'application/pdf');
    expect(r.shrunk).toBe(false);
    expect(r.reason).toMatch(/PDF is 4\.0MB.*cannot be made smaller/);
    expect(sharp).not.toHaveBeenCalled();
  });
});
