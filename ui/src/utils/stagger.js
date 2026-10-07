// The fade-in each list row makes as it appears, one slightly after another.
//
// The delay used to grow with the row's position, so on a list of 300 bills the
// last row waited seven and a half seconds to show — long after anyone had
// started scrolling, and every row was a separate running animation besides.
// Only the first rows stagger now, which is all the eye takes in on arrival;
// everything after them is simply there.
export const STAGGER_ROWS = 10;

export function staggerIn(index, stepMs = 25, duration = '0.2s') {
  return index < STAGGER_ROWS ? `fadeUp ${duration} ease ${index * stepMs}ms both` : undefined;
}
