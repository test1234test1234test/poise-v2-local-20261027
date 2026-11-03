/** Trailing-edge debounce with one promise and timer per waiting batch. */
export function debounceAsync(fn, delayMs) {
  if (typeof fn !== 'function') throw new TypeError('fn must be a function');
  if (typeof delayMs !== 'number') throw new TypeError('delayMs must be a number');
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 2147483647) {
    throw new RangeError('delayMs must be an integer from 0 through 2147483647');
  }

  let waiting;

  function detach(batch) {
    waiting = undefined;
    clearTimeout(batch.timer);
    batch.timer = batch.args = batch.receiver = undefined;
    batch.promise = batch.resolve = batch.reject = undefined;
  }

  function start(batch) {
    if (waiting !== batch) return;
    const { promise, resolve, reject, args, receiver } = batch;
    // Detach before either fn or a then getter can reenter the callable. No
    // running invocation or its settlement ever owns the next waiting batch.
    detach(batch);
    try {
      resolve(Reflect.apply(fn, receiver, args));
    } catch (error) {
      reject(error);
    }
    return promise;
  }

  function debounced(...args) {
    if (waiting === undefined) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      waiting = { promise, resolve, reject };
    }
    const batch = waiting;
    clearTimeout(batch.timer);
    batch.args = args;
    batch.receiver = this;
    batch.timer = setTimeout(() => { start(batch); }, delayMs);
    // Share the public promise itself: forwarding its value through additional
    // promises could assimilate a stateful thenable again for each caller.
    return batch.promise;
  }

  Object.defineProperty(debounced, 'pending', {
    get() { return waiting !== undefined; },
  });

  debounced.flush = function () {
    return waiting === undefined ? Promise.resolve(undefined) : start(waiting);
  };

  debounced.cancel = function (reason) {
    if (waiting === undefined) return;
    const batch = waiting;
    const { reject } = batch;
    detach(batch);
    if (arguments.length === 0) {
      reason = new Error('Debounced call canceled');
      reason.name = 'AbortError';
    }
    reject(reason);
  };

  return debounced;
}
