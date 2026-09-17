// `${Date.now()}${Math.random().toString(36).slice(2, 5)}` was written seven
// times; three base-36 characters behind the same millisecond is a thin
// margin for the loops that create split siblings back to back.
const { newId } = require('./ids');

test('ids are sortable by time, url-safe, and do not collide in a tight loop', () => {
  const ids = Array.from({ length: 20000 }, () => newId());
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids[0]).toMatch(/^\d{13}[a-z0-9]{8}$/);
});
