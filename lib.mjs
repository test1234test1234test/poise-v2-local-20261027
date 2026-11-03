export const baseline = () => 'sandbox';

/** Compare primitive bigints in signed mathematical order, returning Number -1, 0, or 1. */
export function compareBigInts(a, b) {
  if (typeof a !== 'bigint' || typeof b !== 'bigint') {
    throw new TypeError('a and b must be primitive bigints');
  }

  return a < b ? -1 : a > b ? 1 : 0;
}

/** Parse a primitive string containing a canonical unsigned ASCII decimal integer exactly. */
export function parseCanonicalUnsignedBigInt(text) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a primitive string');
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) {
    throw new SyntaxError('text must be a canonical unsigned decimal integer');
  }

  return BigInt(text);
}
