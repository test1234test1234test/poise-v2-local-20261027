import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countLines } from '../lib/count-lines.mjs';

const cases = [
  ['empty text', '', 0],
  ['one unterminated line', 'a', 1],
  ['whitespace-only text', ' \t', 1],
];

for (const [name, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  cases.push(
    [`${name}: two unterminated lines`, `a${newline}b`, 2],
    [`${name}: final terminator`, `a${newline}`, 1],
    [`${name}: whitespace-only terminated line`, ` \t${newline}`, 1],
    [`${name}: one blank line`, newline, 1],
    [`${name}: two blank lines`, newline.repeat(2), 2],
    [`${name}: leading blank line`, `${newline}a`, 2],
    [`${name}: interior blank line`, `a${newline}${newline}b`, 3],
    [`${name}: trailing blank line`, `a${newline}${newline}`, 2],
    [`${name}: multiple trailing blank lines`, `a${newline.repeat(3)}`, 3],
    [`${name}: final whitespace line`, `a${newline} \t`, 2],
    [`${name}: terminated final whitespace line`, `a${newline} \t${newline}`, 2],
  );
}

cases.push(
  ['mixed endings with final terminator', 'a\r\nb\nc\r\n', 3],
  ['mixed endings without final terminator', 'a\nb\r\nc', 3],
  ['mixed endings preserve trailing blank line', 'a\r\n\n', 2],
  ['mixed blank lines', '\n\r\n\n', 3],
  ['lone CR is content', 'a\rb', 1],
  ['lone CR after LF is a final line', 'a\n\r', 2],
  ['CR alone is a nonempty line', '\r', 1],
  ['Unicode line separator is content', 'a\u2028b', 1],
  ['Unicode paragraph separator is content', 'a\u2029b', 1],
  ['Unicode next line is content', 'a\u0085b', 1],
);

for (const [name, text, expected] of cases) {
  test(`countLines: ${name}`, () => {
    assert.equal(countLines(text), expected);
  });
}
