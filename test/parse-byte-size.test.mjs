import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseByteSize } from '../lib/parse-byte-size.mjs';

const maxBytes = 9_007_199_254_740_991n;
const units = [
  ['', 1n, '9007199254740991', '9007199254740992'],
  ['B', 1n, '9007199254740991', '9007199254740992'],
  ['kB', 1_000n, '9007199254740.991', '9007199254740.992'],
  ['MB', 1_000_000n, '9007199254.740991', '9007199254.740992'],
  ['GB', 1_000_000_000n, '9007199.254740991', '9007199.254740992'],
  ['KiB', 1_024n, '8796093022207.9990234375', '8796093022208'],
  ['MiB', 1_048_576n, '8589934591.99999904632568359375', '8589934592'],
  ['GiB', 1_073_741_824n, '8388607.999999999068677425384521484375', '8388608'],
];

function assertBytes(input, expected) {
  const actual = parseByteSize(input);
  assert.equal(typeof actual, 'number');
  assert.ok(Number.isSafeInteger(actual));
  assert.equal(actual, expected, input); // Also distinguishes positive and negative zero.
}

// Generate exact unit quantities by long division, independently of parsing a
// decimal coefficient/scale. Every supported multiplier has a terminating decimal.
function quantityFor(bytes, multiplier) {
  let remainder = bytes % multiplier;
  let fraction = '';
  while (remainder !== 0n) {
    remainder *= 10n;
    fraction += String(remainder / multiplier);
    remainder %= multiplier;
  }
  return String(bytes / multiplier) + (fraction ? `.${fraction}` : '');
}

for (const [unit, multiplier, maximum, overflow] of units) {
  test(`parses zero, one byte, and unit boundaries for ${unit || 'omitted units'}`, () => {
    for (const quantity of ['0', '000', '000.000']) {
      assertBytes(quantity + unit, 0);
    }
    for (const bytes of [1n, multiplier - 1n, multiplier, multiplier + 1n]) {
      const quantity = quantityFor(bytes, multiplier);
      assertBytes(quantity + unit, Number(bytes));
      assertBytes(`${quantity} ${unit}`, Number(bytes));
    }
  });

  test(`checks the exact safe-integer boundary for ${unit || 'omitted units'}`, () => {
    for (const quantity of [quantityFor(maxBytes - 1n, multiplier), maximum]) {
      const expected = quantity === maximum ? Number.MAX_SAFE_INTEGER : 9_007_199_254_740_990;
      assertBytes(quantity + unit, expected);
      const withZeros = quantity.includes('.') ? `${quantity}000` : `${quantity}.000`;
      assertBytes(`000${withZeros}${unit}`, expected);
    }
    assert.throws(() => parseByteSize(overflow + unit), RangeError);
    assert.throws(() => parseByteSize(`000${overflow}${unit}`), RangeError);
  });

  test(`checks whole-unit overflow for ${unit || 'omitted units'}`, () => {
    const largest = maxBytes / multiplier;
    assertBytes(`${largest}${unit}`, Number(largest * multiplier));
    assert.throws(() => parseByteSize(`${largest + 1n}${unit}`), RangeError);
  });
}

test('converts integral fractions exactly without floating-point rounding', () => {
  for (const [input, expected] of [
    ['0001.250kB', 1250],
    ['1.5 KiB', 1536],
    ['1KiB', 1024],
    ['1 KiB', 1024],
    ['1.001kB', 1001],
    ['0.000123MB', 123],
    ['0.001kB', 1],
    ['0.000001MB', 1],
    ['0.000000001GB', 1],
    ['0.0009765625KiB', 1],
    ['0.00000095367431640625MiB', 1],
    ['0.000000000931322574615478515625GiB', 1],
    ['0.0000000009313225746154785156250GiB', 1],
    ['1.0', 1],
    ['9007199254740991.0B', Number.MAX_SAFE_INTEGER],
  ]) {
    assertBytes(input, expected);
  }
});

test('rejects fractional bytes including values that round to integers or underflow', () => {
  for (const input of [
    '0.1B', '1.5', '0.1KiB', '0.0001kB', '0.0000000001GB',
    '0.0000000001KiB', '0.0000000004656612873077392578125GiB',
    '0.0000000009313225746154785156251GiB',
    '0.0000000009313225746154785156249GiB',
    '9007199254740990.5B', '9007199254740991.1B',
    '1.0000000000000000001B', `0.${'0'.repeat(400)}1B`,
  ]) {
    assert.throws(() => parseByteSize(input), RangeError, input);
  }
});

test('normalizes long insignificant zeros before bounding arithmetic', () => {
  const zeros = '0'.repeat(10_000);
  assertBytes(`${zeros}1B`, 1);
  assertBytes(`1.${zeros}B`, 1);
  assertBytes(`0.${zeros}GiB`, 0);
  assertBytes(`0.000000000931322574615478515625${zeros}GiB`, 1);
  for (const [unit, , maximum] of units) {
    const quantity = maximum.includes('.') ? maximum : `${maximum}.`;
    assertBytes(`${zeros}${quantity}${zeros}${unit}`, Number.MAX_SAFE_INTEGER);
  }
  assert.throws(() => parseByteSize(`0.${zeros}1B`), RangeError);
  assert.throws(() => parseByteSize(`${'9'.repeat(10_000)}B`), RangeError);
});

test('accepts each ASCII whitespace character around the quantity and unit', () => {
  for (const whitespace of ['\t', '\n', '\v', '\f', '\r', ' ']) {
    for (const input of [
      `${whitespace}1KiB`, `1${whitespace}KiB`, `1KiB${whitespace}`,
      `${whitespace}1${whitespace}`, `${whitespace}1.0${whitespace}`,
    ]) {
      assertBytes(input, input.includes('KiB') ? 1024 : 1);
    }
  }
  assertBytes(' \t\n\v\f\r1.5 \t\n\v\f\rKiB \t\n\v\f\r', 1536);
});

test('rejects non-ASCII whitespace in every permitted whitespace position', () => {
  for (const whitespace of [
    '\u0085', '\u00a0', '\u1680', '\u2000', '\u2003', '\u2009',
    '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff',
  ]) {
    for (const padding of [whitespace, ` \t${whitespace}\n `]) {
      for (const input of [
        `${padding}1B`, `1${padding}B`, `1B${padding}`, `${padding}1`, `1${padding}`,
      ]) {
        assert.throws(() => parseByteSize(input), TypeError, JSON.stringify(input));
      }
    }
  }
});

const malformed = [
  ['empty quantities', ['', ' ', '\t\n\v\f\r ', 'B', 'KiB']],
  ['invalid numbers', [
    '.5kB', '1.kB', '.', '1..0B', '1.2.3B', '+0B', '-0B', '+1B', '-1B',
    '1e3B', '1E3B', '0x10B', '0b10B', '0o10B', '1,000B', '1_000B',
    'NaN', 'NaNB', 'Infinity', 'InfinityB', '\u0661B', '\uff11B', '1\u0660B',
  ]],
  ['internal whitespace', ['1 0B', '1 .0B', '1. 0B', '1\n0B', '1K iB', '1 Ki B', '1Ki\tB']],
  ['unknown units', ['1KB', '1kb', '1KIB', '1mb', '1TB', '1bytes', '1b', '1M', '1kib', '1constructor', '1__proto__']],
  ['incomplete consumption', ['x1B', '1GB 1MB', '1B1B', '1B!', '1B\0', '1Btext', '1B\n1B', '1\n2', '1B\r\nx']],
  ['invalid zero suffixes', ['0Bjunk', '0constructor', '0__proto__', '0.0.0', '0x0', '0B\u2028', '0B\n1B']],
];

for (const [family, inputs] of malformed) {
  test(`rejects ${family} with TypeError`, () => {
    for (const input of inputs) {
      assert.throws(() => parseByteSize(input), TypeError, JSON.stringify(input));
    }
  });
}

test('validates the complete syntax before rejecting overflow or fractional bytes', () => {
  for (const prefix of ['9007199254740992', '0.1', '9'.repeat(10_000)]) {
    assert.throws(() => parseByteSize(`${prefix}B`), RangeError);
    for (const suffix of ['junk', 'B!', 'B\0', 'B\n1B', 'B\u2028', '.0.0B']) {
      assert.throws(() => parseByteSize(prefix + suffix), TypeError);
    }
  }
});

test('handles long valid padding and malformed whitespace suffixes', () => {
  for (const padding of [' '.repeat(16_000), ' \t\n\v\f\r'.repeat(3_000)]) {
    assertBytes(`${padding}1${padding}`, 1);
    assertBytes(`${padding}1${padding}KiB${padding}`, 1024);
    for (const quantity of ['1', '1B', '0', '0.1B', '9007199254740992B']) {
      assert.throws(() => parseByteSize(`${quantity}${padding}!`), TypeError);
    }
  }
});

test('rejects every nonstring type without calling hooks or reading properties', () => {
  let accesses = 0;
  const sentinel = new Error('Input must not be inspected or coerced');
  const fail = () => { accesses += 1; throw sentinel; };
  const hooks = { toString: fail, valueOf: fail, [Symbol.toPrimitive]: fail };
  const getters = Object.defineProperties({}, {
    toString: { get: fail },
    valueOf: { get: fail },
    [Symbol.toPrimitive]: { get: fail },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const input of [
    undefined, null, true, false, 0, -0, 1, NaN, Infinity, 1n, Symbol('1B'),
    [], ['1B'], {}, Object.create(null), new String('1B'), () => '1B',
    hooks, getters, new Proxy({}, { get: fail }), revoked.proxy,
  ]) {
    assert.throws(() => parseByteSize(input), TypeError);
  }
  assert.throws(() => parseByteSize(), TypeError);
  assert.equal(accesses, 0);
});

test('retains no state after successful and failed calls', () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertBytes('1.5 KiB', 1536);
    assertBytes('1.5 KiB', 1536);
    assert.throws(() => parseByteSize('0Bjunk'), TypeError);
    assert.throws(() => parseByteSize('0.1B'), RangeError);
    assert.throws(() => parseByteSize('9007199254740992B'), RangeError);
    assert.throws(() => parseByteSize(null), TypeError);
    assertBytes('000.000GiB', 0);
    assertBytes('9007199254740.991kB', Number.MAX_SAFE_INTEGER);
  }
});
