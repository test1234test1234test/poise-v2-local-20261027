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

## Hexadecimal byte formatting

```js
import { hexByte } from './lib/hex-byte.mjs';

hexByte(10);  // '0a'
hexByte(255); // 'ff'
hexByte(-0);  // '00'
```

`hexByte(value)` returns exactly two lowercase hexadecimal digits for an integer
primitive number from 0 through 255, inclusive. Negative zero is accepted as zero.
Non-number inputs, including omitted arguments, strings, BigInts, and boxed
numbers, throw `TypeError` without coercion. Numbers outside the integer byte
domain, including fractions, `NaN`, and infinities, throw `RangeError`.

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

## Natural string comparison

```js
import { compareNatural } from './lib/compare-natural.mjs';

compareNatural('file2', 'file10'); // -1
compareNatural('file2', 'file02'); // -1
compareNatural('x0', 'x00');      // -1
compareNatural('a/', 'a9');       // -1

['file10', 'file02', 'file2z', 'file2'].sort(compareNatural);
// ['file2', 'file2z', 'file02', 'file10']
```

`compareNatural(a, b)` returns exactly `-1`, positive `0`, or `1`. Both arguments
must be primitive strings; missing arguments, boxed strings, and other types
throw `TypeError` without coercion, even when paired with an empty string.

Comparison proceeds from left to right. When both current characters are ASCII
digits (`0`–`9`), their complete, maximal digit runs are compared as arbitrary-length
nonnegative integers without conversion to `Number`. Numeric magnitude comes
first (`'0009' < '10'`); equal values are tied immediately by shorter original
run length, before considering suffixes (`'file2z' < 'file02a'`). Equal runs
advance to the next character.

Otherwise, the current Unicode code points are compared by numeric value, even
when only one is an ASCII digit. Equal code points advance together; exhaustion
sorts first. Valid surrogate pairs form one code point, and lone surrogates retain
their numeric values, so `compareNatural('\uD800', '\uE000') === -1`.
Comparison is case-sensitive and uses no locale, trimming, normalization, or
grapheme grouping. Signs, punctuation, whitespace, and non-ASCII digits remain
literal text. Zero is returned only for identical strings.

## Unicode longest common prefix

```js
import { longestCommonPrefix } from './lib/longest-common-prefix.mjs';

longestCommonPrefix(['flower', 'flow', 'flight']); // 'fl'
longestCommonPrefix(['😀x', '😀y']);              // '😀'
longestCommonPrefix(['😀', '😁']);                // ''
longestCommonPrefix([]);                         // ''
```

`longestCommonPrefix(strings)` returns a primitive string containing the longest
common prefix measured in Unicode code points. An empty array returns `''`; a
singleton returns its string unchanged. Empty strings are valid. Comparison is
case-sensitive and preserves the original spelling without normalization or
grapheme grouping, so `['e\u0301', 'e\u0300']` has prefix `'e'`.

Surrogates follow JavaScript string-iterator semantics: a valid surrogate pair
is one comparison element; an unmatched surrogate is preserved as an individual
element. The result never splits a pair in any input. Thus `['\uD800x', '\uD800y']`
returns `'\uD800'`, but `['\uD83D', '😀']` returns `''`.

The argument must be an Array with a primitive string at every own index.
Non-Arrays, boxed strings, other nonstring elements, and sparse arrays (even
with inherited indexed values) throw `TypeError` without coercion. All indexed
values are validated before returning, even when the prefix is empty. The
initial length is captured and each indexed value is read once; unrelated
properties, custom iterators, and constructor/species hooks are ignored.
The helper does not write to or freeze the input, on success or failure, and
accepts frozen arrays. Side effects of caller-provided getters are not undone.

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

## Stable partition

```js
import { partitionStable } from './lib/partition-stable.mjs';

partitionStable([1, 2, 3, 4, 5], value => value % 2 === 0);
// [[2, 4], [1, 3, 5]]

const values = [, 'A', undefined, , 'B'];
partitionStable(values, (_value, index, original) => {
  // original === values; called only at indices 1, 2, 4
  return index % 2 === 0;
});
// [[undefined, 'B'], ['A']] (undefined is an own slot; holes are skipped)
```

`partitionStable(values, predicate)` returns `[matching, remaining]`, preserving
each visited value and its relative order within its group, including repeated
references. The predicate is called exactly once per present **own** array index,
in ascending order, with exactly `(value, originalIndex, originalArray)`. Holes
and inherited numeric properties are skipped without reading them; explicit
`undefined` and non-enumerable own indices are visited. Named, symbol and other
non-index properties are ignored.

Classification uses synchronous JavaScript truthiness: truthy results go to
`matching`, falsy results to `remaining`, without coercing objects or requiring
Booleans. Results are not awaited: a returned Promise is a truthy object, even
if it resolves to `false`, as is `new Boolean(false)`.

Both arguments are required: `values` must be an Array and `predicate` a function.
Other inputs throw `TypeError` without coercion, before any indexed reads or
callback calls, even for empty and all-hole arrays. Array subclasses, arrays and
functions from other realms, and null-prototype arrays are accepted. Every call
returns a fresh ordinary array pair containing two distinct, fresh, dense ordinary
arrays, including empty groups. Input iterators, constructors and `Symbol.species`
hooks are not accessed. Output slots are own data properties even when inherited
numeric accessors or non-writable properties exist on `Array.prototype`.

Traversal captures the initial length after validation, then checks own presence
and reads each present value once immediately before its predicate. Callback or
getter changes to future slots within that bound are observed: filled holes and
replacements are visited; deleted slots are skipped even if an inherited value
is exposed. Shortening the input removes later slots; appends beyond the initial
length are ignored. Replacing or deleting the current slot inside its predicate
does not change the captured value placed in the result. Traversal work is
proportional to initial array length, including holes.

The helper never writes to or freezes the input or its elements; frozen inputs
are supported. Copying is shallow: object and nested-array identities are retained.
Changing a result's slots or length cannot change the source or sibling group;
mutating a shared element remains visible through every reference to it. If a
predicate or indexed getter throws, the exact thrown value propagates immediately,
with no later reads, callback calls or partial return. Caller side effects are not
rolled back. Nested and subsequent invocations have independent result state.

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

## Atomic text edits

```js
import { applyTextEdits } from './lib/apply-text-edits.mjs';

applyTextEdits('abcd', [
  { start: 1, end: 3, text: 'X' },
  { start: 3, end: 3, text: '!' },
]); // 'aX!d'
```

`applyTextEdits(text, edits)` validates a complete batch before returning a
primitive string, without modifying inputs or invoking their getters. All
coordinates are UTF-16 code-unit offsets into the original text. Replacements
may touch but cannot overlap; insertions at a shared boundary retain input order
between the replacements. Malformed inputs throw `TypeError`; invalid numeric
ranges and conflicts throw `RangeError`.

See the [text edit contract](docs/apply-text-edits.md) for exact object/array
schemas, proxy rejection, boundary ordering, Unicode behavior and examples.

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

## CSV parsing

```js
import { parseCsv } from './lib/parse-csv.mjs';

parseCsv('name,city\r\nAda,"London"\r\n'); // [['name', 'city'], ['Ada', 'London']]
parseCsv('a;"b;c"', { delimiter: ';' });   // [['a', 'b;c']]

try {
  parseCsv('\uFEFF"😀"x');
} catch (error) {
  console.log(error.line, error.column, error.offset); // 1 6 5
}
```

Malformed records throw `SyntaxError` with one-based `line` and `column` and an
additive zero-based integer `offset` in original-input UTF-16 code units. The
offset includes an ignored initial BOM and both code units of a surrogate pair;
an unclosed quoted field reports `text.length`. Existing messages, coordinates,
and validation errors are unchanged. See the [CSV documentation](docs/parse-csv.md)
for the strict grammar, delimiters, and error-coordinate examples.

## Query string parsing

Import `parseQueryString` from `./lib/parse-query-string.mjs` to parse query text
into a null-prototype object of string arrays, preserving repeated values in
order. See the [parsing and error contract](docs/parse-query-string.md) for
strict percent decoding, literal-key behavior, and examples.

## Escaped dot path parsing

Import `parseDotPath` from `./lib/parse-dot-path.mjs` to split escaped dot paths
into fresh arrays of literal string segments. See the
[grammar and error contract](docs/parse-dot-path.md) for the two supported
escapes, exact forbidden names, input preservation and examples.

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

## Eager ordered union

```js
import { unionOrdered } from './lib/union-ordered.mjs';

unionOrdered([3, 1, 3], new Set([2, 1]), 'ab'); // [3, 1, 2, 'a', 'b']
unionOrdered('a😀a', '😀b');                  // ['a', '😀', 'b']
unionOrdered();                              // []
```

`unionOrdered(...iterables)` returns a fresh ordinary array of first occurrences,
visiting each source to completion from left to right during the call. Inputs
must be finite synchronous iterables, such as arrays, strings, Sets, generators,
or custom iterables. Finiteness is a caller precondition. Later sources are not
accessed or validated before earlier sources finish, including duplicate tails.

Membership uses SameValueZero equality: repeated `NaN` values appear once and
`+0`/`-0` share a key. The first value itself is retained, including its zero sign:
`Object.is(unionOrdered([-0], [+0])[0], -0)` is `true`. Results are shallow;
objects and nested arrays retain their identities, and distinct objects remain
distinct. Values are not coerced, flattened, or awaited. The helper does not
modify source containers or elements. Consuming a stateful iterator advances it,
and caller-supplied hooks can have their own side effects.

Invalid non-iterables (including explicit `undefined`) and malformed iterator
protocols throw `TypeError` synchronously. Traversal follows native synchronous
`for...of` semantics: errors obtaining an iterator, obtaining/calling `next`, or
reading its result propagate without closing that source. If processing an
obtained value throws, normal IteratorClose attempts the active iterator's
`return()` and preserves the original error even if cleanup fails. Exhausted
sources are never closed, and later sources are untouched after a failure.

## Lazy ordered union

```js
import { orderedUnion } from './lib/ordered-union.mjs';

[...orderedUnion([3, 1, 3], new Set([2, 1]), [4])]; // [3, 1, 2, 4]
[...orderedUnion('a😀a', '😀b')];                  // ['a', '😀', 'b']
```

`orderedUnion(...sources)` is a synchronous generator that yields first
occurrences in source and iteration order, using SameValueZero equality. It
preserves original values and object identity, including the sign of a first
`-0`. Construction touches no source; each source is opened and validated only
after its predecessor finishes. An infinite source can starve later sources,
and the membership Set grows with the number of unique values yielded.

Early return, consumer throw, or source protocol failure attempts cleanup of
only the active iterator. Original errors take precedence over cleanup errors;
an ordinary return propagates a cleanup error. Manual consumers must call
`return()` when abandoning iteration. See [ordered union usage and cleanup
semantics](docs/ordered-union.md) for validation, protocol details, and examples.
