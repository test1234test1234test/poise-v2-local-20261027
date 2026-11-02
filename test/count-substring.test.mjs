import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countSubstring } from '../lib/count-substring.mjs';

const cases = [
  ['non-overlapping repetitions', 'aaaaa', 'aa', 2],
  ['adjacent matches through the end', 'aaaa', 'aa', 2],
  ['self-overlap excluded', 'ababa', 'aba', 1],
  ['later non-overlapping match', 'abababa', 'aba', 2],
  ['resume relative to the found position', 'xxxabab', 'ab', 2],
  ['full-string match at zero', 'abc', 'abc', 1],
  ['absent needle', 'abc', 'z', 0],
  ['needle longer than text', 'a', 'aa', 0],
  ['empty text', '', 'a', 0],
  ['case sensitivity', 'aAaA', 'a', 2],
  ['literal regex metacharacter', 'a.b.', '.', 2],
  ['literal invalid regex syntax', '[x[', '[', 2],
  ['no deletion-boundary matches', 'aababa', 'aba', 1],
  ['valid start after a failed prefix', 'ababc', 'abc', 1],
  ['supplementary characters', '😀😀', '😀', 2],
  ['advance by UTF-16 needle length', '😀😀😀', '😀😀', 1],
  ['high surrogate within a pair', '😀', '\uD83D', 1],
  ['low surrogate within a pair', '😀', '\uDE00', 1],
  ['across surrogate-pair boundaries', '😀😀', '\uDE00\uD83D', 1],
  ['non-overlapping lone surrogates', '\uD800\uD800\uD800', '\uD800\uD800', 1],
  ['no malformed UTF-16 repair', '\uD800', '\uFFFD', 0],
  ['no normalization of decomposed text', 'e\u0301', 'é', 0],
  ['no normalization of composed text', 'é', 'e\u0301', 0],
  ['combining mark within a grapheme', 'e\u0301e\u0301', '\u0301', 2],
  ['NUL content', 'a\0a\0', '\0', 2],
  ['BOM content', '\uFEFFx\uFEFF', '\uFEFF', 2],
  ['whitespace content', ' \t \t', ' \t', 2],
  ['literal CRLF', '\r\n\n', '\r\n', 1],
  ['lone CR content', '\r\n\r', '\r', 2],
  ['literal backslashes', '\\n\\n', '\\n', 2],
  ['no escape decoding', '\\n', '\n', 0],
];

for (const [name, text, needle, expected] of cases) {
  test(`countSubstring: ${name}`, () => {
    assert.equal(countSubstring(text, needle), expected);
  });
}

const invalidInputs = [
  ['undefined', undefined],
  ['null', null],
  ['true', true],
  ['false', false],
  ['zero', 0],
  ['number', 42],
  ['NaN', NaN],
  ['infinity', Infinity],
  ['zero bigint', 0n],
  ['bigint', 42n],
  ['symbol', Symbol('text')],
  ['empty array', []],
  ['string array', ['a']],
  ['plain object', {}],
  ['function', () => 'a'],
  ['regular expression', /a/],
  ['boxed string', new String('a')],
  ['boxed empty string', new String('')],
  ['object with zero length', { length: 0 }],
];

for (const [name, input] of invalidInputs) {
  test(`countSubstring rejects ${name} in either position before range checks or early returns`, () => {
    assert.throws(() => countSubstring(input, 'a'), TypeError);
    assert.throws(() => countSubstring(input, ''), TypeError);
    assert.throws(() => countSubstring('a', input), TypeError);
    assert.throws(() => countSubstring('', input), TypeError);
  });
}

test('countSubstring rejects omitted arguments', () => {
  assert.throws(() => countSubstring(), TypeError);
  assert.throws(() => countSubstring('abc'), TypeError);
  assert.throws(() => countSubstring(''), TypeError);
});

test('countSubstring rejects an empty needle even with empty text', () => {
  assert.throws(() => countSubstring('abc', ''), RangeError);
  assert.throws(() => countSubstring('', ''), RangeError);
});

for (const property of [Symbol.toPrimitive, 'toString', 'valueOf', 'length', 'indexOf']) {
  test(`countSubstring rejects objects without reading ${String(property)}`, () => {
    let reads = 0;
    const input = Object.defineProperty({}, property, {
      get() {
        reads += 1;
        throw new TypeError('property access sentinel');
      },
    });

    assert.throws(() => countSubstring(input, 'a'), TypeError);
    assert.throws(() => countSubstring(input, ''), TypeError);
    assert.throws(() => countSubstring('a', input), TypeError);
    assert.throws(() => countSubstring('', input), TypeError);
    assert.equal(reads, 0);
  });
}

for (const method of [Symbol.toPrimitive, 'toString', 'valueOf']) {
  test(`countSubstring rejects objects without calling ${String(method)}`, () => {
    let calls = 0;
    const input = {
      [method]() {
        calls += 1;
        throw new TypeError('coercion sentinel');
      },
    };

    assert.throws(() => countSubstring(input, 'a'), TypeError);
    assert.throws(() => countSubstring(input, ''), TypeError);
    assert.throws(() => countSubstring('a', input), TypeError);
    assert.throws(() => countSubstring('', input), TypeError);
    assert.equal(calls, 0);
  });
}

test('countSubstring is independent across successful, rejected and zero-match calls', () => {
  for (let index = 0; index < 3; index += 1) {
    assert.equal(countSubstring('aaaaa', 'aa'), 2);
    assert.throws(() => countSubstring(null, ''), TypeError);
    assert.equal(countSubstring('abc', 'z'), 0);
    assert.throws(() => countSubstring('', ''), RangeError);
    assert.equal(countSubstring('xxxabab', 'ab'), 2);
    assert.equal(countSubstring('', 'a'), 0);
    assert.equal(countSubstring('abc', 'abc'), 1);
  }
});

test('countSubstring scans many matches and a long repeated prefix through the tail', () => {
  assert.equal(countSubstring('ab'.repeat(10_000), 'ab'), 10_000);
  assert.equal(countSubstring('a'.repeat(50_000) + 'b', 'a'.repeat(100) + 'b'), 1);
});
