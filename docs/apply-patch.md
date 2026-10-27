# Immutable transactional JSON patches

Import the synchronous named export directly:

```js
import { applyPatch } from './lib/apply-patch.mjs';
```

`applyPatch(document, operations)` applies the six operations below in order and
returns an independent JSON value. It validates and copies the document and all
operation payloads before executing any operation. Later operations see earlier
changes. Any failure throws and discards the working document; neither a result
prefix nor partial changes to the caller's inputs are exposed.

## Accepted inputs and ownership

A JSON value is `null`, a boolean, a finite number, a string, a dense Array of JSON
values, or an object with `Object.prototype` or `null` as its prototype. Ordinary
objects must have only own enumerable string data properties. Symbols, hidden
object properties, getters, setters, custom object prototypes, undefined,
functions, bigint, nonfinite numbers, and cycles are rejected with `TypeError`.
Validation inspects descriptors without invoking property getters or setters.

Arrays must contain every own index from zero through length minus one, and may
have only those data properties and their ordinary `length` property. Extra
properties, including symbols and hidden extra fields, are rejected. Array index
data properties may be nonenumerable: the hidden-property restriction applies
to ordinary objects. Inherited elements cannot fill holes. The same Array rules
apply to the outer `operations` container.

Operation elements must be plain or null-prototype objects with exactly the keys
in the table below, all own enumerable data properties. Inherited parameters,
extra keys, missing keys, unknown operation names, and invalid parameter types
are rejected with `TypeError`. Paths and source paths must be primitive strings.

Frozen inputs and readonly data properties are supported; writability and
configurability are not required. Repeated references without cycles are valid
and are copied independently at each occurrence. An empty operations Array still
validates the document and returns a deep independent copy.

All returned object values have `Object.prototype`; returned Arrays are ordinary
dense Arrays. Output data properties are enumerable, writable, and configurable.
Input prototypes, descriptors, identities, Array slots, operation objects, and
payloads are unchanged on both success and failure. No mutable output subtree
aliases an input subtree or another output location. The engine uses own-property
lookup and explicit data-property creation, so `__proto__`, `constructor`,
`prototype`, and inherited method names are ordinary JSON keys when present.

## Pointer syntax

The empty string `''` denotes the root. Every other pointer starts with `/`.
Split after that first slash, then decode each token exactly once: `~0` becomes
`~` and `~1` becomes `/`. All other tilde sequences, including a trailing `~`,
are syntax errors. There is no percent decoding, dot syntax, or bracket syntax.

| Pointer | Object property addressed |
| --- | --- |
| `/` | The empty name `''` |
| `/parent/` | The empty name inside `parent` |
| `/a~1b` | `a/b` |
| `/a~01` | `a~1`, with no second decoding pass |
| `/%2F` | The literal name `%2F` |
| `/a.b[0]` | The literal name `a.b[0]` |

Array tokens must be canonical nonnegative decimal safe integers. `0` and `12`
are valid spellings; `00`, `+1`, `-1`, `1.0`, whitespace, and `1e0` are not.
Lookups require an existing index. An add destination may equal the Array length
or use the final token `-` to append. Both `copy` and `move` use these same add
destination semantics. `-` is invalid in Array source lookups and intermediate
tokens, but remains a legal literal object property name.

Parents must already exist and must be objects or Arrays. The engine never
creates missing parents implicitly or traverses inherited properties.

## Operations

| `op` | Exact keys | Behavior |
| --- | --- | --- |
| `add` | `op`, `path`, `value` | Create or replace an object member; insert before an Array index, or append at length/`-`; replace the root. |
| `remove` | `op`, `path` | Delete an existing object member or Array element, shifting subsequent elements. Root removal is forbidden. |
| `replace` | `op`, `path`, `value` | Overwrite an existing member/element without insertion. Root replacement is allowed. |
| `test` | `op`, `path`, `value` | Require an existing target equal to the supplied JSON value. Root testing is allowed. |
| `copy` | `op`, `from`, `path` | Read an existing source, deep-copy it, then add at the destination. Either pointer may be root. |
| `move` | `op`, `from`, `path` | Read an existing source, remove it, then add it to the resulting document. |

`test` ignores object member order but compares Array order and length. It does
not coerce types, treats `-0` and `0` as equal, and distinguishes null from a
missing member. Signed zero is otherwise preserved in copied values.

`copy` captures its source before insertion. Copying root to a descendant is
therefore finite and produces an independent snapshot. Later changes to a copy
do not change its source.

`move` interprets its destination against the post-removal document. For example,
moving `/1` to `/3` in `['a', 'b', 'c', 'd']` yields `['a', 'c', 'd', 'b']`.
Moving `/1` to `/4` is invalid because the remaining Array has length three.
Moving a path to itself validates its source and then has no effect on the
independent working copy. Moving a parent into a strict descendant is forbidden;
ancestry is determined using decoded token sequences, not raw string prefixes.
Moving root to another path is forbidden. Moving a nonroot source to root is
allowed and returns the removed value, even when it is a scalar.

## Errors and review interpretations

The following choices resolve the overlapping cases identified in the
[issue review](https://github.com/test1234test1234test/poise-v2-local-20261027/issues/16#issuecomment-6451332298):

- `TypeError`: invalid JSON domain, operation container/schema, or argument type.
- `SyntaxError`: a nonempty pointer without a leading slash or an invalid tilde
  escape, in either `path` or `from`.
- `RangeError`: invalid/unsafe Array index, out-of-bounds edits or source lookups,
  missing edit/source targets, missing parents, scalar traversal, forbidden root
  removal, or forbidden moves.
- An ordinary `Error` named `PatchTestError`: unequal test values or a missing
  **final** test target, including a canonical safe Array index outside its
  bounds. A missing intermediate parent, scalar parent, invalid index spelling,
  or unsafe index still raises `RangeError`. No custom error class is exported.

Every execution error exposes the zero-based `operationIndex`. This module also
attaches that index to operation-specific preflight errors, including
`TypeError` and `SyntaxError`, so callers can locate malformed operations even
before execution. Errors validating the document or outer operations Array have
no operation index. Error message wording is not a public contract.

All schemas, pointers, and payloads are validated before execution; thus an
invalid later payload takes precedence over an earlier unequal test. There is
no promised precedence among multiple preflight errors. The interpretation of
Array add semantics includes `-` for copy/move destinations, and the outer Array
and nonenumerable index policies are explicitly described above.

## Runnable examples

Run these commands from the repository root with Node (CI uses Node 22):

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { applyPatch } from './lib/apply-patch.mjs';

const document = { rows: ['a', 'b', 'c', 'd'] };
const result = applyPatch(document, [
  { op: 'test', path: '/rows/0', value: 'a' },
  { op: 'add', path: '/rows/1', value: 'x' },
  { op: 'replace', path: '/rows/2', value: 'B' },
  { op: 'copy', from: '/rows/0', path: '/saved' },
  { op: 'move', from: '/rows/1', path: '/rows/4' },
  { op: 'remove', path: '/rows/3' },
]);
assert.deepEqual(result, { rows: ['a', 'B', 'c', 'x'], saved: 'a' });
assert.deepEqual(document, { rows: ['a', 'b', 'c', 'd'] });
console.log(result);
JS
```

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { applyPatch } from './lib/apply-patch.mjs';

const original = { 'a/b': { n: 1 } };
const result = applyPatch(original, [
  { op: 'copy', from: '', path: '/snapshot' },
  { op: 'replace', path: '/snapshot/a~1b/n', value: 2 },
]);
assert.deepEqual(result, { 'a/b': { n: 1 }, snapshot: { 'a/b': { n: 2 } } });

try {
  applyPatch(original, [
    { op: 'replace', path: '/a~1b/n', value: 3 },
    { op: 'test', path: '/a~1b/n', value: 1 },
  ]);
  assert.fail('The transaction must fail');
} catch (error) {
  assert.equal(error.name, 'PatchTestError');
  assert.equal(error.operationIndex, 1);
}
assert.deepEqual(original, { 'a/b': { n: 1 } });
console.log(result);
JS
```

There are no dependencies, I/O, timers, or cross-call mutable state. Validation,
cloning, and equality use explicit work stacks to avoid recursive call-stack
limits. Storage follows the expanded JSON structure: repeated references are
duplicated, and each `copy` allocates its captured subtree. Pointer traversal
scales with path depth; Array insertion/removal shifts the subsequent elements.
