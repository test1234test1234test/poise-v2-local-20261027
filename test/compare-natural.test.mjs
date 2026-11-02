import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareNatural } from '../lib/compare-natural.mjs';

const cases = [
  ['numeric magnitude', 'file2', 'file10', -1],
  ['leading-zero tie', 'file2', 'file02', -1],
  ['zero-run tie', 'x0', 'x00', -1],
  ['punctuation before digits', 'a/', 'a9', -1],
  ['complete runs with a shared initial digit', '12', '100', -1],
  ['magnitude before original run length', '0009', '10', -1],
  ['leading zeros do not reduce magnitude', '00010', '9', 1],
  ['run-length tie before suffixes', 'file2z', 'file02a', -1],
  ['zero-run tie before exhaustion', '0a', '00', -1],
  ['equal runs advance to suffixes', 'x002a', 'x002b', -1],
  ['multiple numeric segments', 'v1a2', 'v1a10', -1],
  ['integers beyond Number precision', '9007199254740992', '9007199254740993', -1],
  ['digits before punctuation', 'a1000', 'a:', -1],
  ['minus signs are text', '-2', '-10', -1],
  ['decimal points separate runs', '1.2', '1.10', -1],
  ['exponent notation is text', '1e3', '2e1', -1],
  ['hexadecimal notation is text', '0x10', '1', -1],
  ['code-point rather than UTF-16 order', '\u{10000}', '\uE000', 1],
  ['digits after a supplementary code point', '😀2', '😀10', -1],
  ['different supplementary code points', '😀', '😁', -1],
  ['Arabic-Indic digits are text', 'x\u0662', 'x10', 1],
  ['fullwidth digits are text', 'x\uFF12', 'x10', 1],
  ['non-ASCII digits interrupt ASCII runs', 'x1\u0662', 'x12', -1],
  ['case sensitivity', 'Z', 'a', -1],
  ['no Unicode normalization', 'e\u0301', '\u00E9', -1],
  ['combining marks are individual code points', 'e\u0300', 'e\u0301', -1],
  ['no leading trimming', ' a', 'a', -1],
  ['no trailing trimming', 'a', 'a ', -1],
  ['NUL is not exhaustion', 'a\0', 'a', 1],
  ['embedded NUL', 'a\0z', 'a1', -1],
  ['embedded newline', 'a\n2', 'a2', -1],
  ['CR and LF remain distinct', 'a\r2', 'a\n2', 1],
  ['no newline normalization', 'a\r\n2', 'a\n2', 1],
  ['lone high surrogate', '\uD800', '\uE000', -1],
  ['lone low surrogate', '\uDC00', '\uE000', -1],
  ['lone surrogates are not repaired', '\uD800', '\uFFFD', -1],
  ['valid pair versus lone surrogate', '\uD800\uDC00', '\uD800\uE000', 1],
  ['digits after a lone high surrogate', '\uD8002', '\uD80010', -1],
  ['digits after a lone low surrogate', '\uDC002', '\uDC0010', -1],
  ['empty strings', '', '', 0],
  ['empty before numeric zero', '', '0', -1],
  ['empty before NUL', '', '\0', -1],
  ['exhaustion after text', 'a', 'ab', -1],
  ['exhaustion after a run', 'x1', 'x1a', -1],
  ['exhaustion after a surrogate pair', '😀', '😀a', -1],
  ['identical mixed strings', 'A😀002\0\n\uD800', 'A😀002\0\n\uD800', 0],
  ['extending a leading run can reverse order', '01', '2', -1],
  ['extended leading run', '101', '12', 1],
  ['exhaustion before extending a trailing run', '1', '1a', -1],
  ['extended trailing run', '12', '1a2', 1],
];

function assertComparison(left, right, expected) {
  assert.equal(compareNatural(left, right), expected);
  assert.equal(compareNatural(right, left), expected === 0 ? 0 : -expected);
  // Strict equality also distinguishes positive zero from negative zero.
  assert.equal(compareNatural(left, left), 0);
  assert.equal(compareNatural(right, right), 0);
}

for (const [name, left, right, expected] of cases) {
  test(`compareNatural: ${name}`, () => {
    assertComparison(left, right, expected);
  });
}

const invalidInputs = [
  ['undefined', undefined], ['null', null], ['number', 42], ['zero', 0],
  ['NaN', NaN], ['infinity', Infinity], ['true', true], ['false', false],
  ['bigint', 1n], ['symbol', Symbol('input')], ['empty array', []],
  ['array of strings', ['a']], ['function', () => 'a'], ['plain object', {}],
  ['null-prototype object', Object.create(null)], ['boxed string', new String('a')],
  ['boxed empty string', new String('')],
];

for (const [name, invalid] of invalidInputs) {
  test(`compareNatural rejects ${name} before equality or exhaustion shortcuts`, () => {
    for (const valid of ['', 'a', '12']) {
      assert.throws(() => compareNatural(invalid, valid), TypeError);
      assert.throws(() => compareNatural(valid, invalid), TypeError);
    }
    assert.throws(() => compareNatural(invalid, invalid), TypeError);
  });
}

test('compareNatural rejects missing arguments', () => {
  assert.throws(() => compareNatural(), TypeError);
  assert.throws(() => compareNatural(''), TypeError);
  assert.throws(() => compareNatural('a'), TypeError);
});

test('compareNatural does not read or call conversion hooks', () => {
  let accesses = 0;
  const sentinel = new Error('must not coerce');
  const rejectAccess = () => { accesses += 1; throw sentinel; };
  for (const key of ['toString', 'valueOf', Symbol.toPrimitive]) {
    for (const invalid of [{ [key]: rejectAccess },
      Object.defineProperty({}, key, { get: rejectAccess })]) {
      assert.throws(() => compareNatural(invalid, ''), TypeError);
      assert.throws(() => compareNatural('', invalid), TypeError);
      assert.throws(() => compareNatural(invalid, invalid), TypeError);
    }
  }
  assert.equal(accesses, 0);
});

const zeros = '0'.repeat(5000);
const digits = '7'.repeat(5000);
const text = 'a😀'.repeat(10000);
const alternating = 'x002😀10'.repeat(10000);
const longCases = [
  ['equal-length integers differing at the last digit', digits + '2', digits + '3'],
  ['different significant lengths', '9'.repeat(5000), '1' + zeros],
  ['thousands of leading zeros', zeros + '9', '10'],
  ['long equal-value runs before suffixes', zeros + '9z', zeros + '09a'],
  ['all-zero runs of different lengths', zeros, zeros + '0'],
  ['all-zero run tie before exhaustion', zeros + 'a', zeros + '0'],
  ['equal long runs followed by different suffixes', digits + 'a', digits + 'b'],
  ['long equal text prefix', text + 'a', text + 'b'],
  ['exhaustion after long text', text, text + '\0'],
  ['many alternating runs with a final difference', alternating + 'a2', alternating + 'a10'],
];

for (const [name, left, right] of longCases) {
  test(`compareNatural: ${name}`, () => {
    assertComparison(left, right, -1);
  });
}

test('compareNatural obeys comparator laws and an independently specified mixed ordering', () => {
  // Written in expected order, independently of the comparator under test.
  const ordered = [
    '', '\0', '\n', '\r', ' ', '-2', '-10', '/',
    '0', '0a', '00', '00a', '000', '1', '1.2', '1.10', '1a', '01',
    '2', '2a', '02', '10', '12', '100', ':', 'A', 'Z',
    'a', 'a\0', 'a\n2', 'a\r2', 'a ', 'a/', 'a0', 'a00', 'a1',
    'a2', 'a2z', 'a02', 'a10', 'a:', 'e\u0301', 'x', 'x9', 'x10',
    'x\u0662', 'x\uFF12', 'é', '\u0662', '\uD800', '\uD800\uE000',
    '\uDC00', '\uE000', '\uFF12', '\uFFFD', '\u{10000}',
    '😀', '😀2', '😀02', '😀10', '😁',
  ];
  const results = ordered.map(left => ordered.map(right => compareNatural(left, right)));
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = 0; j < ordered.length; j += 1) {
      const result = results[i][j];
      const pair = `${JSON.stringify(ordered[i])} versus ${JSON.stringify(ordered[j])}`;
      assert.equal(result, i === j ? 0 : i < j ? -1 : 1, pair);
      assert.equal(result === 0, ordered[i] === ordered[j], pair);
      assert.equal(results[j][i], result === 0 ? 0 : -result, pair);
      for (let k = 0; k < ordered.length; k += 1) {
        if (result <= 0 && results[j][k] <= 0) {
          assert.ok(results[i][k] <= 0, 'transitivity');
        }
      }
    }
  }
  assert.deepEqual([...ordered].reverse().sort(compareNatural), ordered);
});

test('compareNatural is repeatable across interleaved successful and rejected calls', () => {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    for (const [, left, right, expected] of cases) {
      assert.throws(() => compareNatural(left, null), TypeError);
      assertComparison(left, right, expected);
      assert.throws(() => compareNatural(undefined, right), TypeError);
    }
  }
});

test('compareNatural sorts the README example with immediate leading-zero ties', () => {
  assert.deepEqual(['file10', 'file02', 'file2z', 'file2'].sort(compareNatural),
    ['file2', 'file2z', 'file02', 'file10']);
});
