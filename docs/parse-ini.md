# Strict INI reader

Import the named `parseIni(text)` export directly from `lib/parse-ini.mjs`:

```js
import { parseIni } from './lib/parse-ini.mjs';

const config = parseIni(`title = Demo
empty =
[ server ]
port = 001
enabled = false
[other]
port = 8080
[server]
host = localhost`);

config.root.title;           // 'Demo'
config.root.empty;           // ''
config.sections.server.port; // '001'
config.sections.server.enabled; // 'false'
Object.keys(config.sections); // ['server', 'other']
Object.keys(config.sections.server); // ['port', 'enabled', 'host']
```

The result has a null prototype and exactly two own properties, `root` and
`sections`. `root` is a null-prototype dictionary of strings. `sections` is a
null-prototype dictionary mapping names to null-prototype dictionaries of
strings, including empty sections. Every call creates independent objects;
root and all named sections are independent scopes. Empty, BOM-only, blank-only,
and comment-only documents return fresh empty dictionaries.

Distinct keys and section names retain **source insertion order**, including
array-index names such as `10`, `2`, and `0`. Reopening a section retains its
original position. The dictionaries use Proxies over null-prototype targets to
provide this order through `Object.keys`, `Object.entries`, and `Reflect.ownKeys`;
an ordinary JavaScript object would reorder array-index names. Bookkeeping is
not stored in own properties. The dictionaries remain mutable: updates retain
position, while deletion followed by reinsertion puts a key at the end.

```js
const ordered = parseIni('10=a\n2=b\n[10]\nx=1\n[2]\nx=2\n[10]\ny=3');
Object.keys(ordered.root);     // ['10', '2']
Object.keys(ordered.sections); // ['10', '2']
Object.keys(ordered.sections['10']); // ['x', 'y']

const safe = parseIni('__proto__=data\n[root]\nconstructor=value');
Object.hasOwn(safe.root, '__proto__'); // true
safe.root.__proto__;                  // 'data'
safe.sections.root.constructor;      // 'value'
Object.getPrototypeOf(safe.root);     // null
```

Names such as `__proto__`, `constructor`, `prototype`, `hasOwnProperty`,
`toString`, `root`, and `sections` are ordinary names at every dictionary level.
They do not alter prototypes or collide with the wrapper's fields.

## Physical lines and whitespace

- Exactly one initial U+FEFF BOM is ignored, only at source offset zero.
  Subsequent BOMs remain data: `\uFEFF\uFEFFa=b` has key `\uFEFFa`, while
  `a=\uFEFF` has a BOM value. A later BOM before a header or comment is not
  indentation and prevents recognition of that header or comment.
- LF, CRLF, and lone CR terminate physical lines. CRLF counts once; LF followed
  by CR counts twice. Blank and comment lines count toward error coordinates.
  U+2028 and U+2029 are content, not physical line endings.
- Only ASCII space (U+0020) and horizontal tab (U+0009) are surrounding grammar
  whitespace. No Unicode whitespace is trimmed or normalized: NBSP (U+00A0)
  can itself be a nonempty key, section name, or value.
- Empty lines and lines containing only space/tab are ignored. A `;` or `#` at
  the first non-space/tab position starts a whole-line comment. Its entire
  contents are ignored, even controls, equals signs, brackets, and quotes.
  Blank and comment lines do not reset the current section.

For example, `a=#literal` stores `#literal`. An NBSP followed by `#key=value`
creates a literal NBSP-prefixed key; it is not a comment. An NBSP-prefixed
`#comment` without an equals sign is an error.

## Sections and assignments

A header is `[name]` with optional space/tab around the whole header and around
the name. The trimmed name must be nonempty, contain no `[` or `]`, and contain
no forbidden raw controls. The closing bracket must be followed only by
space/tab. `[s] #comment`, `[s]=value`, and nested brackets are errors.
Headers are recognized before assignments: `[ a=b ]` names section `a=b`.
Reopening a section adds to the existing scope rather than replacing it.

An assignment splits at the first `=`. Space/tab around the key and value is
trimmed. The key must be nonempty, contain no brackets, and contain no forbidden
raw controls. Further equals signs belong to the value; an empty value is valid.
Assignments before any header belong to `root`; subsequent assignments belong
to the current named section. `[root]` is an ordinary named section, independent
of the top-level root scope. There is no header that switches back to root.

Duplicate assignment keys in the same scope are errors, including equal or empty
values and duplicates after section reopening. Identity is case-sensitive and
uses the trimmed literal name. Dots do not create nesting. Quotes and backslashes
in names are literal characters; names have no quoting or escape syntax.
Interior spaces are accepted in names, but raw interior tabs are not.

## Values and escapes

All values remain strings: numbers and Booleans are not inferred. An unquoted
value preserves all content after surrounding space/tab trimming, including
`;`, `#`, brackets, backslashes, and quote characters in the middle or at the end.
Unquoted backslashes never introduce escapes.

If the first character after trimming is `'` or `"`, the value must be quoted
with that same character. The first unescaped matching closing quote must be
the final non-space/tab character. Trailing comments, doubled quotes, and other
trailing characters are errors, including NBSP, BOM, U+2028, and U+2029. Spaces
inside the quotes remain data; the other kind of quote is literal.

Inside either quote mode, the only escapes are:

| Source escape | Decoded data |
| --- | --- |
| Backslash followed by the matching quote | That quote |
| `\\` | One backslash |
| `\n` | LF |
| `\r` | CR |
| `\t` | HT |

Escapes are decoded exactly once. Backslash followed by the *other* quote is
an unknown escape, as are `\q`, `\0`, `\x41`, and `\u0041`. A final backslash
inside a quote, an absent closing quote, or a mismatched closing quote fails.

These JavaScript examples use `String.raw` to show the actual INI backslashes:

```js
parseIni(String.raw`path=C:\new\test`).root.path;     // 'C:\\new\\test'
parseIni(String.raw`path="C:\\new\\test"`).root.path; // 'C:\\new\\test'
parseIni(String.raw`k="a\nb"`).root.k;               // 'a\nb' (contains LF)
parseIni(String.raw`k="\\n"`).root.k;                // '\\n' (backslash and n)
parseIni(String.raw`k='\\q'`).root.k;                // '\\q' (backslash and q)
parseIni(String.raw`k='it\'s'`).root.k;              // "it's"
parseIni(String.raw`k="say \"hi\""`).root.k;         // 'say "hi"'
```

Raw **U+0000–U+001F and U+007F–U+009F** control characters are forbidden in keys,
section names, and values. Physical CR/LF delimit lines, and surrounding raw HT
serves only as grammar whitespace. A raw HT remaining inside a name, bare value,
or quoted value is an error, including at the edges inside quotes. Validation
applies to raw source, so documented escapes may produce LF, CR, and HT data.
Unicode whitespace and format characters outside those control ranges remain
literal content wherever the grammar permits content.

## Errors and limits

Only primitive strings are accepted. Omitted arguments, boxed strings, and all
other types throw `TypeError` without coercion or invoking conversion hooks.

Process physical lines in source order and report the **first invalid physical
line**. Every syntax failure throws `SyntaxError` with an own numeric, positive
integer `lineNumber` property. An unterminated quote reports the line where it
began; the parser never consumes a second line to find its closing quote.
Decoded newline escapes do not affect physical coordinates. No partial result
is returned. Error-message wording and precedence among defects on the same line
are unspecified.

```js
try {
  parseIni(';comment\r\n[s]\nk=1\nk=2');
} catch (error) {
  error instanceof SyntaxError;            // true
  Object.hasOwn(error, 'lineNumber');        // true
  error.lineNumber;                         // 4
}
```

This dialect has no inline comments, multiline values, line continuation,
interpolation (including `${NAME}`), nesting, type conversion, or file or
environment access. It adds no dependencies and has no fixed input/value length
limit; available memory and JavaScript string limits still apply. It does not
share the CSV parser's quoting rules or the line counter's treatment of lone CR.

Run the regression tests with `npm test` (the repository's `node --test` check).
