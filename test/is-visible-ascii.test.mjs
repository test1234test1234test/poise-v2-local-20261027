import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVisibleAscii } from '../lib.mjs';

test('isVisibleAscii accepts boundaries, digits, letters, punctuation and literal escapes', () => {
  for (const input of [
    '!', '~', '0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz',
    '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', String.raw`\u0080`, 'Hello,world!',
  ]) {
    assert.equal(isVisibleAscii(input), true, JSON.stringify(input));
  }

  const visible = Array.from({ length: 94 }, (_, index) => String.fromCharCode(0x21 + index)).join('');
  assert.equal(isVisibleAscii(visible), true);
});

test('isVisibleAscii classifies every individual UTF-16 code unit', () => {
  for (let unit = 0; unit <= 0xffff; unit += 1) {
    assert.equal(
      isVisibleAscii(String.fromCharCode(unit)),
      unit >= 0x21 && unit <= 0x7e,
      `UTF-16 unit 0x${unit.toString(16)}`,
    );
  }
});

test('isVisibleAscii rejects empty strings', () => {
  assert.equal(isVisibleAscii(''), false);
});

const invalidText = [
  ' ', '\x1f', '\x7f', '\u0080', '\0', '\t', '\n', '\r', '\r\n', '\v', '\f',
  'é', 'café', 'e\u0301', '\u00a0', '\u200b', '\ufeff', '\u2028', '\u2029',
  'Ａ', '\u212a', '\u017f', '😀', '\u{10000}', '\u{10ffff}',
  '\ud800', '\udbff', '\udc00', '\udfff', '\udc00\ud800',
];

for (const input of invalidText) {
  test(`isVisibleAscii rejects ${JSON.stringify(input)} alone and at every position`, () => {
    for (const text of [input, `${input}A`, `A${input}B`, `A${input}`]) {
      assert.equal(isVisibleAscii(text), false, JSON.stringify(text));
    }
  });
}

const nonStringInputs = [
  ['undefined', undefined], ['null', null], ['true', true], ['false', false],
  ['zero', 0], ['negative zero', -0], ['number', 123], ['fraction', 0.5],
  ['NaN', NaN], ['infinity', Infinity], ['negative infinity', -Infinity],
  ['bigint zero', 0n], ['bigint', 123n], ['symbol', Symbol('ASCII')],
  ['empty array', []], ['string array', ['ASCII']], ['object', {}],
  ['null-prototype object', Object.create(null)], ['function', () => 'ASCII'],
  ['boxed empty string', new String('')], ['boxed valid string', new String('ASCII')],
  ['boxed invalid string', new String('é')], ['boxed number', new Number(123)],
  ['boxed boolean', new Boolean(true)], ['boxed bigint', Object(123n)],
  ['buffer', Buffer.from('ASCII')], ['typed array', new Uint8Array([65])],
];

for (const [name, input] of nonStringInputs) {
  test(`isVisibleAscii returns Boolean false for ${name}`, () => {
    assert.equal(isVisibleAscii(input), false);
  });
}

test('isVisibleAscii returns Boolean false for an omitted argument', () => {
  assert.equal(isVisibleAscii(), false);
});

for (const hook of [Symbol.toPrimitive, 'toString', 'valueOf']) {
  test(`isVisibleAscii never reads or calls ${String(hook)} conversion hooks`, () => {
    let accesses = 0;
    const coerce = () => { accesses += 1; return 'ASCII'; };
    const fail = () => { accesses += 1; throw new Error('must not coerce'); };
    for (const input of [
      { [hook]: coerce },
      { [hook]: fail },
      Object.defineProperty({}, hook, { get: fail }),
    ]) {
      assert.equal(isVisibleAscii(input), false);
      assert.equal(accesses, 0);
    }
  });
}

test('isVisibleAscii rejects live and revoked proxies without inspecting them', () => {
  let accesses = 0;
  const fail = () => { accesses += 1; throw new Error('must not inspect'); };
  const handler = { get: fail, getPrototypeOf: fail };
  assert.equal(isVisibleAscii(new Proxy({}, handler)), false);
  const revoked = Proxy.revocable(new String('ASCII'), handler);
  revoked.revoke();
  assert.equal(isVisibleAscii(revoked.proxy), false);
  assert.equal(accesses, 0);
});

test('isVisibleAscii checks the complete long input', () => {
  const text = 'Az09!~'.repeat(16_667);
  assert.equal(isVisibleAscii(text), true);
  for (const invalid of [' ', '\0', '\n', '\x7f', '\u0080', '\ud800']) {
    for (const position of [0, text.length / 2, text.length]) {
      assert.equal(
        isVisibleAscii(text.slice(0, position) + invalid + text.slice(position)),
        false,
        `${JSON.stringify(invalid)} at ${position}`,
      );
    }
  }
});

test('isVisibleAscii remains consistent across repeated and alternating calls', () => {
  for (let repetition = 0; repetition < 10; repetition += 1) {
    for (const [input, expected] of [
      ['ASCII', true], ['ASCII', true], ['é', false], ['é', false],
      ['!~', true], ['', false], [undefined, false], ['A\n', false], ['A', true],
    ]) {
      assert.equal(isVisibleAscii(input), expected);
    }
  }
});
