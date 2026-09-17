// The expense categories a claim can carry — ONE list, used by:
//   * utils/receipt-parser.js   — the prompt offers exactly these names
//   * claims/category-account.js — the account hints are keyed by them
//   * normalise() in the parser  — anything the model returns outside the list is dropped
//
// Names match the headings on the company's claim form, so a category here is
// also a column there. The scope line is what the model is told each one means;
// keep it about WHAT was bought and WHEN, never about why.
const CATEGORIES = [
  { name: 'Entertainment/Meals', scope: 'restaurant, cafe or food-delivery meals during the working day, before 21:00' },
  { name: 'Staff Welfare',       scope: 'pantry snacks, coffee, bakery or supermarket items for the office' },
  { name: 'Staff Overtime Meal', scope: 'a meal paid at or after 21:00 (food delivery, casual dining)' },
  { name: 'Local Travel',        scope: 'taxi, ride-hailing, public transport, petrol or parking within the country, before 21:30' },
  { name: 'Overtime Transport',  scope: 'a taxi or ride-hailing trip paid at or after 21:30' },
  { name: 'Overseas Travel',     scope: 'flights, hotels, trains and visas for trips abroad (airlines, Agoda, Booking.com)' },
  { name: 'Office Supplies',     scope: 'stationery, printer toner, desk accessories, minor equipment' },
  { name: 'Software/Utilities',  scope: 'cloud servers, software subscriptions, telecom and internet bills' },
  { name: 'Medical/Dental',      scope: 'clinic visits, prescription medicine, dental checkups' },
  { name: 'General Expense',     scope: 'courier, postage, bank charges, cleaning, and anything that fits nowhere else' },
];

const CATEGORY_NAMES = CATEGORIES.map(c => c.name);

// "staff  welfare", "Entertainment / Meals" and "SOFTWARE/UTILITIES" all mean
// a listed category; a model is allowed to be sloppy about case and spacing,
// not about which categories exist.
const _key = v => String(v).toLowerCase().replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
const _byKey = new Map(CATEGORIES.map(c => [_key(c.name), c.name]));
function canonicalCategory(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return _byKey.get(_key(value)) || null;
}

module.exports = { CATEGORIES, CATEGORY_NAMES, canonicalCategory };
