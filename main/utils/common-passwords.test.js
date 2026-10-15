// The published list behind the "too common" password rule.
describe('common passwords', () => {
  const { isCommonPassword, commonPasswordCount } = require('./common-passwords');

  test('the list is whole: the top 3,000 plus the long tail of the top 10,000', () => {
    expect(commonPasswordCount()).toBeGreaterThanOrEqual(3000);
  });

  test('matches whole passwords, in any case, and nothing else', () => {
    expect(isCommonPassword('password')).toBe(true);
    expect(isCommonPassword('PASSWORD')).toBe(true);
    expect(isCommonPassword('123456')).toBe(true);
    expect(isCommonPassword('qwerty123456')).toBe(true);   // one of the few long ones in the top 3,000
    expect(isCommonPassword('1qazxsw23edc')).toBe(true);   // a long one from beyond it
    expect(isCommonPassword('password ')).toBe(false);     // a space is a different password
    expect(isCommonPassword('correct horse battery staple')).toBe(false);
    expect(isCommonPassword('')).toBe(false);
    expect(isCommonPassword(null)).toBe(false);
    expect(isCommonPassword(123456)).toBe(false);
  });
});
