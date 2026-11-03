/** Invoke once in a microtask, permanently sharing the resulting promise. */
export function onceAsync(fn) {
  if (typeof fn !== 'function') throw new TypeError('fn must be a function');

  let promise;
  return function (...args) {
    if (promise === undefined) {
      // Cache the reaction's promise before fn or its result can reenter. Native
      // resolution adopts the result directly, without per-caller forwarding.
      promise = Promise.resolve().then(() => Reflect.apply(fn, this, args));
    }
    return promise;
  };
}
