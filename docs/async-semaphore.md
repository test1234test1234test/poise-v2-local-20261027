# Bounded asynchronous work with explicit permits

```js
import { AsyncSemaphore } from '../lib/async-semaphore.mjs';

const semaphore = new AsyncSemaphore(4);

async function doBoundedWork(work, signal) {
  const release = await semaphore.acquire({ signal });
  try {
    signal?.throwIfAborted();
    return await work();
  } finally {
    release();
  }
}
```

Acquire before entering the `try`, check optional cancellation inside it, and
await the work before `finally` releases the permit. This keeps the permit for
the entire asynchronous operation, including failure. An abort between grant
and the consumer's continuation still leaves an owned permit to release.

`AsyncSemaphore` is a named ESM export for Node.js 22. It never starts jobs or
creates timers, intervals, network requests, or persistent workers. Acquisitions
and releases are short, atomic state transitions, not leases: a holder owns its
permit until it explicitly releases it, even after cancellation or closure.
Capacity bounds held permits; queued demand is not bounded by capacity.

## API and ownership

- `new AsyncSemaphore(capacity)` requires a primitive number that is a positive
  safe integer. Wrong types (including omission, boxed numbers, and BigInts)
  throw `TypeError`. Zero, negative zero, negatives, fractions, `NaN`, infinities,
  and unsafe integers throw `RangeError`. `Number.MAX_SAFE_INTEGER` is accepted
  without allocating capacity-sized storage.
- `acquire(options = {})` always returns a Promise resolving to a zero-argument
  release function. A free permit is granted immediately when no waiter is
  ahead. Otherwise live waiters receive permits in strict FIFO order.
- The release function returns `undefined`. Only its first call returns the
  permit and hands it to the next live waiter. An old release cannot release a
  later owner's permit, even after several handoffs or closure.
- `capacity`, `active`, `waiting`, and `closed` are read-only getters. `active`
  counts owned permits, from zero through capacity. `waiting` counts unresolved,
  nonaborted queued acquisitions and can exceed capacity. It excludes aborted
  signals even inside an earlier caller abort listener, before the semaphore's
  own cancellation callback runs. Reading it scans queued requests.

Every grant reserves ownership, updates counters, removes the waiter, and
detaches cancellation **synchronously before `acquire()` or `release()` returns**.
Promise reactions run later. Thus `releaseA(); abortB()` or
`releaseA(); semaphore.close(reason)` preserves B's newly granted permit.
Reversing those operations cancels/rejects B before handoff. A new acquisition
in the same turn as release cannot overtake older live waiters.

## Validation and cancellation

Validation runs first, then closure, then pre-abort, then grant or queue. Invalid
calls reject with validation errors even after closure; every valid post-close
call rejects with the first close reason, including calls with aborted signals.
Validation errors and exceptions from option getters reject the returned
Promise without a synchronous throw or mutation by the failed acquisition.
Caller-defined getters can still perform their own side effects.

Options must be a non-null, non-array object; omitted or `undefined` options
mean `{}`. Only an own `signal` key is accepted. Unknown own keys, including
symbols and non-enumerable keys, reject with `TypeError`. Inherited options are
ignored. An own signal is read once; absent or `undefined` means no signal.
Any other value must pass the native AbortSignal receiver check. Controller
signals, `AbortSignal.abort()` and `AbortSignal.any()` are accepted; duck-typed
objects and `Object.create(AbortSignal.prototype)` reject with `TypeError`.
This stricter contract does not change `mapConcurrent`'s signal-like inputs.

A pre-aborted signal rejects with its exact reason without consuming a permit.
Aborting a queued request unlinks it and rejects with the exact `signal.reason`.
After grant, cancellation cannot reclaim the permit. Cancellation is checked
again during handoff, including when an earlier caller abort listener releases
a permit before the semaphore's cancellation callback runs.

Cancellation uses Node's
[`addAbortListener`](https://nodejs.org/docs/latest-v22.x/api/events.html#eventsaddabortlistenersignal-listener)
so another listener's `stopImmediatePropagation()` cannot suppress it. Synthetic
`abort` events while the signal is not aborted neither cancel nor disable later
cancellation. After such an event the one-shot subscription is re-armed in a
microtask, which also checks for a real abort in the gap. Handoff, close, and
`waiting` still use current signal state during that gap.
Subscriptions are removed on grant, abort, or close without removing caller or
other acquisition listeners. Settled queue records are deleted and their signal,
subscription, and promise callbacks cleared; cancellations do not accumulate
tombstones behind a long-lived holder. Storage follows live requests and grants.

## Closure

`close(reason)` synchronously sets `closed` to true, removes all waiters, and
rejects current and future valid acquisitions. Omitted and explicit `undefined`
reasons create one default `Error`; other reasons, including falsy values, are
preserved by identity. Later closes have no effect and cannot replace the reason.

If close runs from an earlier caller abort listener, an already-aborted queued
request retains its abort reason; remaining live waiters receive the close
reason. Existing holders remain active and can release normally. Closure never
revokes permits, completes owned work, or reopens the semaphore.

Run all regression tests with `node --test` (or `npm test`).
