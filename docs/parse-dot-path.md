# `parseDotPath(text)`

Import the dependency-free named export directly from the repository root:

```js
import { parseDotPath } from './lib/parse-dot-path.mjs';

parseDotPath('a.b');                 // ['a', 'b']
parseDotPath(String.raw`a\.b.c`);     // ['a.b', 'c']
parseDotPath(String.raw`a\\.b`);      // ['a\\', 'b']
parseDotPath(String.raw`a\\\.b`);     // ['a\\.b']
parseDotPath(String.raw`\.`);         // ['.']
parseDotPath(' . ');                 // [' ', ' ']
parseDotPath('01.1e3.a[0]');          // ['01', '1e3', 'a[0]']
```

Every successful call returns a fresh Array containing only primitive strings.
Mutating one result cannot affect earlier or later results. Failed calls retain
no parser state and return no partial result.

## Grammar and preservation

The entire primitive string is significant. A path contains one or more
nonempty segments separated by unescaped ASCII periods (`.`). Within a segment:

- Any code unit other than ASCII period or backslash is ordinary content.
- Backslash followed by period (`\.`) contributes one literal period.
- Backslash followed by backslash (`\\`) contributes one literal backslash.

These are the only two escapes. Decoding happens exactly once: a decoded period
does not separate segments, and a decoded backslash does not start another
escape. An even run of backslashes before a period leaves a separator; an odd
run escapes that period. Empty input, leading or trailing separators, empty
segments, an unmatched trailing backslash and unsupported escapes are invalid.

Whitespace, including tabs, CR, LF, CRLF and nonbreaking spaces, is ordinary
content. Whitespace-only segments are valid. Nothing is trimmed or normalized;
an initial BOM, embedded NUL, Unicode line separators, combining sequences,
astral characters and lone UTF-16 surrogates are preserved unchanged. For
example, `parseDotPath('\uD800.\uDC00')` returns `['\uD800', '\uDC00']`.
Fullwidth `．` and `＼` are ordinary characters.

Numbers remain strings. Brackets, percent sequences and slashes have no special
meaning: `a[b.c]` produces `['a[b', 'c]']`.

The examples use JavaScript expressions. `String.raw` preserves the displayed
backslashes in the parser's input. With ordinary JavaScript literals, double
each backslash: `'a\\.b'` is the same input as `` String.raw`a\.b` ``.
JavaScript `'a\nb'` contains a real newline and is valid; `` String.raw`a\nb` ``
contains an unsupported backslash-plus-`n` escape. Similarly,
`` String.raw`\u0061` `` is invalid, while `` String.raw`\\u0061` `` returns
`['\\u0061']` without interpreting Unicode escape notation.

## Excluded names and errors

Each complete decoded segment is checked with exact, case-sensitive equality.
`__proto__`, `prototype` and `constructor` are forbidden in every position,
including beside escaped segments: `` String.raw`safe\.key.constructor` ``
is invalid. Containing strings and other variants are allowed, including
`constructorSuffix`, `x__proto__`, `Constructor`, ` constructor`, `constructor `
and `` String.raw`constructor\.prototype` `` (one segment, `constructor.prototype`).

- `TypeError`: the input is not a primitive string, including omitted input,
  boxed strings, arrays, objects and functions. Validation does not read input
  properties or invoke conversion hooks.
- `SyntaxError`: the input violates the grammar or contains a forbidden decoded
  segment. No exact error-message wording is specified.

The parser only returns names; it never traverses properties or constructs an
object from the path. The three exclusions do not guarantee safe downstream
property access: allowed names such as `toString` can still name inherited
properties. There is no fixed segment count or string length limit beyond
JavaScript's string and memory limits.

Run the focused tests with
`node --test --test-concurrency=1 test/parse-dot-path.test.mjs`, and the full
repository suite with `npm test -- --test-concurrency=1` on Node 22.
