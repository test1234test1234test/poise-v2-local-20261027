# `parseDuration(text)`

```js
import { parseDuration } from '../lib/parse-duration.mjs';

parseDuration('1d2h3m4s5ms'); // 93784005
parseDuration('1h 30m');     // 5400000
parseDuration('1m250ms');    // 60250
parseDuration(' \t000ms ');  // 0
```

Returns a primitive JavaScript **Number** containing a nonnegative safe integer
number of milliseconds, from `0` through `Number.MAX_SAFE_INTEGER`
(`9007199254740991`) inclusive. There is no rounding or coercion.

## Grammar

An expression contains one or more terms. Each term is an ASCII decimal integer
matching `[0-9]+` immediately followed by one of these exact lowercase units:

| Unit | Meaning | Milliseconds |
| --- | --- | ---: |
| `d` | Day | 86,400,000 |
| `h` | Hour | 3,600,000 |
| `m` | Minute | 60,000 |
| `s` | Second | 1,000 |
| `ms` | Millisecond | 1 |

Units must be unique and strictly descending in the order `d > h > m > s > ms`.
This applies to zero-valued terms too: `0h0h` and `0ms0s` are invalid. Units may be
skipped, as in `1d2s`. `ms` is a single unit. Individual terms have no clock-style
limits: `25h`, `60m`, `90s`, and `1000ms` are valid if the total fits the safe range.
Leading zeros are accepted, including arbitrarily long runs of zeros.

Only ASCII space (U+0020) and tab (U+0009), matching `[ \t]`, may appear around the
expression or between terms. Separators are optional: `1h30m` and `1h 30m` mean
the same thing. Whitespace inside a term, such as `1 ms`, is invalid. The complete
input must match; no prefix or trailing junk is ignored.

Uppercase units, fractions, signs (including `-0ms`), exponent notation, other
numeric spellings, bare numbers, duplicate or reversed units, newlines and other
whitespace, unknown characters, and empty or whitespace-only strings are invalid.

## Errors and exact arithmetic

- **`TypeError`**: the argument is not a primitive string, including omitted
  arguments, objects, and boxed strings. Conversion hooks are never called.
- **`SyntaxError`**: a string violates any grammar rule. Syntax takes precedence
  over overflow: `9007199254740992msx`, `9007199254740992ms0ms`, and an overflowing
  duration followed by a newline all throw `SyntaxError`.
- **`RangeError`**: the complete string is grammatical, but its mathematical total
  exceeds `Number.MAX_SAFE_INTEGER`. Both individual terms and the combined sum
  are subject to this limit. Error-message wording is not part of the contract.

`9007199254740991ms`, `9007199254740s991ms`, and `104249991d8h59m0s991ms` all return
exactly `Number.MAX_SAFE_INTEGER`. Adding one millisecond to any of them throws
`RangeError`.

The parser removes leading zeros and uses bounded BigInt arithmetic before
converting the accepted total to Number. Integers with too many significant
digits retain an overflow marker while the remaining syntax is validated; they
are never rounded into an accepted value or converted into unbounded BigInts.
Each call has its own scan cursor, ordering, and total, so successful and failed
calls retain no parser state. Scanning takes linear time in the input length.
