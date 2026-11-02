import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWellFormedUnicode } from '../lib/well-formed-unicode.mjs';

const validCases = [
  ['empty text', ''],
  ['ASCII', 'ASCII'],
  ['non-ASCII BMP text', 'café 中文'],
  ['code unit before the surrogate range', '\uD7FF'],
  ['code unit after the surrogate range', '\uE000'],
  ['lowest high and lowest low surrogate', '\uD800\uDC00'],
  ['lowest high and highest low surrogate', '\uD800\uDFFF'],
  ['highest high and lowest low surrogate', '\uDBFF\uDC00'],
  ['highest high and highest low surrogate', '\uDBFF\uDFFF'],
  ['pair surrounded by BMP text', 'x\uD800\uDC00y'],
  ['consecutive boundary pairs', '\uD800\uDC00\uDBFF\uDFFF'],
  ['consecutive emoji', '😀😀'],
  ['mixed BMP, supplementary and decomposed text', 'A😀e\u0301'],
  ['NUL, BOM and whitespace', '\0\uFEFF\r\n\t'],
  ['BOM alone', '\uFEFF'],
  ['initial BOM', '\uFEFFtext'],
  ['replacement character', '\uFFFD'],
  ['private-use characters', '\uE123\uF8FF'],
  ['noncharacters', '\uFDD0\uFFFE\uFFFF'],
  ['decomposed text', 'e\u0301'],
  ['combining mark alone', '\u0301'],
  ['literal backslash escape', '\\uD800'],
];

for (const [name, input] of validCases) {
  test(`isWellFormedUnicode accepts ${name}`, () => {
    assert.equal(isWellFormedUnicode(input), true);
  });
}

const malformedCases = [
  ['lowest high surrogate alone', '\uD800'],
  ['highest high surrogate alone', '\uDBFF'],
  ['lowest low surrogate alone', '\uDC00'],
  ['highest low surrogate alone', '\uDFFF'],
  ['reversed pair', '\uDC00\uD800'],
  ['repeated high surrogates', '\uD800\uD800'],
  ['repeated low surrogates', '\uDC00\uDC00'],
  ['ASCII between surrogates', '\uD800x\uDC00'],
  ['newline between surrogates', '\uD800\n\uDC00'],
  ['NUL between surrogates', '\uD800\0\uDC00'],
  ['overlapping pairs', '\uD800\uDBFF\uDC00'],
  ['equal counts with incorrect pairing', '\uD800\uDBFF\uDC00\uDFFF'],
  ['pair followed by a low surrogate', '\uD800\uDC00\uDFFF'],
  ['pair followed by a high surrogate', '\uD800\uDC00\uDBFF'],
  ['code unit just above the low surrogate range', '\uD800\uE000'],
  ['code unit just below the high surrogate range', '\uD7FF\uDC00'],
  ['high surrogate before text', '\uD800text'],
  ['low surrogate before text', '\uDC00text'],
  ['high surrogate inside text', 'left\uD800right'],
  ['low surrogate inside text', 'left\uDC00right'],
  ['high surrogate after multiple pairs', '😀😀\uD800'],
  ['low surrogate after multiple pairs', '😀😀\uDC00'],
];

for (const [name, input] of malformedCases) {
  test(`isWellFormedUnicode returns false for ${name}`, () => {
    assert.equal(isWellFormedUnicode(input), false);
  });
}

const invalidInputs = [
  ['undefined', undefined],
  ['null', null],
  ['true', true],
  ['false', false],
  ['zero', 0],
  ['number', 123],
  ['NaN', NaN],
  ['infinity', Infinity],
  ['zero bigint', 0n],
  ['bigint', 123n],
  ['symbol', Symbol('text')],
  ['empty array', []],
  ['string array', ['text']],
  ['plain object', {}],
  ['function', () => 'text'],
  ['boxed string', new String('text')],
  ['boxed empty string', new String('')],
  ['boxed malformed string', new String('\uD800')],
  ['object with zero length', { length: 0 }],
];

for (const [name, input] of invalidInputs) {
  test(`isWellFormedUnicode rejects ${name}`, () => {
    assert.throws(() => isWellFormedUnicode(input), TypeError);
  });
}

test('isWellFormedUnicode rejects an omitted argument', () => {
  assert.throws(() => isWellFormedUnicode(), TypeError);
});

for (const property of [
  Symbol.toPrimitive, Symbol.iterator, 'toString', 'valueOf',
  'length', '0', 'charCodeAt', 'isWellFormed',
]) {
  test(`isWellFormedUnicode rejects objects without reading ${String(property)}`, () => {
    let reads = 0;
    const input = Object.defineProperty({}, property, {
      get() {
        reads += 1;
        throw new TypeError('property access sentinel');
      },
    });

    assert.throws(() => isWellFormedUnicode(input), TypeError);
    assert.equal(reads, 0);
  });
}

for (const method of [Symbol.toPrimitive, 'toString', 'valueOf', 'isWellFormed']) {
  test(`isWellFormedUnicode rejects objects without calling ${String(method)}`, () => {
    let calls = 0;
    const input = {
      [method]() {
        calls += 1;
        return 'text';
      },
    };

    assert.throws(() => isWellFormedUnicode(input), TypeError);
    assert.equal(calls, 0);
  });
}

test('isWellFormedUnicode is deterministic across repeated, alternating and rejected calls', () => {
  for (let index = 0; index < 10; index += 1) {
    assert.equal(isWellFormedUnicode('😀😀'), true);
    assert.equal(isWellFormedUnicode('😀😀'), true);
    assert.equal(isWellFormedUnicode('\uD800'), false);
    assert.equal(isWellFormedUnicode('\uD800'), false);
    assert.equal(isWellFormedUnicode(''), true);
    assert.throws(() => isWellFormedUnicode(null), TypeError);
    assert.equal(isWellFormedUnicode('plain text'), true);
    assert.equal(isWellFormedUnicode('\uDC00'), false);
  }
});

test('isWellFormedUnicode checks the beginning, middle and end of long text', () => {
  const text = 'abc😀'.repeat(10_000);
  assert.equal(isWellFormedUnicode(text), true);

  for (const surrogate of ['\uD800', '\uDC00']) {
    for (const position of [0, text.length / 2, text.length]) {
      const malformed = text.slice(0, position) + surrogate + text.slice(position);
      assert.equal(isWellFormedUnicode(malformed), false);
    }
  }
});
