/** Rotate dense Array values into a fresh ordinary Array, right for positive steps. */
export function rotateArray(items, steps) {
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an Array');
  }
  if (typeof steps !== 'number') {
    throw new TypeError('steps must be a primitive number');
  }
  if (!Number.isSafeInteger(steps)) {
    throw new RangeError('steps must be a finite safe integer');
  }

  const length = items.length;
  const result = new Array(length);
  if (length === 0) return result;

  // Reduce before adding any indices or length, preserving safe-integer precision.
  const remainder = steps % length;
  const offset = remainder < 0 ? remainder + length : remainder;
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(items, index)) {
      throw new TypeError('items must not contain holes');
    }
    // Define own slots without invoking inherited destination setters/getters.
    Object.defineProperty(result, (index + offset) % length, {
      value: items[index],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}
