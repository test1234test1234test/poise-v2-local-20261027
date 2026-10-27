/** Group array values by key, preserving first-seen key and input value order. */
export function groupBy(items, keyOf) {
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an Array');
  }
  if (typeof keyOf !== 'function') {
    throw new TypeError('keyOf must be a function');
  }

  const groups = new Map();
  const length = items.length;
  for (let index = 0; index < length; index += 1) {
    const value = items[index];
    const key = keyOf(value, index);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [value]);
    } else {
      group.push(value);
    }
  }
  return groups;
}
