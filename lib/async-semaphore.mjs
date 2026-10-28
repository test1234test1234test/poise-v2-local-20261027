import { addAbortListener } from 'node:events';

// Native getters validate the receiver, unlike instanceof or duck typing, and
// read cancellation state without invoking caller-defined property getters.
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const reason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get;
const isAborted = signal => signal !== undefined && aborted.call(signal);

/** FIFO permits with explicit ownership; this class never starts work. */
export class AsyncSemaphore {
  #capacity;
  #active = 0;
  #closed = false;
  #reason;
  // Set insertion order supplies FIFO and deletion unlinks canceled requests.
  #waiters = new Set();

  constructor(capacity) {
    if (typeof capacity !== 'number') throw new TypeError('capacity must be a number');
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError('capacity must be a positive safe integer');
    }
    this.#capacity = capacity;
  }

  get capacity() { return this.#capacity; }
  get active() { return this.#active; }
  get closed() { return this.#closed; }
  get waiting() {
    // An earlier caller abort listener can read this before our callback runs.
    let count = 0;
    for (const waiter of this.#waiters) {
      if (!isAborted(waiter.signal)) count++;
    }
    return count;
  }

  async acquire(options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be a non-array object');
    }
    for (const key of Reflect.ownKeys(options)) {
      if (key !== 'signal') throw new TypeError('unknown option');
    }
    const signal = Object.hasOwn(options, 'signal') ? options.signal : undefined;
    // Validate even after close. A prototype-only imitation fails this check.
    if (signal !== undefined) aborted.call(signal);
    if (this.#closed) throw this.#reason;
    if (isAborted(signal)) throw reason.call(signal);
    if (this.#active < this.#capacity && this.#waiters.size === 0) {
      return this.#grant();
    }
    return new Promise((resolve, reject) => {
      const waiter = { signal, resolve, reject, subscription: undefined };
      this.#waiters.add(waiter);
      if (signal !== undefined) this.#subscribe(waiter);
    });
  }

  close(closeReason) {
    if (this.#closed) return;
    this.#closed = true;
    this.#reason = closeReason === undefined ? new Error('Semaphore is closed') : closeReason;
    for (const waiter of this.#waiters) {
      // Cancellation may already be dispatching an earlier caller listener.
      const rejection = isAborted(waiter.signal) ? reason.call(waiter.signal) : this.#reason;
      this.#reject(waiter, rejection);
    }
  }

  #grant() {
    this.#active++;
    let semaphore = this;
    return function release() {
      if (semaphore === undefined) return;
      const owner = semaphore;
      semaphore = undefined;
      owner.#active--;
      owner.#drain();
    };
  }

  #drain() {
    if (this.#closed) return;
    for (const waiter of this.#waiters) {
      if (this.#active === this.#capacity) break;
      if (isAborted(waiter.signal)) {
        this.#reject(waiter, reason.call(waiter.signal));
      } else {
        const resolve = waiter.resolve;
        this.#remove(waiter);
        resolve(this.#grant());
      }
    }
  }

  #subscribe(waiter) {
    if (!this.#waiters.has(waiter)) return;
    if (isAborted(waiter.signal)) {
      this.#reject(waiter, reason.call(waiter.signal));
      return;
    }
    waiter.subscription = addAbortListener(waiter.signal, () => {
      waiter.subscription[Symbol.dispose]();
      waiter.subscription = undefined;
      if (isAborted(waiter.signal)) {
        this.#reject(waiter, reason.call(waiter.signal));
      } else {
        // addAbortListener resists stopImmediatePropagation but is one-shot,
        // even for synthetic events. Re-arm outside dispatch so shared signals
        // cannot repeatedly visit newly appended listeners in the same event.
        // #subscribe also catches a real abort during this microtask gap.
        queueMicrotask(() => this.#subscribe(waiter));
      }
    });
  }

  #reject(waiter, rejection) {
    const reject = waiter.reject;
    this.#remove(waiter);
    reject(rejection);
  }

  #remove(waiter) {
    this.#waiters.delete(waiter);
    waiter.subscription?.[Symbol.dispose]();
    // Also clear references held by a pending synthetic-event re-arm callback.
    waiter.signal = waiter.resolve = waiter.reject = waiter.subscription = undefined;
  }
}
