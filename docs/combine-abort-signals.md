# Combine abort signals

`combineAbortSignals(signals)` combines native signals for Node.js 22 and returns
`{ signal, dispose }`. Import the named export directly:

```js
import { combineAbortSignals } from './lib/combine-abort-signals.mjs';

const user = new AbortController();
const shutdown = new AbortController();
const { signal, dispose } = combineAbortSignals([user.signal, shutdown.signal]);
try {
  await fetch('https://example.com/data', { signal });
} finally {
  dispose();
}
```

Each call returns its own native `AbortSignal` and disposal function, even for
identical inputs. The output never aliases a source. An empty array produces a
fresh signal that remains un-aborted. Duplicate source references are accepted
without duplicate subscriptions. Separate combinations sharing a source remain
independent.

## Abort ordering and reasons

Validation finishes before composition or listener registration. If any sources
are already aborted, the output aborts synchronously, before the function
returns, with the reason of the first aborted source in array order. No listeners
are installed in that case.

Otherwise, the first source to abort wins, including when an earlier external
source listener aborts another source during event dispatch. The exact native
`source.reason` is propagated without wrapping, coercion or promise assimilation:
objects retain their identity and primitive values remain unchanged. Calling a
native controller's `abort(undefined)` creates a default reason; that same
reason object is propagated. Later sources cannot change the output's reason or
cause another output abort event.

Synthetic `abort` events on live sources do not abort the output or consume its
subscription. A source listener's `stopImmediatePropagation()` does not prevent
propagation of an actual abort.

## Disposal and ownership

Call `dispose()` when the operation using the combined signal finishes, including
when it finishes without cancellation. Disposal is synchronous, returns
`undefined`, and is idempotent. Before any source aborts, disposal removes all
owned listeners and leaves the output un-aborted permanently; subsequent source
aborts have no effect on it. An output abort also removes all owned listeners,
before notifying output listeners. Disposal after abort, including from an
output-abort listener, is harmless.

An abort that has already started takes precedence over disposal. If a
preexisting source listener calls `dispose()` during that source's abort
dispatch, disposal propagates the already-selected reason synchronously before
returning. By contrast, `dispose(); controller.abort(reason)` leaves the output
un-aborted.

The helper never aborts a source or removes external listeners. It uses native
`AbortSignal.any()` to select the winner and a removable listener on a private
bridge signal to forward the result to a separate controller. No direct source
event listeners are needed. Cleanup removes the bridge listener and releases
the helper's reference to the bridge. There are no added dependencies, timers,
background tasks, prototype changes or private runtime-property accesses.

## Validation and setup errors

The argument must be an Array whose every index is an own entry containing a
native signal from the current realm. Holes are invalid even if an inherited
array index supplies a signal. Nulls, undefined entries, non-arrays, signal-shaped
objects, proxies and inherited wrappers are rejected synchronously with
`TypeError`, including when an earlier valid source is already aborted.

Signals must have the current realm's exact `AbortSignal.prototype` and pass the
native receiver check; proxy rejection is explicit. Controller signals,
`AbortSignal.abort()` and `AbortSignal.any()` results are supported. The helper
reads each array entry once into a validated snapshot and does not use the
input's custom iterator. Native API internals and prototypes must remain intact.

If reading an input entry, native composition or listener registration throws,
the original exception escapes synchronously and no result is returned. Any
owned listener installed during setup is removed, including when registration
installs a listener and then throws. Source aborts during registration are
recognized before returning, including aborts just before native registration
and registrations that complete after abort cleanup has already run.

Run focused regressions with
`node --test --test-concurrency=1 test/combine-abort-signals.test.mjs` and the
complete repository check with `npm test -- --test-concurrency=1`.
