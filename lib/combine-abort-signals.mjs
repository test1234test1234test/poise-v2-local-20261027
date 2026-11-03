import { types } from 'node:util';

const signalPrototype = AbortSignal.prototype;
const aborted = Object.getOwnPropertyDescriptor(signalPrototype, 'aborted').get;
const reason = Object.getOwnPropertyDescriptor(signalPrototype, 'reason').get;

/** Combine native signals until the first abort or explicit disposal. */
export function combineAbortSignals(signals) {
  if (!Array.isArray(signals)) throw new TypeError('signals must be an array');
  const sources = new Set();
  const length = signals.length;
  for (let index = 0; index < length; index++) {
    if (!Object.hasOwn(signals, index)) throw new TypeError('signals must not contain holes');
    const signal = signals[index];
    // Node's native receiver check alone accepts some inherited/proxy wrappers.
    if (signal === null || typeof signal !== 'object' || types.isProxy(signal) ||
        Object.getPrototypeOf(signal) !== signalPrototype) {
      throw new TypeError('signals must contain native AbortSignals from this realm');
    }
    aborted.call(signal);
    sources.add(signal);
  }

  const controller = new AbortController();
  // Native composition records the winner before source event dispatch. This
  // preserves abort order during nested dispatch and stopImmediatePropagation.
  // Only this private bridge gets an owned listener; the output is detachable.
  let bridge = AbortSignal.any([...sources]);

  function detach() {
    const current = bridge;
    bridge = undefined;
    current?.removeEventListener('abort', forward);
  }

  function forward() {
    if (bridge === undefined || !aborted.call(bridge)) return;
    const winner = reason.call(bridge);
    detach();
    controller.abort(winner);
  }

  function dispose() {
    // An abort already in progress wins, even when a source's earlier listener
    // calls dispose before the bridge's event has been dispatched.
    forward();
    detach();
  }

  const subscribing = bridge;
  try {
    if (sources.size > 0 && !aborted.call(subscribing)) {
      subscribing.addEventListener('abort', forward);
    }
    // Registration hooks can abort before the native listener is installed.
    forward();
  } catch (error) {
    detach();
    throw error;
  } finally {
    // A registration hook can dispatch abort, then install the listener after
    // detach ran (or install and throw). Remove that in-progress registration.
    if (bridge === undefined) subscribing.removeEventListener('abort', forward);
  }

  return { signal: controller.signal, dispose };
}
