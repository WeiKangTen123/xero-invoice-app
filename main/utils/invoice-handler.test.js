// Why a stored bill waits for a person instead of going to Xero. The old
// guard only held "no number AND no amount", and the model's number fallback
// was the PDF filename, so a misread PDF with total 0 could post a blank draft.
const { holdReason } = require('./invoice-handler');

test('a zero total is held for review whatever the invoice number says', () => {
  expect(holdReason({ invoiceNumber: 'Scan_0001', totalAmount: 0 })).toMatch(/amount/);
  expect(holdReason({ invoiceNumber: 'INV-1789367692013', totalAmount: 0 })).toMatch(/amount/);
  expect(holdReason({ invoiceNumber: 'A-1', totalAmount: null })).toMatch(/amount/);
});

test('an auto-generated number with a real total is held too', () => {
  expect(holdReason({ invoiceNumber: 'INV-1789367692013', totalAmount: 120 })).toMatch(/number/);
  expect(holdReason({ invoiceNumber: '—', totalAmount: 120 })).toMatch(/number/);
  expect(holdReason({ invoiceNumber: '', totalAmount: 120 })).toMatch(/number/);
});

test('a real number and a real total pass', () => {
  expect(holdReason({ invoiceNumber: 'A-1', totalAmount: 120 })).toBeNull();
});

// The last hold before Xero. Disabling an account stops its watcher and
// workers, but a submit queued moments earlier waits in the per-account chain;
// this decides whether it may still go.
describe('accountMayPost', () => {
  beforeEach(() => { jest.resetModules(); require('../db/migrate').run(); });

  test('an active account may post; a disabled or deleted one may not', async () => {
    const users = require('./users');
    const { accountMayPost } = require('./invoice-handler');
    const u = await users.createUser('post@test.com', 'password123', 'user');
    expect(accountMayPost(u.id)).toBe(true);
    users.setDisabled(u.id, true);
    expect(accountMayPost(u.id)).toBe(false);
    users.setDisabled(u.id, false);
    expect(accountMayPost(u.id)).toBe(true);
    users.deleteUser(u.id);
    expect(accountMayPost(u.id)).toBe(false);
  });
});
