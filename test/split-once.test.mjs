import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitOnce } from '../lib/split-once.mjs';

const cases = [
  ['absent separator', 'abc', ':', ['abc', null]],
  ['empty text', '', ':', ['', null]],
  ['separator longer than text', 'a', 'aa', ['a', null]],
  ['leading separator', ':abc', ':', ['', 'abc']],
  ['trailing separator', 'abc:', ':', ['abc', '']],
  ['entire text matches', 'abc', 'abc', ['', '']],
  ['repeated separator preserves the complete tail', 'a:b:c', ':', ['a', 'b:c']],
  ['adjacent occurrences', '::', ':', ['', ':']],
  ['multi-unit separator', 'x::y::z', '::', ['x', 'y::z']],
  ['repeated separator at the end', 'a::::', '::', ['a', '::']],
  ['overlapping occurrences', 'ababa', 'aba', ['', 'ba']],
  ['overlap after a nonempty prefix', 'zababa', 'aba', ['z', 'ba']],
  ['overlap and a later full occurrence', 'abababa', 'aba', ['', 'baba']],
  ['valid match after a failed prefix', 'ababc', 'abc', ['ab', '']],
  ['literal regex metacharacter', 'a.b.c', '.', ['a', 'b.c']],
  ['literal multi-unit regex syntax', 'a.*b.*c', '.*', ['a', 'b.*c']],
  ['literal invalid regex syntax', 'a[b[c', '[', ['a', 'b[c']],
  ['case-sensitive matching', 'Aa', 'a', ['A', '']],
  ['astral separator', 'x😀y😀z', '😀', ['x', 'y😀z']],
  ['astral text before the split', '😀x::y', '::', ['😀x', 'y']],
  ['high surrogate inside a pair', '😀', '\uD83D', ['', '\uDE00']],
  ['low surrogate inside a pair', '😀', '\uDE00', ['\uD83D', '']],
  ['separator crossing two pairs', '😀😀', '\uDE00\uD83D', ['\uD83D', '\uDE00']],
  ['lone surrogates stay literal', 'a\uD800b\uD800c', '\uD800', ['a', 'b\uD800c']],
  ['no malformed UTF-16 repair', '\uD800', '\uFFFD', ['\uD800', null]],
  ['no normalization of text', 'e\u0301', 'é', ['e\u0301', null]],
  ['no normalization of separator', 'é', 'e\u0301', ['é', null]],
  ['combining mark within a grapheme', 'e\u0301x', '\u0301', ['e', 'x']],
  ['embedded NUL', 'a\0b\0c', '\0', ['a', 'b\0c']],
  ['literal two-unit CRLF', 'a\r\nb\r\nc', '\r\n', ['a', 'b\r\nc']],
  ['whitespace preserved', '  a::b  ', '::', ['  a', 'b  ']],
  ['no escape decoding', '\\n', '\n', ['\\n', null]],
];

for (const [name, text, separator, expected] of cases) {
  test(`splitOnce: ${name}`, () => {
    assert.deepEqual(splitOnce(text, separator), expected);
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
  test(`splitOnce rejects ${name} in either position before range checks or early returns`, () => {
    assert.throws(() => splitOnce(input, ':'), TypeError);
    assert.throws(() => splitOnce(input, ''), TypeError);
    assert.throws(() => splitOnce('abc', input), TypeError);
    assert.throws(() => splitOnce('', input), TypeError);
  });
}

test('splitOnce rejects omitted arguments', () => {
  assert.throws(() => splitOnce(), TypeError);
  assert.throws(() => splitOnce('abc'), TypeError);
  assert.throws(() => splitOnce(''), TypeError);
});

test('splitOnce rejects an empty separator even with empty text', () => {
  assert.throws(() => splitOnce('abc', ''), RangeError);
  assert.throws(() => splitOnce('', ''), RangeError);
});

for (const property of [Symbol.toPrimitive, 'toString', 'valueOf', 'length', 'indexOf']) {
  test(`splitOnce rejects objects without reading ${String(property)}`, () => {
    let reads = 0;
    const input = Object.defineProperty({}, property, {
      get() {
        reads += 1;
        throw new TypeError('property access sentinel');
      },
    });

    assert.throws(() => splitOnce(input, ':'), TypeError);
    assert.throws(() => splitOnce(input, ''), TypeError);
    assert.throws(() => splitOnce('abc', input), TypeError);
    assert.throws(() => splitOnce('', input), TypeError);
    assert.equal(reads, 0);
  });
}

for (const method of [Symbol.toPrimitive, 'toString', 'valueOf']) {
  for (const throws of [false, true]) {
    test(`splitOnce never calls ${String(method)} hooks that ${throws ? 'throw' : 'return a string'}`, () => {
      let calls = 0;
      const input = {
        [method]() {
          calls += 1;
          if (throws) throw new TypeError('coercion sentinel');
          return 'abc';
        },
      };

      assert.throws(() => splitOnce(input, ':'), TypeError);
      assert.throws(() => splitOnce(input, ''), TypeError);
      assert.throws(() => splitOnce('abc', input), TypeError);
      assert.throws(() => splitOnce('', input), TypeError);
      assert.equal(calls, 0);
    });
  }
}

for (const [name, text, separator, expected] of [
  ['matched', 'a:b:c', ':', ['a', 'b:c']],
  ['trailing', 'abc:', ':', ['abc', '']],
  ['absent', 'abc', ':', ['abc', null]],
  ['empty text', '', ':', ['', null]],
]) {
  test(`splitOnce returns a fresh two-element array for ${name} calls`, () => {
    const first = splitOnce(text, separator);
    const second = splitOnce(text, separator);

    for (const result of [first, second]) {
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 2);
      assert.deepEqual(result, expected);
    }
    assert.notEqual(first, second);
    first[0] = 'changed';
    first.push('extra');
    assert.deepEqual(second, expected);
    assert.deepEqual(splitOnce(text, separator), expected);
  });
}

test('splitOnce preserves earlier results across alternating successful, absent and rejected calls', () => {
  const matched = splitOnce('a:b:c', ':');
  const absent = splitOnce('abc', ':');
  assert.throws(() => splitOnce(null, ''), TypeError);
  const trailing = splitOnce('abc:', ':');
  const empty = splitOnce('', ':');
  assert.throws(() => splitOnce('', ''), RangeError);
  assert.deepEqual(splitOnce('ababa', 'aba'), ['', 'ba']);

  assert.deepEqual(matched, ['a', 'b:c']);
  assert.deepEqual(absent, ['abc', null]);
  assert.deepEqual(trailing, ['abc', '']);
  assert.deepEqual(empty, ['', null]);
});
