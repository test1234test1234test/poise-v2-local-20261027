# Stable key-based grouping

Import the named `groupBy(items, keyOf)` export directly from `lib/group-by.mjs`.
For example, from a module in the repository root:

```js
import { groupBy } from './lib/group-by.mjs';

const tasks = [
  { name: 'write tests', status: 'active' },
  { name: 'release', status: 'waiting' },
  { name: 'write docs', status: 'active' },
];
const groups = groupBy(tasks, task => task.status);

console.log([...groups.keys()]); // ['active', 'waiting']
console.log(groups.get('active').map(task => task.name));
// ['write tests', 'write docs']
```

The result is a fresh `Map`. Keys appear in first-seen order, and each group
contains values in input order. All keys use ordinary Map equality: objects and
symbols retain their identity, `NaN` keys group together, and `-0` and `+0` share
a group. Numeric and string keys remain distinct. Strings such as `__proto__`
are ordinary keys.

The helper visits array indices once in ascending order and calls
`keyOf(value, index)` once for each index. It uses indexed reads even if the array
overrides its iterator. Sparse holes are read as `undefined` (unless an inherited
indexed property supplies a value), and the source holes remain unchanged.

Traversal uses the array's initial length and reads each value when its index is
reached. If a callback changes the source, appended values beyond that initial
length are not visited; replacements or deletions at later indices affect what
is read there. Shortening the source does not remove those indices from the
traversal. The helper itself never mutates the source and accepts frozen arrays.

Every group is a new array, independent of the input, other groups, and previous
calls. Elements keep their original references: modifying a group array does not
modify the source array, but an object stored in both is still shared. An empty
input returns a fresh empty Map without invoking the callback.

`items` must be an Array and `keyOf` must be a function; otherwise `groupBy`
throws `TypeError`, including for an invalid callback with an empty input. It does
not coerce inputs or accept other iterables. If the callback throws, the exact
thrown value propagates immediately: later indices are not read, no partial Map
is returned, and any callback side effects already performed are not rolled back.
