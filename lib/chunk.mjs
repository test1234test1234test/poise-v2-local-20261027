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
  const length = items.length;
  for (let start = 0; start < length; start += size) {
    // Allocate ordinary arrays without consulting the input's constructor/species.
    const part = new Array(Math.min(size, length - start));
    for (let offset = 0; offset < part.length; offset += 1) {
      const index = start + offset;
      // Like slice, preserve absent slots and copy inherited indexed values.
      if (index in items) part[offset] = items[index];
    }
    result.push(part);
  }
  return result;
}
