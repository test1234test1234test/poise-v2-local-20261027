import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNewlines } from '../lib/normalize-newlines.mjs';

const cases = [
  ['empty text', '', ''],
  ['unterminated text', 'a', 'a'],
  ['whitespace-only text', ' \t', ' \t'],
  ['single LF', '\n', '\n'],
  ['existing LF and blank lines', 'a\n\nb\n', 'a\n\nb\n'],
  ['single CRLF', '\r\n', '\n'],
  ['single CR', '\r', '\n'],
  ['multiple CRLF replacements', 'a\r\nb\r\nc\r\n', 'a\nb\nc\n'],
  ['multiple CR replacements', 'a\rb\rc\r', 'a\nb\nc\n'],
  ['CRLF without a final terminator', 'a\r\nb', 'a\nb'],
  ['CR without a final terminator', 'a\rb', 'a\nb'],
  ['final lone CR', 'a\r', 'a\n'],
  ['LF followed by CR is two endings', '\n\r', '\n\n'],
  ['CR followed by CRLF is two endings', '\r\r\n', '\n\n'],
  ['CRLF followed by CR is two endings', '\r\n\r', '\n\n'],
  ['consecutive CRLF pairs', '\r\n\r\n', '\n\n'],
  ['consecutive lone CRs', '\r\r', '\n\n'],
  ['leading blank lines', '\r\r\na', '\n\na'],
  ['interior blank line', 'a\r\n\rb', 'a\n\nb'],
  ['trailing blank line', 'a\r\n\r\n', 'a\n\n'],
  ['mixed endings', 'a\nb\r\nc\rd', 'a\nb\nc\nd'],
  ['mixed leading, interior and trailing blank lines', '\ra\r\n\nb\rc\r\n\r\n', '\na\n\nb\nc\n\n'],
  ['space separates CR from LF', '\r \n', '\n \n'],
  ['tab separates CR from LF', '\r\t\n', '\n\t\n'],
  ['unterminated whitespace-only final line', 'a\r\n \t', 'a\n \t'],
  ['terminated whitespace-only lines', ' \t\r\n \t\r', ' \t\n \t\n'],
  ['spaces and tabs around content', ' \ta\t \r\n b \t\r c\t ', ' \ta\t \n b \t\n c\t '],
  ['non-ASCII content', 'café\r東京\r\n😀', 'café\n東京\n😀'],
  ['literal backslash escapes', '\\r\\n', '\\r\\n'],
  ['literal escapes alongside actual endings', '\\r\\n\r\n\\r\\n\r', '\\r\\n\n\\r\\n\n'],
  [
    'other UTF-16 code units alongside CRLF and CR',
    '\uFEFF\u0085\u2028\u2029\v\f\0\u00A0 \te\u0301😀\uD800x\uDC00\r\n\uD800\r\uDC00',
    '\uFEFF\u0085\u2028\u2029\v\f\0\u00A0 \te\u0301😀\uD800x\uDC00\n\uD800\n\uDC00',
  ],
];

for (const [name, text, expected] of cases) {
  test(`normalizeNewlines: ${name}`, () => {
    const normalized = normalizeNewlines(text);
    assert.equal(normalized, expected);
    assert.equal(normalizeNewlines(normalized), expected, 'normalization is idempotent');
  });
}
