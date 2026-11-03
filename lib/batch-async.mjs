const isObject = value => value !== null &&
  (typeof value === 'object' || typeof value === 'function');

/** Lazily batch an iterable, serializing consumer requests per iterator. */
export function batchAsync(source, size) {
  if (typeof size !== 'number') throw new TypeError('size must be a number');
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new RangeError('size must be a positive safe integer');
  }

  return {
    // The generator's request queue serializes next/return/throw, including
    // cleanup. Its body does not run for an unused iterator or an initial return.
    async *[Symbol.asyncIterator]() {
      let iterator;
      let exhausted = false;
      let failed = false;
      let synchronous;
      try {
        let factory = source[Symbol.asyncIterator];
        synchronous = factory == null;
        if (synchronous) factory = source[Symbol.iterator];
        if (typeof factory !== 'function') {
          throw new TypeError('source must have a callable iterator factory');
        }
        const opened = Reflect.apply(factory, source, []);
        if (!isObject(opened)) throw new TypeError('iterator must be an object');
        iterator = opened;
        // Capture next once, as GetIterator does; methods keep their receiver.
        const next = iterator.next;
        if (typeof next !== 'function') throw new TypeError('next must be callable');

        while (!exhausted) {
          const group = [];
          for (let index = 0; index < size; index++) {
            const pending = Reflect.apply(next, iterator, []);
            const result = synchronous ? pending : await pending;
            if (!isObject(result)) throw new TypeError('next result must be an object');
            const done = Boolean(result.done);
            if (done) exhausted = true;
            // Async-from-sync reads/awaits value even on a terminal result.
            // Async iterators already resolve their results; preserve their
            // yielded values verbatim and do not inspect terminal values.
            const value = synchronous ? await result.value : done ? undefined : result.value;
            if (done) break;
            group.push(value);
          }
          if (group.length > 0) yield group;
        }
      } catch (error) {
        // A falsy thrown value is still an original failure.
        failed = true;
        throw error;
      } finally {
        if (iterator !== undefined && !exhausted) {
          try {
            const close = iterator.return;
            if (close != null) {
              if (typeof close !== 'function') throw new TypeError('return must be callable');
              // Cleanup must finish even when a sync source returns a promise.
              const result = await Reflect.apply(close, iterator, []);
              if (!isObject(result)) throw new TypeError('return result must be an object');
              if (synchronous) {
                // Complete the async-from-sync return, including its value.
                Boolean(result.done);
                await result.value;
              }
            }
          } catch (error) {
            if (!failed) throw error;
          }
        }
      }
    },
  };
}
