/** Split own array values into stable, dense groups using predicate truthiness. */
export function partitionStable(values, predicate) {
  if (!Array.isArray(values)) {
    throw new TypeError('values must be an Array');
  }
  if (typeof predicate !== 'function') {
    throw new TypeError('predicate must be a function');
  }

  const matching = [];
  const remaining = [];
  const length = values.length;
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(values, index)) continue;
    const value = values[index];
    const group = predicate(value, index, values) ? matching : remaining;
    // Define own slots so inherited numeric setters or read-only properties cannot interfere.
    Object.defineProperty(group, group.length, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return [matching, remaining];
}
