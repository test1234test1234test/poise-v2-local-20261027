export function isPowerOfTwo(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return false;
  }

  // Exact halving preserves all safe-integer bits, unlike Number bitwise checks.
  while (value % 2 === 0) {
    value /= 2;
  }
  return value === 1;
}
