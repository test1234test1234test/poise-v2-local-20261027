import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createSecretKey, webcrypto } from 'node:crypto';
import * as module from '../lib/apply-text-edits.mjs';
import { applyTextEdits } from '../lib/apply-text-edits.mjs';

const E = (start, end, text) => ({ start, end, text });

function snapshot(...objects) {
  return objects.map(object => ({
    object,
    keys: Reflect.ownKeys(object),
    descriptors: Object.getOwnPropertyDescriptors(object),
    prototype: Object.getPrototypeOf(object),
    extensible: Object.isExtensible(object),
  }));
}

function assertUnchanged(before) {
  for (const { object, keys, descriptors, prototype, extensible } of before) {
    assert.deepEqual(Reflect.ownKeys(object), keys);
    for (const key of keys) {
      const after = Object.getOwnPropertyDescriptor(object, key);
      assert.deepEqual(Reflect.ownKeys(after), Reflect.ownKeys(descriptors[key]));
      for (const field of Reflect.ownKeys(after)) {
        // Strict identity also checks sharing, signed zero and accessor functions.
        assert.equal(after[field], descriptors[key][field]);
      }
    }
    assert.equal(Object.getPrototypeOf(object), prototype);
    assert.equal(Object.isExtensible(object), extensible);
  }
}

function rejectsEdit(edit, ErrorType = TypeError) {
  for (const edits of [[edit], [E(0, 0, 'valid prefix'), edit]]) {
    assert.throws(() => applyTextEdits('abcd', edits), ErrorType);
  }
}

const cases = [
  ['empty batch', 'abcd', [], 'abcd'],
  ['empty source and batch', '', [], ''],
  ['original offsets after a longer replacement', 'abcd', [E(3, 4, 'Z'), E(0, 1, 'LONG')], 'LONGbcZ'],
  ['start insertion supplied after replacement', 'abcd', [E(1, 3, 'X'), E(1, 1, '!')], 'a!Xd'],
  ['insertions surrounding a replacement in input', 'abcd', [E(1, 1, 'A'), E(1, 3, 'X'), E(1, 1, 'B')], 'aABXd'],
  ['end insertion', 'abcd', [E(1, 3, 'X'), E(3, 3, '!')], 'aX!d'],
  ['shared boundary', 'abcdef', [E(3, 5, 'T'), E(3, 3, 'P'), E(1, 3, 'R'), E(3, 3, 'Q')], 'aRPQTf'],
  ['unsorted duplicate insertions at zero', 'abcd', [E(4, 4, '!'), E(0, 0, 'A'), E(0, 0, 'B'), E(2, 2, 'C')], 'ABabCcd!'],
  ['insertions into empty source', '', [E(0, 0, 'A'), E(0, 0, ''), E(0, 0, 'B')], 'AB'],
  ['deletion boundaries', 'abcd', [E(1, 3, ''), E(1, 1, 'S'), E(3, 3, 'E')], 'aSEd'],
  ['touching replacements', 'abcdef', [E(3, 5, 'Y'), E(1, 3, 'X')], 'aXYf'],
  ['whole-string deletion', 'abcd', [E(0, 4, '')], ''],
  ['end-of-string insertion', 'abcd', [E(4, 4, '!')], 'abcd!'],
  ['empty insertion before replacement', 'abc', [E(1, 2, 'X'), E(1, 1, ''), E(1, 1, '!')], 'a!Xc'],
  ['signed zero', '', [E(-0, 0, 'A'), E(0, -0, 'B')], 'AB'],
  ['repeated substrings located by offsets', 'ababa', [E(2, 3, 'X')], 'abXba'],
  ['identity replacement', 'abcd', [E(1, 3, 'bc')], 'abcd'],
  ['surrogate pair replacement', 'A😀B', [E(1, 3, 'X')], 'AXB'],
  ['split surrogate pair', 'A😀B', [E(1, 2, 'X')], 'AX\uDE00B'],
  ['insertion between surrogate halves', 'A😀B', [E(2, 2, '!')], 'A\uD83D!\uDE00B'],
  ['unpaired surrogates brought together', '\uD83Dx\uDE00', [E(1, 2, '')], '😀'],
  ['lone surrogate replacement', '😀', [E(0, 2, '\uD800')], '\uD800'],
  ['preexisting lone surrogates', '\uDC00x\uD800', [E(1, 2, 'Y')], '\uDC00Y\uD800'],
  ['combining marks remain separate code units', 'e\u0301', [E(1, 1, '!')], 'e!\u0301'],
  ['replacement remains decomposed', 'x', [E(0, 1, 'e\u0301')], 'e\u0301'],
];

for (const [name, original, edits, expected] of cases) {
  test(`applyTextEdits: ${name}`, () => {
    const before = snapshot(edits, ...edits);
    const result = applyTextEdits(original, edits);
    assert.equal(typeof result, 'string');
    assert.equal(result, expected);
    assert.equal(result.length, original.length +
      edits.reduce((sum, edit) => sum + edit.text.length - (edit.end - edit.start), 0));
    assert.equal(applyTextEdits(original, edits), expected);
    assertUnchanged(before);
  });
}

test('applyTextEdits inserts payloads literally without substitutions or property writes', () => {
  const before = snapshot(Object.prototype, Array.prototype, String.prototype);
  for (const payload of ['$&', '$$', '$`', "$'", '$1', '$99', '$<name>',
    '\0\r\n', '\\', '<b>&</b>', '__proto__', 'constructor', 'prototype', 'e\u0301']) {
    assert.equal(applyTextEdits('abc', [E(1, 2, payload)]), 'a' + payload + 'c');
    assert.equal(applyTextEdits('abc', [E(1, 1, payload)]), 'a' + payload + 'bc');
  }
  assertUnchanged(before);
});

const conflicts = [
  ['partial overlap', [E(0, 2, 'X'), E(1, 3, 'Y')]],
  ['containment', [E(0, 4, 'R'), E(2, 3, 'S')]],
  ['same start', [E(1, 2, ''), E(1, 3, '')]],
  ['duplicate range', [E(1, 3, 'X'), E(1, 3, 'Y')]],
  ['strictly interior insertion', [E(1, 3, 'X'), E(2, 2, '!')]],
  ['empty insertion inside deletion', [E(1, 3, ''), E(2, 2, '')]],
  ['identity replacement still consumes its interval', [E(1, 3, 'bc'), E(2, 2, '!')]],
  ['duplicate identity replacements', [E(1, 3, 'bc'), E(1, 3, 'bc')]],
  ['start insertion does not hide an interior insertion', [E(1, 4, 'X'), E(1, 1, 'S'), E(3, 3, 'I')]],
  ['start insertion does not hide an overlap', [E(1, 4, 'X'), E(1, 1, 'S'), E(2, 3, 'R')]],
];

function* permutations(values) {
  if (values.length === 0) yield [];
  for (let index = 0; index < values.length; index++) {
    for (const rest of permutations(values.filter((_, i) => i !== index))) {
      yield [values[index], ...rest];
    }
  }
}

for (const [name, edits] of conflicts) {
  test(`applyTextEdits rejects ${name} in every order without input changes`, () => {
    for (const batch of permutations(edits)) {
      const before = snapshot(batch, ...batch);
      assert.throws(() => applyTextEdits('abcd', batch), RangeError);
      assertUnchanged(before);
    }
  });
}

test('applyTextEdits handles every permutation of distinct starts and stable equal-start insertions', () => {
  for (const edits of permutations([E(0, 1, 'LONG'), E(2, 2, '!'), E(3, 4, 'Z'), E(4, 4, '?')])) {
    assert.equal(applyTextEdits('abcd', edits), 'LONGb!cZ?');
  }
  for (const insertions of permutations([E(1, 1, 'A'), E(1, 1, 'B'), E(1, 1, 'C')])) {
    for (let index = 0; index <= insertions.length; index++) {
      const edits = insertions.slice();
      edits.splice(index, 0, E(1, 3, 'X'));
      assert.equal(applyTextEdits('abcd', edits), 'a' + insertions.map(e => e.text).join('') + 'Xd');
    }
  }
});

test('applyTextEdits preserves repeated edit references and does not deduplicate them', () => {
  const insertion = E(-0, 0, 'A');
  const replacement = E(1, 2, 'X');
  for (const edit of [insertion, replacement]) {
    const edits = [edit, edit];
    const before = snapshot(edits, edit);
    if (edit === insertion) assert.equal(applyTextEdits('abcd', edits), 'AAabcd');
    else assert.throws(() => applyTextEdits('abcd', edits), RangeError);
    assertUnchanged(before);
  }
});

test('applyTextEdits accepts each field creation order, null prototypes and readonly fields', () => {
  for (const fields of permutations(['start', 'end', 'text'])) {
    for (const prototype of [null, Object.prototype]) {
      for (const readonly of [false, true]) {
        const edit = Object.create(prototype);
        const values = E(1, 2, 'X');
        for (const field of fields) {
          Object.defineProperty(edit, field, {
            value: values[field], enumerable: true, writable: !readonly, configurable: !readonly,
          });
        }
        const edits = [edit];
        const before = snapshot(edits, edit);
        assert.equal(applyTextEdits('abc', edits), 'aXc');
        assertUnchanged(before);
      }
    }
  }
});

test('applyTextEdits preserves mutable, sealed and frozen inputs on success and late failure', () => {
  for (const protect of [value => value, Object.seal, Object.freeze]) {
    for (const failure of [null, 'shape', 'range', 'conflict']) {
      const first = protect(E(2, 3, 'X'));
      const second = protect(failure === 'shape' ? { start: 0, text: 'bad' }
        : failure === 'range' ? E(4, 5, 'bad')
        : failure === 'conflict' ? E(1, 4, 'bad') : E(0, 0, 'A'));
      const edits = protect([first, second]);
      const before = snapshot(edits, first, second, Object.prototype, Array.prototype);
      if (failure === null) assert.equal(applyTextEdits('abcd', edits), 'AabXd');
      else assert.throws(() => applyTextEdits('abcd', edits), failure === 'shape' ? TypeError : RangeError);
      assertUnchanged(before);
    }
  }
});

test('applyTextEdits validates argument types even for empty batches and empty text', () => {
  const invalid = [undefined, null, true, false, 0, NaN, Infinity, 1n, Symbol('input'),
    new String('abc'), new Number(1), {}, () => {}, new Set(), new Uint8Array(),
    { 0: E(0, 0, 'X'), length: 1 }];
  assert.throws(() => applyTextEdits(), TypeError);
  for (const value of [...invalid, []]) {
    assert.throws(() => applyTextEdits(value, []), TypeError);
  }
  for (const value of [...invalid, '', 'abc']) {
    assert.throws(() => applyTextEdits('', value), TypeError);
  }
  assert.throws(() => applyTextEdits('', [E(0, 1, '')]), RangeError);
  assert.throws(() => applyTextEdits('', [{ start: 0, end: 0 }]), TypeError);
});

test('applyTextEdits rejects primitive, array, function and custom-prototype edit values', () => {
  for (const edit of [undefined, null, true, 0, NaN, 1n, Symbol('edit'), 'edit',
    new String(''), new Number(0), [], Object.assign([], E(0, 0, 'X')),
    Object.assign(() => {}, E(0, 0, 'X')), Object.assign(Object.create({}), E(0, 0, 'X')),
    new (class Edit { start = 0; end = 0; text = 'X'; })()]) {
    rejectsEdit(edit);
  }
  rejectsEdit(Object.setPrototypeOf(Object.assign([], E(0, 0, 'X')), null));
});

test('applyTextEdits rejects missing, hidden and inherited required fields', () => {
  for (const field of ['start', 'end', 'text']) {
    const missing = E(0, 0, 'X');
    delete missing[field];
    rejectsEdit(missing);
    rejectsEdit(Object.defineProperty(E(0, 0, 'X'), field, { enumerable: false }));
    const inherited = Object.assign(Object.create({ [field]: E(0, 0, 'X')[field] }), missing);
    rejectsEdit(inherited);
  }
  rejectsEdit(Object.create(E(0, 0, 'X')));
});

test('applyTextEdits rejects all extra own keys, including hidden symbols and dangerous names', () => {
  for (const key of ['extra', '__proto__', 'constructor', 'prototype', '0', Symbol('extra'), Symbol.toStringTag]) {
    for (const enumerable of [true, false]) {
      const edit = Object.defineProperty(E(0, 0, 'X'), key, { value: 'unused', enumerable });
      const before = snapshot(edit, Object.prototype);
      rejectsEdit(edit);
      assertUnchanged(before);
    }
  }
  // Three keys is insufficient if one of the required fields has been substituted.
  for (const key of ['other', Symbol('text')]) {
    rejectsEdit(Object.defineProperty({ start: 0, end: 0 }, key, { value: 'X', enumerable: true }));
  }
});

test('applyTextEdits distinguishes malformed coordinate types from invalid numbers without coercion', () => {
  const wrongTypes = [undefined, null, false, true, '1', 1n, Symbol('offset'), new Number(1), {}, [], () => 1];
  const badNumbers = [-1, -Number.MIN_VALUE, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];
  for (const field of ['start', 'end']) {
    for (const value of wrongTypes) rejectsEdit({ ...E(0, 4, 'X'), [field]: value });
    for (const value of badNumbers) rejectsEdit({ ...E(0, 4, 'X'), [field]: value }, RangeError);
  }
  for (const edit of [E(3, 2, 'X'), E(5, 5, 'X'), E(0, 5, 'X'), E(0, -1, 'X'),
    E(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'X')]) {
    rejectsEdit(edit, RangeError);
  }
  for (const value of [...wrongTypes.filter(value => typeof value !== 'string'), 0, NaN, Infinity, new String('X')]) {
    rejectsEdit(E(0, 0, value));
  }
  let calls = 0;
  for (const key of ['toString', 'valueOf', Symbol.toPrimitive]) {
    const invalid = Object.defineProperty({}, key, {
      get() { calls++; throw new Error('conversion hook read'); },
    });
    assert.throws(() => applyTextEdits(invalid, []), TypeError);
    assert.throws(() => applyTextEdits('', invalid), TypeError);
    rejectsEdit(E(invalid, 0, 'X'));
    rejectsEdit(E(0, invalid, 'X'));
    rejectsEdit(E(0, 0, invalid));
  }
  assert.equal(calls, 0);
});

test('applyTextEdits rejects every accessor form without invoking getters or setters', () => {
  let calls = 0;
  const descriptors = [
    { get() { calls++; return 0; } },
    { get() { calls++; throw new Error('getter called'); } },
    { set(_) { calls++; } },
    { get: undefined, set: undefined },
  ];
  for (const descriptor of descriptors) {
    for (const enumerable of [true, false]) {
      for (const field of ['start', 'end', 'text', 'extra', Symbol('extra')]) {
        const edit = Object.defineProperty(E(0, 0, 'X'), field, { ...descriptor, enumerable });
        const before = snapshot(edit);
        rejectsEdit(edit);
        assertUnchanged(before);
      }
      for (const index of [0, 1]) {
        const edits = Object.defineProperty([E(0, 0, 'prefix'), E(0, 0, 'X')], index, {
          ...descriptor, enumerable,
        });
        const before = snapshot(edits);
        assert.throws(() => applyTextEdits('', edits), TypeError);
        assertUnchanged(before);
      }
    }
  }
  assert.equal(calls, 0);
});

test('applyTextEdits rejects holes, inherited indices and metadata even when empty', () => {
  for (const edits of [new Array(1), [, E(0, 0, 'X')], [E(0, 0, 'X'), ,],
    [E(0, 0, 'X'), , E(0, 0, 'Y')]]) {
    assert.throws(() => applyTextEdits('', edits), TypeError);
  }
  let calls = 0;
  for (const descriptor of [
    { value: E(0, 0, 'X') }, { get() { calls++; throw new Error('inherited index read'); } },
  ]) {
    const prototype = Object.defineProperty(Object.create(Array.prototype), '0', descriptor);
    for (const metadata of [false, true]) {
      const edits = Object.setPrototypeOf(new Array(1), prototype);
      if (metadata) edits.note = 'fills the own-key count but not the hole';
      assert.throws(() => applyTextEdits('', edits), TypeError);
    }
  }
  for (const key of ['note', '00', '-0', '1e0', '4294967295', '__proto__',
    'constructor', 'prototype', Symbol('note'), Symbol.iterator]) {
    for (const enumerable of [true, false]) {
      for (const descriptor of [
        { value: 'metadata' }, { get() { calls++; throw new Error('metadata getter called'); } },
      ]) {
        for (const edits of [[], [E(0, 0, 'X')]]) {
          Object.defineProperty(edits, key, { ...descriptor, enumerable });
          assert.throws(() => applyTextEdits('', edits), TypeError);
        }
      }
    }
  }
  assert.equal(calls, 0);
});

test('applyTextEdits accepts hidden own indices and arrays with foreign, null or custom prototypes', () => {
  let calls = 0;
  class Edits extends Array {
    constructor(...values) { super(...values); calls++; }
    static get [Symbol.species]() { calls++; throw new Error('species called'); }
  }
  const subclass = new Edits(E(0, 0, 'X'));
  const foreign = runInNewContext('[]');
  foreign.push(E(0, 0, 'X'));
  const customPrototype = Object.create(Array.prototype);
  for (const key of ['constructor', 'slice', 'sort', 'map', 'forEach', Symbol.iterator]) {
    Object.defineProperty(customPrototype, key, {
      get() { calls++; throw new Error('input hook read'); },
    });
  }
  calls = 0;
  for (const edits of [subclass, foreign, Object.setPrototypeOf([E(0, 0, 'X')], null),
    Object.setPrototypeOf([E(0, 0, 'X')], customPrototype),
    Object.defineProperty([], '0', { value: E(0, 0, 'X') })]) {
    const before = snapshot(edits, Object.getOwnPropertyDescriptor(edits, '0').value);
    assert.equal(applyTextEdits('', edits), 'X');
    assertUnchanged(before);
  }
  for (const prototype of [null, customPrototype, Edits.prototype]) {
    assert.equal(applyTextEdits('abc', Object.setPrototypeOf([], prototype)), 'abc');
  }
  assert.equal(calls, 0);
});

test('applyTextEdits rejects foreign object prototypes and accepts foreign null-prototype records', () => {
  rejectsEdit(runInNewContext('({ start: 0, end: 0, text: "X" })'));
  const edit = runInNewContext('Object.assign(Object.create(null), { start: 0, end: 0, text: "X" })');
  assert.equal(applyTextEdits('', [edit]), 'X');
});

test('applyTextEdits does not read inherited edit hooks or proxy prototypes', () => {
  let calls = 0;
  const trap = () => { calls++; throw new Error('inherited hook called'); };
  const prototype = Object.create(null);
  for (const key of ['start', 'end', 'text', 'constructor', Symbol.toStringTag]) {
    Object.defineProperty(prototype, key, { get: trap });
  }
  rejectsEdit(Object.create(prototype));
  rejectsEdit(Object.assign(Object.create(new Proxy({}, { get: trap, getPrototypeOf: trap })), E(0, 0, 'X')));
  assert.equal(calls, 0);
});

test('applyTextEdits rejects live and revoked proxies before any traps, including after a valid edit', () => {
  let calls = 0;
  const trap = () => { calls++; throw new Error('proxy trap called'); };
  for (const target of [[E(0, 0, 'X')], E(0, 0, 'X'), () => {}]) {
    const before = snapshot(target);
    const proxy = new Proxy(target, {
      get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
      has: trap, set: trap, defineProperty: trap, setPrototypeOf: trap, preventExtensions: trap,
    });
    const revocable = Proxy.revocable(target, {});
    revocable.revoke();
    for (const value of [proxy, revocable.proxy]) {
      assert.throws(() => applyTextEdits('', value), TypeError);
      rejectsEdit(value);
    }
    assertUnchanged(before);
  }
  // A descriptor trap can itself return a getter-bearing descriptor object.
  for (const target of [[E(0, 0, 'X')], E(0, 0, 'X')]) {
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(object, key) {
        calls++;
        return {
          configurable: true, enumerable: true, writable: true,
          get value() { calls++; return Reflect.getOwnPropertyDescriptor(object, key).value; },
        };
      },
    });
    assert.throws(() => applyTextEdits('', proxy), TypeError);
    rejectsEdit(proxy);
  }
  assert.throws(() => applyTextEdits('', new Proxy([], { ownKeys: trap })), TypeError);
  assert.equal(calls, 0);
});

test('applyTextEdits rejects native brands even after disguising their prototypes and own keys', async () => {
  const cryptoKey = await webcrypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', true, ['encrypt']);
  const factories = [
    () => new Date(0), () => /x/, () => new Map(), () => new Set(),
    () => new WeakMap(), () => new WeakSet(), () => Promise.resolve(), () => new Error(),
    () => new Number(0), () => new String(''), () => new Boolean(false),
    () => Object(1n), () => Object(Symbol('boxed')),
    () => new ArrayBuffer(0), () => new SharedArrayBuffer(0),
    () => new DataView(new ArrayBuffer(0)), () => new Uint8Array(0),
    () => (function () { return arguments; })(), () => (function* () {})(),
    () => new Map().entries(), () => new Set().values(),
    () => createSecretKey(Buffer.from('key')), () => cryptoKey,
  ];
  for (const create of factories) {
    for (const prototype of [null, Object.prototype]) {
      const edit = create();
      // Remove removable native keys so shape checks alone cannot reject most brands.
      for (const key of Reflect.ownKeys(edit)) {
        if (Object.getOwnPropertyDescriptor(edit, key).configurable) delete edit[key];
      }
      Object.setPrototypeOf(edit, prototype);
      Object.assign(edit, E(0, 0, 'X'));
      rejectsEdit(edit);
    }
  }
  rejectsEdit(module);
});

// Independent oracle: compare every pair, then scan original code-unit offsets.
// It uses neither sorting nor the implementation's equal-start group validation.
function oracle(original, edits) {
  for (let i = 0; i < edits.length; i++) {
    for (let j = i + 1; j < edits.length; j++) {
      const a = edits[i];
      const b = edits[j];
      if (a.start < a.end && b.start < b.end) {
        if (Math.max(a.start, b.start) < Math.min(a.end, b.end)) return null;
      } else if ((a.start === a.end && b.start < a.start && a.start < b.end) ||
                 (b.start === b.end && a.start < b.start && b.start < a.end)) return null;
    }
  }
  let result = '';
  for (let offset = 0; offset <= original.length; offset++) {
    for (const edit of edits) {
      if (edit.start === offset && edit.end === offset) result += edit.text;
    }
    for (const edit of edits) {
      if (edit.start === offset && edit.end > offset) result += edit.text;
    }
    if (offset < original.length && !edits.some(e => e.start <= offset && offset < e.end)) {
      result += original[offset];
    }
  }
  return result;
}

test('applyTextEdits agrees with a pairwise oracle for exhaustive small ordered batches', () => {
  let accepted = 0;
  let rejected = 0;
  for (let length = 0; length <= 4; length++) {
    const original = 'a😀b'.slice(0, length);
    const intervals = [];
    for (let start = 0; start <= length; start++) {
      for (let end = start; end <= length; end++) intervals.push([start, end]);
    }
    function visit(batch) {
      for (const payloads of [['X', 'YY', '!'], ['', '😀', '']]) {
        const edits = batch.map(([start, end], index) => E(start, end, payloads[index]));
        const expected = oracle(original, edits);
        if (expected === null) {
          assert.throws(() => applyTextEdits(original, edits), RangeError);
          rejected++;
        } else {
          const result = applyTextEdits(original, edits);
          assert.equal(result, expected);
          assert.equal(result.length, original.length +
            edits.reduce((sum, e) => sum + e.text.length - (e.end - e.start), 0));
          accepted++;
        }
      }
      if (batch.length < 3) {
        for (const interval of intervals) visit([...batch, interval]);
      }
    }
    visit([]);
  }
  assert.ok(accepted > 0 && rejected > 0);
});
