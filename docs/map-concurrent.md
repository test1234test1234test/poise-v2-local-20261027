# Bounded asynchronous mapping

This module retains the options-based API and its default concurrency of four.
For the public `mapConcurrent(items, limit, mapper, { signal } = {})` entry point
in `lib.mjs`, see the [README](../README.md#bounded-asynchronous-mapping). Both
use the same scheduler and failure/cancellation behavior.

```js
import { mapConcurrent } from '../lib/map-concurrent.mjs';

const controller = new AbortController();
const results = await mapConcurrent([3, 1, 2], async (value, index, signal) => {
  signal?.throwIfAborted();
  return { index, doubled: value * 2 };
}, { concurrency: 2, signal: controller.signal });
// [{ index: 0, doubled: 6 }, { index: 1, doubled: 2 }, { index: 2, doubled: 4 }]
```

`mapConcurrent(items, mapper, options = {})` is a named ESM export returning a
Promise. It calls `mapper(value, index, signal)` at most once per input index,
starting indices in ascending order as capacity becomes available. The default
concurrency is four. At most that many mapper calls are unsettled at once.
Mappers may return plain values, promises, or thenables, or throw synchronously.
Results always follow input order, regardless of completion order.

The helper never writes to the input array or its element objects. Results use
a fresh array; input values and mapped results keep their original references.
This does not prevent a caller-supplied mapper from mutating its own inputs.
The initial input length fixes the traversal bound. An item starts at mapper
invocation; each value is read just before that invocation using ordinary
indexed access. If the read throws, the operation fails and drains active work.
If it aborts the signal, that mapper is not invoked. Sparse holes are visited as
`undefined` unless an inherited indexed property supplies a value. Appended
items beyond the initial length are not visited; changes to unstarted indices
are visible. The input iterator is not used.

## Failure and cancellation

The first observed mapper failure or actual cancellation owns the outcome.
Observation means the order of synchronous throws, promise rejection callbacks,
and abort notifications in JavaScript, independent of error timestamps or input
indices. For example, rejecting a mapper promise and immediately calling `controller.abort()`
in the same synchronous turn observes the abort event before the queued promise
rejection callback. The exact winning rejection value is preserved, including
`undefined`, `null`, and other falsy values.

Once stopped, the helper invokes no more mappers. It observes every started
mapper's settlement, consumes later rejections, and rejects only after all
started calls have settled. Successful late completions cannot restart mapping.
A synchronous mapper throw stops the current launch loop immediately. Neither
failure nor cancellation returns partial results or retries a mapper.

The supplied signal is passed unchanged to every mapper; without one, the third
argument is `undefined`. The helper never aborts a caller-owned controller. An
abort stops future launches and lets cooperative active mappers observe the
supplied signal. An active mapper that ignores cancellation and never settles
keeps the returned Promise pending indefinitely, even if cancellation came
from a timeout-based signal. There is no helper timeout or process termination.
Every listener installed by a call is removed when it settles, leaving caller
listeners and other invocations' listeners intact. Empty or already-aborted
calls install no listeners.

Cancellation requires `signal.aborted === true`; dispatching a synthetic
`abort` event alone does not cancel work. Native abort notifications are
protected against other listeners calling `stopImmediatePropagation()`.
The scheduler also checks abort state before launching, after reading an input
value, and before processing settlements, so cancellation cannot be lost during
the re-arming of a listener after a synthetic event. A previously observed
failure still retains its reason when cancellation arrives later.

## Validation and boundary conventions

Validation errors reject the returned Promise; the public call does not throw
synchronously. Validation runs before cancellation or the empty-input fast path.
After validation, an already-aborted signal rejects with its exact `reason`,
**including for an empty array**. A non-aborted empty input resolves to a fresh
empty array without invoking the mapper. This precedence follows the issue
review's recommended interpretation of the overlapping requirements.

- `items` must be an Array and `mapper` a function; wrong types reject with
  `TypeError`.
- Options must be a non-null, non-array object. Only own `concurrency` and
  `signal` keys are accepted. Unknown own keys, including symbols and
  non-enumerable keys, reject with `TypeError`. Inherited options are ignored.
  Omitted or `undefined` options use the default empty object.
- An absent own `concurrency` uses four. An explicitly supplied `undefined`,
  any other non-number, or a boxed number rejects with `TypeError`. Numbers
  that are not positive safe integers reject with `RangeError`.
  `Number.MAX_SAFE_INTEGER` is valid and does not allocate that many workers.
- An absent or `undefined` signal means no signal. Other signals must be
  non-null, non-array objects with callable `addEventListener` and
  `removeEventListener`, boolean `aborted`, and a present `reason` member;
  these members may be inherited. Native AbortSignals satisfy this contract,
  including before abort when `reason` is `undefined`. Plainly invalid shapes
  reject with `TypeError` before any mapper runs. Custom signal objects must
  implement AbortSignal event and listener semantics.

Each invocation has independent state and capacity, even when calls share a
signal. Scheduler state and promise handlers are allocated only for started
work, bounded by `min(concurrency, items.length)` at a time, plus an O(n) ordered
result array. There is no pending promise per queued item, runtime dependency,
or shared global scheduler.
