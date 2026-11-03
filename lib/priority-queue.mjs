import { addAbortListener } from 'node:events';
import { types } from 'node:util';

const signalPrototype = AbortSignal.prototype;
const aborted = Object.getOwnPropertyDescriptor(signalPrototype, 'aborted').get;
const reason = Object.getOwnPropertyDescriptor(signalPrototype, 'reason').get;
const isAborted = signal => signal !== undefined && aborted.call(signal);

function validateOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be a non-array object');
  }
}

/** A stable priority queue whose concurrency bound includes cancelled running work. */
export function createPriorityQueue(options) {
  validateOptions(options);
  const { concurrency } = options;
  if (typeof concurrency !== 'number') throw new TypeError('concurrency must be a number');
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new RangeError('concurrency must be a positive safe integer');
  }

  // Set order breaks priority ties without a monotonically growing sequence id.
  // Deletion also releases cancelled callbacks even behind permanently busy work.
  const queued = new Set();
  const running = new Set();
  let idleWaiters = [];
  let closed = false, scheduled = false, dispatching = false;
  let closeError, closePromise, resolveClose;

  function drained() {
    if (queued.size || running.size) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
    resolveClose?.();
    resolveClose = undefined;
  }

  function unsubscribe(job) {
    job.subscription?.[Symbol.dispose]();
    job.subscription = undefined;
  }

  function commit(job, fulfilled, value) {
    if (job.committed) return;
    job.committed = true;
    unsubscribe(job);
    const settle = fulfilled ? job.resolve : job.reject;
    job.resolve = job.reject = job.promise = job.signal = undefined;
    settle(value);
  }

  function cancel(job) {
    if (job.committed || !isAborted(job.signal)) return;
    const rejection = reason.call(job.signal);
    if (queued.delete(job)) job.fn = job.resolveResult = job.rejectResult = undefined;
    commit(job, false, rejection);
    // Running ownership belongs to finish(), never to public settlement.
    drained();
  }

  function subscribe(job) {
    if (job.committed) return;
    if (isAborted(job.signal)) {
      cancel(job);
      return;
    }
    job.subscription = addAbortListener(job.signal, () => {
      if (job.committed) return;
      unsubscribe(job);
      if (isAborted(job.signal)) cancel(job);
      else {
        // A synthetic event consumes this one-shot listener. Re-arm outside
        // dispatch so new shared-signal listeners are not visited repeatedly.
        queueMicrotask(() => subscribe(job));
      }
    });
  }

  function reconcileAborts() {
    // Also works inside an earlier external listener and during synthetic-event
    // re-arming, before our subscription has received the real abort.
    for (const job of queued) cancel(job);
    for (const job of running) cancel(job);
  }

  function finish(job, fulfilled, value) {
    cancel(job);
    commit(job, fulfilled, value);
    running.delete(job);
    schedule();
    drained();
  }

  function dispatch() {
    scheduled = false;
    dispatching = true;
    while (running.size < concurrency && queued.size) {
      let next;
      for (const job of queued) {
        cancel(job);
        if (!job.committed && (next === undefined || job.priority > next.priority)) next = job;
      }
      if (next === undefined) break;
      queued.delete(next);
      running.add(next);
      const { fn, promise, signal, resolveResult, rejectResult } = next;
      next.fn = next.resolveResult = next.rejectResult = undefined;
      try {
        const value = fn(signal ?? new AbortController().signal);
        if (value === promise) throw new TypeError('A job cannot return its own promise');
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
      // Select again after caller code: it may submit, cancel or close the queue.
    }
    dispatching = false;
    drained();
  }

  function schedule() {
    if (scheduled || dispatching || !queued.size || running.size >= concurrency) return;
    scheduled = true;
    queueMicrotask(dispatch);
  }

  function submit(fn, options = {}) {
    let priority, signal;
    try {
      if (typeof fn !== 'function') throw new TypeError('fn must be a function');
      validateOptions(options);
      priority = options.priority;
      if (priority === undefined) priority = 0;
      if (typeof priority !== 'number' || !Number.isFinite(priority)) {
        throw new TypeError('priority must be a finite number');
      }
      signal = options.signal;
      if (signal !== undefined) {
        if (signal === null || typeof signal !== 'object' || types.isProxy(signal) ||
            Object.getPrototypeOf(signal) !== signalPrototype) {
          throw new TypeError('signal must be a native AbortSignal from this realm');
        }
        aborted.call(signal);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    // Validation getters may themselves submit work, close or abort.
    if (closed) return Promise.reject(closeError);
    if (isAborted(signal)) return Promise.reject(reason.call(signal));

    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    let resolveResult = resolve, rejectResult = reject;
    // Without cancellation, the public promise also tracks physical completion.
    // Cancellable work needs its own result promise, which abort cannot settle.
    const result = signal === undefined ? promise : new Promise((yes, no) => {
      resolveResult = yes;
      rejectResult = no;
    });
    const job = { fn, priority, signal, promise, resolve, reject,
      resolveResult, rejectResult, committed: false };
    // Register before returning the public promise. Both handlers return
    // undefined, and observe physical completion even after public cancellation.
    result.then(value => finish(job, true, value), error => finish(job, false, error));
    queued.add(job);
    if (signal !== undefined) subscribe(job);
    schedule();
    return promise;
  }

  function close() {
    if (closed) return closePromise;
    closed = true;
    closeError = Object.assign(new Error('Priority queue is closed'), { code: 'QUEUE_CLOSED' });
    closePromise = new Promise(resolve => { resolveClose = resolve; });
    reconcileAborts();
    drained();
    return closePromise;
  }

  function onIdle() {
    reconcileAborts();
    if (!queued.size && !running.size) {
      drained();
      return Promise.resolve();
    }
    return new Promise(resolve => { idleWaiters.push(resolve); });
  }

  return {
    submit,
    close,
    onIdle,
    get active() { return running.size; },
    get pending() {
      let count = 0;
      for (const job of queued) if (!isAborted(job.signal)) count++;
      return count;
    },
    get closed() { return closed; },
  };
}
