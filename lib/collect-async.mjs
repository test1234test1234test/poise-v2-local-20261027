import { addAbortListener } from 'node:events';
import { types } from 'node:util';

const signalPrototype = AbortSignal.prototype;
const aborted = Object.getOwnPropertyDescriptor(signalPrototype, 'aborted').get;
const reason = Object.getOwnPropertyDescriptor(signalPrototype, 'reason').get;
const isObject = value => value !== null &&
  (typeof value === 'object' || typeof value === 'function');

function settle(waiter, succeeded, value) {
  const callback = succeeded ? waiter.resolve : waiter.reject;
  waiter.resolve = waiter.reject = undefined;
  // Box fulfillment so the wait does not assimilate a result a second time.
  callback?.(succeeded ? { value } : value);
}

// These reactions retain only a cleared waiter after interruption, not the
// collection loop, its output, iterator, signal or promise callbacks.
function observe(value, waiter) {
  try {
    // Promise.resolve can return a native promise with its own shadowed then.
    // Attach reactions through the prototype method, as await ignores that shadow.
    Promise.prototype.then.call(Promise.resolve(value),
      result => settle(waiter, true, result),
      error => settle(waiter, false, error),
    );
  } catch (error) {
    settle(waiter, false, error);
  }
}

async function finishClose(pending, synchronous) {
  const result = await pending;
  if (!isObject(result)) throw new TypeError('return result must be an object');
  if (synchronous) {
    Boolean(result.done);
    await result.value;
  }
}

function closeIterator(iterator, synchronous) {
  const close = iterator.return;
  if (close == null) return;
  if (typeof close !== 'function') throw new TypeError('return must be callable');
  // Only cleanup-result handling can outlive cancellation; it holds no
  // collector state and observes sync cleanup values as well as the result.
  return finishClose(Reflect.apply(close, iterator, []), synchronous);
}

/** Collect in order, with exact limits and prompt, non-draining cancellation. */
export async function collectAsync(iterable, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be a non-array object');
  }
  const configuredLimit = options.limit;
  const limit = configuredLimit === undefined ? Infinity : configuredLimit;
  if (typeof limit !== 'number') throw new TypeError('limit must be a number');
  if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new RangeError('limit must be Infinity or a nonnegative safe integer');
  }
  const signal = options.signal;
  if (signal !== undefined) {
    if (signal === null || typeof signal !== 'object' || types.isProxy(signal) ||
        Object.getPrototypeOf(signal) !== signalPrototype) {
      throw new TypeError('signal must be a native AbortSignal from this realm');
    }
    if (aborted.call(signal)) throw reason.call(signal);
  }
  const values = [];
  if (limit === 0) return values;

  let iterator, next, synchronous, subscription, waiter;
  let exhausted = false, cancelled = false, finished = false;
  let failed = false, failure;

  function fail(error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }

  function noticeAbort() {
    if (!cancelled && signal !== undefined && aborted.call(signal)) {
      cancelled = true;
      fail(reason.call(signal));
      subscription?.[Symbol.dispose]();
      subscription = undefined;
      if (waiter !== undefined) settle(waiter, false, failure);
    }
    return cancelled;
  }

  function checkAbort() {
    if (noticeAbort()) throw failure;
  }

  function subscribe() {
    if (finished || noticeAbort()) return;
    subscription = addAbortListener(signal, () => {
      subscription?.[Symbol.dispose]();
      subscription = undefined;
      if (!noticeAbort()) {
        // A synthetic event consumes the one-shot listener. Re-arm outside
        // dispatch, checking both real abort in the gap and stale completion.
        queueMicrotask(subscribe);
      }
    });
  }

  function wait(value) {
    const current = {};
    const promise = new Promise((resolve, reject) => {
      current.resolve = resolve;
      current.reject = reject;
    });
    waiter = current;
    // A source call can abort before returning its promise. Observe it even
    // then, before interrupting the wait. There is no shared abort promise.
    observe(value, current);
    if (noticeAbort()) settle(current, false, failure);
    return promise;
  }

  try {
    if (signal !== undefined) subscribe();
    checkAbort();
    let factory = iterable[Symbol.asyncIterator];
    checkAbort();
    synchronous = factory == null;
    if (synchronous) {
      factory = iterable[Symbol.iterator];
      checkAbort();
    }
    if (typeof factory !== 'function') {
      throw new TypeError('iterable must have a callable iterator factory');
    }
    const opened = Reflect.apply(factory, iterable, []);
    // Ownership starts before reading next, including a factory that aborts
    // and then returns an iterator. Never close inside an executing source call.
    if (isObject(opened)) iterator = opened;
    checkAbort();
    if (iterator === undefined) throw new TypeError('iterator must be an object');
    next = iterator.next;
    checkAbort();
    if (typeof next !== 'function') throw new TypeError('next must be callable');

    while (values.length < limit) {
      checkAbort();
      const pending = Reflect.apply(next, iterator, []);
      // Sync result objects are not assimilated, even if they are thenable.
      const result = synchronous ? pending : (await wait(pending)).value;
      checkAbort();
      if (!isObject(result)) throw new TypeError('next result must be an object');
      const done = Boolean(result.done);
      if (done) exhausted = true;
      checkAbort();
      // Async-from-sync awaits even terminal values. Manual async iterators
      // preserve payload identity and do not inspect terminal values.
      const value = synchronous ? (await wait(result.value)).value
        : done ? undefined : result.value;
      checkAbort();
      if (done) break;
      values.push(value);
    }
  } catch (error) {
    noticeAbort();
    fail(error);
  }

  try {
    if (iterator !== undefined && !exhausted) {
      const opened = iterator;
      // Relinquish close ownership before accessing return. Reentrant abort
      // cannot start another close, and a generator's next has now unwound.
      iterator = next = undefined;
      await wait(closeIterator(opened, synchronous));
      checkAbort();
    }
  } catch (error) {
    noticeAbort();
    fail(error);
  } finally {
    finished = true;
    subscription?.[Symbol.dispose]();
    subscription = waiter = undefined;
  }

  if (failed) throw failure;
  return values;
}
