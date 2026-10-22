const fs   = require('fs');
const path = require('path');

// The password rules are checked twice: by a form as the password is typed
// (ui/src/pages/account/password-rules.js) and by the server, whose answer
// counts (main/utils/users.js passwordProblem). The server's list of common
// passwords is far longer than the form's, so it may refuse what the form
// let through; never the other way round, and never in other words — or the
// form would hold back a password the server takes, or say one thing while
// the server says another.
const src    = fs.readFileSync(path.join(__dirname, '../../ui/src/pages/account/password-rules.js'), 'utf8');
const client = new Function(`${src.replace(/^export /gm, '')}\nreturn { passwordProblem, COMMON_PASSWORDS };`)();
const server = require('../utils/users');

const EMAILS = ['Jane.Doe@Example.com', ' JOSÉ.garcia@example.com ', undefined];
const CASES  = [
  // The form's own list, as it is and shouted.
  ...client.COMMON_PASSWORDS, ...client.COMMON_PASSWORDS.map(p => p.toUpperCase()),
  // Length, in characters after NFC.
  undefined, null, 123456789012, '', 'short', 'elevenchars', '😀'.repeat(6), 'café au lai',
  'x'.repeat(129), '🐱🐶'.repeat(65), 'correct horse battery staple '.repeat(5).slice(0, 129),
  // Shapes.
  'aaaaaaaaaaaa', 'AAAAAAAAAAAAAAAA', '😀'.repeat(12), '123456789012', '987654321098', '0123456789012345678901', '1111111111111',
  '890123456789', '210987654321',
  // Only the words of this app.
  'Xero2026!!!!', 'xeroxeroxero', 'FinancialAutomation1', 'flovon.flovon', 'Accounting#2026', 'invoices4finance', 'INVOICE-INVOICE',
  // The account's own address.
  'jane.doe@example.com', 'JANE.DOE@EXAMPLE.COM', 'Jane.Doe@Example.com', 'josé.garcia@example.com', 'josé.garcia',
  'josé.garcia',
];

test('every password the form refuses, the server refuses in the same words', () => {
  let refused = 0;
  for (const password of CASES) {
    for (const email of EMAILS) {
      const said = client.passwordProblem(password, email);
      if (said === null) continue;
      refused++;
      expect({ password, email, server: server.passwordProblem(password, email) }).toEqual({ password, email, server: said });
    }
  }
  expect(refused).toBeGreaterThan(CASES.length * 2);
});

test('what both let through', () => {
  for (const p of ['correct horse battery staple', '🐱🐶🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮', 'café au lait', '🐱🐶'.repeat(64), 'xero is my accountant']) {
    expect([p, client.passwordProblem(p, 'jane.doe@example.com')]).toEqual([p, null]);
    expect([p, server.passwordProblem(p, 'jane.doe@example.com')]).toEqual([p, null]);
  }
});

test('the same limits on both sides', () => {
  const rules = new Function(`${src.replace(/^export /gm, '')}\nreturn { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH };`)();
  expect(rules).toEqual({ PASSWORD_MIN_LENGTH: server.PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH: server.PASSWORD_MAX_LENGTH });
});
