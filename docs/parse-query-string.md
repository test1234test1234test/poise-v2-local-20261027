# `parseQueryString(text)`

Import the named export directly:

```js
import { parseQueryString } from './lib/parse-query-string.mjs';

const query = parseQueryString('?a=1&flag&a=2&=empty');
Object.getPrototypeOf(query); // null
query.a;                     // ['1', '2']
query.flag;                  // ['']
query[''];                   // ['empty']
```

The result is a new null-prototype object with an own data property for each
decoded key. Every value is an array of decoded strings, including singleton
values. Repeated keys retain all values in input order, including duplicates.
Only value order within each key is specified; keys follow ordinary JavaScript
object enumeration rules, including numeric ordering for integer-index keys.

## Parsing and decoding

1. Remove at most one literal `?` at the very beginning of the supplied text.
2. Split on literal `&` and ignore empty pairs.
3. Split each nonempty pair at its first literal `=`. Without an equals sign,
   the whole pair is the key and its value is empty. Empty keys and values,
   including repeated empty keys, are valid.
4. Decode the key and value separately, then group by the decoded key.

Component decoding is behaviorally equivalent to
`decodeURIComponent(component.replace(/\+/g, ' '))`: literal pluses become spaces
before exactly one strict percent-decoding pass using UTF-8. Encoded delimiters
remain data; `%2B` becomes a literal plus, and `%25ZZ` becomes the literal `%ZZ`
without another decoding pass.

This function parses query text, not a full URL. A hash mark and any second
question mark are ordinary data. Whitespace is preserved, semicolons do not
separate pairs, and bracket/dot names such as `arr[]` and `user.name` are literal
keys. Values remain strings; there is no numeric conversion, case folding, or
Unicode normalization.

Raw UTF-16 code units, including unpaired high and low surrogates, are preserved.
Strict UTF-8 validation applies to percent-encoded octets: raw `\uD800` is valid
data, while `%ED%A0%80` throws. Raw surrogates remain distinct from U+FFFD.
NUL, BOM (even at the start), valid U+FFFD, and Unicode noncharacters are data.

## Errors and independence

- `TypeError`: `text` is not a primitive string, including omitted arguments,
  boxed strings, objects, arrays, and functions. Inputs are rejected without
  inspecting their properties or invoking conversion hooks.
- `URIError`: either component contains an invalid percent escape or invalid
  percent-encoded UTF-8, including truncated sequences and encoded surrogates.
  Any malformed component aborts the call; no partial result is returned.
  Error-message wording is not part of the contract.

Empty input, a lone `?`, or only empty pairs returns a fresh empty null-prototype
object. Each call and each key get independent mutable arrays: mutating a result
cannot affect another key, an earlier result, or a later call. Failed calls
leave previous results unchanged. Names such as `__proto__`, `constructor`, and
`prototype` are ordinary own data properties and never change a prototype.
The parser retains no state, mutates no global objects, and performs no I/O or
network requests. There is no fixed pair, key, or component length limit beyond
JavaScript string and memory limits; the entire supplied query is processed.

Run the regression tests with `node --test test/parse-query-string.test.mjs`,
and the full repository suite with `npm test` (`node --test`) on Node 22.
