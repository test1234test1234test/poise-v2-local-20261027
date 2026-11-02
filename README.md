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

## Event journal

Import `createEventJournal` and `restoreEventJournal` from `./lib/event-journal.mjs`
for atomic JSON event batches, sequence checks, retry receipts and validated
replay. See the [event journal API and export schema](docs/event-journal.md) for
JSON normalization, reducer isolation, pagination and failure behavior.

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
