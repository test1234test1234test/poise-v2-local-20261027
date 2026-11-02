# Atomic text edits

Import the synchronous named export directly:

```js
import { applyTextEdits } from './lib/apply-text-edits.mjs';

applyTextEdits('abcd', [
  { start: 1, end: 3, text: 'X' },
  { start: 3, end: 3, text: '!' },
]); // 'aX!d'

applyTextEdits('abcd', [
  { start: 3, end: 4, text: 'Z' },
  { start: 0, end: 1, text: 'LONG' },
]); // 'LONGbcZ'
```

`applyTextEdits(text, edits)` returns a primitive string after applying a batch
against the **original** text. All shapes, coordinates and conflicts are
validated before rendering. A failure throws without exposing a partial result.
An empty batch returns the original string, while still validating both arguments.

## Coordinates and ordering

`start` and `end` are nonnegative safe-integer Numbers with
`start <= end <= text.length`. Signed zero (`-0`) is accepted as zero.
Coordinates count UTF-16 code units, exactly like JavaScript string `length` and
`slice`; they are not code-point, byte or grapheme-cluster offsets.

- A nonempty interval (`start < end`) replaces `[start, end)`. Empty replacement
  text deletes the interval. Even identity replacements consume their interval.
- A zero-length interval (`start === end`) inserts without consuming characters.
  Multiple insertions at one position appear in their original input order,
  including repeated occurrences of the same edit object.
- Nonempty intervals may touch but must not overlap, including containment,
  duplicate ranges and any two nonempty intervals with the same start.
- An insertion strictly inside a nonempty interval is invalid, even if its text
  is empty. Insertions at the interval's start appear before its replacement;
  insertions at its end appear after it.

The function stably sorts private records by start, then handles equal-start
groups. A replacement's position within such a group does not change where its
boundary insertions appear. At a boundary shared by adjacent replacements the
order is left replacement, boundary insertions, right replacement:

```js
applyTextEdits('abcd', [
  { start: 1, end: 3, text: 'X' },
  { start: 1, end: 1, text: 'A' },
  { start: 1, end: 1, text: 'B' },
]); // 'aABXd'

applyTextEdits('abcdef', [
  { start: 3, end: 5, text: 'T' },
  { start: 3, end: 3, text: 'P' },
  { start: 1, end: 3, text: 'R' },
  { start: 3, end: 3, text: 'Q' },
]); // 'aRPQTf'

applyTextEdits('A😀B', [{ start: 1, end: 2, text: 'X' }]);
// 'AX\uDE00B' (a split surrogate pair is permitted)
```

Input and replacement code units are preserved literally: no normalization,
surrogate repair, newline conversion or replacement-token expansion occurs.
Lone surrogates, combining marks, NUL, markup, backslashes, `$&`, `$$` and strings
containing `__proto__`, `constructor` or `prototype` are ordinary text.

## Accepted containers and ownership

`text` and every replacement must be primitive strings. Each edit must be a plain
record whose prototype is the current realm's `Object.prototype` or `null`, with
exactly three own enumerable **data** properties: `start`, `end` and `text`.
Field creation order does not matter. Missing or inherited fields, hidden fields,
extra own string/symbol keys (including hidden keys), arrays, functions and
accessors are rejected. Accessors are rejected even if both accessor functions
are undefined, without invoking any getter or setter.

`edits` must be an Array containing an own data descriptor at every index from
zero through `length - 1`, with no extra own properties beyond those indices and
`length`. Holes, inherited substitutes, indexed accessors and all own metadata
(including symbols and hidden keys) are rejected, even on an empty array.
Nonenumerable **array indices** are accepted; edit fields must be enumerable.
Array subclasses, foreign-realm Arrays and Arrays with custom or null prototypes
are supported. No input iterator, method, constructor or species hook is read.

Live and revoked proxies are rejected as arrays or edits before reflection,
without running traps, using `node:util.types.isProxy`. Edit records follow
[stableStringify's prototype and native-brand boundary](stable-stringify.md#proxy-and-built-in-boundaries):
foreign-realm ordinary objects are rejected, while foreign null-prototype records
are accepted. Native brands recognized by `node:util.types` (buffers/views,
arguments, boxed primitives, Date, external objects, generators, Map/Set and their
iterators, module namespaces, native errors, Promise, RegExp, weak collections,
KeyObject and CryptoKey) remain rejected after prototype replacement.
Classification never reads `constructor` or `Symbol.toStringTag`. Deliberately
disguised host objects or instances whose origins these checks cannot identify
are outside the supported input boundary.

Frozen/sealed arrays and records, readonly data fields and readonly array indices
are accepted. Success and failure preserve own keys and their order, property
descriptors, prototypes, extensibility, array length/order, edit identities and
signed zero. Nothing is frozen, annotated or sorted in place. Validated primitive
fields are copied into private records; data never names a property to write.
There is no I/O or mutable state shared between calls.

## Errors

| Failure | Exception |
| --- | --- |
| Wrong argument/container/edit shape, proxies, accessors, non-number coordinates or non-primitive-string replacements | `TypeError` |
| Primitive numeric coordinate that is negative, fractional, nonfinite or unsafe | `RangeError` |
| Reversed or out-of-bounds range | `RangeError` |
| Overlapping nonempty intervals or a strictly interior insertion | `RangeError` |

No values are coerced, including in error messages. Validation may stop at the
first error; message wording and precedence among independent invalid inputs are
unspecified. A successful call finishes all validation before rendering.

There is no imposed batch or output-size cap. Sorting takes `O(n log n)` work for
`n` edits; validation and rendering additionally follow the batch and text size.
Private records and output chunks use `O(n)` storage plus the output text.
Available memory and the runtime's maximum string size still bound results.

Run the feature tests with
`node --test --test-concurrency=1 test/apply-text-edits.test.mjs`, or the full
repository suite with `npm test -- --test-concurrency=1` on Node 22.
