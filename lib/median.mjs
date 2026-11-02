/** Return the median of a dense Array of finite numbers without modifying it. */
export function median(values) {
  if (!Array.isArray(values)) {
    throw new TypeError('values must be an Array');
  }

  const length = values.length;
  if (length === 0) return null;

  // Capture each indexed value once, without using input iterators or species.
  const sorted = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(values, index)) {
      throw new TypeError('values must not contain holes');
    }
    const value = values[index];
    if (!Number.isFinite(value)) {
      throw new TypeError('values must contain only finite numbers');
    }
    sorted.push(value);
  }
  sorted.sort((a, b) => a - b);

  const middle = Math.floor(length / 2);
  if (length % 2 === 1) return sorted[middle];

  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  const sum = lower + upper;
  // Scale only on overflow: halving small endpoints first can lose subnormals.
  return Number.isFinite(sum) ? sum / 2 : lower / 2 + upper / 2;
}
