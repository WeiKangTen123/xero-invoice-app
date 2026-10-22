// The published list behind the "too common" password rule, and the two
// shapes refused with it.
describe('common passwords', () => {
  const { isCommonPassword, isPattern, isContextWords, commonPasswordCount, LIST_PATH } = require('./common-passwords');

  test('the list is whole: the xato.net top 3,000 and its 12-to-64-character entries to the first million', () => {
    expect(commonPasswordCount()).toBeGreaterThanOrEqual(45000);
    expect(require('fs').statSync(LIST_PATH).size).toBeLessThan(1.5 * 1024 * 1024);
    expect(require('fs').readFileSync(LIST_PATH, 'utf8')).toMatch(/^# .*\n# Sources, all from SecLists \(github\.com\/danielmiessler\/SecLists, MIT licence\)/);
  });

  test('matches whole passwords, in any case, and nothing else', () => {
    expect(isCommonPassword('password')).toBe(true);
    expect(isCommonPassword('PASSWORD')).toBe(true);
    expect(isCommonPassword('123456')).toBe(true);
    expect(isCommonPassword('qwerty123456')).toBe(true);   // one of the few long ones in the top 3,000
    expect(isCommonPassword('1qazxsw23edc')).toBe(true);   // a long one from the top 10,000
    expect(isCommonPassword('password ')).toBe(false);     // a space is a different password
    expect(isCommonPassword('correct horse battery staple')).toBe(false);
    expect(isCommonPassword('')).toBe(false);
    expect(isCommonPassword(null)).toBe(false);
    expect(isCommonPassword(123456)).toBe(false);
  });

  // The ones twelve characters and longer that passed before the list grew.
  test('the long favourites from the first million, and the forms\' own list', () => {
    for (const p of ['password1234', 'administrator', 'welcome12345', 'qwertyuiop12', 'Password@123', 'abcd12345678', 'trustno1trustno1']) {
      expect([p, isCommonPassword(p)]).toEqual([p, true]);
    }
  });

  test('compared in NFC', () => {
    // Neither form is on the list; the point is that both are looked up alike.
    expect(isCommonPassword('cafécafécafé')).toBe(isCommonPassword('cafécafécafé'));
  });

  test('one character the whole way, or a straight run of digits either way, any length', () => {
    for (const p of ['aaaaaaaaaaaa', 'ZZZZZZZZZZZZZ', '😀😀😀😀', '123456789012', '987654321098', '0123456789012345678901', '1111111111111', '890123', '3210']) {
      expect([p, isPattern(p)]).toEqual([p, true]);
      expect(isCommonPassword(p)).toBe(true);
    }
    for (const p of ['aaaaaaaaaaab', '123456789013', '135792468024', '1', '', null, 'abcabcabcabc']) {
      expect([p, isPattern(p)]).toEqual([p, false]);
    }
  });

  test('nothing but the words of this app, once everything but letters is out', () => {
    for (const p of ['Xero2026!!!!', 'xeroxeroxero', 'Flovon-Flovon', 'FinancialAutomation1', 'finance finance', 'Invoices4Accounting', 'automation']) {
      expect([p, isContextWords(p)]).toEqual([p, true]);
    }
    for (const p of ['xero is my accountant', 'financially', 'xeroé', '2026!!!!', '', null]) {
      expect([p, isContextWords(p)]).toEqual([p, false]);
    }
  });
});
