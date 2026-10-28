/** Keep the first own array value for each key, using SameValueZero equality. */
export function uniqueBy(items, keyOf) {
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an Array');
  }
  if (typeof keyOf !== 'function') {
    throw new TypeError('keyOf must be a function');
  }

  const result = [];
  const seen = new Set();
  const length = items.length;
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(items, index)) continue;
    const value = items[index];
    const key = keyOf(value, index);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}
