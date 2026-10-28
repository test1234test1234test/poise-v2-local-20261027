# Keep first occurrences by key

Import the named `uniqueBy(items, keyOf)` export directly from `lib/unique-by.mjs`.
For example, from a module in the repository root:

```js
import { uniqueBy } from './lib/unique-by.mjs';

const firstA = { id: 'a', name: 'first A' };
const firstB = { id: 'b', name: 'first B' };
const items = [
  firstA,
  firstB,
  { id: 'a', name: 'later A' },
  { id: 'b', name: 'later B' },
];
const result = uniqueBy(items, item => item.id);

result.map(item => item.name); // ['first A', 'first B']
result[0] === firstA;          // true
result[1] === firstB;          // true

uniqueBy([NaN, NaN, -0, +0, 1, '1'], value => value);
// [NaN, -0, 1, '1']
```

The result is a fresh, dense, ordinary array containing the first item for each
distinct key, in original order. Keys use Map/Set SameValueZero equality: `NaN`
equals `NaN`, and `-0` and `+0` share a key. Different primitive types remain
distinct, including `1`, `'1'`, and `1n`, or `null` and `undefined`. Objects and
symbols compare by identity; equal-shaped objects and same-description symbols
remain distinct. Keys are never stringified or otherwise coerced, and strings
such as `'__proto__'` and `'constructor'` are ordinary keys. Selected values are
retained unchanged, including the sign of a first `-0` value.

The helper calls `keyOf(value, index)` once per present **own** array element,
including elements with duplicate keys, in increasing original-index order.
Holes and inherited indexed properties are skipped without reading them, while
non-enumerable own elements and explicit `undefined` are visited. Named, symbol,
and other non-index properties are ignored, including an overridden iterator.

```js
uniqueBy([, 'a', undefined, , 'a'], value => value); // ['a', undefined]
uniqueBy([, , 'a', , 'b', , , 'c'], (value, index) => index % 2);
// ['a', 'c'] (original indices 2 and 7)
```

Traversal captures the initial length. For each index below that bound, it checks
own presence at visit time and reads a present value exactly once immediately
before its callback. Callback or accessor changes to later indices are observed:
filled holes and replacement values are visited, deleted indices are skipped,
and inherited values exposed by deletion remain unread. Appends beyond the
initial length are excluded. Shortening the source removes later own elements,
so those absent indices are skipped. Replacing or deleting the current slot
inside its callback does not change the captured value selected for the result.

The helper itself never writes to or freezes the source or its elements, and
frozen inputs are accepted. This is a shallow operation: object and nested-array
references are preserved. Changing result slots or length does not change the
source, but modifying a shared element is visible through both references.
Each invocation, including nested calls, has independent result and membership
state. Empty and all-hole inputs return new empty arrays without calling `keyOf`.
Array subclasses are accepted, but neither their `Symbol.species` hooks nor the
input's `constructor` select the result type; those hooks are not accessed.

`items` must be an Array and `keyOf` must be a function, including arrays and
functions from another realm. Invalid or missing arguments throw `TypeError`
without coercion, even for empty or all-hole inputs, before any indexed reads.
Other iterables, array-like objects, and typed arrays are rejected.

If a callback or indexed getter throws, the exact thrown value propagates
immediately: no later elements are read, no later callbacks run, and no partial
result is returned. Callback or accessor side effects already performed are not
rolled back. A callback that only throws leaves the input unchanged by the helper.

Run all regression tests with `npm test` (or `node --test`).
