const { _describeItems } = require('./parser');
describe('description comes from the items, not the email subject', () => {
  test('joins the first line of each item', () => {
    expect(_describeItems([
      { description: 'Issuance of Notarial Certificate — 2 × 75.00' }, { description: 'Witnessing of Signing (Personal)' },
      { description: 'Witnessing of Additional Signing (Personal)' }, { description: 'Certifying True Copy' },
      { description: 'Authentication by Singapore Academy of Law (SAL)' },
    ])).toBe('Issuance of Notarial Certificate — 2 × 75.00, Witnessing of Signing (Personal), Witnessing of Additional Signing (Personal), Certifying True Copy +1 more');
  });
  test('AR template: project and campaign, without their labels', () => {
    expect(_describeItems([{ description: 'Project: Project Demo 123\nCampaign: Display of products' }])).toBe('Project Demo 123 — Display of products');
    expect(_describeItems([{ description: 'Project: Project Demo 123\nTerritory: Singapore' }])).toBe('Project Demo 123');
  });
  test('nothing usable → empty, so the caller falls back', () => {
    expect(_describeItems([])).toBe('');
    expect(_describeItems([{ description: 'Item' }])).toBe('');
  });
});
