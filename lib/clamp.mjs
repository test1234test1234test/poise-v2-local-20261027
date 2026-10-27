export function clamp(value, min, max) {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) {
    throw new TypeError('value, min, and max must be finite numbers');
  }
  if (min > max) {
    throw new RangeError('min must be less than or equal to max');
  }

  if (value < min) return min;
  if (value > max) return max;
  return value;
}
