import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexByte } from '../lib/hex-byte.mjs';

test('hexByte formats all 256 bytes as exactly two lowercase hexadecimal digits', () => {
  const digits = '0123456789abcdef';
  let value = 0;
  for (const high of digits) {
    for (const low of digits) {
      assert.equal(hexByte(value), high + low, `byte ${value}`);
      value += 1;
    }
  }
});

test('hexByte formats negative zero as zero', () => {
  assert.equal(hexByte(-0), '00');
});

test('hexByte accepts the Number after caller arithmetic has rounded', () => {
  const rounded = 255 + Number.EPSILON;
  assert.equal(rounded, 255);
  assert.equal(hexByte(rounded), 'ff');
});

test('hexByte rejects an omitted argument with TypeError', () => {
  assert.throws(() => hexByte(), TypeError);
});

test('hexByte rejects non-number inputs with TypeError', () => {
  const cases = [
    ['undefined', undefined],
    ['null', null],
    ['true', true],
    ['false', false],
    ['empty string', ''],
    ['zero string', '0'],
    ['decimal string', '15'],
    ['hexadecimal string', '0xff'],
    ['zero BigInt', 0n],
    ['byte BigInt', 255n],
    ['symbol', Symbol('byte')],
    ['boxed zero', new Number(0)],
    ['boxed byte', new Number(255)],
    ['boxed NaN', new Number(NaN)],
    ['empty array', []],
    ['numeric array', [15]],
    ['object', {}],
    ['null-prototype object', Object.create(null)],
    ['function', () => 15],
  ];
  for (const [label, value] of cases) {
    assert.throws(() => hexByte(value), TypeError, label);
  }
});

test('hexByte rejects numbers outside the integer byte domain with RangeError', () => {
  const cases = [
    ['negative integer', -1],
    ['integer above the byte range', 256],
    ['fraction near zero', 0.5],
    ['negative fraction', -0.5],
    ['interior fraction', 15.5],
    ['fraction above the byte range', 255.5],
    ['positive subnormal', Number.MIN_VALUE],
    ['negative subnormal', -Number.MIN_VALUE],
    ['fraction just below 255', 255 - 2 ** -45],
    ['fraction just above 255', 255 + 2 ** -45],
    ['NaN', NaN],
    ['positive infinity', Infinity],
    ['negative infinity', -Infinity],
    ['integer that would wrap to a byte', 2 ** 32 + 15],
    ['largest safe integer', Number.MAX_SAFE_INTEGER],
    ['largest finite number', Number.MAX_VALUE],
  ];
  for (const [label, value] of cases) {
    assert.throws(() => hexByte(value), RangeError, label);
  }
});

for (const [label, hook] of [
  ['Symbol.toPrimitive', Symbol.toPrimitive],
  ['valueOf', 'valueOf'],
  ['toString', 'toString'],
]) {
  test(`hexByte does not coerce an object with a byte-returning ${label} method`, () => {
    let calls = 0;
    const value = {
      [hook]() {
        calls += 1;
        return 15;
      },
    };
    assert.throws(() => hexByte(value), TypeError);
    assert.equal(calls, 0);
  });

  test(`hexByte does not call a throwing ${label} method`, () => {
    let calls = 0;
    const value = {
      [hook]() {
        calls += 1;
        throw new Error('conversion method must not run');
      },
    };
    assert.throws(() => hexByte(value), TypeError);
    assert.equal(calls, 0);
  });

  test(`hexByte does not read a throwing ${label} getter`, () => {
    let reads = 0;
    const value = Object.defineProperty({}, hook, {
      get() {
        reads += 1;
        throw new Error('conversion getter must not run');
      },
    });
    assert.throws(() => hexByte(value), TypeError);
    assert.equal(reads, 0);
  });
}
