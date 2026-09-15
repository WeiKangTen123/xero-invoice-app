// The AR email of 14 Sep 2026: one item of 2000 and a second block that is
// the payment schedule for it (50% = 1000 upon confirmation, 50% on event
// date), with blank lines after its Amount. The total is 2000, not 3000, and
// nothing in the second block may be lost.
const { parseTemplateFormat, _isPaymentSchedule } = require('./parser');

const EMAIL = `Client / Customer (Full name/entities name) : Demo 123
Email : demo@123.com
Address : 123 Tiong Bahru
 
Date : 14 Sep 2026
Payment Terms / Payment Date : 28 Sep 2026
Currency : SGD
Tax inclusive / exclusive : No Tax
 

• Description / Details : 
Project: Project Demo 123
Campaign: Display of products
Project period: 14 Sep to 28 Sep 2026
Territory: Singapore 
Amount : 2000
Discount :
Tax (If applicable) : No Tax
 

• Description / Details :
Scope of work:

• 10 X Philips Airfryer
• Description / Details : Payment Terms:  50% upon confirmation (14 Sep 2026), 50% on Event Date (28 Sep 2026) - immediate upon invoice
 
Amount : 1000


Discount :
Tax (If applicable) : No Tax
`;

describe('a payment-schedule block on the AR template', () => {
  const r = parseTemplateFormat(EMAIL, { subject: 'Invoice' }, {});

  test('is not summed as a second item: total stays 2000', () => {
    expect(r.lineItems).toHaveLength(1);
    expect(r.lineItems[0].unitAmount).toBe(2000);
    expect(r.totalAmount).toBe(2000);
    expect(r.subTotal).toBe(2000);
  });

  test('keeps the scope of work and the terms on the item', () => {
    const d = r.lineItems[0].description;
    expect(d).toContain('Project: Project Demo 123');
    expect(d).toContain('Scope of work:');
    expect(d).toContain('10 X Philips Airfryer');
    expect(d).toContain('Payment Terms:  50% upon confirmation (14 Sep 2026), 50% on Event Date (28 Sep 2026)');
    expect(d).not.toMatch(/Description \/ Details/);
  });

  test('exposes the attached text as notes, so a later correction can keep them', () => {
    expect(r.scheduleNotes).toHaveLength(1);
    expect(r.scheduleNotes[0]).toContain('10 X Philips Airfryer');
    expect(r.scheduleNotes[0]).toContain('Payment Terms:');
    expect(r.lineItems[0].description.endsWith(r.scheduleNotes[0])).toBe(true);
  });

  test('asks a person to confirm the total', () => {
    expect(r.reviewReason).toMatch(/payment schedule/);
    expect(r.reviewReason).toContain('1,000');
  });

  test('header fields are unaffected', () => {
    expect(r.contactName).toBe('Demo 123');
    expect(r.invoiceDate).toBe('2026-09-14');
    expect(r.dueDate).toBe('2026-09-28');
    expect(r.currency).toBe('SGD');
    expect(r.taxAmount).toBe(0);
  });
});

describe('the same email as mailparser actually delivers it (bold as *x*, bullets as "   - ")', () => {
  const AS_DELIVERED = `Client / Customer (Full name/entities name) : Demo 123
Email : demo@123.com
Address : 123 Tiong Bahru

Date : 14 Sep 2026
Payment Terms / Payment Date : 28 Sep 2026
Currency : SGD
Tax inclusive / exclusive : No Tax


   - Description / Details :

*Project*: Project Demo 123
*Campaign*: Display of products
*Project period*: 14 Sep to 28 Sep 2026
*Territory*: Singapore
Amount : 2000
Discount :
Tax (If applicable) : No Tax


   - Description / Details :

*Scope of work:*

   - 10 X Philips Airfryer


   - Description / Details : *Payment Terms:  50% upon confirmation (14 Sep
   2026), 50% on Event Date (28 Sep 2026) - immediate upon invoice*

Amount : 1000


Discount :
Tax (If applicable) : No Tax
`;
  const r = parseTemplateFormat(AS_DELIVERED, { subject: 'create AR invoice' }, {});

  test('description names the job, with no formatting marks', () => {
    expect(r.description).toBe('Project Demo 123 — Display of products');
  });
  test('item text is clean: no asterisks, no bullets, no nested label', () => {
    const d = r.lineItems[0].description;
    expect(d).not.toMatch(/[*]/);
    expect(d).not.toMatch(/^\s*-\s/m);
    expect(d).not.toMatch(/Description \/ Details/);
    expect(d).toContain('Project: Project Demo 123');
    expect(d).toContain('10 X Philips Airfryer');
    expect(d).toContain('Payment Terms:  50% upon confirmation');
  });
  test('total and flag as before', () => {
    expect(r.totalAmount).toBe(2000);
    expect(r.lineItems).toHaveLength(1);
    expect(r.reviewReason).toMatch(/payment schedule/);
  });
});

describe('blank lines between Amount, Discount and Tax', () => {
  test('no longer drop a real second item', () => {
    const two = EMAIL.replace(/• Description \/ Details : Payment Terms[^\n]*\n/, '');
    const r = parseTemplateFormat(two, { subject: 'Invoice' }, {});
    expect(r.lineItems).toHaveLength(2);
    expect(r.totalAmount).toBe(3000);
    expect(r.reviewReason).toBeNull();
    expect(r.scheduleNotes).toEqual([]);
  });
});

describe('_isPaymentSchedule', () => {
  test('percent next to a payment word', () => {
    expect(_isPaymentSchedule('Payment Terms: 50% upon confirmation, 50% on event date')).toBe(true);
    expect(_isPaymentSchedule('30% deposit, balance on delivery')).toBe(true);
  });
  test('a discount or a plain description is not one', () => {
    expect(_isPaymentSchedule('Banner printing, 10% discount applied')).toBe(false);
    expect(_isPaymentSchedule('Scope of work: 10 X Philips Airfryer')).toBe(false);
    expect(_isPaymentSchedule('Payment by bank transfer')).toBe(false);
  });
});
