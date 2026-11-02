# Lazy ordered union

Import the named generator directly from `./lib/ordered-union.mjs` in a module
at the repository root:

```js
import { orderedUnion } from './lib/ordered-union.mjs';

[...orderedUnion([3, 1, 3], new Set([2, 1]), [4, 2])]; // [3, 1, 2, 4]
[...orderedUnion('a😀a', '😀b')];                      // ['a', '😀', 'b']
[...orderedUnion()];                                 // []

const item = Object.freeze({ id: 1 });
const values = [...orderedUnion([NaN, -0, item], [NaN, +0, item])];
Object.is(values[1], -0); // true
values[2] === item;      // true
```

`orderedUnion(...sources)` yields the first occurrence of each value, visiting
sources in argument order and each source in its normal iteration order. Inputs
need not be sorted. Equality is SameValueZero: `NaN` deduplicates, and positive
and negative zero share membership. The original first value is yielded, so a
first `-0` retains its sign. Distinct object references and symbols remain distinct;
`1`, `'1'`, and `1n` are different values. Values are never coerced, cloned,
mutated, recursively flattened, or awaited. Promises and thenables are ordinary
object identities.

Each argument must be a synchronous iterable. Strings yield Unicode code points
through their normal iterator, including astral characters and lone surrogates.
Sparse array holes yield `undefined`; overridden array iterators are respected.
Arrays, Sets, generators, and custom synchronous iterables are accepted. Repeated
sources are visited again normally: a repeated array is iterated again, while an
already-consumed generator ordinarily contributes nothing on its next visit.
There is no distinct-iterator restriction. Cleanup of an active iterator also
affects any caller aliases of that same object.

## Laziness and validation

Construction obtains no source iterator. Returning or throwing into the union
before its first pull also touches no sources. A later source is not opened
until the current source reports completion. Each unique value is delivered
before the next source pull; duplicate runs are consumed as needed to find the
next unique value. Changes to a later source before it is reached are visible
through its eventual iterator.

An infinite first source prevents all later sources from being reached. There
is no fairness or bounded-work-per-output guarantee: requesting another output
from an infinite duplicate tail can run forever. Consuming a finite prefix of
distinct values remains lazy:

```js
function* naturals() {
  for (let value = 0; ; value++) yield value;
}
const prefix = [];
for (const value of orderedUnion(naturals(), [100])) {
  prefix.push(value);
  if (prefix.length === 3) break; // Attempts cleanup of naturals(); never opens [100].
}
// prefix is [0, 1, 2]
```

The generator retains source argument references and a Set of previously yielded
unique values. It does not materialize any source's contents. Membership storage
grows with the number of unique values already yielded; separate calls have
independent state.

Validation occurs when traversal reaches each source. `orderedUnion(undefined)`
therefore throws `TypeError` on its first pull, whereas `orderedUnion()` is empty.
For `orderedUnion([1, 1, 2], null)`, the first two pulls yield `1` and `2`, and the
third throws `TypeError`. Async-only iterables, missing/non-callable iterator
factories, primitive factory results, and non-callable `next` methods are invalid.
Exceptions thrown by user hooks propagate unchanged.

A factory-returned iterator need not itself be iterable. Its `next` method is
captured once per source occurrence. Iterator results must be objects, including
callable objects; `null` and all primitive results throw `TypeError`. `done` is
read once and interpreted by truthiness. If it is falsy, `value` is read once;
terminal `value` is never read. Missing or inherited properties are valid: `{}`
represents an `undefined` value with a false completion flag. Reused result objects
work because each value is captured before yielding it.

## Cleanup and errors

Ownership starts when a factory returns an iterator object, before obtaining
`next`, and lasts until truthy `done` is observed or the union terminates. Consumer
return or throw, and any failure obtaining/calling `next`, validating its result,
or reading `done`/`value`, cause one synchronous cleanup attempt on the active
iterator. A factory lookup/call failure or primitive factory result acquires no
iterator to clean up. Exhausted source occurrences receive no `return` lookup;
future source occurrences are never opened or closed. Returning immediately after
a source's last yielded value still closes it, since completion has not yet been
observed.

Cleanup looks up the current `return` hook only when needed. Missing, `undefined`,
and `null` hooks are skipped. A non-callable hook or primitive cleanup result
throws `TypeError`. The factory, captured `next`, and cleanup `return` are called
with their source/iterator receiver and zero arguments, without consulting the
hook's own `.call` property. Values sent to `union.next(value)` are ignored.
`union.throw(error)` closes through the source's `return`, never its `throw`.
A successful `union.return(marker)` returns `{ done: true, value: marker }`.

An existing source or consumer error always takes precedence over a cleanup
error, including throws of `undefined`, `null`, or other falsy values. On an
ordinary early return with no original error, a cleanup error propagates instead.
This also applies to early exits from `for...of`, including `break`, function
return, and loop-body throws.

Cleanup is one attempt, not a guarantee that arbitrary finalization finishes.
Its result's `done` and `value` are never inspected, and a `{ done: false }`
result is neither retried nor yielded. For example, a source generator that
yields from its `finally` block can remain suspended after cleanup. The union
does not drain it. After termination, further union operations do not revisit
source hooks; a completed generator's `throw(error)` still throws that error.
Reentrant generator operations while it is executing throw `TypeError`.

Manual consumers must call `return()` when abandoning iteration. Merely ceasing
to call `next()` cannot trigger deterministic cleanup:

```js
const union = orderedUnion([1, 2, 3], [4]);
try {
  console.log(union.next().value); // 1
} finally {
  union.return();
}
```

Run all regression tests with `node --test --test-concurrency=1` (or
`npm test -- --test-concurrency=1`).
