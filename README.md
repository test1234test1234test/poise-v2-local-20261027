# Disposable Poise v2 sandbox

Toy work only. No production deployment, upstream fork, production credentials, or production work references. All orchestration runs locally.

## Array chunking

```js
import { chunk } from './lib/chunk.mjs';

chunk([1, 2, 3, 4, 5], 2); // [[1, 2], [3, 4], [5]]
chunk([], 2);              // []
chunk([1, 2], 3);          // [[1, 2]] (a copied chunk)
```

`chunk(items, size)` returns consecutive arrays of at most `size` elements in
their original order, retaining a final partial chunk. Every call creates a new
outer array and new chunk arrays, including when the size equals or exceeds the
input length. Empty inputs produce a new empty array with no chunks.
Array subclasses are accepted, but the returned outer array and chunks are
ordinary arrays. The input's `constructor` and `Symbol.species` hooks are not used.

This is a shallow, non-mutating operation: it does not modify or freeze the input
or its elements, and frozen arrays are accepted. Object and nested-array element
references are preserved. Replacing a slot in a chunk does not change the source
array or sibling chunks; modifying a shared element object remains visible
through all references to that object.

Sparse slots follow `Array.prototype.slice` property-presence semantics. Holes
count toward chunk boundaries and lengths and remain holes, distinct from
explicit `undefined`. Inherited indexed values are copied into own chunk slots,
as with slicing:

```js
const parts = chunk([, 'a', undefined, , 'b'], 2);
parts.map(part => part.length); // [2, 2, 1]
Object.hasOwn(parts[0], 0);     // false (hole)
Object.hasOwn(parts[1], 0);     // true (explicit undefined)
Object.hasOwn(parts[1], 1);     // false (hole)
```

Validation applies even to empty inputs. `items` must be an Array and `size` must
be a primitive number; otherwise a `TypeError` is thrown. There is no coercion or
default size: strings, booleans, boxed numbers, BigInts, and omitted sizes are
rejected. Numeric sizes must be positive safe integers, or a `RangeError` is
thrown. This excludes zero (including `-0`), negative numbers, fractions, `NaN`,
infinities, and unsafe integers. `Number.MAX_SAFE_INTEGER` is valid; an oversized
size copies only the available elements, without padding or allocating to that
size.

## Array pagination

```js
import { paginate } from './lib/paginate.mjs';

paginate([], 1, 2);
// { items: [], page: 1, pageSize: 2, totalItems: 0, totalPages: 0,
//   hasPrevious: false, hasNext: false }

paginate([1, 2, 3, 4, 5], 3, 2);
// { items: [5], page: 3, pageSize: 2, totalItems: 5, totalPages: 3,
//   hasPrevious: true, hasNext: false }

paginate([1, 2, 3, 4, 5], 4, 2);
// { items: [], page: 4, pageSize: 2, totalItems: 5, totalPages: 3,
//   hasPrevious: true, hasNext: false }
```

`paginate(items, page, pageSize)` selects a contiguous, one-based page. It echoes
the requested `page` and `pageSize`, including beyond the last page. `totalItems`
is the source length, including holes; `totalPages` is
`Math.ceil(totalItems / pageSize)`, or zero for an empty source. `hasPrevious` is
true when `totalPages > 0 && page > 1`: some existing page is earlier, even if the
immediately preceding page does not exist. `hasNext` is true when
`page < totalPages`. Both flags are false for every request on an empty source.

Every call returns a fresh ordinary items array, including empty results and
pages that cover the whole source. Copying is shallow: object and nested-array
references are preserved. The source and its elements are never modified or
frozen; frozen sources, Array subclasses, and arrays from other realms are
accepted. No input constructor or `Symbol.species` hook is used.

Sparse holes count toward page boundaries and remain absent own slots, including
trailing holes. Explicit own `undefined` and non-enumerable own indices are
copied. Unlike `chunk`, pagination ignores inherited indexed properties and does
not read their getters. The result still inherits from `Array.prototype`.

```js
const result = paginate([1, , undefined, ,], 2, 2);
result.items.length;               // 2
Object.hasOwn(result.items, 0);     // true (explicit undefined)
Object.hasOwn(result.items, 1);     // false (hole)
```

All arguments are required and validated even for empty sources or pages beyond
the end. A non-Array `items` or any non-number `page` or `pageSize` throws
`TypeError`, including boxed numbers, objects, and functions. Arguments are never
coerced. Primitive numbers that are not positive safe integers throw
`RangeError`: zero (including `-0`), negatives, fractions, `NaN`, infinities, and
unsafe integers are invalid. `Number.MAX_SAFE_INTEGER` is valid for either or
both numeric arguments. Only the selected range is allocated, without padding
to `pageSize` or calculating an oversized page offset:

```js
const max = Number.MAX_SAFE_INTEGER;
paginate([1, 2], 1, max).items;   // [1, 2] (a fresh copy)
paginate([1, 2], max, max).items; // [] (hasPrevious: true, hasNext: false)
paginate([], max, max).items;     // [] (both navigation flags false)
```

## Numeric clamp

Import the named `clamp(value, min, max)` export from `lib/clamp.mjs`:

```js
import { clamp } from './lib/clamp.mjs';

clamp(5, 0, 10); // 5
clamp(-1, 0, 10); // 0
clamp(11, 0, 10); // 10
clamp(3, 2, 2); // 2 (equal bounds are valid)
```

All three arguments must be finite primitive numbers. Invalid or missing
arguments throw `TypeError`, without coercion or mutation. This validation runs
first; if all arguments are valid but `min > max`, the function throws
`RangeError`.

Bounds are inclusive. An in-range value is returned unchanged, preserving its
sign when it is zero, even with equal bounds: `Object.is(clamp(-0, 0, 0), -0)` is
`true`. Out-of-range values return the corresponding bound unchanged. Fractions,
subnormal numbers, and the full finite number range are supported.

Run the regression tests with `node --test` (also available as `npm test`).

## Safe integer power of two

```js
import { isPowerOfTwo } from './lib/is-power-of-two.mjs';

isPowerOfTwo(1);             // true
isPowerOfTwo(2 ** 32);       // true
isPowerOfTwo(2 ** 32 + 1);   // false
isPowerOfTwo(2 ** 52);       // true (largest accepted power)
isPowerOfTwo(2 ** 53);       // false (unsafe integer)
isPowerOfTwo('2');           // false (no coercion)
```

`isPowerOfTwo(value)` returns a primitive Boolean: `true` exactly for primitive
JavaScript Number values equal to `2 ** exponent`, for integer exponents from 0
through 52. Only positive safe integers can qualify; `2 ** 52` is the largest
accepted power. The check preserves all significant bits above the 32-bit range.

Every other input returns `false` without coercion or exceptions, including zero,
negative numbers, fractions, `NaN`, infinities, unsafe integers, strings, boxed
Numbers, BigInts, Symbols, objects, and omitted inputs. Object conversion hooks
are never accessed or called. The function checks the Number it receives, so
`2 ** 52 + 0.5`, which JavaScript rounds to `2 ** 52` before the call, is accepted.

## Finite-number median

```js
import { median } from './lib/median.mjs';

const values = [4, 1, 3, 2];
median(values);    // 2.5
values;            // [4, 1, 3, 2] (unchanged)
median([10, 2, 3]); // 3
median([]);        // null
```

`median(values)` accepts an Array of finite primitive numbers. Other inputs,
invalid elements, and holes throw `TypeError` without coercion. Every index must
be an own property; inherited values cannot fill holes. Non-enumerable indices
are accepted, and unrelated named/symbol properties are ignored.

The odd-length result is the middle value in numeric order; the even-length
result is the mean of the two middle values, avoiding overflow and using binary64
round-to-nearest, ties-to-even. Equal values, including signed zeros, retain their
input order. Odd results preserve the selected zero's sign; even results follow
Number arithmetic (two `-0` values yield `-0`, mixed zeros yield `+0`).

The helper snapshots the initial length and reads each own index once in order,
validating and sorting the captured values in separate storage. Frozen arrays,
Array subclasses, and arrays from other realms are accepted; input iterators,
methods, constructors, and species are unused. The helper performs no writes to
the input, even on failure; side effects of caller getters/proxies are not undone.

## Closed interval merging

```js
import { mergeIntervals } from './lib/merge-intervals.mjs';

const intervals = [[5, 7], [1, 3], [3, 5], [9, 9]];
mergeIntervals(intervals); // [[1, 7], [9, 9]]
intervals; // [[5, 7], [1, 3], [3, 5], [9, 9]] (unchanged)
mergeIntervals([]); // [] (a fresh array)
```

`mergeIntervals(intervals)` merges closed intervals: overlaps and shared endpoints
coalesce, while every positive gap keeps intervals separate, however small.
Single-point intervals are valid. The result is a fresh dense ordinary Array of
fresh ordinary `[start, end]` pairs, sorted numerically by start and then end.
No result pair aliases an input pair, another result pair, or another call's pairs.
Every result endpoint equal to zero is normalized to `+0`; input `-0`s are preserved.

The input must be a dense Array of dense two-element Arrays. Endpoints must be
finite primitive numbers with `start <= end`. Malformed inputs, holes, invalid
endpoints, and reversed bounds throw `TypeError` without coercion. Every outer
index and both pair indices must be own properties; inherited indices cannot
fill holes and their getters are not read. Non-enumerable own indices are valid,
and unrelated named/symbol properties are ignored.

The helper captures the initial outer length, visits own outer slots once in index
order, and reads each encountered pair's length, start and end once for that
occurrence. Ownership is checked before each indexed read. Repeated references
are separate occurrences; changes made by getters to later slots are observed,
while outer appends beyond the captured length are ignored. Only captured,
validated numbers are used for sorting and merging, after full validation.

Frozen arrays, Array subclasses, cross-realm Arrays, and null-prototype Arrays are
accepted at either level. Input iterators, methods, constructors and
`Symbol.species` are not read. Proxies that forward Array length and own-index
checks normally are supported; arbitrary virtualization of those checks is
outside this contract. Caller-thrown accessor/proxy exceptions propagate unchanged.
The helper performs no writes, deletes, freezing or prototype changes to inputs
on success or failure; caller getter/proxy side effects cannot be undone.
Validation/copying and merging are linear; sorting gives `O(n log n)` total time
with `O(n)` additional space.

## Line counter

Import the named `countLines(text)` function from `lib/count-lines.mjs`:

```js
import { countLines } from './lib/count-lines.mjs';

countLines('');               // 0
countLines('first\r\nsecond'); // 2
countLines('first\n');         // 1
countLines('first\n\n');       // 2 (the blank line is preserved)
```

`text` is a string. LF and CRLF delimit lines, including mixed endings.
A final terminator does not add an extra empty line; actual blank lines and
whitespace-only lines still count. Lone CR, U+2028, U+2029, and U+0085 are
ordinary content. Non-string inputs are outside this function's contract.

Run all tests with `node --test` (or `npm test`).

## Substring counter

```js
import { countSubstring } from './lib/count-substring.mjs';

countSubstring('aaaaa', 'aa'); // 2 (non-overlapping matches)
countSubstring('', 'a');      // 0
countSubstring('a.b.', '.');   // 2 (literal matching)
```

`countSubstring(text, needle)` counts literal, case-sensitive, non-overlapping
matches over JavaScript UTF-16 code units, including lone surrogates. It does not
interpret regular expressions or normalize Unicode. Both arguments must be
primitive strings; otherwise it throws `TypeError` without coercion. After type
validation, an empty needle throws `RangeError`, even when the text is empty.

## Unicode edit distance

```js
import { levenshteinDistance } from './lib/levenshtein.mjs';

levenshteinDistance('kitten', 'sitting'); // 3
levenshteinDistance('😀', '');            // 1 (one Unicode code point)
levenshteinDistance('é', 'e\u0301');      // 2 (no normalization)
```

`levenshteinDistance(left, right)` returns the minimum total cost of inserting,
deleting or substituting Unicode code points, each with cost one. The result is a
nonnegative integer. Comparison is case-sensitive; text is not normalized or
grouped into grapheme clusters, and inputs are not mutated. Empty strings are
valid: two empty strings have distance zero, and the distance from empty text is
the other string's code-point length. Transposition is not a unit-cost edit.

Both arguments must be primitive, well-formed Unicode strings. Other values
(including omitted arguments and boxed strings) and unpaired UTF-16 surrogates
throw `TypeError`. Validation precedes equality and empty-input results, without
coercion, reading properties of nonstrings, or repairing malformed text.

For code-point lengths `m` and `n`, total work is `O(1 + m + n + m*n)`, including
linear validation and traversal when an input is empty. Auxiliary space is
`O(1 + min(m,n))`: only the side with fewer UTF-16 code units is buffered (at most
twice the smaller code-point length), with one distance row. The other input is
streamed; no full matrix or second code-point buffer is retained.

## First occurrences by key

Import `uniqueBy` from `lib/unique-by.mjs` to keep the first item for each key in
original order. It returns a new ordinary array, preserves element references,
uses Map/Set key equality, and skips sparse holes and inherited indexed values.
See [the contract and examples](docs/unique-by.md) for validation, traversal, and
callback side-effect behavior.

## Newline normalization

Import the named `normalizeNewlines(text)` function from `lib/normalize-newlines.mjs`:

```js
import { normalizeNewlines } from './lib/normalize-newlines.mjs';

normalizeNewlines('');                 // ''
normalizeNewlines('a');                // 'a'
normalizeNewlines('a\n\nb\n');         // 'a\n\nb\n'
normalizeNewlines('a\r\nb\rc\n');      // 'a\nb\nc\n'
normalizeNewlines('\r\r\n');           // '\n\n'
normalizeNewlines('\n\r');             // '\n\n'
normalizeNewlines('a\r\n\r\n');        // 'a\n\n'
normalizeNewlines('a\r');              // 'a\n'
normalizeNewlines('a\r\n \t');         // 'a\n \t'
normalizeNewlines('\\r\\n');           // '\\r\\n' (literal backslashes)
```

`text` is a string, and the return value is a string. Each immediately adjacent
CRLF pair becomes one LF; each remaining CR becomes one LF. Existing LF stays
unchanged. Leading, interior, and trailing blank lines are preserved. Trailing
line endings retain their presence and multiplicity, with their spelling
converted to LF. No final newline is added to unterminated input.

All other UTF-16 code units are preserved exactly, including spaces, tabs,
U+0085, U+2028, U+2029, vertical tab, form feed, BOM, NUL, combining sequences,
and isolated surrogates. Whitespace is not trimmed, and literal backslash
escapes are not decoded. Applying the function again leaves the result unchanged.
Non-string inputs are outside this function's contract.

Normalization is opt-in for callers; `countLines` and `parseCsv` retain their
existing newline rules.

## HTML text escaping

Import the named `escapeHtml(text)` function to serialize ordinary HTML text
content:

```js
import { escapeHtml } from './lib/escape-html.mjs';

const markup = '<p>' + escapeHtml('Tom & <Ada>') + '</p>';
// '<p>Tom &amp; &lt;Ada&gt;</p>'

escapeHtml(`&<>"'`); // '&amp;&lt;&gt;&quot;&#39;'
escapeHtml('&amp;'); // '&amp;amp;'
escapeHtml('');      // ''
```

Every `&`, `<`, `>`, `"` and `'` is replaced with `&amp;`, `&lt;`, `&gt;`,
`&quot;` and `&#39;`, respectively. Existing entities are ordinary input: their
ampersands are escaped again, so repeated escaping is intentionally not
idempotent.

Only primitive strings are accepted. Non-string values, including boxed strings
and omitted arguments, throw `TypeError` without coercion. The returned string
preserves every other code unit, including Unicode, lone surrogates, whitespace,
line endings, BOM and NUL; empty input returns an empty string. This preservation
describes the JavaScript string result, not a browser parse/render round trip.

Use this helper for ordinary HTML text serialization. It is not an HTML sanitizer
or an encoder for JavaScript, CSS or URLs.

## Unicode well-formedness

Import the named `isWellFormedUnicode(text)` function to check UTF-16 surrogate
pairing:

```js
import { isWellFormedUnicode } from './lib/well-formed-unicode.mjs';

isWellFormedUnicode('');                 // true
isWellFormedUnicode('A😀e\u0301');        // true
isWellFormedUnicode('\uFEFF');           // true
isWellFormedUnicode('\uD800');           // false
isWellFormedUnicode('\uD800x\uDC00');    // false
isWellFormedUnicode(new String(''));     // throws TypeError
```

Only primitive strings are accepted; all other inputs, including boxed strings
and omitted arguments, throw `TypeError` without coercion. The result is a
Boolean: empty text is valid, and every high surrogate must be immediately
followed by a low surrogate, with no unpaired low surrogates. All other code
units are accepted, including BOM, NUL, combining marks and noncharacters.
The input is preserved without repair, normalization, trimming or escape
decoding. This check is opt-in; existing string helpers retain their contracts.

## UTF-8 text chunking

```js
import { chunkUtf8 } from './lib/chunk-utf8.mjs';

chunkUtf8('aé€😀b', 5); // ['aé', '€', '😀b']
chunkUtf8('e\u0301', 2); // ['e', '\u0301']
chunkUtf8('', 1);       // []
```

`chunkUtf8(text, maxBytes)` returns a fresh ordinary Array of nonempty strings,
each at most `maxBytes` UTF-8 bytes. Each chunk is the longest consecutive prefix
that fits without splitting a Unicode code point. Joining the chunks reproduces
the original text exactly, including BOM, NUL and combining marks; no
normalization or grapheme-cluster grouping occurs. Empty text returns a fresh
empty array.

Both arguments are required, even for empty text: `text` must be a primitive
string and `maxBytes` a positive safe-integer Number. Invalid arguments throw
`TypeError` without coercion. After argument validation, any unpaired UTF-16
surrogate throws `TypeError`; only for well-formed text does a code point larger
than the limit throw `RangeError`. Failures return no partial result. Work is
linear in the input length, with allocation based on the actual text and chunks,
not on the limit; `Number.MAX_SAFE_INTEGER` is accepted.

## Asynchronous semaphore

Import `AsyncSemaphore` from `lib/async-semaphore.mjs` for fair, cancellable
permits that bound concurrent work. Acquire before the work and release in
`finally`; see [usage and the ownership contract](docs/async-semaphore.md).

## Query string parsing

Import `parseQueryString` from `./lib/parse-query-string.mjs` to parse query text
into a null-prototype object of string arrays, preserving repeated values in
order. See the [parsing and error contract](docs/parse-query-string.md) for
strict percent decoding, literal-key behavior, and examples.

## TTL cache

Import `createTtlCache` from `./lib/ttl-cache.mjs` for an in-memory cache with
explicit expiry and deterministic least-recently-used eviction. See the
[TTL cache examples and error contract](docs/ttl-cache.md) for clock injection,
snapshot behavior, and configuration. The existing `LruCache` API is unchanged.

## Bounded FIFO ring buffer

```js
import { createRingBuffer } from './lib/ring-buffer.mjs';

const buffer = createRingBuffer(2);
const item = { id: 1 };
buffer.shift();         // { found: false }
buffer.push(undefined); // { evicted: false }
buffer.push(item);      // { evicted: false }; buffer.size is now 2
buffer.push('next');    // { evicted: true, value: undefined }
buffer.toArray();       // [item, 'next']; fresh array, same item reference
buffer.shift();         // { found: true, value: item }
buffer.clear();         // undefined
buffer.size;            // 0; capacity remains 2
buffer.shift();         // { found: false }
```

`createRingBuffer(capacity)` requires a positive safe-integer number. Every
invalid capacity throws `TypeError`, without coercion; there is no default.
Large capacities, including `2 ** 32` and `Number.MAX_SAFE_INTEGER`, are valid
without allocating their capacity up front. The read-only `size` getter reports
the current number of entries. A push into a full buffer evicts exactly the
oldest entry and leaves size unchanged; the push that first fills it does not
evict. Empty shifts leave the buffer unchanged.

Every JavaScript value is accepted, including `undefined`, without inspecting or
copying payloads. Repeated references remain separate FIFO entries. Each `push`
and `shift` returns a fresh status object; false results have no `value` property,
while successful removals include it even for `undefined`. Editing a result
wrapper cannot change the buffer or other results, and later operations do not
rewrite earlier results. Payload references remain shared.

`toArray()` returns a fresh dense ordinary Array in FIFO order, including when
empty. Editing its slots cannot change the buffer or another snapshot, and later
buffer operations do not change previous snapshots. Mutations to shared payload
objects remain visible through all references. At a theoretical size above the
Array length limit (`2 ** 32 - 1`), `toArray()` throws `RangeError` without changing
the buffer. `clear()` releases the buffer's references, resets size, preserves
capacity, and returns `undefined`; clearing an empty buffer is safe.

The linked FIFO performs a bounded number of structural operations on every
`push` and `shift` (worst-case `O(1)`, excluding runtime allocation and garbage
collection). Buffer-owned storage is `O(1 + size)`, excluding caller-owned
payload internals and returned results/snapshots. Removed nodes are not pooled;
draining or clearing releases both endpoints without mutating payloads or
promising immediate garbage collection. Snapshot work and output storage are
`O(size)`, independent of capacity.

## Event journal

Import `createEventJournal` and `restoreEventJournal` from `./lib/event-journal.mjs`
for atomic JSON event batches, sequence checks, retry receipts and validated
replay. See the [event journal API and export schema](docs/event-journal.md) for
JSON normalization, reducer isolation, pagination and failure behavior.

## Deterministic JSON serialization

```js
import { stableStringify } from './lib/stable-stringify.mjs';

stableStringify({ b: { d: 4, c: 3 }, a: [2, 1] });
// '{"a":[2,1],"b":{"c":3,"d":4}}'
stableStringify({ '2': 2, '10': 10 });
// '{"10":10,"2":2}'
```

`stableStringify(value)` emits compact JSON with object keys sorted by raw UTF-16
code units and array order preserved. It accepts null, primitive booleans and
strings, finite primitive numbers, dense Arrays and plain/null-prototype objects.
Unsupported values, accessors, holes and cycles throw `TypeError`; shared acyclic
references are serialized at each occurrence. It never invokes input getters,
constructors or `toJSON`, and does not modify the input.

The contract deliberately differs from native JSON's omission and null-conversion
rules. See the [serialization contract](docs/stable-stringify.md) for ignored
properties, array metadata, proxy and built-in boundaries, escaping and limits.

## Byte size parsing

```js
import { parseByteSize } from './lib/parse-byte-size.mjs';

parseByteSize('1.5 KiB');             // 1536
parseByteSize('1.001kB');             // 1001
parseByteSize('9007199254740.991kB'); // 9007199254740991
```

`parseByteSize(text)` converts a decimal quantity with an optional case-sensitive
`B`, `kB`, `MB`, `GB`, `KiB`, `MiB` or `GiB` unit into an exact safe integer byte
count. A missing unit means bytes. ASCII whitespace may surround the quantity
or separate its number and unit. Nonstring inputs and malformed syntax throw
`TypeError`; fractional bytes and values above `Number.MAX_SAFE_INTEGER` throw
`RangeError`. See the [grammar, multipliers and error contract](docs/parse-byte-size.md).

## Lazy sorted merge

```js
import { mergeSorted } from './lib/merge-sorted.mjs';

const ascending = (a, b) => a - b;
[...mergeSorted([[1, 3, 3], [2, 3, 4]], ascending)];
// [1, 2, 3, 3, 3, 4]

function* evens() {
  for (let value = 0; ; value += 2) yield value;
}
const prefix = [];
for (const value of mergeSorted([evens(), [1, 3, 5]], ascending)) {
  prefix.push(value);
  if (prefix.length === 5) break; // Closes the live source iterators.
}
// prefix is [0, 1, 2, 3, 4]
```

`mergeSorted(sources, compare)` returns a synchronous iterable iterator with
`next()`, `return()` and `[Symbol.iterator]()` returning itself. Each source must
already be sorted in the consistent order defined by `compare`; descending
orders work too. Input sortedness is not checked. Do not change ordering keys
while their elements are buffered. Elements retain their identities, and neither
the source containers nor their elements are copied, sorted or modified.
Each source's order is preserved. Equal elements from different sources use
ascending original source index, including across duplicate runs. An infinite
run of equal values in an earlier source therefore starves equal values in later
sources; this ordering does not promise fairness.

The outer input must be an Array and `compare` must be a function. These checks
run at the function call, even for `[]`. Each comparison receives two elements
and must return a finite primitive number, interpreted only by sign. Other
results throw `TypeError` without coercion; comparator exceptions propagate.
Comparisons are unnecessary with fewer than two live sources. The restriction
on comparison results does not restrict payload types: `undefined`, infinities,
objects and Promises can all be elements with an appropriate comparator.

Construction opens and advances nothing. The first `next()` captures the outer
Array's length, then opens sources in index order using live indexed reads
(including inherited indices); the outer Array's iterator is ignored. Changes
before that call are visible, and appends during opening are beyond the captured
length. An absent slot reads as `undefined` and fails source validation when
opened. Each source must have a synchronous iterator factory that returns an
object with a callable `next`; async-only sources are rejected. Returned iterator
objects need not themselves be iterable. Different entries must return distinct
iterator objects: shared iterators throw `TypeError` during opening, with normal
failure cleanup of the already opened live set. Repeating an Array source works
because each opening creates an independent iterator.

A successful first pull obtains one result from every source. Later pulls refill
only the previous winner, after its buffered value has been delivered. Returning
after a yield does not pull again; returning before the first `next()` opens and
closes nothing. The merger captures each iterator's `next` method once and calls
it with that iterator as receiver. Each result's `done` is read first, and a
non-exhausted result's `value` is read once and buffered by reference, so reused
result objects work. Startup takes `O(k)` work for `k` sources; subsequent
selection takes `O(log(max(2, liveSources)))` work per output. Auxiliary storage
is `O(k)` with at most one buffered value per live source and no output history.

On early consumer return, source failure or comparison failure, cleanup attempts
one synchronous `return()` per opened, unexhausted iterator in source index
order. Ownership starts as soon as an iterator object is obtained, before reading
its `next` property. Observing truthy `done` marks exhaustion: no further `next`,
`value` or cleanup access is made for that exhausted result/iterator. Never-opened
iterators are also left alone. Cleanup looks up the current `return` hook and
calls it with its iterator as receiver. Missing/null hooks are skipped;
non-callable hooks and primitive cleanup results are `TypeError`s. Cleanup does
not inspect result properties or retry a result with `done: false`.

Every eligible cleanup is attempted even when earlier hooks throw. An original
traversal/comparison error retains priority; on normal early return, the first
cleanup error propagates after the remaining attempts. A `for...of` body throw
also retains its original error. Cleanup does not guarantee completion of a
source's arbitrary finalization code. After termination or failure, further
`next()`/`return()` calls do not touch sources. Reentrant calls into the same merge
while it is executing throw `TypeError`. Manual consumers must call `return()`
when abandoning a merge; merely stopping calls to `next()` cannot signal cleanup.
