const { _vendorAddress } = require('./parser');
describe('the vendor address is never the bank address', () => {
  const dbs = '12 Marina Boulevard, DBS Asia Central, Marina Bay Financial Centre Tower 3, Singapore 018982';
  test('same text as bankAddress → dropped', () => {
    expect(_vendorAddress({ vendorAddress: dbs, bankAddress: dbs })).toBe('');
  });
  test('found inside the payment reference → dropped', () => {
    expect(_vendorAddress({ vendorAddress: dbs, paymentReference: `Bank: DBS Bank Ltd | Acct: 072-143611-6 | Address: ${dbs}` })).toBe('');
  });
  test('a real vendor address is kept', () => {
    expect(_vendorAddress({ vendorAddress: '6 Battery Road, #11-01A, 049909 Singapore', bankAddress: dbs })).toBe('6 Battery Road, #11-01A, 049909 Singapore');
    expect(_vendorAddress({ vendorAddress: '6 Battery Road, #11-01A, 049909 Singapore' })).toBe('6 Battery Road, #11-01A, 049909 Singapore');
  });
});
