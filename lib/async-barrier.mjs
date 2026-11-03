import { addAbortListener } from 'node:events';
import { types } from 'node:util';

const signalPrototype = AbortSignal.prototype;
const aborted = Object.getOwnPropertyDescriptor(signalPrototype, 'aborted').get;
const reason = Object.getOwnPropertyDescriptor(signalPrototype, 'reason').get;
const isAborted = signal => signal !== undefined && aborted.call(signal);

function readSignal(options) {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be a non-array object');
  }
  const signal = options.signal;
  if (signal !== undefined) {
    // The native receiver check alone accepts some proxies/inherited wrappers.
    if (signal === null || typeof signal !== 'object' || types.isProxy(signal) ||
        Object.getPrototypeOf(signal) !== signalPrototype) {
      throw new TypeError('signal must be a native AbortSignal from this realm');
    }
    aborted.call(signal);
    // addAbortListener uses public signal members. Reject overrides without
    // invoking them, before registration can reenter or install then throw.
    for (const key of ['aborted', 'reason', 'addEventListener', 'removeEventListener']) {
      if (Object.hasOwn(signal, key)) throw new TypeError('signal members must not be shadowed');
    }
  }
  return signal;
}

/** Reusable FIFO rendezvous with synchronous release and per-arrival abort. */
export function createAsyncBarrier(parties) {
  if (typeof parties !== 'number') throw new TypeError('parties must be a number');
  if (!Number.isSafeInteger(parties) || parties <= 0) {
    throw new RangeError('parties must be a positive safe integer');
  }

  // Storage follows actual arrivals, even for Number.MAX_SAFE_INTEGER parties.
  const waiters = new Set();
  let generation = 0, closed = false, closeReason;

  function settle(waiter, result, rejected = false) {
    const callback = rejected ? waiter.reject : waiter.resolve;
    waiters.delete(waiter);
    waiter.subscription?.[Symbol.dispose]();
    // A queued synthetic-event re-arm may still retain this record.
    waiter.signal = waiter.subscription = waiter.resolve = waiter.reject = undefined;
    callback(result);
  }

  function subscribe(waiter) {
    if (!waiters.has(waiter)) return;
    if (isAborted(waiter.signal)) {
      settle(waiter, reason.call(waiter.signal), true);
      return;
    }
    waiter.subscription = addAbortListener(waiter.signal, () => {
      if (!waiters.has(waiter)) return;
      waiter.subscription?.[Symbol.dispose]();
      waiter.subscription = undefined;
      if (isAborted(waiter.signal)) {
        settle(waiter, reason.call(waiter.signal), true);
      } else {
        // Even synthetic events consume this propagation-resistant one-shot
        // listener. Re-arm outside dispatch to avoid revisiting shared-signal
        // listeners; subscribe also catches a real abort during the gap.
        queueMicrotask(() => subscribe(waiter));
      }
    });
  }

  function wait(options) {
    let signal;
    try {
      signal = readSignal(options);
    } catch (error) {
      return Promise.reject(error);
    }
    // Option getters may have closed the barrier or admitted a nested arrival.
    if (closed) return Promise.reject(closeReason);
    if (isAborted(signal)) return Promise.reject(reason.call(signal));

    return new Promise((resolve, reject) => {
      const waiter = { signal, resolve, reject, subscription: undefined };
      waiters.add(waiter);
      if (waiters.size === parties) {
        // An earlier external abort listener may submit the apparent final
        // arrival before our listener has removed the aborted participant.
        for (const entry of waiters) {
          if (isAborted(entry.signal)) settle(entry, reason.call(entry.signal), true);
        }
        if (waiters.size === parties) {
          const round = generation++;
          for (const entry of waiters) settle(entry, round);
          return;
        }
      }
      if (signal !== undefined) subscribe(waiter);
    });
  }

  function close(value) {
    if (closed) return false;
    closed = true;
    closeReason = value;
    for (const waiter of waiters) {
      // An abort already dispatching an earlier external listener wins.
      settle(waiter, isAborted(waiter.signal) ? reason.call(waiter.signal) : closeReason, true);
    }
    return true;
  }

  return {
    wait,
    close,
    get pending() {
      // Reflect real aborts even inside an earlier listener or a re-arm gap.
      let count = 0;
      for (const waiter of waiters) if (!isAborted(waiter.signal)) count++;
      return count;
    },
    get generation() { return generation; },
    get closed() { return closed; },
  };
}
