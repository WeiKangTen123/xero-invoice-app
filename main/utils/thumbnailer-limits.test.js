// sharp is mocked here so the pixel cap can be checked on any machine (this
// checkout's sharp build is for a Mac). What is under test is the options the
// thumbnailer opens an image with and what it does when sharp refuses one;
// thumbnailer.test.js covers the real resize with the real library.
jest.mock('sharp', () => {
  const sharp = jest.fn(() => {
    const chain = {};
    ['rotate', 'resize', 'jpeg'].forEach(m => { chain[m] = jest.fn(() => chain); });
    chain.toFile = jest.fn(async () => {
      if (sharp.failWith) throw sharp.failWith;
      return {};
    });
    return chain;
  });
  sharp.concurrency = jest.fn();
  sharp.failWith = null;
  return sharp;
});

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const sharp = require('sharp');
const thumbnailer = require('./thumbnailer');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-limits-'));
  sharp.mockClear();
  sharp.failWith = null;
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('utils/thumbnailer — the pixel cap', () => {
  test('every image is opened with the receipt pixel cap, not sharp\'s 268-megapixel default', async () => {
    const src = path.join(dir, 'r.jpg');
    fs.writeFileSync(src, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    await thumbnailer.thumbnailPath(src, dir, 'r.jpg', 160, 'image/jpeg');
    expect(sharp).toHaveBeenCalledTimes(1);
    expect(sharp).toHaveBeenCalledWith(src, { limitInputPixels: 50_000_000 });
    expect(thumbnailer.MAX_INPUT_PIXELS).toBe(50_000_000);
  });

  test('an image over the cap is not scaled, and the caller serves the original', async () => {
    const src = path.join(dir, 'bomb.png');
    fs.writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    sharp.failWith = new Error('Input image exceeds pixel limit');
    await expect(thumbnailer.thumbnailPath(src, dir, 'bomb.png', 160, 'image/png')).resolves.toBeNull();
  });
});
