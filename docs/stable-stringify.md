# Deterministic JSON serialization

Import the synchronous named export directly:

```js
import { stableStringify } from './lib/stable-stringify.mjs';

stableStringify({ b: { d: 4, c: 3 }, a: [2, 1] });
// '{"a":[2,1],"b":{"c":3,"d":4}}'
stableStringify({ '2': 2, '10': 10 });
// '{"10":10,"2":2}'
```

`stableStringify(value)` returns compact JSON text without formatting whitespace.
Every object's own enumerable string keys are sorted lexicographically by their
**raw JavaScript UTF-16 code units**, before escaping. This includes integer-like
names (`"10"` precedes `"2"`), empty/prefix keys, and control characters (tab
precedes newline). U+10000 precedes U+E000. There is no locale comparison,
case folding or Unicode normalization. Array element order is preserved.

## Supported data and rejection

Accepted values are `null`, primitive booleans and strings, finite primitive
numbers, dense Arrays, and plain objects whose prototype is the current realm's
`Object.prototype` or `null`. Foreign-realm ordinary objects fail the prototype
check; foreign-realm null-prototype dictionaries are accepted.

Strings and keys use ordinary JSON escaping, including quotes, backslashes,
control characters and isolated UTF-16 surrogates. Malformed UTF-16 is accepted
and round-trips unchanged. Numbers use native JSON spelling and normalize `-0`
to `0` in the output only. Fractions, subnormals, the full finite number range
and integers outside the safe-integer range are accepted.

All of the following throw `TypeError` when encountered in serialized data:

- `undefined` (including an omitted argument), functions, symbols and bigint;
- `NaN`, positive infinity and negative infinity;
- boxed primitives, Date, RegExp, Map/Set and weak collections, Promise, Error,
  buffers/views/typed arrays, arguments, iterators, module namespaces, and
  instances with custom object prototypes;
- proxies, sparse arrays, accessor properties and ancestor cycles, subject to
  the property rules below.

Unsupported object members are never dropped, and unsupported array elements
are never converted to `null`. Enumerable string accessors are rejected without
calling a getter or setter, even if the getter would return valid JSON or both
accessor functions are undefined. There is no coercion, even in error messages.

## Object properties, arrays and hooks

Objects ignore inherited properties, nonenumerable properties and symbol keys,
without reading or traversing their values. These ignored properties can contain
accessors, unsupported values or cycles. Own enumerable string keys such as
`__proto__`, `constructor`, `prototype`, `hasOwnProperty` and `toString` are
ordinary data keys.

Arrays follow a positional rule: each index `0..length-1` must have an **own data
descriptor**. Hidden data indices are accepted and serialized; indexed accessors
are rejected regardless of enumerability. Inherited values/getters cannot fill
holes. The intrinsic nonenumerable `length` describes the positions and is not
emitted as a member. Array subclasses, foreign-realm arrays and arrays with null
or custom prototypes are accepted; no input constructor, species or iterator is
consulted.

Extra own enumerable string array properties are rejected, even when they contain
valid data, to avoid silently discarding them. Names such as `note`, `00`, `-0`,
`1e0` and `4294967295` are metadata, not indices. Nonenumerable non-index metadata
and all symbol keys are ignored. Thus the nonenumerable-ignore rule applies to
object members and array metadata, **not array positions**.

`toJSON` receives no special treatment and is never called. A hidden or inherited
`toJSON` method/getter is ignored. On an object, an own enumerable string-valued
`toJSON` serializes as data; a function-valued one or an accessor throws
`TypeError`. On an array, an enumerable `toJSON` is rejected as metadata.

## Proxy and built-in boundaries

Live and revoked proxies are rejected before reflection, without executing any
traps. This includes the proxy-backed null-prototype dictionaries returned by
`parseIni`; those results cannot be passed directly to `stableStringify`.

The implementation rejects native brands recognized by `node:util.types`:
array buffers and views, arguments, boxed primitives, Date, external objects,
generators, Map/Set and their iterators, module namespaces, native errors,
Promise, RegExp, weak collections, KeyObject and CryptoKey. These remain rejected
after replacing their prototypes with `Object.prototype` or `null`. Construction
history is not inferred from `constructor` or `Symbol.toStringTag`. Deliberately
disguised host objects or instances whose origins these brand/prototype checks
cannot identify are outside the supported input boundary.

`JSON.rawJSON()` wrappers are explicitly admitted as null-prototype data objects.
Their internal raw-text marker is never used:

```js
stableStringify(JSON.rawJSON('-0'));    // '{"rawJSON":"-0"}'
stableStringify(JSON.rawJSON('1e400')); // '{"rawJSON":"1e400"}'
```

An ordinary object with a `rawJSON` property behaves identically. No property name
enables raw-text injection. Native `JSON.stringify` is used only for already
validated primitives and string keys, never for container traversal.

## Ownership, sharing and resources

Frozen/sealed containers and readonly data properties are accepted. Success and
failure leave input descriptors, key order, prototypes, array slots/length,
extensibility, sharing identities and the sign of input `-0` unchanged. Nothing
is frozen, sorted in place or otherwise mutated.

Only references to an ancestor on the active traversal path are cycles. A child
shared between sibling branches, repeated array elements or a diamond-shaped
acyclic graph is serialized separately at each occurrence. Ignored properties
do not participate in cycle detection. There is no memoization or mutable state
shared between calls.

Traversal uses an explicit stack, with no imposed nesting or output-size cap.
Available memory and the runtime's maximum string size still bound results.
Work and output storage follow the **expanded JSON**, not the number of distinct
input objects; each object's keys additionally require sorting. Repeated shared
subtrees can therefore produce large output. Runtime resource exhaustion is not
an input-validation `TypeError` guarantee.

Run the feature tests with
`node --test --test-concurrency=1 test/stable-stringify.test.mjs`, or the full
repository suite with `npm test -- --test-concurrency=1`.
