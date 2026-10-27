/** Split an Array into fresh, shallow chunks, preserving slice-style holes. */
export function chunk(items, size) {
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an Array');
  }
  if (typeof size !== 'number') {
    throw new TypeError('size must be a number');
  }
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new RangeError('size must be a positive safe integer');
  }

  const result = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(Array.prototype.slice.call(items, start, start + size));
  }
  return result;
}
