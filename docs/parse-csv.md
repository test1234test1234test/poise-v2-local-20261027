# Strict CSV reader

`parseCsv(text, options = {})` reads an entire string and returns an array of
rows, each an array of strings. Import the named export directly:

```js
import { parseCsv } from './lib/parse-csv.mjs';

parseCsv('name,city\r\nAda,London\r\n"Lin, Jr.",東京\r\n');
// [
//   ['name', 'city'],
//   ['Ada', 'London'],
//   ['Lin, Jr.', '東京'],
// ]

parseCsv('a;"b;c";d', { delimiter: ';' });
// [['a', 'b;c', 'd']]
```

The first row has no special meaning. Rows may have different widths. Values
remain literal strings: `001`, `TRUE`, and `=1+1` are neither converted nor
evaluated. The reader does not infer headers, pad rows, skip empty rows, or
perform filesystem or network operations. Every call has independent parser
state and returns fresh row arrays. It has no dependencies or fixed field/line
length limit; available memory and JavaScript string limits still apply.

## Options and delimiters

The default delimiter is comma. An explicit delimiter must be exactly one
UTF-16 code unit (`delimiter.length === 1`) other than double quote, CR, or LF.
For example, `';'`, `'é'`, space, tab, NUL, U+2028, U+FEFF, and a single surrogate
code unit are accepted; `'😀'` is two code units and is rejected. Input text is
preserved exactly, including astral characters and combining sequences.

Only own properties of `options` are considered. Every own key, including
non-enumerable and symbol keys, must be the string `delimiter`. Inherited
properties are ignored, including an inherited delimiter. Non-array objects
are accepted without requiring a plain object; null-prototype objects and
class instances work. An own delimiter is read once. Neither text nor options
are coerced or mutated.

Omitting `options` or passing `undefined` uses the default options. An absent
own delimiter defaults to comma; `{ delimiter: undefined }` is invalid.

Argument validation runs even for empty or BOM-only input:

| Error | Cause |
| --- | --- |
| `TypeError` | Nonstring text (including boxed strings); null, array, or nonobject options; unknown own option keys; a nonstring delimiter |
| `RangeError` | A delimiter with length other than one UTF-16 code unit, or a delimiter equal to quote, CR, or LF |

## Fields, whitespace, and row endings

A double quote opens a quoted field only at the start of that field. Inside
quotes, `""` encodes one literal quote. Delimiters and line breaks are content.
A closing quote must be followed immediately by the selected delimiter, LF,
CRLF, or end of input. A quote in a bare field is invalid. With the default
delimiter, both `' "a"'` and `'"a" '` are errors; whitespace is never trimmed.
If space is the selected delimiter, `'"a" b'` validly produces `[['a', 'b']]`.

Outside quotes, only LF (`\n`) and CRLF (`\r\n`) end rows. Mixed endings are
accepted. Bare CR (`\r`) is invalid outside quotes. Inside quotes, LF, CRLF,
and bare CR are all preserved exactly; no newline normalization occurs.
U+2028, U+2029, and U+0085 are ordinary field content unless selected as the
delimiter.

Empty input has zero rows. Each row has at least one field. Consecutive or
trailing delimiters produce empty strings. Quoted and bare empty fields are
ordinary equal strings without metadata. A final row ending closes the row
without adding an extra row, but actual empty rows are retained:

| Input (JavaScript literal) | Result |
| --- | --- |
| `''` | `[]` |
| `','` | `[['', '']]` |
| `'"",,\n'` | `[['', '', '']]` |
| `'a\r\n'` | `[['a']]` |
| `'\n'` | `[['']]` |
| `'\n\r\n'` | `[[''], ['']]` |

## BOM and error coordinates

One U+FEFF BOM is removed only at the beginning of the entire input. A BOM-only
input therefore produces `[]`. Other BOMs remain data, except that outside
quotes they separate fields if U+FEFF is the selected delimiter. The initial
removal happens before delimiter recognition:

```js
parseCsv('\uFEFF\uFEFF'); // [['\uFEFF']]
parseCsv('\uFEFFa\uFEFFb', { delimiter: '\uFEFF' }); // [['a', 'b']]
parseCsv('"\uFEFF"', { delimiter: '\uFEFF' }); // [['\uFEFF']]
```

Malformed CSV throws `SyntaxError` with integer, one-based `line` and `column`
properties. No partial rows are returned. The position identifies the first
offending input character; an unterminated quoted field points at the position
immediately after the last input character. Coordinates refer to the original
input, including the removed leading BOM. Columns count UTF-16 code units.
LF and CRLF each advance one line and reset the column to 1, even inside a
quoted field. A quoted bare CR advances the column by one without changing
the line. A BOM adds one column only on its original line.

For example, `'😀"'` fails at `(1, 3)`, `'\uFEFF"a"x'` fails at `(1, 5)`,
`'"a\r\nb"x'` fails at `(2, 3)`, and `'"a\r\n'` fails at EOF `(2, 1)`.
Error-message wording is not part of the API contract.
