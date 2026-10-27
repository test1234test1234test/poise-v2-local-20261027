import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../lib/clamp.mjs';

const validCases = [
  ['interior value', 5, 0, 10, 5],
  ['inclusive lower bound', 0, 0, 10, 0],
  ['inclusive upper bound', 10, 0, 10, 10],
  ['below lower bound', -1, 0, 10, 0],
  ['above upper bound', 11, 0, 10, 10],
  ['below negative interval', -11, -10, -2, -10],
  ['within negative interval', -5, -10, -2, -5],
  ['above negative interval', -1, -10, -2, -2],
  ['below equal bounds', 1, 2, 2, 2],
  ['at equal bounds', 2, 2, 2, 2],
  ['above equal bounds', 3, 2, 2, 2],
  ['fractional interior value', 0.25, 0.1, 0.9, 0.25],
  ['below fractional interval', 0.05, 0.1, 0.9, 0.1],
  ['above fractional interval', 0.95, 0.1, 0.9, 0.9],
  ['positive subnormal', Number.MIN_VALUE, 0, 1, Number.MIN_VALUE],
  ['negative subnormal', -Number.MIN_VALUE, -1, 0, -Number.MIN_VALUE],
  ['largest finite value', Number.MAX_VALUE, 0, Number.MAX_VALUE, Number.MAX_VALUE],
  ['most negative finite value', -Number.MAX_VALUE, -Number.MAX_VALUE, 0, -Number.MAX_VALUE],
  ['interval whose width overflows', 0, -Number.MAX_VALUE, Number.MAX_VALUE, 0],
  ['large value above interval', Number.MAX_VALUE, -1, 1, 1],
  ['large value below interval', -Number.MAX_VALUE, -1, 1, -1],
  ['in-range negative zero', -0, 0, 1, -0],
  ['in-range positive zero', 0, -1, -0, 0],
  ['negative zero with equal positive bounds', -0, 0, 0, -0],
  ['positive zero with equal negative bounds', 0, -0, -0, 0],
  ['negative zero with mixed zero bounds', -0, 0, -0, -0],
  ['positive zero with mixed zero bounds', 0, -0, 0, 0],
  ['clamps to negative zero lower bound', -1, -0, 1, -0],
  ['clamps to negative zero upper bound', 1, -1, -0, -0],
];

for (const [name, value, min, max, expected] of validCases) {
  test(`clamp: ${name}`, () => {
    // Strict equality also distinguishes positive and negative zero.
    assert.equal(clamp(value, min, max), expected);
  });
}

const invalidArguments = [
  ['NaN', NaN],
  ['positive infinity', Infinity],
  ['negative infinity', -Infinity],
  ['numeric string', '2'],
  ['empty string', ''],
  ['true', true],
  ['false', false],
  ['null', null],
  ['undefined', undefined],
  ['empty array', []],
  ['numeric array', [2]],
  ['object', {}],
  ['boxed number', new Number(2)],
  ['bigint', 2n],
  ['symbol', Symbol('2')],
  ['function', () => 2],
];

for (const [index, parameter] of ['value', 'min', 'max'].entries()) {
  for (const [name, invalid] of invalidArguments) {
    test(`clamp rejects ${name} as ${parameter}`, () => {
      const args = [5, 0, 10];
      args[index] = invalid;
      assert.throws(() => clamp(...args), TypeError);
    });
  }

  for (const hook of ['valueOf', Symbol.toPrimitive]) {
    test(`clamp does not coerce or mutate ${parameter} via ${String(hook)}`, () => {
      const input = {
        conversions: 0,
        [hook]() {
          this.conversions += 1;
          return 2;
        },
      };
      const before = Object.getOwnPropertyDescriptors(input);
      const args = [5, 0, 10];
      args[index] = input;

      assert.throws(() => clamp(...args), TypeError);
      assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
    });
  }
}

for (const args of [[], [5], [5, 0]]) {
  test(`clamp rejects ${3 - args.length} omitted arguments`, () => {
    assert.throws(() => clamp(...args), TypeError);
  });
}

const invalidCombinations = [
  ['NaN with equal bounds', [NaN, 2, 2]],
  ['string with equal bounds', ['2', 2, 2]],
  ['equal infinite bounds', [0, Infinity, Infinity]],
  ['invalid upper bound before clamping low', [-1, 0, NaN]],
  ['invalid lower bound before clamping high', [11, NaN, 10]],
  ['NaN with reversed bounds', [NaN, 10, 0]],
  ['string bound that would reverse the range', [0, '10', 1]],
  ['infinite bound that would reverse the range', [0, Infinity, 1]],
];

for (const [name, args] of invalidCombinations) {
  test(`clamp validates all arguments first: ${name}`, () => {
    assert.throws(() => clamp(...args), TypeError);
  });
}

for (const value of [-1, 5, 11]) {
  test(`clamp rejects reversed finite bounds for value ${value}`, () => {
    assert.throws(() => clamp(value, 10, 0), RangeError);
  });
}
