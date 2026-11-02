const MAX_BYTES = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER).length;
// Multiplier and maximum fractional scale after removing trailing zeros.
const UNITS = {
  B: [1n, 0],
  kB: [1_000n, 3],
  MB: [1_000_000n, 6],
  GB: [1_000_000_000n, 9],
  KiB: [1_024n, 10],
  MiB: [1_048_576n, 20],
  GiB: [1_073_741_824n, 30],
};

/** Parse a decimal quantity into an exact, nonnegative safe integer byte count. */
export function parseByteSize(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Byte size must be a primitive string');
  }

  // Keep the separator inside the optional unit group to avoid overlapping
  // whitespace repetitions when the unit is absent. Check full consumption:
  // JavaScript's $ can also match before a final Unicode line separator.
  const match = /^[\x09-\x0D\x20]*([0-9]+)(?:\.([0-9]+))?(?:[\x09-\x0D\x20]*(B|kB|MB|GB|KiB|MiB|GiB))?[\x09-\x0D\x20]*$/.exec(text);
  if (match === null || match[0].length !== text.length) {
    throw new TypeError('Invalid byte size syntax');
  }

  const integer = match[1].replace(/^0+/, '');
  const fraction = match[2] ?? '';
  let scale = fraction.length;
  while (scale > 0 && fraction[scale - 1] === '0') scale -= 1;
  const [multiplier, maxScale] = UNITS[match[3] ?? 'B'];

  // All units are at least one byte. Once insignificant zeros are removed,
  // these bounds reject only overflow or nonintegral bytes, while keeping the
  // coefficient and power of ten bounded regardless of input length.
  if (integer.length > MAX_INTEGER_DIGITS) {
    throw new RangeError('Byte size exceeds the safe integer range');
  }
  if (scale > maxScale) {
    throw new RangeError('Byte size must be a whole number of bytes');
  }

  const coefficient = BigInt((integer + fraction.slice(0, scale)) || '0');
  const denominator = 10n ** BigInt(scale);
  const numerator = coefficient * multiplier;
  if (numerator % denominator !== 0n) {
    throw new RangeError('Byte size must be a whole number of bytes');
  }
  const bytes = numerator / denominator;
  if (bytes > MAX_BYTES) {
    throw new RangeError('Byte size exceeds the safe integer range');
  }
  return Number(bytes);
}
