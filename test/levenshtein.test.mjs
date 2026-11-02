import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levenshteinDistance } from '../lib/levenshtein.mjs';

const cases = [
  ['both empty', '', '', 0],
  ['identical mixed Unicode', 'A😀e\u0301', 'A😀e\u0301', 0],
  ['empty and ASCII', '', 'abc', 3],
  ['insertion and deletion', 'cat', 'cart', 1],
  ['substitution', 'cat', 'cut', 1],
  ['multiple edits', 'kitten', 'sitting', 3],
  ['shifted alignment', 'flaw', 'lawn', 2],
  ['no unit-cost transposition', 'ab', 'ba', 2],
  ['supplementary character counts once', '😀', '', 1],
  ['both surrogate units differ', '\u{10000}', '\u{10FFFF}', 1],
  ['supplementary deletion inside text', 'a😀b', 'ab', 1],
  ['no normalization or grapheme comparison', 'é', 'e\u0301', 2],
  ['combining mark is separate', 'e\u0301', 'e', 1],
  ['case sensitivity', 'A', 'a', 1],
  ['ZWJ family components', '👨‍👩‍👧‍👦', '', 7],
  ['regional indicators', '🇺🇸', '', 2],
  ['NUL, BOM and noncharacter', '\0\uFEFF\uFFFF', '', 3],
  ['newlines are not normalized', 'a\r\nb', 'a\nb', 1],
  ['all line terminators count', '\n\r\u2028\u2029', '', 4],
  ['literal escape text is not decoded', '\\uD800', '', 6],
  ['shared high surrogate at prefix', '😀', '😁😀', 1],
  ['shared low surrogate at suffix', '\u{10000}', '\u{10000}\u{10400}', 1],
  ['code points are not truncated to 16 bits', '\0', '\u{10000}', 1],
  ['supplementary matches are preserved', 'x\u{10000}', 'y\u{10000}', 1],
  ['UTF-16 and code-point length order differ', '😀😀', 'abc', 3],
];

for (const [name, left, right, expected] of cases) {
  test(`levenshteinDistance: ${name} in both orientations`, () => {
    assert.equal(levenshteinDistance(left, right), expected);
    assert.equal(levenshteinDistance(right, left), expected);
  });
}

for (const point of [
  '\uD7FF', '\uE000', '\uD800\uDC00', '\uDBFF\uDFFF',
  '\uFFFD', '\0', '\uFEFF', '\uFDD0', '\uFFFE', '\uFFFF', '\uE123', '\u0301',
]) {
  test(`levenshteinDistance accepts valid code point ${JSON.stringify(point)}`, () => {
    assert.equal(levenshteinDistance(point, point), 0);
    assert.equal(levenshteinDistance(point, ''), 1);
    assert.equal(levenshteinDistance('', point), 1);
    assert.equal(levenshteinDistance(point, 'a'), 1);
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
  ['string array', ['text']],
  ['plain object', {}],
  ['function', () => 'text'],
  ['boxed string', new String('text')],
  ['boxed empty string', new String('')],
  ['boxed malformed string', new String('\uD800')],
];

for (const [name, input] of invalidInputs) {
  test(`levenshteinDistance rejects ${name} before successful shortcuts`, () => {
    assert.throws(() => levenshteinDistance(input, input), TypeError);
    for (const valid of ['', 'text']) {
      assert.throws(() => levenshteinDistance(input, valid), TypeError);
      assert.throws(() => levenshteinDistance(valid, input), TypeError);
    }
  });
}

test('levenshteinDistance rejects omitted arguments', () => {
  assert.throws(() => levenshteinDistance(), TypeError);
  assert.throws(() => levenshteinDistance(''), TypeError);
  assert.throws(() => levenshteinDistance('text'), TypeError);
});

const malformedInputs = [
  '\uD800', '\uDBFF', '\uDC00', '\uDFFF',
  '\uD800text', '\uDC00text',
  'left\uD800right', 'left\uDC00right',
  'text\uD800', 'text\uDC00',
  '\uD800\uD800', '\uDC00\uDC00', '\uDC00\uD800',
  '\uD800x\uDC00', '\uD800\n\uDC00', '\uD800\0\uDC00',
  '\uD800\uDBFF\uDC00', '\uD800\uDBFF\uDC00\uDFFF',
  '\uD800\uDC00\uDFFF', '\uD800\uDC00\uDBFF',
  '😀😀\uD800', '😀😀\uDC00',
];

for (const input of malformedInputs) {
  test(`levenshteinDistance rejects malformed UTF-16 ${JSON.stringify(input)}`, () => {
    assert.throws(() => levenshteinDistance(input, input), TypeError);
    for (const valid of ['', 'text', '😀😀']) {
      assert.throws(() => levenshteinDistance(input, valid), TypeError);
      assert.throws(() => levenshteinDistance(valid, input), TypeError);
    }
  });
}

for (const property of [
  Symbol.toPrimitive, Symbol.iterator, 'toString', 'valueOf',
  'length', '0', 'charCodeAt', 'isWellFormed',
]) {
  test(`levenshteinDistance rejects objects without reading ${String(property)}`, () => {
    let reads = 0;
    const input = Object.defineProperty({}, property, {
      get() {
        reads += 1;
        throw new Error('property access sentinel');
      },
    });

    for (const valid of ['', 'text']) {
      assert.throws(() => levenshteinDistance(input, valid), TypeError);
      assert.throws(() => levenshteinDistance(valid, input), TypeError);
    }
    assert.equal(reads, 0);
  });
}

for (const method of [Symbol.toPrimitive, 'toString', 'valueOf']) {
  test(`levenshteinDistance rejects objects without calling ${String(method)}`, () => {
    let calls = 0;
    const input = {
      [method]() {
        calls += 1;
        throw new Error('conversion sentinel');
      },
    };

    for (const valid of ['', 'text']) {
      assert.throws(() => levenshteinDistance(input, valid), TypeError);
      assert.throws(() => levenshteinDistance(valid, input), TypeError);
    }
    assert.equal(calls, 0);
  });
}

test('levenshteinDistance calls stay independent after rejected inputs', () => {
  for (let index = 0; index < 3; index += 1) {
    assert.equal(levenshteinDistance('kitten', 'sitting'), 3);
    assert.throws(() => levenshteinDistance('', '\uDC00'), TypeError);
    assert.equal(levenshteinDistance('é', 'e\u0301'), 2);
    assert.throws(() => levenshteinDistance(undefined, undefined), TypeError);
    assert.equal(levenshteinDistance('😀', ''), 1);
    assert.equal(levenshteinDistance('same', 'same'), 0);
  }
});

test('levenshteinDistance handles substantially unequal lengths without row overflow', () => {
  for (const [left, right, expected] of [
    ['😀', '😀'.repeat(65_537), 65_536],
    ['x', '😀'.repeat(65_536), 65_536],
    ['', '😀'.repeat(65_537), 65_537],
  ]) {
    assert.equal(levenshteinDistance(left, right), expected);
    assert.equal(levenshteinDistance(right, left), expected);
  }
});

// A full-matrix oracle is used only for the short generated inputs below.
function referenceDistance(left, right) {
  const a = [...left];
  const b = [...right];
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return matrix[a.length][b.length];
}

test('levenshteinDistance agrees with a reference for all short mixed Unicode strings', () => {
  const alphabet = ['a', 'b', '😀', '😁', '\u{10000}', '\u{10400}', '\u0301'];
  const strings = [''];
  let level = [''];
  for (let length = 1; length <= 3; length += 1) {
    level = level.flatMap(prefix => alphabet.map(point => prefix + point));
    strings.push(...level);
  }

  for (const left of strings) {
    assert.equal(levenshteinDistance(left, left), 0);
    for (const right of strings) {
      const context = `${JSON.stringify(left)}, ${JSON.stringify(right)}`;
      const result = levenshteinDistance(left, right);
      const m = [...left].length;
      const n = [...right].length;
      assert.equal(result, referenceDistance(left, right), context);
      assert.equal(result, levenshteinDistance(right, left), context);
      assert.ok(Number.isInteger(result) && result >= 0, context);
      assert.ok(result >= Math.abs(m - n) && result <= Math.max(m, n), context);
    }
  }
});
