import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../lib/parse-duration.mjs';

const validExamples = [
  ['1d', 86_400_000],
  ['1h', 3_600_000],
  ['1m', 60_000],
  ['1s', 1_000],
  ['1ms', 1],
  ['1d2h3m4s5ms', 93_784_005],
  ['1h30m', 5_400_000],
  ['1h 30m', 5_400_000],
  ['1m250ms', 60_250],
  ['1m 250ms', 60_250],
  ['1s1ms', 1_001],
  ['1d2s', 86_402_000],
  [' \t01d\t002h 003m004s0005ms\t ', 93_784_005],
  ['\t 1h \t \t30m \t', 5_400_000],
  ['0ms', 0],
  ['0d0h0m0s0ms', 0],
  ['000ms', 0],
  ['0001ms', 1],
  ['25h', 90_000_000],
  ['60m', 3_600_000],
  ['90s', 90_000],
  ['1000ms', 1_000],
];

for (const [input, expected] of validExamples) {
  test(`parses ${JSON.stringify(input)} as ${expected} milliseconds`, () => {
    assert.equal(parseDuration(input), expected);
  });
}

test('accepts the exact safe-integer boundary as a Number in multiple forms', () => {
  for (const input of [
    '9007199254740991ms',
    '0009007199254740991ms',
    '9007199254740s991ms',
    '104249991d8h59m0s991ms',
  ]) {
    assert.equal(parseDuration(input), Number.MAX_SAFE_INTEGER, input);
  }
  assert.equal(parseDuration('9007199254740990ms'), 9_007_199_254_740_990);
});

test('rejects exact millisecond, multiplier, and aggregate overflow', () => {
  for (const input of [
    '9007199254740992ms',
    '9007199254740993ms',
    '0009007199254740992ms',
    '9007199254740s992ms',
    '104249991d8h59m0s992ms',
    '104249992d',
    '2501999793h',
    '150119987580m',
    '9007199254741s',
  ]) {
    assert.throws(() => parseDuration(input), RangeError, input);
  }
});

test('handles very long integers and leading zeros without losing precision', () => {
  const zeros = '0'.repeat(10_000);
  assert.equal(parseDuration(`${zeros}ms`), 0);
  assert.equal(parseDuration(`${zeros}1ms`), 1);
  assert.equal(parseDuration(`${zeros}1d${zeros}5ms`), 86_400_005);
  assert.equal(parseDuration(`${zeros}9007199254740991ms`), Number.MAX_SAFE_INTEGER);
  assert.throws(() => parseDuration(`${zeros}9007199254740992ms`), RangeError);
  assert.throws(() => parseDuration(`${'9'.repeat(10_000)}ms`), RangeError);
});

const invalidSyntax = [
  ['empty expressions', ['', ' ', '\t', ' \t ']],
  ['missing numbers or units', ['d', 'h', 'm', 's', 'ms', '1', '1h 2']],
  ['uppercase units', ['1D', '1H', '1M', '1S', '1MS', '1Ms', '1mS']],
  ['fractions', ['1.5h', '.5s', '1.s', '0.0ms']],
  ['signs', ['+1s', '-1s', '-0ms', '1h+1m', '1h-1m']],
  ['exponents and other numeric spellings', [
    '1e3ms', '1E3ms', '0x10ms', '0b10ms', '0o10ms', '1_000ms', 'NaNms', 'Infinityms',
  ]],
  ['non-ASCII digits', ['\u0661s', '\uff11s', '1\u0660s']],
  ['internal whitespace', ['1 h', '1\tms', '1m s', '1 0s', '1m\ts']],
  ['unknown units', ['1w', '1us', '1sec', '1mss', '1ss', '1mm', '1dms']],
  ['incomplete consumption', ['x1s', '1h,1m', '1h!1m', '1s!', '1s\0', '1s 2', '1h/1m']],
];

for (const [family, inputs] of invalidSyntax) {
  test(`rejects ${family} with SyntaxError`, () => {
    for (const input of inputs) {
      assert.throws(() => parseDuration(input), SyntaxError, JSON.stringify(input));
    }
  });
}

test('rejects forbidden whitespace before, between, and after terms', () => {
  for (const whitespace of ['\n', '\r', '\r\n', '\v', '\f', '\u0085', '\u00a0', '\u2003', '\uFEFF', '\u2028', '\u2029']) {
    for (const input of [
      `${whitespace}1h`,
      `1h${whitespace}1m`,
      `1h${whitespace}`,
      ` \t1h ${whitespace}\t`,
    ]) {
      assert.throws(() => parseDuration(input), SyntaxError, JSON.stringify(input));
    }
  }
});

test('enforces uniqueness and descending order for every pair, even zero terms', () => {
  const units = ['d', 'h', 'm', 's', 'ms'];
  const milliseconds = [86_400_000, 3_600_000, 60_000, 1_000, 1];
  for (let first = 0; first < units.length; first += 1) {
    for (let second = 0; second < units.length; second += 1) {
      for (const [left, right] of [[1, 1], [1, 0], [0, 1], [0, 0]]) {
        for (const separator of ['', ' ', '\t']) {
          const input = `${left}${units[first]}${separator}${right}${units[second]}`;
          if (first < second) {
            assert.equal(parseDuration(input), left * milliseconds[first] + right * milliseconds[second], input);
          } else {
            assert.throws(() => parseDuration(input), SyntaxError, input);
          }
        }
      }
    }
  }
  assert.throws(() => parseDuration('1d1h1m1s1ms0ms'), SyntaxError);
  assert.throws(() => parseDuration('1d1h0d'), SyntaxError);
});

test('reports malformed syntax even when an earlier term or sum overflows', () => {
  for (const prefix of ['9007199254740992ms', `${'9'.repeat(10_000)}ms`, '104249991d8h59m0s992ms']) {
    for (const suffix of ['x', '0ms', '1s', '\n', '\r\n', '\u00a0', ' 1', ' 0 ms']) {
      assert.throws(() => parseDuration(prefix + suffix), SyntaxError);
    }
  }
  assert.throws(() => parseDuration('9007199254740992d1 h'), SyntaxError);
});

test('rejects every nonstring type without coercion', () => {
  const coercible = {
    [Symbol.toPrimitive]() { assert.fail('must not coerce an object'); },
    toString() { assert.fail('must not call toString'); },
    valueOf() { assert.fail('must not call valueOf'); },
  };
  for (const input of [undefined, null, 1, 0, NaN, Infinity, 1n, true, false, Symbol('1s'), [], ['1s'], {}, new String('1s'), () => '1s', coercible]) {
    assert.throws(() => parseDuration(input), TypeError);
  }
  assert.throws(() => parseDuration(), TypeError);
});

test('retains no parser state across repeated successes and failures', () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(parseDuration('1h'), 3_600_000);
    assert.equal(parseDuration('1h'), 3_600_000);
    assert.throws(() => parseDuration('1h1h'), SyntaxError);
    assert.equal(parseDuration('0ms'), 0);
    assert.throws(() => parseDuration('9007199254740992ms'), RangeError);
    assert.throws(() => parseDuration(null), TypeError);
    assert.equal(parseDuration('1h'), 3_600_000);
    assert.equal(parseDuration('1d2h3m4s5ms'), 93_784_005);
  }
});
