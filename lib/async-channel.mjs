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
    // Node's receiver check alone can accept proxies or inherited wrappers.
    if (signal === null || typeof signal !== 'object' || types.isProxy(signal) ||
        Object.getPrototypeOf(signal) !== signalPrototype) {
      throw new TypeError('signal must be a native AbortSignal from this realm');
    }
    aborted.call(signal);
  }
  return signal;
}

/** A bounded FIFO with synchronous acceptance and cancellable backpressure. */
export function createAsyncChannel(capacity) {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new TypeError('capacity must be a positive safe integer');
  }

  let head = null, tail = null, size = 0;
  let closed = false, closeError;
  // Insertion order supplies FIFO; deletion unlinks canceled operations.
  const senders = new Set(), receivers = new Set();

  function settle(waiter, result, rejected = false) {
    const callback = rejected ? waiter.reject : waiter.resolve;
    waiter.queue.delete(waiter);
    waiter.subscription?.[Symbol.dispose]();
    // A pending synthetic-event re-arm can still hold this record. Release
    // its payload, signal, queue and promise callbacks on every exit path.
    waiter.queue = waiter.value = waiter.signal = waiter.subscription = undefined;
    waiter.resolve = waiter.reject = undefined;
    callback(result);
  }

  function firstLive(queue) {
    for (const waiter of queue) {
      // An earlier external abort listener may be triggering this handoff.
      if (isAborted(waiter.signal)) settle(waiter, reason.call(waiter.signal), true);
      else return waiter;
    }
  }

  function advance() {
    while (true) {
      const receiver = firstLive(receivers);
      if (receiver !== undefined && size > 0) {
        const value = head.value;
        head = head.next;
        size--;
        if (head === null) tail = null;
        settle(receiver, { value, done: false });
        continue;
      }
      if (!closed && size < capacity) {
        const sender = firstLive(senders);
        if (sender !== undefined) {
          const value = sender.value;
          if (receiver === undefined) {
            const node = { value, next: null };
            if (tail === null) head = node;
            else tail.next = node;
            tail = node;
            size++;
          }
          settle(sender, undefined);
          if (receiver !== undefined) settle(receiver, { value, done: false });
          continue;
        }
      }
      if (closed && size === 0 && receiver !== undefined) {
        settle(receiver, { value: undefined, done: true });
        continue;
      }
      return;
    }
  }

  function subscribe(waiter) {
    if (waiter.queue === undefined) return;
    if (isAborted(waiter.signal)) {
      settle(waiter, reason.call(waiter.signal), true);
      return;
    }
    waiter.subscription = addAbortListener(waiter.signal, () => {
      if (waiter.queue === undefined) return;
      waiter.subscription?.[Symbol.dispose]();
      waiter.subscription = undefined;
      if (isAborted(waiter.signal)) {
        settle(waiter, reason.call(waiter.signal), true);
      } else {
        // The listener resists stopImmediatePropagation but is one-shot even
        // for synthetic events.
        // Re-arm outside dispatch to avoid revisiting new shared-signal
        // listeners; subscribe catches a real abort during the microtask gap.
        queueMicrotask(() => subscribe(waiter));
      }
    });
  }

  function enqueue(queue, signal, value) {
    return new Promise((resolve, reject) => {
      const waiter = { queue, signal, value, resolve, reject, subscription: undefined };
      queue.add(waiter);
      advance();
      // Immediately settled operations never need an abort subscription.
      if (waiter.queue !== undefined && signal !== undefined) subscribe(waiter);
    });
  }

  function send(value, options) {
    let signal;
    try {
      signal = readSignal(options);
    } catch (error) {
      return Promise.reject(error);
    }
    // Option getters can reenter the channel; inspect current state afterwards.
    if (isAborted(signal)) return Promise.reject(reason.call(signal));
    if (closed) return Promise.reject(closeError);
    return enqueue(senders, signal, value);
  }

  function receive(options) {
    let signal;
    try {
      signal = readSignal(options);
    } catch (error) {
      return Promise.reject(error);
    }
    if (isAborted(signal)) return Promise.reject(reason.call(signal));
    return enqueue(receivers, signal, undefined);
  }

  function close() {
    if (closed) return false;
    closed = true;
    closeError = Object.assign(new Error('Channel is closed'), { code: 'CHANNEL_CLOSED' });
    for (const sender of senders) {
      settle(sender, isAborted(sender.signal) ? reason.call(sender.signal) : closeError, true);
    }
    advance();
    return true;
  }

  return {
    get size() { return size; },
    get closed() { return closed; },
    send,
    receive,
    close,
  };
}
