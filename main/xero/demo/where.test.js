// The where parser behind the demo facade: every clause the app sends is
// read as Xero reads it, and anything it does not know is refused outright.
const { tokenize, parseWhere, compileWhere, compileOrder, dayOf } = require('./where');

const INVOICES = {
  Date: r => r.date, Status: r => r.status, Type: r => r.type, AmountDue: r => r.amountDue,
  'Contact.ContactID': r => r.contact.contactID, Name: r => r.name, EmailAddress: r => r.emailAddress,
};
const rows = [
  { date: '2026-09-01T00:00:00', status: 'AUTHORISED', type: 'ACCREC', amountDue: 100, contact: { contactID: 'ABC-1' }, name: 'Acme Pte Ltd', emailAddress: 'a@acme.sg' },
  { date: '2026-10-15T00:00:00', status: 'PAID',       type: 'ACCREC', amountDue: 0,   contact: { contactID: 'abc-2' }, name: 'Beta Co',      emailAddress: 'b@beta.sg' },
  { date: new Date('2026-10-01T00:00:00Z'), status: 'AUTHORISED', type: 'ACCPAY', amountDue: 50, contact: { contactID: 'ABC-1' }, name: 'Acme Supplies', emailAddress: '' },
];
const names = (where, fields = INVOICES, list = rows) => list.filter(compileWhere(where, fields)).map(r => r.name);

describe('the clauses the app sends', () => {
  test('a date window with DateTime(y,m,d), inclusive at the start and exclusive at the end', () => {
    expect(names('Date >= DateTime(2026,10,1) && Date < DateTime(2026,10,15)')).toEqual(['Acme Supplies']);
    expect(names('Date >= DateTime(2026,10,1)')).toEqual(['Beta Co', 'Acme Supplies']);
    expect(names('Date < DateTime(2026,10,1)')).toEqual(['Acme Pte Ltd']);
  });

  test('a Date held as a Date object is compared by its UTC day, as the app reads Xero dates', () => {
    expect(names('Date == DateTime(2026,10,1)')).toEqual(['Acme Supplies']);
  });

  test('Status, Type and a number', () => {
    expect(names('Status=="AUTHORISED"')).toEqual(['Acme Pte Ltd', 'Acme Supplies']);
    expect(names('Type=="ACCREC"')).toEqual(['Acme Pte Ltd', 'Beta Co']);
    expect(names('AmountDue>0')).toEqual(['Acme Pte Ltd', 'Acme Supplies']);
    expect(names('AmountDue>0 && Type=="ACCPAY"')).toEqual(['Acme Supplies']);
  });

  test('a Guid is matched whatever its case', () => {
    expect(names('Contact.ContactID==Guid("abc-1")')).toEqual(['Acme Pte Ltd', 'Acme Supplies']);
    expect(names('Contact.ContactID==Guid("ABC-2")')).toEqual(['Beta Co']);
  });

  test('|| and parentheses, as the live check asks for the two transfer legs', () => {
    expect(names('(Type=="ACCPAY" || Status=="PAID") && AmountDue>=0')).toEqual(['Beta Co', 'Acme Supplies']);
    expect(names('Type=="ACCPAY" || Status=="PAID"')).toEqual(['Beta Co', 'Acme Supplies']);
  });

  test('Name and EmailAddress, exactly and by Contains / StartsWith (case-insensitive)', () => {
    expect(names('Name=="Beta Co"')).toEqual(['Beta Co']);
    expect(names('EmailAddress=="a@acme.sg"')).toEqual(['Acme Pte Ltd']);
    expect(names('Name.Contains("acme")')).toEqual(['Acme Pte Ltd', 'Acme Supplies']);
    expect(names('Name.StartsWith("beta")')).toEqual(['Beta Co']);
    expect(names('Name!="Beta Co"')).toEqual(['Acme Pte Ltd', 'Acme Supplies']);
  });

  test('a string with an escaped quote', () => {
    const list = [{ name: 'Say "hi" Ltd' }];
    expect(list.filter(compileWhere('Name=="Say \\"hi\\" Ltd"', { Name: r => r.name }))).toHaveLength(1);
  });

  test('no clause at all filters nothing', () => {
    expect(names(undefined)).toHaveLength(3);
    expect(names('')).toHaveLength(3);
    expect(names(null)).toHaveLength(3);
  });
});

describe('what is refused, loudly', () => {
  test('a field the endpoint does not offer', () => {
    expect(() => compileWhere('Foo=="x"', INVOICES)).toThrow(/filters on "Foo", which this endpoint does not support/);
    expect(() => compileWhere('Date >= DateTime(2026,1,1) && Account.AccountID==Guid("x")', INVOICES)).toThrow(/Account\.AccountID/);
  });

  test('syntax it does not know', () => {
    expect(() => parseWhere('Date >= 2026-01-01')).toThrow();
    expect(() => parseWhere('Status=="AUTHORISED" &&')).toThrow(/expected id|ends early/);
    expect(() => parseWhere('Status=="AUTHORISED')).toThrow(/unterminated/);
    expect(() => parseWhere('Status ~ "x"')).toThrow();
    expect(() => parseWhere('Status=="A" Type=="B"')).toThrow(/unexpected/);
    expect(() => compileWhere('Name.Contains(3)', INVOICES)).toThrow(/takes a string/);
  });

  test('the tokens, for the record', () => {
    expect(tokenize('Date >= DateTime(2026,1,1) && Status=="A"').map(t => t.t)).toEqual([
      'id', 'op', 'id', '(', 'num', ',', 'num', ',', 'num', ')', '&&', 'id', 'op', 'str',
    ]);
  });
});

describe('order', () => {
  const F = { Date: r => r.date, Name: r => r.name };
  test('"Field DIR" on an offered field; a tie keeps the list\'s order; strings sort as read, case aside', () => {
    expect([...rows].sort(compileOrder('Date DESC', F)).map(r => r.name)).toEqual(['Beta Co', 'Acme Supplies', 'Acme Pte Ltd']);
    expect([...rows].sort(compileOrder('Name ASC', F)).map(r => r.name)).toEqual(['Acme Pte Ltd', 'Acme Supplies', 'Beta Co']);
    expect([...rows].sort(compileOrder('Name', F)).map(r => r.name)).toEqual(['Acme Pte Ltd', 'Acme Supplies', 'Beta Co']);
    const tied = [{ name: 'b', date: '2026-01-01' }, { name: 'a', date: '2026-01-01' }];
    expect([...tied].sort(compileOrder('Date ASC', F)).map(r => r.name)).toEqual(['b', 'a']);
    const mixed = [{ name: 'SG Enterprise' }, { name: 'Sentosa' }, { name: 'acme' }, { name: 'Beta' }];
    expect([...mixed].sort(compileOrder('Name ASC', F)).map(r => r.name)).toEqual(['acme', 'Beta', 'Sentosa', 'SG Enterprise']);
  });
  test('none, or a field not offered', () => {
    expect(compileOrder(undefined, F)).toBeNull();
    expect(() => compileOrder('DueDate ASC', F)).toThrow(/order by "DueDate" is not supported/);
    expect(() => compileOrder('Name ASC extra', F)).toThrow(/cannot read order/);
  });
});

describe('dayOf', () => {
  test('a Xero date in any of its forms', () => {
    expect(dayOf('2026-10-01T00:00:00')).toBe('2026-10-01');
    expect(dayOf('2026-10-01')).toBe('2026-10-01');
    expect(dayOf(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10-01');
    expect(dayOf(null)).toBeNull();
    expect(dayOf(new Date('nope'))).toBeNull();
  });
});
