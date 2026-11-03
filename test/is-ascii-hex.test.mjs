import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAsciiHex } from '../lib.mjs';

// Independent literal oracle: do not derive this from the implementation.
const alphabet = '0123456789ABCDEFabcdef';

test('isAsciiHex accepts the complete hexadecimal alphabet', () => {
  assert.equal(alphabet.length, 22);
  assert.equal(new Set(alphabet).size, 22);
  assert.equal(isAsciiHex(alphabet), true);
  for (const character of alphabet) {
    assert.equal(isAsciiHex(character), true, character);
    assert.equal(isAsciiHex(character.repeat(3)), true, character);
  }
});

for (let code = 0; code < 128; code += 1) {
  const character = String.fromCharCode(code);
  const expected = alphabet.includes(character);
  test('isAsciiHex classifies ASCII U+' + code.toString(16).padStart(4, '0'), () => {
    for (const text of [character, character + 'Af09', 'Af' + character + '09', 'Af09' + character]) {
      assert.equal(isAsciiHex(text), expected, JSON.stringify(text));
    }
  });
}

test('isAsciiHex respects the six ASCII digit and letter boundaries', () => {
  for (const [text, expected] of [
    ['/', false], ['0', true], ['9', true], [':', false],
    ['@', false], ['A', true], ['F', true], ['G', false],
    ['`', false], ['a', true], ['f', true], ['g', false],
  ]) {
    assert.equal(isAsciiHex(text), expected, JSON.stringify(text));
  }
});

for (const text of ['0', '00', 'abc', 'aBcDeF0123456789', 'deadBEEF', '0b10', '0B10', '0b', '0B', '1e3', '1E3']) {
  test('isAsciiHex accepts lexical hexadecimal text ' + JSON.stringify(text), () => {
    assert.equal(isAsciiHex(text), true);
  });
}

for (const text of [
  '', '0x10', '0X10', '0o10', '0O10', '+f', '-f', '1.0', 'f_f', 'fg',
  '\\x66', '\\u0066', '%66', 'f\ng', 'g\nf', 'f\ng\nf',
]) {
  test('isAsciiHex rejects the original text ' + JSON.stringify(text), () => {
    assert.equal(isAsciiHex(text), false);
  });
}

for (const separator of [' ', '\t', '\n', '\r', '\r\n', '\v', '\f', '\u00a0', '\ufeff', '\u2028', '\u2029', '\0']) {
  test('isAsciiHex rejects separator ' + JSON.stringify(separator) + ' in every position', () => {
    for (const text of [separator, separator + 'f', 'f' + separator + '0', 'f' + separator]) {
      assert.equal(isAsciiHex(text), false, JSON.stringify(text));
    }
  });
}

const nonAsciiInputs = [
  ['first non-ASCII code point', '\u0080'],
  ['accented letter', 'é'],
  ['decomposed letter', 'e\u0301'],
  ['combining mark', '\u0301'],
  ['fullwidth zero', '０'],
  ['fullwidth uppercase F', 'Ｆ'],
  ['fullwidth lowercase f', 'ｆ'],
  ['Arabic-Indic digit', '\u0661'],
  ['em space', '\u2003'],
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
  test('isAsciiHex rejects ' + name + ', alone and embedded', () => {
    for (const text of [input, input + 'Af09', 'Af' + input + '09', 'Af09' + input]) {
      assert.equal(isAsciiHex(text), false, JSON.stringify(text));
    }
  });
}

const nonStringInputs = [
  ['undefined', undefined], ['null', null], ['true', true], ['false', false],
  ['zero', 0], ['negative zero', -0], ['integer', 15], ['negative integer', -15],
  ['fraction', 0.5], ['NaN', NaN], ['infinity', Infinity], ['negative infinity', -Infinity],
  ['zero bigint', 0n], ['bigint', 15n], ['negative bigint', -15n], ['symbol', Symbol('f')],
  ['function', () => 'f'], ['empty array', []], ['string array', ['f']],
  ['ordinary object', {}], ['null-prototype object', Object.create(null)],
  ['boxed empty string', new String('')], ['boxed hexadecimal string', new String('f')],
  ['boxed number', new Number(15)], ['boxed boolean', new Boolean(true)],
  ['boxed bigint', Object(15n)], ['boxed symbol', Object(Symbol('f'))],
  ['array-like object', { 0: 'f', length: 1 }],
  ['empty buffer', Buffer.alloc(0)], ['hexadecimal buffer', Buffer.from('f')],
  ['typed array', new Uint8Array([102])],
];

for (const [name, input] of nonStringInputs) {
  test('isAsciiHex returns false for ' + name, () => {
    assert.equal(isAsciiHex(input), false);
  });
}

test('isAsciiHex returns false for an omitted argument', () => {
  assert.equal(isAsciiHex(), false);
});

for (const hook of [Symbol.toPrimitive, 'toString', 'valueOf']) {
  test('isAsciiHex does not read or call ' + String(hook), () => {
    let accesses = 0;
    const coerce = () => { accesses += 1; return 'f'; };
    const fail = () => { accesses += 1; throw new Error('must not coerce'); };
    for (const descriptor of [
      { value: coerce },
      { value: fail },
      { get() { accesses += 1; return coerce; } },
      { get: fail },
    ]) {
      const input = Object.defineProperty(Object.create(null), hook, descriptor);
      assert.equal(isAsciiHex(input), false);
      assert.equal(accesses, 0);
    }
  });
}

test('isAsciiHex checks the primitive type before reading length', () => {
  let reads = 0;
  const input = {
    get length() {
      reads += 1;
      throw new Error('must not read length');
    },
  };
  assert.equal(isAsciiHex(input), false);
  assert.equal(reads, 0);
});

test('isAsciiHex rejects live and revoked proxies without inspecting them', () => {
  let calls = 0;
  const trap = () => { calls += 1; throw new Error('must not inspect proxy'); };
  for (const target of [{}, new String('f'), () => 'f']) {
    const { proxy, revoke } = Proxy.revocable(target, {
      get: trap, has: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
    });
    assert.equal(isAsciiHex(proxy), false);
    assert.equal(calls, 0);
    revoke();
    assert.equal(isAsciiHex(proxy), false);
    assert.equal(calls, 0);
  }
});

test('isAsciiHex is stable across repeated and alternating inputs', () => {
  for (let repetition = 0; repetition < 10; repetition += 1) {
    for (const [input, expected] of [
      ['deadBEEF', true], ['deadBEEF', true], ['fg', false], ['fg', false],
      [undefined, false], ['', false], ['0b10', true], [new String('f'), false], ['1e3', true],
    ]) {
      assert.equal(isAsciiHex(input), expected);
    }
  }
});

test('isAsciiHex validates long strings through their final character', () => {
  const text = alphabet.repeat(10_000);
  assert.equal(isAsciiHex(text), true);
  for (const position of [0, text.length / 2, text.length]) {
    for (const invalid of ['g', 'é', '\0', '\n', '\r\n', '\u2028']) {
      assert.equal(isAsciiHex(text.slice(0, position) + invalid + text.slice(position)), false,
        JSON.stringify(invalid) + ' at position ' + position);
    }
  }
  assert.equal(isAsciiHex(text), true);
});
