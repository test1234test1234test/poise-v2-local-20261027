# Asynchronous priority queue

```js
import { createPriorityQueue } from '../lib.mjs';
// Also available from '../lib/priority-queue.mjs'.

const queue = createPriorityQueue({ concurrency: 2 });
const controller = new AbortController();
const ordinary = queue.submit(signal => fetch('https://example.com/ordinary', { signal }));
const urgent = queue.submit(signal => fetch('https://example.com/urgent', { signal }), {
  priority: 10,
  signal: controller.signal,
});

// Stops acceptance immediately; accepted work still drains in priority order.
const drained = queue.close();
const results = await Promise.allSettled([ordinary, urgent]);
await drained;
```

`createPriorityQueue({ concurrency })` creates an independent queue for Node.js
22, using only platform APIs. `concurrency` must be a positive safe integer;
`Number.MAX_SAFE_INTEGER` is supported without allocating that many workers.
The constructor throws `TypeError` for a nonnumeric concurrency or malformed
options, and `RangeError` for an invalid numeric concurrency. Its options must
be a non-null, non-array object; inherited `concurrency` is read once, unrelated
keys are ignored, and a throwing getter's exact error escapes synchronously.

The returned object exposes `submit(fn, options)`, `close()`, `onIdle()` and
getter-only properties `active`, `pending`, and `closed`. Initially these
properties are `0`, `0`, and `false`.

## Acceptance, dispatch, and priority

`submit()` always returns a Promise. A valid, open, nonaborted submission is
accepted synchronously into `pending`; its callback is never invoked on the
submission's stack. For example, immediately after an idle submission,
`active === 0` and `pending === 1`.

Dispatch is scheduled with `queueMicrotask`. This is the queue's definition of
waiting until the current JavaScript turn ends: synchronous submissions made
before that microtask compete together. It does not wait for a later event-loop
task or the entire microtask queue to empty. A higher-priority submission in a
microtask queued **after** dispatch cannot preempt work that dispatch already
started. A submission in a microtask queued **before** dispatch participates in
that selection.

Each available slot takes the highest finite numeric priority among currently
queued jobs. Priority defaults to `0`; negative, fractional and extreme finite
values are valid. Ties, including `+0` and `-0`, use successful acceptance order.
A submission made by an options getter is accepted before the outer submission.

Dispatch selects one job at a time, establishing its active ownership before
entering caller code, then selects again. Reentrant submissions from a callback
can compete for the next available slot once that callback returns. They cannot
run inside their own `submit()` call. For example, with two slots, if A starts
and synchronously submits higher-priority C, C starts ahead of lower-priority B
that remains queued. A callback can also cancel queued jobs or initiate close.
Running jobs are never preempted by priority, and rejection does not stop later
eligible work.

`active` counts callbacks whose complete returned results have not yet been
processed as settled by the queue. It never exceeds concurrency, even if their
public promises have already been cancelled. Synchronous returns and throws
keep their slots until the promise settlement reaction runs. `pending` counts
accepted, unstarted, noncancelled jobs. It reflects native abort state even
inside an earlier external abort listener or the re-arming gap described below.

The bound applies to running work. There is no pending-capacity bound or
backpressure API, and strict priority does not promise starvation freedom.
Storage follows live jobs and idle waiters; selection scans pending jobs.
There are no persistent workers, timers, polling, or third-party dependencies.

## Validation and results

Validation precedes the closed-state check, which precedes pre-abort and
acceptance. `fn` must be a function. Omitted or explicit `undefined` submission
options mean `{}`; otherwise they must be a non-null, non-array object,
including class instances and null-prototype objects. Unknown properties are
ignored. Supported properties, including inherited getters, are read once in
the order `priority`, then `signal`, validating each before reading the next.
Missing or `undefined` priority means `0`; other priorities must be finite
primitive numbers. Missing or `undefined` signal means no external signal.

Signals must be native AbortSignals with this realm's `AbortSignal.prototype`:
controller signals, `AbortSignal.abort()` and `AbortSignal.any()` are supported.
Proxies, inherited-signal wrappers, prototype-only imitations, duck types and
foreign-prototype signals are rejected. Modifying platform prototypes or native
signal methods/state is outside the supported boundary.

Invalid submissions reject with `TypeError`, without synchronous throws,
listener installation or admission, including while busy or after close.
Throwing option getters reject with the exact thrown value. Getters' own side
effects remain: they may submit another job, abort or close the queue. The
outer call checks current closed/abort state only after successful validation.
Thus a getter that closes and then throws retains its thrown reason; a valid
submission with an already-aborted signal after close gets the closed error.

Callbacks are invoked as `fn(signal)`, without a supplied receiver and with
exactly one argument. With an external signal, this is that signal itself;
otherwise it is a fresh, nonaborted AbortSignal for that job. Close never aborts
these signals.

Results use native Promise resolution: synchronous values, synchronous throws,
pending/rejected promises and nested thenables are supported. Rejection reasons
retain their exact identity, including falsy reasons, and are never assimilated.
The callback return is resolved once for physical completion. Without an
external signal the public promise itself supplies that observation. With an
external signal a separate result promise allows public cancellation while
still observing physical completion and any late rejection. Its fulfillment
value is forwarded through native promise resolution, as with `Promise.race`:
a final object's `then` accessor can be read again during public delivery.
Stateful accessors on final fulfillment values can therefore affect delivery;
this is distinct from invoking the original returned thenable twice.

Directly returning the job's own public promise rejects with `TypeError` and
releases its slot. Other dependency cycles cannot generally be detected. A
running callback awaiting a child queued behind its own occupied slot can
deadlock. Returning/awaiting that queue's `close()` or `onIdle()` from a running
callback also creates a cycle. A callback may initiate close or register idle
waiters, but must finish independently. Return or await all work whose duration
must count toward concurrency; detached work cannot be tracked.

## Cancellation and outcome races

An already-aborted signal rejects with its exact native `signal.reason`, without
invoking the callback or adding a listener. Aborting a queued job unlinks it,
removes its listener, and rejects once with that same reason. Other jobs retain
their order. Cancelled queued records release callback and promise references
even when a predecessor never settles.

Aborting an active job promptly rejects its public promise and the callback
observes its signal as aborted. **Its active slot remains occupied until the
callback's actual returned result settles.** Cancellation never manufactures
capacity. A function that ignores cancellation and never settles keeps its slot
and keeps idle/close pending. Late fulfillment or rejection cannot overwrite a
cancelled outcome; the queue observes late rejections without creating an
unhandled rejected bookkeeping chain. Callers should handle their own public
job promises' rejections.

For a cancellable job, completion commits in the result promise's settlement
reaction, after rechecking genuine abort state. Cancellation commits when the
queue observes genuine abort, usually during native abort dispatch. The first
commit wins. Resolving a deferred result and immediately aborting **before** its
settlement reaction runs gives cancellation precedence. Aborting after public
completion has committed cannot change that outcome. Aborting from the callback
itself, a result's `then` getter, or its `then` method wins over that callback's
subsequent return/throw. Physical completion is still observed separately.

Each submission owns its own abort subscription, even when multiple jobs or
queues share a source. Owned listeners are removed on public completion or
cancellation; unrelated listeners and other jobs' subscriptions are preserved.
Node's `addAbortListener` prevents `stopImmediatePropagation()` from suppressing
cancellation. A synthetic `signal.dispatchEvent(new Event('abort'))` on a live
signal does not cancel work. It consumes the one-shot subscription, which is
re-armed in a microtask that also checks for a real abort during the gap.
Dispatch, completion, close and idle observation also check genuine state;
settled records cannot be re-armed.

## Close and idle boundaries

`close()` sets `closed` to `true` synchronously and stops accepting new work.
Accepted queued and active jobs drain normally, in priority order, unless
independently cancelled. In particular, `submit(); close()` in one synchronous
stack still executes that accepted job. Every later valid submission rejects
with one retained `Error` whose `code` is `'QUEUE_CLOSED'`, including submissions
with already-aborted signals. Invalid submissions retain validation precedence.

Close returns the **same Promise object on every call**, before and after
drainage. It fulfills with `undefined` only when `active` and `pending` are both
zero, including physical completion of previously cancelled active work.
Individual job failures do not reject close.

`onIdle()` returns a Promise fulfilling with `undefined` at the next observed
zero-active/zero-pending boundary, or already fulfilled if the queue is idle
when called. It does not close the queue. All current waiters are detached and
fulfilled at that boundary, before their handlers run. They observe that idle
period, not quiescence forever; fulfillment cannot be revoked by later work.

Consequently, an already-idle call followed immediately by a submission stays
fulfilled. A final job's fulfillment handler, or an idle waiter's handler, can
submit more work after an idle boundary has fulfilled older waiters. Waiters
registered after that new submission wait for the new busy period. If other
queued/active work still exists when a completion handler submits, there has
been no idle boundary and existing waiters continue waiting. Repeated idle
periods and multiple waiters are supported independently of close.
