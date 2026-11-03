export const baseline = () => 'sandbox';
export { collectAsync } from './lib/collect-async.mjs';

/** Compare primitive bigints in signed mathematical order, returning Number -1, 0, or 1. */
export function compareBigInts(a, b) {
  if (typeof a !== 'bigint' || typeof b !== 'bigint') {
    throw new TypeError('a and b must be primitive bigints');
  }

  return a < b ? -1 : a > b ? 1 : 0;
}
