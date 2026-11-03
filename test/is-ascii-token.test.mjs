import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAsciiToken } from '../lib.mjs';

// Independent literal oracle: do not derive this from the implementation.
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&'*+-.^_`|~";
const punctuation = "!#$%&'*+-.^_`|~";

test('isAsciiToken accepts the complete token alphabet and punctuation-only tokens', () => {
  assert.equal(alphabet.length, 77);
  assert.equal(new Set(alphabet).size, 77);
  assert.equal(isAsciiToken(alphabet), true);
  assert.equal(isAsciiToken(punctuation), true);
});

for (const character of punctuation) {
  test('isAsciiToken accepts punctuation ' + JSON.stringify(character), () => {
    assert.equal(isAsciiToken(character), true);
    assert.equal(isAsciiToken('Az09' + character + 'token'), true);
  });
}

for (let code = 0; code < 128; code += 1) {
  const character = String.fromCharCode(code);
  const expected = alphabet.includes(character);
  test('isAsciiToken classifies ASCII U+' + code.toString(16).padStart(4, '0'), () => {
    for (const text of [character, character + 'Az09', 'Az' + character + '09', 'Az09' + character]) {
      assert.equal(isAsciiToken(text), expected, JSON.stringify(text));
    }
  });
}

test('isAsciiToken respects ASCII letter, digit and upper-bound transitions', () => {
  for (const [text, expected] of [
    ['/', false], ['0', true], ['9', true], [':', false],
    ['@', false], ['A', true], ['Z', true], ['[', false],
    ['`', true], ['a', true], ['z', true], ['{', false],
    ['\u007e', true], ['\u007f', false], ['\u0080', false],
  ]) {
    assert.equal(isAsciiToken(text), expected, JSON.stringify(text));
  }
});

test('isAsciiToken accepts literal tokens without decoding or context restrictions', () => {
  for (const text of ['%20', 'a%2Fb', '%ZZ', '-', '123', 'null', 'undefined', 'true', 'false', 'NaN', 'Infinity', '-Infinity']) {
    assert.equal(isAsciiToken(text), true, text);
  }
});

for (const text of ['', ' ', ' \t ', 'a/b', 'a=b', '"token"', '\\u0041', '\\n', '<\ntoken\n>']) {
  test('isAsciiToken rejects the original text ' + JSON.stringify(text), () => {
    assert.equal(isAsciiToken(text), false);
  });
}

for (const separator of ['\0', ' ', '\t', '\v', '\f', '\n', '\r', '\r\n', '\u2028', '\u2029']) {
  test('isAsciiToken rejects separator ' + JSON.stringify(separator) + ' in every position', () => {
    for (const text of [separator, separator + 'token', 'to' + separator + 'ken', 'token' + separator, separator + 'token' + separator]) {
      assert.equal(isAsciiToken(text), false, JSON.stringify(text));
    }
  });
}

const nonAsciiInputs = [
  ['first non-ASCII code point', '\u0080'],
  ['accented letter', 'é'],
  ['accented text', 'café'],
  ['decomposed letter', 'e\u0301'],
  ['combining mark', '\u0301'],
  ['non-Latin letters', '中文'],
  ['Arabic-Indic digit', '\u0661'],
  ['fullwidth digit', '１'],
  ['fullwidth letter', 'Ａ'],
  ['nonbreaking space', '\u00a0'],
  ['em space', '\u2003'],
  ['BOM', '\ufeff'],
  ['Kelvin sign', '\u212a'],
  ['long s', '\u017f'],
  ['emoji', '😀'],
  ['lowest supplementary code point', '\u{10000}'],
  ['highest supplementary code point', '\u{10ffff}'],
  ['lowest lone high surrogate', '\ud800'],
  ['highest lone high surrogate', '\udbff'],
  ['lowest lone low surrogate', '\udc00'],
  ['highest lone low surrogate', '\udfff'],
  ['reversed surrogate pair', '\udc00\ud800'],
];

for (const [name, input] of nonAsciiInputs) {
  test('isAsciiToken rejects ' + name + ', alone and embedded', () => {
    for (const text of [input, input + 'token', 'to' + input + 'ken', 'token' + input]) {
      assert.equal(isAsciiToken(text), false, JSON.stringify(text));
    }
  });
}

const nonStringInputs = [
  ['undefined', undefined], ['null', null], ['true', true], ['false', false],
  ['zero', 0], ['negative zero', -0], ['integer', 123], ['negative integer', -123],
  ['fraction', 0.5], ['NaN', NaN], ['infinity', Infinity], ['negative infinity', -Infinity],
  ['zero bigint', 0n], ['bigint', 123n], ['negative bigint', -123n], ['symbol', Symbol('token')],
  ['function', () => 'token'], ['empty array', []], ['string array', ['token']],
  ['ordinary object', {}], ['null-prototype object', Object.create(null)],
  ['boxed empty string', new String('')], ['boxed token', new String('token')],
  ['boxed number', new Number(123)], ['boxed boolean', new Boolean(true)],
  ['boxed bigint', Object(123n)], ['boxed symbol', Object(Symbol('token'))],
  ['array-like object', { 0: 't', length: 1 }],
  ['empty buffer', Buffer.alloc(0)], ['token buffer', Buffer.from('token')],
  ['typed array', new Uint8Array([116])],
];

for (const [name, input] of nonStringInputs) {
  test('isAsciiToken returns false for ' + name, () => {
    assert.equal(isAsciiToken(input), false);
  });
}

test('isAsciiToken returns false for an omitted argument', () => {
  assert.equal(isAsciiToken(), false);
});

for (const hook of [Symbol.toPrimitive, 'toString', 'valueOf']) {
  test('isAsciiToken does not read or call ' + String(hook), () => {
    let accesses = 0;
    const coerce = () => { accesses += 1; return 'token'; };
    const fail = () => { accesses += 1; throw new Error('must not coerce'); };
    for (const descriptor of [
      { value: coerce },
      { value: fail },
      { get() { accesses += 1; return coerce; } },
      { get: fail },
    ]) {
      const input = Object.defineProperty(Object.create(null), hook, descriptor);
      assert.equal(isAsciiToken(input), false);
      assert.equal(accesses, 0);
    }
  });
}

test('isAsciiToken checks the primitive type before reading length', () => {
  let reads = 0;
  const input = {
    get length() {
      reads += 1;
      throw new Error('must not read length');
    },
  };
  assert.equal(isAsciiToken(input), false);
  assert.equal(reads, 0);
});

test('isAsciiToken rejects live and revoked proxies without inspecting them', () => {
  let calls = 0;
  const trap = () => { calls += 1; throw new Error('must not inspect proxy'); };
  for (const target of [{}, () => 'token']) {
    const { proxy, revoke } = Proxy.revocable(target, {
      get: trap, has: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
    });
    assert.equal(isAsciiToken(proxy), false);
    assert.equal(calls, 0);
    revoke();
    assert.equal(isAsciiToken(proxy), false);
    assert.equal(calls, 0);
  }
});

test('isAsciiToken is stable across repeated and alternating inputs', () => {
  for (let repetition = 0; repetition < 10; repetition += 1) {
    for (const [input, expected] of [
      ['token', true], ['token', true], ['bad token', false], ['bad token', false],
      [undefined, false], ['', false], ['!', true], [new String('token'), false], ['token', true],
    ]) {
      assert.equal(isAsciiToken(input), expected);
    }
  }
});

test('isAsciiToken validates long tokens through their final character', () => {
  const text = alphabet.repeat(10_000);
  assert.equal(isAsciiToken(text), true);
  for (const position of [0, text.length / 2, text.length]) {
    for (const invalid of ['/', '\0', '\n', 'é']) {
      assert.equal(isAsciiToken(text.slice(0, position) + invalid + text.slice(position)), false);
    }
  }
  assert.equal(isAsciiToken(text), true);
});
