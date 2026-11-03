import { addAbortListener } from 'node:events';
import { types } from 'node:util';

const signalPrototype = AbortSignal.prototype;
const aborted = Object.getOwnPropertyDescriptor(signalPrototype, 'aborted').get;
const reason = Object.getOwnPropertyDescriptor(signalPrototype, 'reason').get;
const isAborted = signal => signal !== undefined && aborted.call(signal);

function checkAbort(signal) {
  if (isAborted(signal)) throw reason.call(signal);
}

function validateLimit(value, name, minimum, maximum) {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
}

// Only an idle delay needs a subscription. Running callbacks are always awaited
// in full, then checked for abort, so cancellation cannot leave work behind.
function waitForDelay(delayMs, signal) {
  return new Promise((resolve, reject) => {
    let timer, subscription;
    let settled = false;

    function cleanup() {
      settled = true;
      clearTimeout(timer);
      subscription?.[Symbol.dispose]();
      subscription = undefined;
    }

    function finish() {
      if (settled) return;
      cleanup();
      if (isAborted(signal)) reject(reason.call(signal));
      else resolve();
    }

    function subscribe() {
      if (settled) return;
      if (isAborted(signal)) {
        finish();
        return;
      }
      subscription = addAbortListener(signal, () => {
        if (settled) return;
        subscription?.[Symbol.dispose]();
        subscription = undefined;
        if (isAborted(signal)) finish();
        // Synthetic events consume the one-shot listener. Re-arm outside the
        // dispatch, checking for a real abort in the gap and stale completion.
        else queueMicrotask(subscribe);
      });
    }

    try {
      timer = setTimeout(finish, delayMs);
      if (signal !== undefined) subscribe();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/** Retry sequentially; abort drains the active callback before rejecting. */
export async function retryAsync(operation, options = {}) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be a non-array object');
  }
  const attempts = 'attempts' in options ? options.attempts : 3;
  const delayMs = 'delayMs' in options ? options.delayMs : 0;
  const shouldRetry = options.shouldRetry;
  const signal = options.signal;
  validateLimit(attempts, 'attempts', 1, 1000);
  validateLimit(delayMs, 'delayMs', 0, 2147483647);
  if (shouldRetry !== undefined && typeof shouldRetry !== 'function') {
    throw new TypeError('shouldRetry must be a function');
  }
  if (signal !== undefined) {
    // Node's native getter alone accepts some wrappers. Require the current
    // realm's exact prototype and reject proxies before the receiver check.
    if (signal === null || typeof signal !== 'object' || types.isProxy(signal) ||
        Object.getPrototypeOf(signal) !== signalPrototype) {
      throw new TypeError('signal must be a native AbortSignal from this realm');
    }
    aborted.call(signal);
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    checkAbort(signal);
    let value, failure;
    let succeeded = false;
    try {
      value = await operation(attempt);
      succeeded = true;
    } catch (error) {
      failure = error;
    }
    checkAbort(signal);
    if (succeeded) return value;
    if (attempt === attempts) throw failure;

    if (shouldRetry !== undefined) {
      checkAbort(signal);
      let decision;
      try {
        decision = await shouldRetry(failure, attempt);
      } finally {
        // Abort owns even a hook rejection or an invalid decision, but only
        // after the hook's entire returned result (including cleanup) settles.
        checkAbort(signal);
      }
      if (typeof decision !== 'boolean') throw new TypeError('shouldRetry must return a boolean');
      if (!decision) throw failure;
    }
    if (delayMs > 0) await waitForDelay(delayMs, signal);
  }
}
