/** Collect first occurrences from finite synchronous iterables in argument order. */
export function unionOrdered(...iterables) {
  const result = [];
  const seen = new Set();
  for (const iterable of iterables) {
    for (const value of iterable) {
      if (!seen.has(value)) {
        seen.add(value);
        // Keep the original representative: Set membership normalizes -0 to +0.
        result.push(value);
      }
    }
  }
  return result;
}
