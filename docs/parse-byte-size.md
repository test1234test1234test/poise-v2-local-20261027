# `parseByteSize(text)`

```js
import { parseByteSize } from '../lib/parse-byte-size.mjs';

parseByteSize('1.5 KiB');             // 1536
parseByteSize('0001.250kB');          // 1250
parseByteSize('0.000123MB');          // 123
parseByteSize('9007199254740.991kB'); // 9007199254740991
parseByteSize('1.0');                // 1
```

Returns a primitive Number containing the exact nonnegative integer byte count,
from positive zero through `Number.MAX_SAFE_INTEGER` (`9007199254740991`)
inclusive. The input must be a primitive string; no coercion, rounding or
truncation occurs.

## Grammar

The entire string must match this grammar:

```text
input  := WS* number (WS* unit)? WS*
number := [0-9]+ ('.' [0-9]+)?
unit   := 'B' | 'kB' | 'MB' | 'GB' | 'KiB' | 'MiB' | 'GiB'
WS     := [\x09-\x0D\x20]
```

ASCII whitespace means horizontal tab (U+0009), line feed (U+000A), vertical tab
(U+000B), form feed (U+000C), carriage return (U+000D), and space (U+0020).
It may surround the quantity or separate the number from its unit. Unicode
whitespace, including NBSP, BOM, U+2028 and U+2029, is rejected.

Units are case-sensitive and use these exact byte multipliers:

| Unit | Bytes |
| --- | ---: |
| Omitted or `B` | 1 |
| `kB` | 1000 |
| `MB` | 1000000 |
| `GB` | 1000000000 |
| `KiB` | 1024 |
| `MiB` | 1048576 |
| `GiB` | 1073741824 |

`1KiB` and `1 KiB` are equivalent. A decimal point requires digits on both sides.
Leading zeros and trailing fractional zeros do not affect the value; there is
no input-length or precision cap. For example, `000.000GiB` returns positive
zero, and `0.0000000009313225746154785156250GiB` returns one byte.

Only one quantity is allowed. Empty or whitespace-only strings, signs (including
`+0B` and `-0B`), exponents, hexadecimal/binary/octal notation, commas,
underscores, Unicode digits, `NaN`, `Infinity`, and trailing text are invalid.
Whitespace inside a number or unit (`1 0B`, `1 .0B`, `1 Ki B`) is invalid.
Aliases such as `KB`, `kb`, `KIB`, `mb`, `TB` and `bytes` are not supported.
Multiple quantities such as `1GB 1MB` are invalid.

## Errors and exact conversion

- **`TypeError`**: malformed syntax or a nonstring argument, including an omitted
  argument or a boxed string. Objects and proxies are rejected without reading
  properties or invoking conversion hooks. Syntax is checked before conversion:
  `9007199254740992junk`, `0.1B!`, and `0Bjunk` all throw `TypeError`.
- **`RangeError`**: a grammatical quantity is not a whole number of bytes or
  exceeds the inclusive safe-integer limit. For example, `0.1B`, `0.1KiB`,
  `1.5` and `9007199254740992B` throw `RangeError`. Error-message wording is not
  part of the contract.

The range applies to the final byte count, so `9007199254740991.0B` succeeds.
All significant decimal digits matter: `1.0000000000000000001B` is fractional
and throws even though floating-point conversion would round it to one byte.

The parser normalizes insignificant zeros and uses bounded BigInt multiplication,
division and a remainder check before converting the accepted integer to Number.
Long integers that must overflow and fractional scales that cannot produce whole
bytes are rejected without constructing unbounded BigInts or powers of ten.
Scanning is linear in the input length, and calls retain no parser state.

Run the dedicated tests with
`node --test --test-concurrency=1 test/parse-byte-size.test.mjs`, or the complete
repository suite with `npm test -- --test-concurrency=1` on Node 22.
