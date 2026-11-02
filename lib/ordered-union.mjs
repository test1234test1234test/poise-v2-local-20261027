function isObject(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/** Yield first occurrences from synchronous sources in argument order. */
export function* orderedUnion(...sources) {
  const seen = new Set();
  for (const source of sources) {
    const method = source?.[Symbol.iterator];
    if (typeof method !== 'function') {
      throw new TypeError('Each source must be a synchronous iterable');
    }
    const iterator = Reflect.apply(method, source, []);
    if (!isObject(iterator)) throw new TypeError('Iterators must be objects');

    let done = false;
    let failed = false;
    try {
      // Own the iterator before reading next, and capture that method only once.
      const next = iterator.next;
      if (typeof next !== 'function') throw new TypeError('Iterator next must be a function');
      while (true) {
        const result = Reflect.apply(next, iterator, []);
        if (!isObject(result)) throw new TypeError('Iterator results must be objects');
        if (result.done) {
          done = true;
          break;
        }
        const value = result.value;
        if (!seen.has(value)) {
          seen.add(value);
          // Yield the original representative, preserving even a first -0.
          yield value;
        }
      }
    } catch (error) {
      // A separate flag also preserves falsy source and consumer throws.
      failed = true;
      throw error;
    } finally {
      if (!done) {
        try {
          const close = iterator.return;
          if (close !== undefined && close !== null) {
            if (typeof close !== 'function') {
              throw new TypeError('Iterator return must be a function');
            }
            const result = Reflect.apply(close, iterator, []);
            if (!isObject(result)) throw new TypeError('Iterator return must return an object');
          }
        } catch (error) {
          // Cleanup may fail an ordinary return, but never replace a pending throw.
          if (!failed) throw error;
        }
      }
    }
  }
}
