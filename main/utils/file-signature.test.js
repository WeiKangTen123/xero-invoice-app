const { sniff, check, label, labelList } = require('./file-signature');

// The first bytes of each format as real files carry them: a camera JPEG
// (JFIF and EXIF), a PNG, a WebP, an iPhone HEIC, a generic HEIF and a PDF.
const JFIF = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const EXIF = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x2f, 0xfe, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
const PNG  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x10, 0x00, 0x00]), Buffer.from('WEBPVP8 ')]);
const box  = brand => Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(4)]);
const HEIC = box('heic');
const HEIF = box('mif1');
const AVIF = box('avif');
const PDF  = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');

// What arrives when somebody renames a file: a Windows program, a shell
// script, a web page, plain text.
const EXE  = Buffer.concat([Buffer.from('MZ'), Buffer.from([0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]), Buffer.alloc(54)]);
const ELF  = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
const SH   = Buffer.from('#!/bin/sh\nrm -rf /\n');
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');
const TEXT = Buffer.from('Grab ride SGD 18.40, honest');

const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

describe('utils/file-signature — what a file is, from its first bytes', () => {
  test('recognises the real headers of every format a receipt arrives in', () => {
    expect(sniff(JFIF)).toBe('image/jpeg');
    expect(sniff(EXIF)).toBe('image/jpeg');
    expect(sniff(PNG)).toBe('image/png');
    expect(sniff(WEBP)).toBe('image/webp');
    expect(sniff(HEIC)).toBe('image/heic');
    expect(sniff(HEIF)).toBe('image/heif');
    expect(sniff(PDF)).toBe('application/pdf');
  });

  test('a program, a script, a web page or plain text is none of them, whatever it is called', () => {
    for (const b of [EXE, ELF, SH, HTML, TEXT]) expect(sniff(b)).toBeNull();
  });

  test('AVIF shares HEIF\'s container but is not taken for it', () => {
    expect(sniff(AVIF)).toBeNull();
  });

  test('a PDF marker anywhere but the very start does not count', () => {
    // A file can be a web page and a "PDF" at once if junk before the marker
    // is allowed. Nothing that makes a receipt PDF puts any there.
    expect(sniff(Buffer.from('<html>%PDF-1.4'))).toBeNull();
    expect(sniff(Buffer.from(' %PDF-1.4'))).toBeNull();
  });

  test('empty, tiny and non-buffer input is nothing, not a throw', () => {
    expect(sniff(Buffer.alloc(0))).toBeNull();
    expect(sniff(Buffer.from([0xff]))).toBeNull();
    expect(sniff(null)).toBeNull();
    expect(sniff('%PDF-1.4')).toBeNull();
  });
});

describe('utils/file-signature — check(), what a receipt may be stored as', () => {
  test('a real receipt passes as the type its contents show', () => {
    expect(check(JFIF, RECEIPT_TYPES)).toEqual({ mime: 'image/jpeg' });
    expect(check(PNG, RECEIPT_TYPES)).toEqual({ mime: 'image/png' });
    expect(check(PDF, RECEIPT_TYPES)).toEqual({ mime: 'application/pdf' });
  });

  test('a renamed program or text file is refused, saying what is accepted', () => {
    for (const b of [EXE, TEXT, HTML]) {
      const r = check(b, RECEIPT_TYPES);
      expect(r.mime).toBeUndefined();
      expect(r.found).toBeNull();
      expect(r.error).toMatch(/not a JPEG, PNG or PDF/);
      expect(r.error).toMatch(/whatever its name or type says/);
    }
  });

  test('a HEIC or WebP image is named in the refusal rather than called "not an image"', () => {
    const heic = check(HEIC, RECEIPT_TYPES);
    expect(heic.found).toBe('image/heic');
    expect(heic.error).toMatch(/This is a HEIC image, which Xero does not accept/);
    expect(heic.error).toMatch(/Save it as a JPEG, PNG or PDF/);
    expect(check(WEBP, RECEIPT_TYPES).error).toMatch(/WebP image/);
  });

  test('labels read as a person would say them', () => {
    expect(label('image/heic')).toBe('HEIC');
    expect(labelList(RECEIPT_TYPES)).toBe('JPEG, PNG or PDF');
    expect(labelList(['application/pdf'])).toBe('PDF');
  });
});
