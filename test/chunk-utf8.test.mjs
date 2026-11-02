import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkUtf8 } from '../lib/chunk-utf8.mjs';

function checkChunks(text, maxBytes, expected) {
  const result = chunkUtf8(text, maxBytes);
  if (expected !== undefined) assert.deepEqual(result, expected);
  assert.equal(Array.isArray(result), true);
  assert.equal(Object.getPrototypeOf(result), Array.prototype);
  assert.equal(result.join(''), text);
  for (let index = 0; index < result.length; index += 1) {
    const part = result[index];
    assert.equal(typeof part, 'string');
    assert.ok(part.length > 0);
    assert.equal(part.isWellFormed(), true);
    assert.ok(Buffer.byteLength(part, 'utf8') <= maxBytes);
    if (index + 1 < result.length) {
      const nextPoint = String.fromCodePoint(result[index + 1].codePointAt(0));
      assert.ok(Buffer.byteLength(part + nextPoint, 'utf8') > maxBytes,
        'each nonfinal chunk must contain the longest prefix that fits');
    }
  }
  return result;
}

const partitions = [
  ['empty text', '', 1, []],
  ['empty text with largest safe limit', '', Number.MAX_SAFE_INTEGER, []],
  ['ASCII partial tail', 'abcde', 2, ['ab', 'cd', 'e']],
  ['ASCII exact boundary', 'abcd', 2, ['ab', 'cd']],
  ['one-byte limit', 'ab', 1, ['a', 'b']],
  ['mixed widths', 'aé€😀b', 5, ['aé', '€', '😀b']],
  ['two-byte exact fit', 'éé', 4, ['éé']],
  ['three-byte exact fit', '€€', 3, ['€', '€']],
  ['four-byte exact fit', '😀😀', 4, ['😀', '😀']],
  ['unused capacity cannot skip a code point', 'a€b', 3, ['a', '€', 'b']],
  ['UTF-16 offsets differ from byte counts', 'é😀a', 6, ['é😀', 'a']],
  ['decomposed accent', 'e\u0301', 2, ['e', '\u0301']],
  ['combining mark order', '\u0301\u0327', 3, ['\u0301', '\u0327']],
  ['ZWJ emoji', '👩\u200D💻', 4, ['👩', '\u200D', '💻']],
  ['regional indicators', '🇺🇸', 4, ['🇺', '🇸']],
  ['initial BOM, NUL and CRLF', '\uFEFFa\0\r\n', 3, ['\uFEFF', 'a\0\r', '\n']],
  ['interior BOM', 'x\uFEFFy', 3, ['x', '\uFEFF', 'y']],
  ['replacement character and noncharacters', '\uFFFD\uFDD0\uFFFE\uFFFF', 3,
    ['\uFFFD', '\uFDD0', '\uFFFE', '\uFFFF']],
  ['boundary surrogate pairs', '\u{10000}\u{10FFFF}', 4, ['\u{10000}', '\u{10FFFF}']],
  ['literal backslash escapes', '\\uD800\\n', 3, ['\\uD', '800', '\\n']],
  ['limit above 32 bits', 'aé€😀', 2 ** 32, ['aé€😀']],
  ['largest safe limit', 'aé€😀', Number.MAX_SAFE_INTEGER, ['aé€😀']],
];

for (const [name, text, maxBytes, expected] of partitions) {
  test(`chunkUtf8: ${name}`, () => {
    checkChunks(text, maxBytes, expected);
  });
}

const widthBoundaries = [
  [0x00, 1], [0x7F, 1], [0x80, 2], [0x7FF, 2], [0x800, 3],
  [0xD7FF, 3], [0xE000, 3], [0xFFFF, 3], [0x10000, 4], [0x10FFFF, 4],
];

for (const [point, width] of widthBoundaries) {
  test(`chunkUtf8 handles UTF-8 width at U+${point.toString(16).toUpperCase()}`, () => {
    const char = String.fromCodePoint(point);
    checkChunks(char, width, [char]);
    checkChunks(char + char, width, [char, char]);
    checkChunks(char + char, width * 2, [char + char]);
    checkChunks('a' + char + 'b', width, ['a', char, 'b']);
    if (width > 1) assert.throws(() => chunkUtf8(char, width - 1), RangeError);
  });
}

test('chunkUtf8 preserves mixed scalar boundaries and fills greedily across varying limits', () => {
  const points = widthBoundaries.map(([point]) => String.fromCodePoint(point));
  const text = points.join('') + points.reverse().join('');
  for (let maxBytes = 4; maxBytes <= 32; maxBytes += 1) checkChunks(text, maxBytes);
});

test('chunkUtf8 returns fresh ordinary arrays, independent of previous results and failures', () => {
  for (const text of ['', 'abc', 'aé€😀']) {
    const first = checkChunks(text, 4);
    const second = checkChunks(text, 4);
    assert.notEqual(first, second);
    assert.deepEqual(first, second);
    const expected = second.slice();
    first.push('changed');
    assert.deepEqual(second, expected);
    assert.throws(() => chunkUtf8('abc😀def', 3), RangeError);
    assert.throws(() => chunkUtf8('\uD800', 4), TypeError);
    assert.throws(() => chunkUtf8('', 0), TypeError);
    const afterFailure = checkChunks(text, 4, expected);
    assert.notEqual(afterFailure, second);
  }
});

test('chunkUtf8 requires a primitive string without coercion', () => {
  for (const text of [undefined, null, true, false, 0, 1, NaN, Infinity, 0n, 1n,
    Symbol('text'), [], ['abc'], {}, /abc/, () => 'abc',
    new String('abc'), new String(''), new String('\uD800')]) {
    assert.throws(() => chunkUtf8(text, 4), TypeError);
  }
  assert.throws(() => chunkUtf8(), TypeError);
});

test('chunkUtf8 requires a positive safe-integer limit, including for empty text', () => {
  const invalidLimits = [undefined, null, '2', true, false, 2n, Symbol('limit'),
    new Number(2), [], [2], {}, () => 2, 0, -0, -1, 1.5, Number.MIN_VALUE,
    NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];
  for (const text of ['', 'abc', '😀']) {
    assert.throws(() => chunkUtf8(text), TypeError);
    for (const maxBytes of invalidLimits) {
      assert.throws(() => chunkUtf8(text, maxBytes), TypeError);
    }
  }
});

for (const property of [Symbol.toPrimitive, 'toString', 'valueOf']) {
  test(`chunkUtf8 does not read or invoke ${String(property)} on arguments`, () => {
    let accesses = 0;
    const getter = Object.defineProperty({}, property, {
      get() { accesses += 1; throw new TypeError('coercion sentinel'); },
    });
    const method = {
      [property]() { accesses += 1; throw new TypeError('coercion sentinel'); },
    };
    for (const input of [getter, method]) {
      assert.throws(() => chunkUtf8(input, 4), TypeError);
      assert.throws(() => chunkUtf8('', input), TypeError);
      assert.throws(() => chunkUtf8('abc', input), TypeError);
    }
    assert.equal(accesses, 0);
  });
}

const malformedSequences = [
  ['lowest high surrogate', '\uD800'],
  ['highest high surrogate', '\uDBFF'],
  ['lowest low surrogate', '\uDC00'],
  ['highest low surrogate', '\uDFFF'],
  ['reversed pair', '\uDC00\uD800'],
  ['repeated high surrogates', '\uD800\uD800'],
  ['repeated low surrogates', '\uDC00\uDC00'],
  ['separated surrogates', '\uD800x\uDC00'],
  ['NUL between surrogates', '\uD800\0\uDC00'],
  ['overlapping pairs', '\uD800\uDBFF\uDC00'],
  ['pair followed by a high surrogate', '😀\uD800'],
  ['pair followed by a low surrogate', '😀\uDC00'],
];

for (const [name, malformed] of malformedSequences) {
  test(`chunkUtf8 rejects ${name} at every position`, () => {
    for (const text of [malformed, malformed + 'abc', 'abc' + malformed + 'def',
      'abc' + malformed]) {
      assert.throws(() => chunkUtf8(text, 4), TypeError);
    }
  });
}

test('chunkUtf8 validates the whole text before checking code-point capacity', () => {
  for (const malformed of ['\uD800', '\uDC00']) {
    assert.throws(() => chunkUtf8('😀' + malformed, 3), TypeError);
    assert.throws(() => chunkUtf8(malformed + '😀', 3), TypeError);
    assert.throws(() => chunkUtf8('abc😀'.repeat(10_000) + malformed, 4), TypeError);
  }
});

for (const [point, maxBytes] of [['é', 1], ['€', 2], ['😀', 3]]) {
  test(`chunkUtf8 rejects an oversized ${point} without returning partial chunks`, () => {
    for (const text of [point, point + 'abc', 'abc' + point, 'abc' + point + 'def',
      'abc'.repeat(10_000) + point + 'def'.repeat(10_000)]) {
      assert.throws(() => chunkUtf8(text, maxBytes), RangeError);
    }
    checkChunks('abc', 2, ['ab', 'c']);
  });
}

test('chunkUtf8 handles bounded long inputs with tiny limits and a single large chunk', () => {
  const ascii = 'ab'.repeat(20_000);
  assert.equal(checkChunks(ascii, 1).length, ascii.length);
  const mixed = 'aé€😀'.repeat(10_000);
  assert.equal(checkChunks(mixed, 4).length, 30_000);
  checkChunks(mixed, Buffer.byteLength(mixed, 'utf8'), [mixed]);
});
