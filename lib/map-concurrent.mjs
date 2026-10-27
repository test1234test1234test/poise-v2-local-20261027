/** Map an Array in input order, with bounded work and draining cancellation. */
export async function mapConcurrent(items, mapper, options = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an Array');
  if (typeof mapper !== 'function') throw new TypeError('mapper must be a function');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be a non-array object');
  }
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'concurrency' && key !== 'signal') {
      throw new TypeError('unknown option');
    }
  }
  const concurrency = Object.hasOwn(options, 'concurrency') ? options.concurrency : 4;
  if (typeof concurrency !== 'number') throw new TypeError('concurrency must be a number');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive safe integer');
  }
  const signal = Object.hasOwn(options, 'signal') ? options.signal : undefined;
  if (signal !== undefined && (
    signal === null || typeof signal !== 'object' || Array.isArray(signal) ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function' ||
    typeof signal.aborted !== 'boolean' || !('reason' in signal)
  )) {
    throw new TypeError('signal must behave as an AbortSignal');
  }
  // Validation and pre-abort take priority even for an empty input.
  if (signal?.aborted) throw signal.reason;
  const length = items.length;
  if (length === 0) return [];

  return new Promise((resolve, reject) => {
    const results = new Array(length);
    let next = 0;
    let active = 0;
    let stopped = false;
    let reason;
    let settled = false;
    let listening = false;

    function finish() {
      if (settled || active !== 0 || (!stopped && next < length)) return;
      settled = true;
      if (listening) signal.removeEventListener('abort', onAbort);
      if (stopped) reject(reason);
      else resolve(results);
    }

    function stop(error) {
      // Outcome ownership is separate from the reason, which may be falsy.
      if (!stopped) {
        stopped = true;
        reason = error;
      }
      finish();
    }

    function onAbort() {
      stop(signal.reason);
    }

    function launch() {
      while (!stopped && active < concurrency && next < length) {
        const index = next++;
        // Count the call before entering user code: it can abort synchronously.
        active++;
        try {
          const mapped = mapper(items[index], index, signal);
          Promise.resolve(mapped).then(
            value => {
              results[index] = value;
              active--;
              launch();
            },
            error => {
              active--;
              stop(error);
            },
          );
        } catch (error) {
          // Observe a synchronous throw before the next initial/refill launch.
          active--;
          stop(error);
        }
      }
      finish();
    }

    if (signal !== undefined) {
      listening = true;
      signal.addEventListener('abort', onAbort);
      // Also support a signal that became aborted during listener registration.
      if (signal.aborted) onAbort();
    }
    launch();
  });
}
