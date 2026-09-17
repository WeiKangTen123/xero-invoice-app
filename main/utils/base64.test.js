// The same strict decoder was pasted into three route files.
const { decodeBase64 } = require('./base64');

test('decodes plain and data-URI base64, strictly', () => {
  expect(decodeBase64(Buffer.from('hi').toString('base64')).toString()).toBe('hi');
  expect(decodeBase64('data:image/jpeg;base64,' + Buffer.from('hi').toString('base64')).toString()).toBe('hi');
  expect(decodeBase64('not base64 !!')).toBeNull();
  expect(decodeBase64('')).toBeNull();
  expect(decodeBase64(undefined)).toBeNull();
  expect(decodeBase64(42)).toBeNull();
});
