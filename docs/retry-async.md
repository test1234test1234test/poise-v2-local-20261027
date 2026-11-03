# Bounded asynchronous retry

```js
import { retryAsync } from '../lib/retry-async.mjs';

const value = await retryAsync(attempt => readFromReplica(attempt), {
  attempts: 3,
  delayMs: 100,
  shouldRetry: (error, attempt) => error.code === 'TEMPORARY',
});
```

`retryAsync(operation, options)` always returns a Promise. It calls
`operation(attempt)` with one-based attempt numbers, awaiting plain values,
promises and nested thenables, and treating synchronous throws as failures.
The first fulfillment is returned, including falsy values. Attempts never
overlap. Without a hook, every operation failure is retried until the limit;
exhaustion rejects with the exact final failure, without wrapping or coercion.
An error named `AbortError` has no special meaning unless the supplied signal
has actually aborted.

When another attempt is available, `shouldRetry(error, attempt)` is called with
the current failure and attempt number. Its awaited result must be a primitive
boolean: `true` approves a retry, `false` rejects with the current operation
failure, and anything else rejects with `TypeError`. A thrown or rejected hook
rejects with that exact hook error. The hook never runs after success or the
last allowed attempt. A positive delay starts only after approval (or an
eligible failure without a hook), with no initial or terminal delay.

## Validation and scheduling

Validation completes before cancellation checks or any callback, timer or
listener. Invalid inputs and throwing option getters reject the returned
Promise without a synchronous throw. Invalid options therefore take precedence
over an already-aborted signal. No values are coerced.

| Argument/option | Contract |
| --- | --- |
| `operation` | Required function. |
| `options` | Omitted/`undefined`, or a non-null, non-array object; functions are invalid. Frozen and null-prototype objects are accepted. |
| `attempts` | Absent: `3`. Integer Number from `1` through `1000`. |
| `delayMs` | Absent: `0`. Integer Number from `0` through `2147483647`; `-0` is accepted. |
| `shouldRetry` | Absent/`undefined`, or a function. |
| `signal` | Absent/`undefined`, or a native current-realm AbortSignal. |

Nonnumber limits, including explicit `undefined` and boxed numbers, reject with
`TypeError`. Numeric fractions, `NaN`, infinities and out-of-range values reject
with `RangeError`; this includes `attempts: -0`. Other invalid arguments reject
with `TypeError`. The hook and signal are validated even if no retry is needed.

Supported options are read once, including inherited properties/getters, and
snapshotted before callbacks. Unrelated keys are ignored without reading their
values. Mutating options later cannot change the limits, hook or signal.
Caller-defined getters can still perform their own side effects.

The first operation enters synchronously during the call after validation and
pre-abort checks. Both callbacks are invoked as plain functions with no supplied
`this`. Zero delay skips the timer; it does not promise an event-loop turn
between attempts. A sequence of synchronous throws can exhaust its budget
before `retryAsync` returns. Positive delays use real timers; their scheduling
does not promise exact wall-clock precision.

Signals must have this realm's exact `AbortSignal.prototype` and pass the native
receiver check. Controller signals, `AbortSignal.abort()` and `AbortSignal.any()`
are supported. Duck types, proxies, inherited-signal wrappers, prototype-only
imitations and foreign-prototype signals are rejected. Modifying signal members
(including shadowing `aborted`, `reason`, or event methods), native internals or
platform prototypes is unsupported, both before and during an invocation.

## Cancellation and ownership

An already-aborted signal prevents every callback and rejects with its exact
`signal.reason`. Aborting an idle retry delay clears the owned timer and rejects
with that reason. Aborting an active operation or hook stops future callback
entry, **waits for that callback's complete result**, then rejects with the abort
reason even if the callback fulfilled, rejected or returned an invalid decision.
Callback cleanup awaited inside `finally` is part of that result.

Cancellation is checked before callback entry and after every awaited callback
and delay. If a gate resolves or rejects and the signal aborts in the same
synchronous turn before the continuation runs, abort wins, including on the
final attempt. Once the helper commits its terminal result, later abort has no
effect, even before the caller's promise reaction runs. Result adoption uses
ordinary ECMAScript `await` and Promise return semantics: thenables must have
stable behavior. Stateful `then` accessors that change behavior on later reads
can cause extra adoption during public delivery; the cancellation boundary does
not extend to such changing delivery behavior.

Only a pending positive delay needs an owned abort subscription. It resists
another listener's `stopImmediatePropagation()`. Synthetic `abort` events on a
live signal neither cancel work nor disable later real cancellation; a consumed
subscription is re-armed in a microtask that checks for abort during the gap.
Every owned timer and subscription is removed on completion/cancellation;
stale re-arms cannot reinstall listeners. External listeners/timers and source
controllers are untouched. Concurrent invocations have independent state,
including when they share a signal.

Callbacks can close over the caller's signal for cooperative cancellation:

```js
const controller = new AbortController();
const { signal } = controller;
const pending = retryAsync(async () => {
  signal.throwIfAborted();
  const response = await fetch('https://example.com/status', { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}, { signal, attempts: 3, delayMs: 100 });

// A UI/event handler can call controller.abort(reason) while pending.
try {
  console.log(await pending);
} catch (error) {
  if (signal.aborted) console.log('Cancelled:', signal.reason);
  else throw error;
}
```

All asynchronous work requiring drainage must be returned or awaited by the
operation or hook. Detached timers/requests are outside the helper's ownership.
A callback that never settles keeps retry pending even after abort: bounded
attempts do not bound runtime. Cancellation may discard a successful result
after its side effects have already happened.

**Retry only operations the caller can safely repeat.** A write may commit
before its response fails; replaying that rejected write can duplicate the
effect. Use appropriate idempotency (for example, an idempotency key) or another
application-level guarantee before retrying such work.

Run regression tests with `node --test --test-concurrency=1`.
