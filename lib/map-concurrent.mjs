import { addAbortListener } from 'node:events';

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
    let subscription;

    function checkAbort() {
      if (!stopped && signal?.aborted) {
        stopped = true;
        reason = signal.reason;
      }
      return stopped;
    }

    function finish() {
      checkAbort();
      if (settled || active !== 0 || (!stopped && next < length)) return;
      settled = true;
      subscription?.[Symbol.dispose]();
      subscription = undefined;
      if (stopped) reject(reason);
      else resolve(results);
    }

    function stop(error) {
      // Outcome ownership is separate from the reason, which may be falsy.
      if (!checkAbort()) {
        stopped = true;
        reason = error;
      }
      finish();
    }

    function onAbort() {
      if (settled) return;
      subscription?.[Symbol.dispose]();
      subscription = undefined;
      if (checkAbort()) finish();
      // A synthetic event consumes the protected one-shot listener too.
      // Re-arm outside dispatch so shared signals cannot revisit new listeners.
      else queueMicrotask(subscribe);
    }

    function subscribe() {
      if (settled || stopped) return;
      if (checkAbort()) {
        finish();
        return;
      }
      subscription?.[Symbol.dispose]();
      subscription = addAbortListener(signal, onAbort);
      // Signal-like registration hooks can abort before returning the handle.
      if (settled) {
        subscription[Symbol.dispose]();
        subscription = undefined;
      } else {
        finish();
      }
    }

    function launch() {
      while (!checkAbort() && active < concurrency && next < length) {
        const index = next++;
        // Count the call before entering user code: it can abort synchronously.
        active++;
        try {
          const item = items[index];
          // Reading an item can abort. Only an invoked mapper needs draining.
          if (checkAbort()) {
            active--;
            break;
          }
          const mapped = mapper(item, index, signal);
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
      subscribe();
    }
    launch();
  });
}
