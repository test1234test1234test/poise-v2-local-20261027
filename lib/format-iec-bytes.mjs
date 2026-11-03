const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];

/** Format an exact nonnegative byte count with half-up IEC rounding. */
export function formatIecBytes(value) {
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new TypeError('Byte count must be a primitive Number or BigInt');
  }
  if (value < 0 || (typeof value === 'number' && !Number.isSafeInteger(value))) {
    throw new RangeError('Byte count must be a nonnegative integer, safe when a Number');
  }

  const bytes = BigInt(value);
  if (bytes < 1024n) return `${bytes} B`;

  let unit = 0;
  let divisor = 1n;
  while (unit < UNITS.length - 1 && bytes >= divisor * 1024n) {
    unit += 1;
    divisor *= 1024n;
  }

  // Keep the original bytes intact; round only the final scaled magnitude.
  const numerator = bytes * 10n;
  let tenths = (numerator + divisor / 2n) / divisor;
  if (tenths === 10240n && unit < UNITS.length - 1) {
    unit += 1;
    divisor *= 1024n;
    tenths = (numerator + divisor / 2n) / divisor;
  }

  return `${tenths / 10n}.${tenths % 10n} ${UNITS[unit]}`;
}
