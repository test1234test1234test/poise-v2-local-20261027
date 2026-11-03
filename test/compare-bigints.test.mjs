import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareBigInts } from '../lib.mjs';

const precision = 2n ** 53n;
const word = 2n ** 64n;
const huge = 10n ** 400n;
const cases = [
  ['bigint zero has no sign', -0n, 0n, 0],
  ['negative before zero', -1n, 0n, -1],
  ['zero before positive', 0n, 1n, -1],
  ['opposite signs', -7n, 11n, -1],
  ['negative magnitude order', -10n, -2n, -1],
  ['numeric rather than lexical order', 2n, 10n, -1],
  ['adjacent positives beyond Number precision', precision, precision + 1n, -1],
  ['adjacent negatives beyond Number precision', -precision - 1n, -precision, -1],
  ['adjacent positives beyond Number range', huge, huge + 1n, -1],
  ['adjacent negatives beyond Number range', -huge - 1n, -huge, -1],
  ['huge opposite signs', huge, -huge, 1],
  ['signed 64-bit boundary', word / 2n, 1n, 1],
  ['beyond unsigned 64-bit range', word + 1n, 1n, 1],
  ['beyond negative 64-bit range', -word - 1n, -1n, -1],
];

for (const [name, left, right, expected] of cases) {
  test(`compareBigInts: ${name}`, () => {
    assert.equal(compareBigInts(left, right), expected);
    assert.equal(compareBigInts(right, left), expected === 0 ? 0 : -expected);
    // Strict assertions require Number results and positive zero for equality.
    assert.equal(compareBigInts(left, left), 0);
    assert.equal(compareBigInts(right, right), 0);
  });
}

function assertRejected(invalid) {
  for (const valid of [0n, 1n]) {
    assert.throws(() => compareBigInts(invalid, valid), TypeError);
    assert.throws(() => compareBigInts(valid, invalid), TypeError);
  }
  assert.throws(() => compareBigInts(invalid, invalid), TypeError);
}

const invalidInputs = [
  ['undefined', undefined], ['null', null], ['zero', 0], ['negative zero', -0],
  ['integer', 1], ['negative integer', -1], ['fraction', 0.5], ['NaN', NaN],
  ['infinity', Infinity], ['negative infinity', -Infinity],
  ['empty string', ''], ['numeric string', '1'], ['negative numeric string', '-1'],
  ['true', true], ['false', false], ['symbol', Symbol('input')],
  ['empty array', []], ['bigint array', [1n]], ['function', () => 1n],
  ['plain object', {}], ['null-prototype object', Object.create(null)],
  ['boxed zero bigint', Object(0n)], ['boxed bigint', Object(1n)],
  ['boxed number', new Number(1)], ['boxed string', new String('1')],
  ['boxed boolean', new Boolean(true)], ['boxed symbol', Object(Symbol('input'))],
];

for (const [name, invalid] of invalidInputs) {
  test(`compareBigInts rejects ${name} before comparison or equality shortcuts`, () => {
    assertRejected(invalid);
  });
}

test('compareBigInts rejects missing arguments', () => {
  assert.throws(() => compareBigInts(), TypeError);
  assert.throws(() => compareBigInts(0n), TypeError);
  assert.throws(() => compareBigInts(1n), TypeError);
});

for (const hook of [Symbol.toPrimitive, 'valueOf', 'toString']) {
  test(`compareBigInts does not read or call ${String(hook)}`, () => {
    let accesses = 0;
    const sentinel = new Error('must not coerce');
    const fail = () => { accesses += 1; throw sentinel; };
    assertRejected({ [hook]: fail });
    assertRejected(Object.defineProperty({}, hook, { get: fail }));
    assertRejected({ [hook]: () => { accesses += 1; return 1n; } });
    assert.equal(accesses, 0);
  });
}

test('compareBigInts rejects live and revoked proxies without inspecting them', () => {
  let accesses = 0;
  const fail = () => { accesses += 1; throw new Error('must not inspect'); };
  const handler = { get: fail, getPrototypeOf: fail, has: fail, ownKeys: fail,
    getOwnPropertyDescriptor: fail };
  for (const target of [{}, Object(1n), () => 1n]) {
    assertRejected(new Proxy(target, handler));
    const revoked = Proxy.revocable(target, handler);
    revoked.revoke();
    assertRejected(revoked.proxy);
  }
  assert.equal(accesses, 0);
});

test('compareBigInts follows an independently ordered signed list and sorts duplicates', () => {
  const ordered = [
    -huge - 1n, -huge, -word - 1n, -precision - 1n, -precision,
    -10n, -7n, -7n, -2n, -1n, 0n, 0n, 1n, 2n, 10n,
    precision, precision + 1n, word + 1n, huge, huge + 1n,
  ];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = 0; j < ordered.length; j += 1) {
      const expected = ordered[i] === ordered[j] ? 0 : i < j ? -1 : 1;
      assert.equal(compareBigInts(ordered[i], ordered[j]), expected, `indices ${i}, ${j}`);
    }
  }
  assert.deepEqual([...ordered].reverse().sort(compareBigInts), ordered);
});
