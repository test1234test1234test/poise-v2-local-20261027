import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCanonicalUnsignedBigInt } from '../lib.mjs';

const validInputs = [
  ['0', 0n], ['1', 1n], ['2', 2n], ['3', 3n], ['4', 4n],
  ['5', 5n], ['6', 6n], ['7', 7n], ['8', 8n], ['9', 9n],
  ['10', 10n], ['101', 101n], ['1000', 1000n], ['1234567890', 1234567890n],
  ['9007199254740991', 9007199254740991n],
  ['9007199254740992', 9007199254740992n],
  ['9007199254740993', 9007199254740993n],
  ['18446744073709551616', 18446744073709551616n],
  ['18446744073709551617', 18446744073709551617n],
];

for (const [text, expected] of validInputs) {
  test(`parseCanonicalUnsignedBigInt parses ${text} exactly`, () => {
    assert.equal(parseCanonicalUnsignedBigInt(text), expected);
  });
}

test('parseCanonicalUnsignedBigInt preserves long values beyond Number range', () => {
  assert.equal(parseCanonicalUnsignedBigInt('9'.repeat(10_000)), 10n ** 10_000n - 1n);
  assert.equal(parseCanonicalUnsignedBigInt('1' + '0'.repeat(4095) + '1'), 10n ** 4096n + 1n);
});

const malformedInputs = [
  '', '+0', '-0', '+1', '-1', '00', '01', '0001',
  '1_000', '1,000', '1 000', '1.0', '.1', '1.', '1e3', '1E3',
  '0x10', '0X10', '0b10', '0B10', '0o10', '0O10',
  'NaN', 'Infinity', '1n', 'x1', '1x', '0x', 'x0', '0n',
  '0\0', '1\0', '\u00001', '1\u00002', '1\n2', 'x\n1\nx',
  '\u0660', '\u0661\u0662', '\uFF10', '\uFF11\uFF12',
  '1\u0660', '\u06611', '1\uFF10', '\u22121', '\uFF0B1',
  '😀', '1😀', '\uD800', '1\uD800', '\uDC00', '1\uDC00',
];

for (const text of malformedInputs) {
  test(`parseCanonicalUnsignedBigInt rejects malformed ${JSON.stringify(text)}`, () => {
    assert.throws(() => parseCanonicalUnsignedBigInt(text), SyntaxError);
  });
}

for (const whitespace of [' ', '\t', '\n', '\r', '\r\n', '\v', '\f', '\u00A0', '\uFEFF', '\u2028', '\u2029']) {
  test(`parseCanonicalUnsignedBigInt rejects ${JSON.stringify(whitespace)} in every position`, () => {
    for (const text of [
      whitespace, `${whitespace}0`, `${whitespace}123`,
      `0${whitespace}`, `123${whitespace}`, `1${whitespace}2`,
    ]) {
      assert.throws(() => parseCanonicalUnsignedBigInt(text), SyntaxError, JSON.stringify(text));
    }
  });
}

test('parseCanonicalUnsignedBigInt rejects long noncanonical strings in full', () => {
  const prefix = '9'.repeat(10_000);
  for (const text of ['0'.repeat(10_000), `0${prefix}`, `${prefix}x`, `${prefix}\n`, `${prefix}\u2029`]) {
    assert.throws(() => parseCanonicalUnsignedBigInt(text), SyntaxError);
  }
});

const nonStringInputs = [
  ['undefined', undefined], ['null', null], ['false', false], ['true', true],
  ['zero', 0], ['negative zero', -0], ['integer', 1], ['negative integer', -1],
  ['fraction', 0.5], ['NaN', NaN], ['infinity', Infinity], ['negative infinity', -Infinity],
  ['bigint zero', 0n], ['bigint', 1n], ['negative bigint', -1n], ['symbol', Symbol('1')],
  ['boxed zero string', new String('0')], ['boxed string', new String('1')],
  ['boxed number', new Number(1)], ['boxed boolean', new Boolean(true)],
  ['boxed bigint', Object(1n)], ['boxed symbol', Object(Symbol('1'))],
  ['empty array', []], ['string array', ['1']], ['number array', [1]],
  ['plain object', {}], ['null-prototype object', Object.create(null)], ['function', () => '1'],
];

for (const [name, input] of nonStringInputs) {
  test(`parseCanonicalUnsignedBigInt rejects ${name}`, () => {
    assert.throws(() => parseCanonicalUnsignedBigInt(input), TypeError);
  });
}

test('parseCanonicalUnsignedBigInt rejects omitted input', () => {
  assert.throws(() => parseCanonicalUnsignedBigInt(), TypeError);
});

for (const hook of [Symbol.toPrimitive, 'toString', 'valueOf']) {
  test(`parseCanonicalUnsignedBigInt does not read or call ${String(hook)}`, () => {
    let accesses = 0;
    const coerce = () => { accesses += 1; return '1'; };
    const fail = () => { accesses += 1; throw new Error('must not coerce'); };
    for (const input of [
      { [hook]: coerce },
      { [hook]: fail },
      Object.defineProperty({}, hook, { get() { accesses += 1; return coerce; } }),
      Object.defineProperty({}, hook, { get: fail }),
    ]) {
      assert.throws(() => parseCanonicalUnsignedBigInt(input), TypeError);
      assert.equal(accesses, 0);
    }
  });
}

test('parseCanonicalUnsignedBigInt remains repeatable across successful and rejected calls', () => {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    for (const [text, expected] of [['0', 0n], ['123', 123n]]) {
      assert.equal(parseCanonicalUnsignedBigInt(text), expected);
      assert.equal(parseCanonicalUnsignedBigInt(text), expected);
      assert.throws(() => parseCanonicalUnsignedBigInt(`${text}x`), SyntaxError);
      assert.throws(() => parseCanonicalUnsignedBigInt(expected), TypeError);
      assert.equal(parseCanonicalUnsignedBigInt(text), expected);
    }
  }
});
