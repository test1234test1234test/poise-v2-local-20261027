import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPowerOfTwo } from '../lib/is-power-of-two.mjs';

test('isPowerOfTwo accepts all 53 safe integer powers of two', () => {
  for (let exponent = 0; exponent <= 52; exponent += 1) {
    assert.equal(isPowerOfTwo(2 ** exponent), true, `2 ** ${exponent}`);
  }
});

test('isPowerOfTwo rejects ordinary non-powers and truncation/rounding traps', () => {
  for (const value of [
    3, 6, 12,
    2 ** 32 + 1,
    2 ** 32 + 2,
    3 * 2 ** 32,
    2 ** 52 - 1,
    2 ** 52 + 1,
    Number.MAX_SAFE_INTEGER,
  ]) {
    assert.equal(isPowerOfTwo(value), false, String(value));
  }
});

test('isPowerOfTwo rejects both neighbors of each power from 4 through 2 ** 52', () => {
  for (let exponent = 2; exponent <= 52; exponent += 1) {
    const power = 2 ** exponent;
    assert.equal(isPowerOfTwo(power - 1), false, `2 ** ${exponent} - 1`);
    assert.equal(isPowerOfTwo(power + 1), false, `2 ** ${exponent} + 1`);
  }
});

test('isPowerOfTwo rejects all 1,378 safe integers with two distinct set bits', () => {
  for (let high = 1; high <= 52; high += 1) {
    for (let low = 0; low < high; low += 1) {
      const value = 2 ** high + 2 ** low;
      assert.equal(isPowerOfTwo(value), false, `2 ** ${high} + 2 ** ${low}`);
    }
  }
});

test('isPowerOfTwo rejects zero, negative, nonfinite and unsafe numbers', () => {
  for (const value of [
    0, -0, -1, -2, -3, -(2 ** 52),
    NaN, Infinity, -Infinity,
    2 ** 53, 2 ** 54, 2 ** 100, Number.MAX_VALUE,
  ]) {
    assert.equal(isPowerOfTwo(value), false, String(value));
  }
});

test('isPowerOfTwo rejects representable fractions, including fractional powers', () => {
  for (const value of [
    0.5, -0.5, 1.5, 2.5, Number.MIN_VALUE,
    2 ** 51 + 0.5,
    2 ** 52 - 0.5,
  ]) {
    assert.equal(Number.isInteger(value), false, `fraction fixture: ${value}`);
    assert.equal(isPowerOfTwo(value), false, String(value));
  }
});

test('isPowerOfTwo classifies the Number after caller arithmetic has rounded', () => {
  const rounded = 2 ** 52 + 0.5;
  assert.equal(rounded, 2 ** 52);
  assert.equal(isPowerOfTwo(rounded), true);
});

test('isPowerOfTwo returns false for non-number inputs without throwing', () => {
  for (const value of [
    undefined, null, true, false,
    '', '2', '4294967296',
    [], [2], {}, Object.create(null), () => 2,
    new Number(2), new Number(NaN),
    0n, 2n, Symbol('2'),
  ]) {
    assert.equal(isPowerOfTwo(value), false);
  }
});

test('isPowerOfTwo returns false for an omitted argument', () => {
  assert.equal(isPowerOfTwo(), false);
});

for (const hook of [Symbol.toPrimitive, 'valueOf', 'toString']) {
  test(`isPowerOfTwo does not read a ${String(hook)} getter`, () => {
    let reads = 0;
    const input = Object.defineProperty({}, hook, {
      get() {
        reads += 1;
        throw new Error('conversion getter must not run');
      },
    });

    assert.equal(isPowerOfTwo(input), false);
    assert.equal(reads, 0);
  });

  test(`isPowerOfTwo does not call a ${String(hook)} method`, () => {
    let calls = 0;
    const input = {
      [hook]() {
        calls += 1;
        throw new Error('conversion method must not run');
      },
    };

    assert.equal(isPowerOfTwo(input), false);
    assert.equal(calls, 0);
  });
}
