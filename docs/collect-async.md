# Cancellation-safe collection

```js
import { collectAsync } from '../lib.mjs';

await collectAsync([1, Promise.resolve(2), 3]); // [1, 2, 3]
await collectAsync([1, 2, 3], { limit: 2 });    // [1, 2]

const controller = new AbortController();
const pending = collectAsync(source, { limit: 100, signal: controller.signal });
// Attach the rejection handler before an event handler can cancel collection.
const handled = pending.catch(error => {
  if (controller.signal.aborted) console.log('Cancelled:', error);
  else throw error;
});
controller.abort(new Error('No longer needed'));
await handled;
```

`collectAsync(iterable, { limit = Infinity, signal } = {})` always returns a
Promise, including for invalid arguments and throwing option getters. It
collects a synchronous or asynchronous iterable in order into a fresh ordinary,
mutable Array. Empty input produces `[]`. Values retain object identity; this
is a shallow collection. A failure rejects without exposing the partial array.

## Options and acquisition

Validation order is: options object, read/validate `limit`, read/validate
`signal`, pre-abort check, zero-limit check, then iterator acquisition. Thus
invalid options win over pre-abort. Supported option properties are read once,
including inherited getters; unrelated properties are ignored. An invalid limit
does not even read `signal`. Getter side effects belong to the caller.

| Option | Accepted values |
| --- | --- |
| `options` | Omitted/`undefined`, or a non-null, non-array object. Functions are invalid; frozen and null-prototype objects are supported. |
| `limit` | Absent/`undefined` defaults to `Infinity`. Otherwise a primitive number: `Infinity` or a nonnegative safe integer, including `0`, `-0` and `Number.MAX_SAFE_INTEGER`. |
| `signal` | Absent/`undefined`, or a native AbortSignal from this realm. |

Nonnumeric limits (including strings, booleans, BigInts, boxed numbers and
`null`) reject with `TypeError`, without coercion. Negative/fractional numbers,
`NaN`, `-Infinity` and unsafe integers reject with `RangeError`. Other invalid
options reject with `TypeError`. Storage grows with collected items, never with
the configured limit in advance.

An already-aborted signal rejects with the identical `signal.reason`, even at
limit zero. With a live/absent signal, zero returns a fresh `[]`. Neither path
accesses either iterator-factory getter, acquires an iterator, calls `next`, or
accesses `return`. The iterable therefore need not be valid on these paths.

Signals must have this realm's exact `AbortSignal.prototype` and pass its native
receiver check. Controller signals, `AbortSignal.abort()` and `AbortSignal.any()`
are supported. Signal-like objects, proxies, inherited wrappers, prototype-only
imitations and foreign-prototype signals are rejected. Shadowing signal members
or modifying event methods, native internals or platform prototypes is outside
the supported contract, before and during collection.

## Iterator and value semantics

The async iterator method takes precedence. Only an absent/`undefined` or `null`
async method permits sync fallback. Factories and methods are called with their
own source/iterator receiver and no arguments. A factory must be callable and
return an object (functions also count as objects). `next` is captured once and
must be callable. Non-iterables, noncallable methods, primitive iterators and
primitive iterator results reject with `TypeError`; thrown getters and methods
retain their exact error identity.

Acquiring an object establishes close ownership **before** reading `next`. If
the factory aborts but then returns an iterator, that iterator is closed without
reading `next`. Abort during a factory getter prevents further acquisition.

Reads are sequential, with no overlap or speculative read. A finite positive
limit permits exactly that many values and no next call to discover whether
more values exist. For example, a two-value source with `limit: 2` is an early
close, even if a third read would have reported exhaustion. Natural exhaustion
means the collector actually observed truthy `done`.

| Source | Read/value handling |
| --- | --- |
| Sync | The result of `next()` must itself be an object and is **not** awaited or assimilated, even if thenable. Read `done`, then read and await `value`, including terminal values. Promises and nested thenables are assimilated. Value rejection fails collection. |
| Async | Await the result of `next()`, then read `done`. For a nonterminal result, preserve `value` verbatim, including a promise or thenable. Do not read terminal `value`. |

Awaiting a native promise whose constructor is `Promise` ignores its own `then`
property, including an undefined value or throwing getter, just as `await` does.

`done` and any applicable `value` are read once per result. Once a truthy `done`
getter returns, the source is exhausted, even if that getter aborted the signal.
A sync terminal value's rejection or later cancellation does not close an
already exhausted source. A manual async iterator's opaque promise payload is
caller-owned: the collector neither awaits it nor supplies rejection handling.
Likewise, uninspected payloads in results abandoned on abort remain source-owned.
Promises used as error reasons are opaque reasons, not operations to assimilate.

## Closing and failure precedence

| Exit | Close and settlement |
| --- | --- |
| Validation failure, pre-abort, zero, or failure before acquisition | No close. |
| Observed natural exhaustion | Never access `return`, including after sync terminal-value failure/abort. |
| Positive limit reached | Attempt close once, await normal cleanup, then resolve the values. A cleanup-only failure rejects. |
| Source/protocol failure after acquisition | Attempt close once and await normal cleanup; reject with the original failure even if cleanup fails. |
| Abort before terminal commitment | Interrupt any current read, sync value or cleanup wait. Attempt close once if the source is owned and unexhausted; reject without awaiting either the outstanding source operation or cleanup. |

A missing/null `return` is allowed. Otherwise `return` must be callable. Its
result is awaited for **both** kinds of source and must resolve to an object.
For sync cleanup, read `done` then await `value`, including nested thenables;
for async cleanup, neither property is read. Noncallable `return` or primitive
resolved results are `TypeError`s. Throwing accessors/methods and rejecting
cleanup results/values retain their errors under the precedence rules above.
`done: false` does not cause another close or read. This is one close **attempt**,
not a guarantee that all source cleanup finished: a generator may yield from
`finally` before releasing a resource.

Close ownership is relinquished before reading `return`, so a getter or method
that aborts reentrantly cannot cause a second attempt. Abort never calls `return`
inside an executing source call: it lets that call unwind first. In particular,
a synchronous generator that aborts inside `next()` can execute its `finally`
when closed, without a generator-reentrancy error.

Cancellation is checked before source entry and at continuation checkpoints
after source calls, getters and awaited operations. An already-aborted signal
wins at those checkpoints **until an error has been committed**. Resolving or
rejecting a pending read and then aborting in the same synchronous turn selects
the abort reason, as does aborting first. This applies to final items, terminal
results and cleanup completion. A pending result whose `done` has not yet been
read has not established exhaustion.

An error becomes irrevocable when the collector processes a failed operation
at a checkpoint (after checking cancellation), or observes actual abort. It
preserves every reason, including `undefined`, `null`, `false`, `0`, symbols,
objects and thenables, without wrapping, truthiness tests or assimilation.
`controller.abort(undefined)` uses the platform's default reason; the collector
preserves `signal.reason`, not the argument to `abort`.

A source error already committed before cleanup remains the rejection reason
if abort interrupts cleanup later. Otherwise abort during normal limit cleanup
selects the abort reason and reuses the existing close attempt. Cleanup failure
never replaces a committed failure. Successful collection becomes irrevocable
only after observed exhaustion and required terminal-value handling, or after
normal limit cleanup. Abort after terminal commitment has no effect, even if a
caller reaction has not run yet.

## Cancellation, scheduling and retained work

Prompt cancellation does not wait for pending `next()` or `return()` promises.
For example, native async generators can queue `return()` behind a `next()`
blocked forever on source I/O. Collection still rejects after abort. The helper
cannot stop that I/O, run a generator's `finally` immediately, or preempt
synchronous user code that blocks the JavaScript thread.

There is **no task-queue fairness guarantee**. Immediately ready reads advance
through promise microtasks without deliberate timer/I/O yields. An unbounded
ready source can therefore prevent timer-driven cancellation from being
delivered. A timeout signal is not a hard runtime bound; use a finite limit or a
source that yields to the event loop when that matters. The first source call
starts synchronously during `collectAsync`, after validation and acquisition.

The collector removes its abort subscription on every outcome. An earlier
listener's `stopImmediatePropagation()` cannot suppress cancellation. Synthetic
`abort` events on live signals do not cancel collection: a consumed one-shot
subscription is re-armed outside dispatch, checking for real abort during the
gap. Stale re-arms cannot reinstall a listener after completion. Caller listeners
are preserved, and concurrent collections sharing a signal remain independent.

There is no detached collection loop, shared never-settling cancellation
promise, or growing list of cancellation waiters. Apart from output storage,
collector bookkeeping is bounded independently of item count. After abort,
late read completion cannot pull again or restore a subscription. Abandoned
operation promises retain only minimal rejection observers with cleared wait
callbacks; they do not retain the collector's output or source state. Reactions
already attached to source promises cannot be removed. A close already attempted
continues to validate its eventual result and observe any sync cleanup value,
without retaining the collection loop. These unavoidable observations can
outlive the public Promise, including forever if source work never settles.

Run the regression suite with `UV_THREADPOOL_SIZE=1 node --test --test-concurrency=1`.
