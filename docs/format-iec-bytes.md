# `formatIecBytes(value)`

```js
import { formatIecBytes } from '../lib/format-iec-bytes.mjs';

formatIecBytes(0);        // '0 B'
formatIecBytes(-0);       // '0 B'
formatIecBytes(1023);     // '1023 B'
formatIecBytes(1024);     // '1.0 KiB'
formatIecBytes(1536n);    // '1.5 KiB'
formatIecBytes(1048575);  // '1.0 MiB'
```

Returns a primitive string displaying a nonnegative integer byte count. Accepts
primitive Numbers from zero through `Number.MAX_SAFE_INTEGER` inclusive, provided
they are integers, and nonnegative BigInts with no magnitude cap. Number `-0`
is accepted and returns `'0 B'`. Inputs are never coerced.

## Formatting and rounding

Units are case-sensitive: `B`, `KiB`, `MiB`, `GiB`, `TiB`, `PiB`, and `EiB`.
Each step is exactly 1024 times the preceding unit; EiB is `1024n ** 6n` bytes.
Values below 1024 use integer-only B formatting. Larger values start with the
largest supported unit whose byte divisor does not exceed the input and print
exactly one fractional digit, even for whole units.

Rounding is half up, using exact integer arithmetic on the original byte count.
For example, `1279` becomes `'1.2 KiB'`, while the exact half tie `1280` becomes
`'1.3 KiB'`. If rounding would print `1024.0` and a larger supported unit exists,
the formatter promotes to that unit and recalculates from the original bytes:
`1048524` becomes `'1023.9 KiB'`, but `1048525` becomes `'1.0 MiB'`.

EiB is the largest unit. Larger inputs keep their full decimal magnitude:
`1024n ** 7n` becomes `'1024.0 EiB'`, and `10000n * (1024n ** 6n)` becomes
`'10000.0 EiB'`. BigInts are never converted to Number for rounding or rendering,
so even values beyond Number's finite range retain exact rounding.

Output uses ASCII digits, an ASCII decimal point for scaled units, and exactly
one ASCII space before the unit. There are no grouping separators, exponent
notation, leading padding, or trailing whitespace/newlines.

## Errors

- **`TypeError`**: any type other than a primitive Number or BigInt, including
  omitted arguments, `undefined`, `null`, strings, booleans, Symbols, functions,
  arrays, objects, and boxed Numbers/BigInts. Objects and proxies are rejected
  without reading properties or invoking conversion hooks, including when
  constructing error messages.
- **`RangeError`**: negative Numbers or BigInts, fractional Numbers (including
  `Number.MIN_VALUE`), `NaN`, infinities, or unsafe Numbers. For example,
  `9007199254740992` throws, while `9007199254740992n` returns `'8.0 PiB'`.
  `Number.MAX_SAFE_INTEGER` and its BigInt equivalent also return `'8.0 PiB'`.

Error-message wording is not part of the contract.

## Relationship to `parseByteSize`

This is a lossy display API, not an inverse of [parseByteSize](parse-byte-size.md).
For example, `1025` displays as `'1.0 KiB'`, which parses as `1024`. Also, `1126`
displays as `'1.1 KiB'`, which the parser rejects with `RangeError` because it
represents 1126.4 bytes. The parser accepts units only through GiB and returns
safe Numbers, so TiB/PiB/EiB output and arbitrary BigInt magnitudes cannot round
trip through it.

Run the dedicated tests with
`node --test --test-concurrency=1 test/format-iec-bytes.test.mjs`, or the complete
repository suite with `npm test -- --test-concurrency=1` on Node 22.
