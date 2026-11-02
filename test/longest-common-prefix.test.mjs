import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { longestCommonPrefix } from '../lib/longest-common-prefix.mjs';

const cases = [
  ['empty array', [], ''],
  ['empty singleton', [''], ''],
  ['empty element', ['', 'abc'], ''],
  ['singleton', ['same'], 'same'],
  ['identical strings', ['same', 'same'], 'same'],
  ['multiway prefix', ['flower', 'flow', 'flight'], 'fl'],
  ['later input constrains the prefix', ['abc', 'abd', 'ax'], 'a'],
  ['whole input is the prefix', ['ab', 'abcd'], 'ab'],
  ['no match', ['a', 'b'], ''],
  ['case sensitivity', ['A', 'a'], ''],
  ['complete astral character', ['😀x', '😀y'], '😀'],
  ['shared high surrogate is insufficient', ['😀', '😁'], ''],
  ['astral mismatch after BMP prefix', ['a😀x', 'a😁y'], 'a'],
  ['shared low surrogate is insufficient', ['x\u{10000}a', 'x\u{10400}b'], 'x'],
  ['code-point counts differ from slice offsets', ['😀😀', '😀a'], '😀'],
  ['end immediately after a pair', ['a😀', 'a😀x'], 'a😀'],
  ['no canonical normalization', ['é', 'e\u0301'], ''],
  ['preserve decomposed spelling', ['e\u0301x', 'e\u0301y'], 'e\u0301'],
  ['prefix inside a grapheme', ['e\u0301', 'e\u0300'], 'e'],
  ['ZWJ is a separate code point', ['👩\u200D💻', '👩\u200D🔬'], '👩\u200D'],
  ['prefix inside a flag grapheme', ['🇺🇸', '🇺🇦'], '🇺'],
  ['NUL and BOM are data', ['\0\uFEFFx', '\0\uFEFFy'], '\0\uFEFF'],
  ['literal CRLF', ['a\r\nx', 'a\r\ny'], 'a\r\n'],
  ['no newline normalization', ['a\r\nx', 'a\nx'], 'a'],
  ['lone high surrogate', ['\uD800x', '\uD800y'], '\uD800'],
  ['lone low surrogate', ['\uDC00x', '\uDC00y'], '\uDC00'],
  ['lone high surrogate versus pair', ['\uD83D', '😀'], ''],
  ['lone low surrogate versus pair', ['\uDE00', '😀'], ''],
  ['BMP prefix before lone high surrogate versus pair', ['a\uD83D', 'a😀'], 'a'],
  ['astral prefix before lone high surrogate versus pair', ['😀\uD83D', '😀😀'], '😀'],
  ['BMP prefix before lone low surrogate versus pair', ['a\uDE00', 'a😀'], 'a'],
  ['astral prefix before lone low surrogate versus pair', ['😀\uDE00', '😀😀'], '😀'],
  ['pair followed by lone high surrogate', ['😀\uD800x', '😀\uD800y'], '😀\uD800'],
  ['pair followed by lone low surrogate', ['😀\uDC00x', '😀\uDC00y'], '😀\uDC00'],
  ['lone surrogate is not repaired', ['\uD83D', '\uFFFD'], ''],
  ['malformed singleton is preserved', ['\uDC00\uD800'], '\uDC00\uD800'],
];

for (const [name, strings, expected] of cases) {
  test(`longestCommonPrefix: ${name} in both orders on repeated calls`, () => {
    for (const input of [strings, [...strings].reverse()]) {
      const before = Object.getOwnPropertyDescriptors(input);
      const prototype = Object.getPrototypeOf(input);
      for (let call = 0; call < 2; call += 1) {
        assert.equal(longestCommonPrefix(input), expected);
        assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
        assert.equal(Object.getPrototypeOf(input), prototype);
        assert.equal(Object.isExtensible(input), true);
      }
    }
  });
}

test('longestCommonPrefix compares all inputs, including between sorted endpoints', () => {
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const prefix of ['', 'x', '😀']) {
    const strings = ['\uD800a', '\uD800\uDC00', '\uD800\uE000'].map(text => prefix + text);
    for (const order of orders) {
      assert.equal(longestCommonPrefix(order.map(index => strings[index])), prefix);
    }
  }
});

test('longestCommonPrefix rejects non-Arrays, including array-like impostors', () => {
  const fakeArray = Object.assign(Object.create(Array.prototype), { 0: 'a', length: 1 });
  for (const value of [undefined, null, true, false, 0, NaN, Infinity, 1n, Symbol('input'),
    '', 'abc', new String('abc'), {}, { length: 0 }, { 0: 'a', length: 1 },
    new Set(['a']), new Uint8Array(0), new Uint8Array([1]), () => [], fakeArray]) {
    assert.throws(() => longestCommonPrefix(value), TypeError);
  }
  assert.throws(() => longestCommonPrefix(), TypeError);
});

const invalidElements = [
  ['undefined', undefined], ['null', null], ['number', 42], ['NaN', NaN],
  ['boolean', false], ['bigint', 1n], ['symbol', Symbol('element')], ['object', {}],
  ['empty array', []], ['nested array', ['a']], ['function', () => 'a'],
  ['boxed string', new String('a')], ['boxed empty string', new String('')],
];

for (const [name, invalid] of invalidElements) {
  test(`longestCommonPrefix rejects ${name} anywhere, even after an empty prefix`, () => {
    for (const strings of [[invalid], [invalid, 'z', 'a'], ['z', invalid, 'a'],
      ['z', 'a', invalid], ['', invalid], ['flower', 'flight', 'flow', invalid]]) {
      const before = Object.getOwnPropertyDescriptors(strings);
      const prototype = Object.getPrototypeOf(strings);
      assert.throws(() => longestCommonPrefix(strings), TypeError);
      assert.deepEqual(Object.getOwnPropertyDescriptors(strings), before);
      assert.equal(Object.getPrototypeOf(strings), prototype);
      assert.equal(Object.isExtensible(strings), true);
    }
  });
}

for (const key of ['toString', 'valueOf', Symbol.toPrimitive]) {
  test(`longestCommonPrefix rejects objects without accessing or calling ${String(key)}`, () => {
    let accesses = 0;
    const rejectAccess = () => { accesses += 1; throw new Error('must not coerce'); };
    for (const invalid of [{ [key]: rejectAccess }, Object.defineProperty({}, key, { get: rejectAccess })]) {
      assert.throws(() => longestCommonPrefix(invalid), TypeError);
      assert.throws(() => longestCommonPrefix(['', invalid]), TypeError);
      assert.throws(() => longestCommonPrefix(['a', 'b', invalid]), TypeError);
    }
    assert.equal(accesses, 0);
  });
}

test('longestCommonPrefix rejects sparse arrays without changing them', () => {
  for (const strings of [new Array(1), new Array(3), [, 'ab'], ['ab', , 'ac'],
    ['ab', ,], ['', ,], Object.freeze(new Array(1))]) {
    const before = Object.getOwnPropertyDescriptors(strings);
    const extensible = Object.isExtensible(strings);
    assert.throws(() => longestCommonPrefix(strings), TypeError);
    assert.deepEqual(Object.getOwnPropertyDescriptors(strings), before);
    assert.equal(Object.isExtensible(strings), extensible);
  }
});

test('longestCommonPrefix rejects inherited indices without reading them', () => {
  for (const descriptor of [
    { value: 'abc' },
    { get() { assert.fail('must not read inherited index'); } },
  ]) {
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, '0', descriptor);
    const strings = Object.setPrototypeOf(new Array(1), prototype);
    assert.throws(() => longestCommonPrefix(strings), TypeError);
    assert.equal(Object.hasOwn(strings, 0), false);
    assert.equal(Object.getPrototypeOf(strings), prototype);
  }
});

test('longestCommonPrefix validates non-enumerable indices and ignores unrelated properties', () => {
  for (const value of ['ac', 42]) {
    const strings = ['ab', value];
    Object.defineProperty(strings, '1', { enumerable: false, writable: false });
    strings.note = 42;
    for (const key of ['extra', '-1', '1.5', Symbol('extra')]) {
      Object.defineProperty(strings, key, { get() { assert.fail('not an element'); } });
    }
    const before = Object.getOwnPropertyDescriptors(strings);
    if (typeof value === 'string') assert.equal(longestCommonPrefix(strings), 'a');
    else assert.throws(() => longestCommonPrefix(strings), TypeError);
    assert.deepEqual(Object.getOwnPropertyDescriptors(strings), before);
  }
});

test('longestCommonPrefix accepts frozen arrays on repeated calls', () => {
  for (const [strings, expected] of [[[], ''], [['😀'], '😀'],
    [['flower', 'flight', 'flow'], 'fl'], [['', 'a'], '']]) {
    Object.freeze(strings);
    const before = Object.getOwnPropertyDescriptors(strings);
    assert.equal(longestCommonPrefix(strings), expected);
    assert.equal(longestCommonPrefix(strings), expected);
    assert.deepEqual(Object.getOwnPropertyDescriptors(strings), before);
    assert.equal(Object.isFrozen(strings), true);
  }
});

test('longestCommonPrefix performs no temporary writes on success or failure', () => {
  for (const [strings, expected] of [[[], ''], [['flower', 'flight', 'flow'], 'fl'],
    [['z', 'a', null], TypeError], [['', ,], TypeError]]) {
    const rejectWrite = () => assert.fail('must not write to the input');
    const input = new Proxy(strings, {
      set: rejectWrite, defineProperty: rejectWrite, deleteProperty: rejectWrite,
      setPrototypeOf: rejectWrite, preventExtensions: rejectWrite,
    });
    if (expected === TypeError) assert.throws(() => longestCommonPrefix(input), TypeError);
    else assert.equal(longestCommonPrefix(input), expected);
  }
});

test('longestCommonPrefix ignores input methods, constructors and misleading iterators', () => {
  let iteratorCalls = 0;
  for (const strings of [['flower', 'flight', 'flow'], [42]]) {
    for (const key of ['slice', 'sort', 'hasOwnProperty', 'constructor']) {
      Object.defineProperty(strings, key, { get() { assert.fail('must not read source hooks'); } });
    }
    strings[Symbol.iterator] = function* () { iteratorCalls += 1; };
    if (strings.length === 1) assert.throws(() => longestCommonPrefix(strings), TypeError);
    else assert.equal(longestCommonPrefix(strings), 'fl');
  }
  assert.equal(iteratorCalls, 0);
});

test('longestCommonPrefix does not use species that could alias the input', () => {
  let speciesReads = 0;
  class Input extends Array {
    static get [Symbol.species]() {
      speciesReads += 1;
      return function () { return subclass; };
    }
  }
  const subclass = new Input('flower', 'flight', 'flow');
  const ordinary = ['flower', 'flight', 'flow'];
  ordinary.constructor = {
    get [Symbol.species]() {
      speciesReads += 1;
      return function () { return ordinary; };
    },
  };
  for (const strings of [ordinary, subclass]) {
    const before = Object.getOwnPropertyDescriptors(strings);
    const prototype = Object.getPrototypeOf(strings);
    assert.equal(longestCommonPrefix(strings), 'fl');
    assert.deepEqual(Object.getOwnPropertyDescriptors(strings), before);
    assert.equal(Object.getPrototypeOf(strings), prototype);
  }
  assert.equal(speciesReads, 0);
});

test('longestCommonPrefix accepts cross-realm and null-prototype Arrays', () => {
  for (const strings of [runInNewContext("['flower', 'flight', 'flow']"),
    Object.setPrototypeOf(['flower', 'flight', 'flow'], null)]) {
    const before = Object.getOwnPropertyDescriptors(strings);
    const prototype = Object.getPrototypeOf(strings);
    assert.equal(longestCommonPrefix(strings), 'fl');
    assert.deepEqual(Object.getOwnPropertyDescriptors(strings), before);
    assert.equal(Object.getPrototypeOf(strings), prototype);
  }
});

test('longestCommonPrefix compares the captured values without rereading getters', () => {
  const reads = [0, 0, 0];
  const strings = ['flower', 'flight', 'flow'];
  for (let index = 0; index < strings.length; index += 1) {
    const value = strings[index];
    Object.defineProperty(strings, index, {
      get() { reads[index] += 1; return reads[index] === 1 ? value : null; },
    });
  }
  const before = Object.getOwnPropertyDescriptors(strings);
  assert.equal(longestCommonPrefix(strings), 'fl');
  assert.deepEqual(reads, [1, 1, 1]);
  assert.deepEqual(Object.getOwnPropertyDescriptors(strings), before);
});

test('longestCommonPrefix captures initial length before getters append elements', () => {
  const strings = ['ab', 'ac'];
  Object.defineProperty(strings, '0', { get() { strings.push(null); return 'ab'; } });
  assert.equal(longestCommonPrefix(strings), 'a');
  assert.equal(strings.length, 3);
  assert.equal(strings[2], null);
});

test('longestCommonPrefix retains a long prefix before an astral mismatch', () => {
  const prefix = 'a😀e\u0301'.repeat(10_000);
  assert.equal(longestCommonPrefix([prefix + '😀x', prefix + '😁y', prefix + '😀']), prefix);
});

// Independent oracle: materialize iterator elements and inspect each column.
function referencePrefix(strings) {
  const sequences = strings.map(text => [...text]);
  const common = [];
  for (let index = 0; index < sequences[0].length; index += 1) {
    const point = sequences[0][index];
    if (!sequences.every(sequence => sequence[index] === point)) break;
    common.push(point);
  }
  return common.join('');
}

function assertCommonPrefix(strings) {
  const result = longestCommonPrefix(strings);
  const context = JSON.stringify(strings);
  assert.equal(result, referencePrefix(strings), context);
  const resultPoints = [...result];
  const sequences = strings.map(text => [...text]);
  for (const sequence of sequences) {
    assert.deepEqual(sequence.slice(0, resultPoints.length), resultPoints, context);
  }
  const next = resultPoints.length;
  assert.ok(sequences.some(sequence => sequence.length === next || sequence[next] !== sequences[0][next]), context);
}

test('longestCommonPrefix matches an iterator oracle for generated pairs and triples', () => {
  const fragments = ['a', 'b', '😀', '😁', '\uD800', '\uDC00', '\u0301'];
  const strings = ['', ...fragments];
  for (const left of fragments) {
    for (const right of fragments) strings.push(left + right);
  }
  // Ordered pairs include reversed and duplicate inputs, and raw fragments can
  // join into a surrogate pair rather than remaining independent elements.
  for (const left of strings) {
    for (const right of strings) assertCommonPrefix([left, right]);
  }
  const tripleStrings = ['', ...fragments, '\uD800a', '\uD800\uDC00', '\uD800\uE000'];
  for (const prefix of ['', 'x', '😀', '\uD800']) {
    for (const first of tripleStrings) {
      for (const second of tripleStrings) {
        for (const third of tripleStrings) {
          assertCommonPrefix([prefix + first, prefix + second, prefix + third]);
        }
      }
    }
  }
});
