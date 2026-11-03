export function hexByte(value) {
  if (typeof value !== 'number') {
    throw new TypeError('value must be a number');
  }
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError('value must be an integer from 0 through 255');
  }

  return value.toString(16).padStart(2, '0');
}
