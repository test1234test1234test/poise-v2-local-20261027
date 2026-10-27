const MAX_MILLISECONDS = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_DIGITS = String(Number.MAX_SAFE_INTEGER).length;
const MILLISECONDS = {
  d: 86_400_000n,
  h: 3_600_000n,
  m: 60_000n,
  s: 1_000n,
  ms: 1n,
};

/** Parse unique, descending integer duration terms into safe milliseconds. */
export function parseDuration(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Duration must be a string');
  }

  // A local sticky regex requires contiguous consumption and has no shared cursor.
  const term = /[ \t]*([0-9]+)(ms|[dhms])[ \t]*/y;
  let position = 0;
  let previousMultiplier = null;
  let total = 0n;

  while (position < text.length) {
    term.lastIndex = position;
    const match = term.exec(text);
    if (match === null) {
      throw new SyntaxError('Invalid duration term');
    }

    const multiplier = MILLISECONDS[match[2]];
    if (previousMultiplier !== null && multiplier >= previousMultiplier) {
      throw new SyntaxError('Duration units must be unique and descending');
    }
    previousMultiplier = multiplier;
    position = term.lastIndex;

    // Ignore leading zeros before bounding the conversion. More significant
    // digits cannot fit even in milliseconds; retain an overflow sentinel while
    // still checking the remaining syntax, including ordering and duplicates.
    const digits = match[1].replace(/^0+/, '');
    const value = digits.length > MAX_DIGITS
      ? MAX_MILLISECONDS + 1n
      : BigInt(digits || '0');
    total += value * multiplier;
  }

  if (previousMultiplier === null) {
    throw new SyntaxError('Duration requires at least one term');
  }
  if (total > MAX_MILLISECONDS) {
    throw new RangeError('Duration exceeds the safe integer range');
  }
  return Number(total);
}
