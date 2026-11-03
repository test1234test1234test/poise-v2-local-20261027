import { addAbortListener } from 'node:events';
import { types } from 'node:util';

const signalPrototype = AbortSignal.prototype;
const aborted = Object.getOwnPropertyDescriptor(signalPrototype, 'aborted').get;
const reason = Object.getOwnPropertyDescriptor(signalPrototype, 'reason').get;
const isAborted = signal => signal !== undefined && aborted.call(signal);

/** Serial execution per Map key, with cancellation only before callback entry. */
export function createKeyedSerialExecutor() {
  const lanes = new Map();
  let closed = false;
  let running = 0;
  let closeError, closePromise, resolveClose;

  function retire(lane) {
    if (!lane.running && lane.jobs.size === 0) {
      lanes.delete(lane.key);
      lane.key = undefined;
    }
  }

  function remove(job) {
    job.lane.jobs.delete(job);
    job.subscription?.[Symbol.dispose]();
    // A synthetic-event re-arm may still hold this record. It must retain
    // neither the queue nor the cancelled callback, signal or promise.
    job.lane = job.fn = job.signal = job.promise = undefined;
    job.resolve = job.reject = job.subscription = undefined;
  }

  function cancel(job, rejection) {
    const { lane, reject } = job;
    remove(job);
    retire(lane);
    reject(rejection);
  }

  function subscribe(job) {
    if (job.lane === undefined) return;
    if (isAborted(job.signal)) {
      cancel(job, reason.call(job.signal));
      return;
    }
    job.subscription = addAbortListener(job.signal, () => {
      // Disposing an already-aborted subscription need not cancel its queued
      // notification, and close may run in an earlier external listener.
      if (job.lane === undefined) return;
      job.subscription?.[Symbol.dispose]();
      job.subscription = undefined;
      if (isAborted(job.signal)) {
        cancel(job, reason.call(job.signal));
      } else {
        // Synthetic events consume the one-shot subscription too. Re-arm
        // outside dispatch, so shared signals cannot revisit new listeners.
        // subscribe checks for real cancellation during this microtask gap.
        queueMicrotask(() => subscribe(job));
      }
    });
  }

  function drained() {
    if (closed && running === 0 && resolveClose !== undefined) {
      resolveClose();
      resolveClose = undefined;
    }
  }

  function schedule(lane) {
    if (lane.running || lane.scheduled || lane.jobs.size === 0) return;
    lane.scheduled = true;
    queueMicrotask(() => start(lane));
  }

  function finish(lane) {
    lane.running = false;
    running--;
    retire(lane);
    schedule(lane);
    drained();
  }

  function start(lane) {
    lane.scheduled = false;
    // An empty, retired lane can have a stale scheduled start. In particular,
    // it must never delete or start a replacement lane for the same key.
    for (const job of lane.jobs) {
      if (isAborted(job.signal)) {
        cancel(job, reason.call(job.signal));
        continue;
      }
      const { fn, promise, resolve, reject } = job;
      lane.running = true;
      running++;
      remove(job);
      // The public promise alone adopts the callback result. Observing that
      // exact promise avoids a second then-getter read and handles self-return
      // with native self-resolution rejection. Both handlers return undefined.
      promise.then(() => finish(lane), () => finish(lane));
      try {
        resolve(fn());
      } catch (error) {
        reject(error);
      }
      return;
    }
  }

  function run(key, fn, options = {}) {
    let signal;
    try {
      if (typeof fn !== 'function') throw new TypeError('fn must be a function');
      if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('options must be a non-array object');
      }
      signal = options.signal;
      if (signal !== undefined) {
        // The native getter alone also accepts some wrappers on Node. Reject
        // proxies and inherited-signal wrappers, and require this realm's
        // unmodified prototype as well as the native receiver check.
        if (signal === null || typeof signal !== 'object' || types.isProxy(signal) ||
            Object.getPrototypeOf(signal) !== signalPrototype) {
          throw new TypeError('signal must be a native AbortSignal from this realm');
        }
        aborted.call(signal);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    // Getters can close the executor or admit nested jobs during validation.
    if (closed) return Promise.reject(closeError);
    if (isAborted(signal)) return Promise.reject(reason.call(signal));

    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    let lane = lanes.get(key);
    if (lane === undefined) {
      lane = { key, jobs: new Set(), running: false, scheduled: false };
      lanes.set(key, lane);
    }
    const job = { lane, fn, signal, promise, resolve, reject, subscription: undefined };
    // Set insertion order gives FIFO; deletion unlinks cancellation immediately.
    lane.jobs.add(job);
    if (signal !== undefined) subscribe(job);
    schedule(lane);
    return promise;
  }

  function close() {
    if (closed) return closePromise;
    closed = true;
    closeError = Object.assign(new Error('Executor is closed'), { code: 'EXECUTOR_CLOSED' });
    closePromise = new Promise(resolve => { resolveClose = resolve; });
    for (const lane of lanes.values()) {
      for (const job of lane.jobs) {
        // An abort already dispatching an earlier external listener wins.
        cancel(job, isAborted(job.signal) ? reason.call(job.signal) : closeError);
      }
    }
    drained();
    return closePromise;
  }

  return {
    run,
    close,
    get pending() {
      // Reflect cancellation even during an earlier external abort listener
      // or the synthetic-event re-arm gap, before our callback can unlink it.
      let count = 0;
      for (const lane of lanes.values()) {
        for (const job of lane.jobs) if (!isAborted(job.signal)) count++;
      }
      return count;
    },
    get closed() { return closed; },
  };
}
