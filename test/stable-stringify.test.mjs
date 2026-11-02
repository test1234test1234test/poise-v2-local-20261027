import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createSecretKey, webcrypto } from 'node:crypto';
import * as serializer from '../lib/stable-stringify.mjs';
import { stableStringify } from '../lib/stable-stringify.mjs';
import { parseIni } from '../lib/parse-ini.mjs';

function rejectsEverywhere(value) {
  assert.throws(() => stableStringify(value), TypeError, 'root');
  assert.throws(() => stableStringify({ child: value }), TypeError, 'object member');
  assert.throws(() => stableStringify([value]), TypeError, 'array element');
}

test('stableStringify spells admitted primitives like native JSON at every depth', () => {
  for (const value of [
    null, true, false, '', 'text', 0, -0, 1, -42, 1.25, -0.125,
    Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE,
    Number.MAX_SAFE_INTEGER + 1, 1e-7, 1e-6, 1e20, 1e21,
  ]) {
    const expected = JSON.stringify(value);
    assert.equal(stableStringify(value), expected);
    assert.equal(stableStringify({ b: [value], a: value }),
      `{"a":${expected},"b":[${expected}]}`);
  }
  assert.equal(stableStringify(-0), '0');
  assert.equal(stableStringify({ zero: -0, array: [-0] }), '{"array":[0],"zero":0}');
  assert.equal(stableStringify({}), '{}');
  assert.equal(stableStringify([]), '[]');
  assert.equal(stableStringify(Object.create(null)), '{}');
  assert.equal(stableStringify({ b: [], a: {} }), '{"a":{},"b":[]}');
});

test('stableStringify sorts nested object members independently of insertion order', () => {
  const expected = '{"a":[2,1,{"10":10,"2":2}],"b":{"c":3,"d":4}}';
  for (const inner of [{ d: 4, c: 3 }, { c: 3, d: 4 }]) {
    for (const numeric of [Object.fromEntries([['2', 2], ['10', 10]]), { 10: 10, 2: 2 }]) {
      assert.equal(stableStringify({ b: inner, a: [2, 1, numeric] }), expected);
      assert.equal(stableStringify({ a: [2, 1, numeric], b: inner }), expected);
    }
  }
  const dictionary = Object.assign(Object.create(null), { b: 2, a: 1 });
  assert.equal(stableStringify(dictionary), '{"a":1,"b":2}');
  assert.equal(stableStringify([dictionary, { dictionary }]),
    '[{"a":1,"b":2},{"dictionary":{"a":1,"b":2}}]');
});

test('stableStringify sorts raw UTF-16 keys, without locale comparison or normalization', () => {
  const ordered = ['', '\t', '\n', '10', '2', 'A', 'a', 'aa', 'e\u0301', 'é', '\u{10000}', '\uE000'];
  const expected = '{"":1,"\\t":1,"\\n":1,"10":1,"2":1,"A":1,"a":1,"aa":1,"é":1,"é":1,"𐀀":1,"":1}';
  for (const keys of [ordered, ordered.slice().reverse(), ordered.slice(5).concat(ordered.slice(0, 5))]) {
    const value = Object.fromEntries(keys.map(key => [key, 1]));
    assert.equal(stableStringify(value), expected);
    assert.equal(stableStringify({ nested: [value] }), `{"nested":[${expected}]}`);
  }
});

const textCases = [
  ['punctuation', '"\\/'], ['non-ASCII', 'é漢字😀'], ['line separators', '\u2028\u2029'],
  ['paired surrogates', '\uD800\uDC00'], ['high surrogate', '\uD800'],
  ['low surrogate', '\uDFFF'], ['mixed surrogates', '\uDC00x\uD800😀'],
  ['literal escape text', '\\uD800'],
  ...Array.from({ length: 32 }, (_, code) => [`C0 control ${code}`, String.fromCharCode(code)]),
];

for (const [name, text] of textCases) {
  test(`stableStringify uses ordinary JSON escaping for ${name} in values and keys`, () => {
    const escaped = JSON.stringify(text);
    assert.equal(stableStringify(text), escaped);
    assert.equal(JSON.parse(stableStringify(text)), text);
    assert.equal(stableStringify({ [text]: text }), `{${escaped}:${escaped}}`);
    assert.deepEqual(JSON.parse(stableStringify({ [text]: text })), { [text]: text });
  });
}

const brandedValues = [
  ['boxed number', () => new Number(1)], ['boxed string', () => new String('x')],
  ['boxed boolean', () => new Boolean(false)], ['boxed bigint', () => Object(1n)],
  ['boxed symbol', () => Object(Symbol('x'))],
  ['Date', () => new Date(0)], ['RegExp', () => /x/], ['Map', () => new Map()],
  ['Set', () => new Set()], ['WeakMap', () => new WeakMap()], ['WeakSet', () => new WeakSet()],
  ['Promise', () => Promise.resolve(1)], ['Error', () => new Error('invalid')],
  ['ArrayBuffer', () => new ArrayBuffer(1)], ['SharedArrayBuffer', () => new SharedArrayBuffer(1)],
  ['DataView', () => new DataView(new ArrayBuffer(1))], ['Buffer', () => Buffer.from([1])],
  ['arguments', () => (function () { return arguments; })(1)],
  ['generator object', () => (function* () { yield 1; })()],
  ['Map iterator', () => new Map().entries()], ['Set iterator', () => new Set().values()],
  ['KeyObject', () => createSecretKey(Buffer.from('secret'))],
  ...[
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array,
    Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
  ].map(Type => [Type.name, () => new Type(1)]),
];

const unsupportedValues = [
  ['undefined', () => undefined], ['function', () => () => 1],
  ['async function', () => async () => 1], ['generator function', () => function* () {}],
  ['async generator function', () => async function* () {}],
  ['symbol', () => Symbol('value')], ['bigint', () => 1n],
  ['NaN', () => NaN], ['positive infinity', () => Infinity], ['negative infinity', () => -Infinity],
  ['class instance', () => new (class Item {})()],
  ['custom prototype', () => Object.create({ inherited: 1 })],
  ['array iterator', () => [1].values()], ['string iterator', () => 'text'[Symbol.iterator]()],
  ['module namespace', () => serializer],
  ['WeakRef', () => new WeakRef({})], ['FinalizationRegistry', () => new FinalizationRegistry(() => {})],
  ...brandedValues,
];

for (const [name, create] of unsupportedValues) {
  test(`stableStringify rejects ${name} at root and nested positions`, () => {
    rejectsEverywhere(create());
  });
}

for (const [name, create] of brandedValues) {
  test(`stableStringify rejects the ${name} brand after prototype replacement`, () => {
    for (const prototype of [null, Object.prototype]) {
      rejectsEverywhere(Object.setPrototypeOf(create(), prototype));
    }
  });
}

test('stableStringify rejects CryptoKeys even with a replaced prototype', async () => {
  const key = await webcrypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', true, ['encrypt']);
  rejectsEverywhere(key);
  rejectsEverywhere(Object.setPrototypeOf(key, null));
  rejectsEverywhere(Object.setPrototypeOf(key, Object.prototype));
});

test('stableStringify rejects omitted input', () => {
  assert.throws(() => stableStringify(), TypeError);
});

test('stableStringify rejects live and revoked proxies without executing traps', () => {
  let calls = 0;
  const trap = () => { calls++; throw new Error('proxy trap sentinel'); };
  for (const target of [{}, [], () => {}]) {
    const proxy = new Proxy(target, {
      get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
      has: trap, apply: trap, construct: trap,
    });
    rejectsEverywhere(proxy);
    const revocable = Proxy.revocable(target, {});
    revocable.revoke();
    rejectsEverywhere(revocable.proxy);
  }
  assert.equal(calls, 0);
});

test('stableStringify explicitly rejects parseIni proxy dictionaries', () => {
  const parsed = parseIni('a=1\n[section]\nb=2');
  for (const value of [parsed, parsed.root, parsed.sections, parsed.sections.section]) {
    rejectsEverywhere(value);
  }
});

test('stableStringify treats raw JSON wrappers as data, never raw output', () => {
  for (const raw of ['-0', '1e400']) {
    const expected = `{"rawJSON":${JSON.stringify(raw)}}`;
    for (const value of [JSON.rawJSON(raw), Object.assign(Object.create(null), { rawJSON: raw })]) {
      assert.equal(stableStringify(value), expected);
      assert.equal(stableStringify({ child: value }), `{"child":${expected}}`);
      assert.equal(stableStringify([value]), `[${expected}]`);
    }
  }
});

test('stableStringify uses current-realm object prototypes and accepts foreign null dictionaries', () => {
  rejectsEverywhere(runInNewContext('({ a: 1 })'));
  assert.equal(stableStringify(runInNewContext('Object.assign(Object.create(null), { b: 2, a: 1 })')),
    '{"a":1,"b":2}');
});

test('stableStringify accepts array subclasses and foreign, custom and null prototypes', () => {
  let calls = 0;
  class Items extends Array {
    constructor(...values) { super(...values); calls++; }
    static get [Symbol.species]() { calls++; throw new Error('species sentinel'); }
  }
  const subclass = new Items(2, 1);
  calls = 0;
  const customPrototype = Object.defineProperty({}, 'toJSON', {
    get() { calls++; throw new Error('inherited hook sentinel'); },
  });
  for (const value of [
    subclass, runInNewContext('[2, 1]'),
    Object.setPrototypeOf([2, 1], null), Object.setPrototypeOf([2, 1], customPrototype),
  ]) {
    assert.equal(stableStringify(value), '[2,1]');
    assert.equal(stableStringify({ child: value }), '{"child":[2,1]}');
  }
  assert.equal(calls, 0);
});

const sparseArrays = [
  ['leading hole', () => [, 1]], ['interior hole', () => [1, , 3]],
  ['trailing hole', () => [1, ,]], ['empty slots', () => new Array(3)],
  ['deleted slot', () => { const a = [1, 2]; delete a[0]; return a; }],
  ['increased length', () => { const a = [1]; a.length = 3; return a; }],
  ['hole plus metadata', () => Object.assign([1, , 3], { note: 4 })],
];

for (const [name, create] of sparseArrays) {
  test(`stableStringify rejects ${name}`, () => rejectsEverywhere(create()));
}

test('stableStringify does not use inherited data or getters to fill holes', () => {
  let calls = 0;
  for (const descriptor of [
    { value: 1 }, { get() { calls++; throw new Error('inherited index sentinel'); } },
  ]) {
    const prototype = Object.defineProperty(Object.create(Array.prototype), '0', descriptor);
    rejectsEverywhere(Object.setPrototypeOf(new Array(1), prototype));
  }
  assert.equal(calls, 0);
});

test('stableStringify includes hidden own data indices and reads intrinsic length separately', () => {
  const array = Object.defineProperty([1, 2], '0', { enumerable: false, writable: false });
  Object.defineProperty(array, 'length', { writable: false });
  assert.equal(stableStringify(array), '[1,2]');
  assert.equal(stableStringify({ array }), '{"array":[1,2]}');
});

for (const name of ['valid data', 'undefined', 'getter', 'self-reference']) {
  test(`stableStringify rejects enumerable array metadata containing ${name}`, () => {
    const array = [1];
    let calls = 0;
    const descriptor = name === 'getter'
      ? { get() { calls++; throw new Error('metadata getter sentinel'); } }
      : { value: name === 'valid data' ? 2 : name === 'self-reference' ? array : undefined };
    Object.defineProperty(array, 'note', { ...descriptor, enumerable: true });
    rejectsEverywhere(array);
    assert.equal(calls, 0);
  });
}

for (const key of ['00', '-0', '1e0', '4294967295', '01', '-1', '1.0']) {
  test(`stableStringify treats array property ${key} as metadata`, () => {
    rejectsEverywhere(Object.assign([1, 2], { [key]: 3 }));
  });
}

for (const name of ['valid getter', 'throwing getter', 'setter only', 'undefined get/set']) {
  test(`stableStringify rejects ${name} descriptors without executing accessors`, () => {
    let calls = 0;
    const descriptor = name === 'valid getter' ? { get() { calls++; return 1; } }
      : name === 'throwing getter' ? { get() { calls++; throw new Error('getter sentinel'); } }
      : name === 'setter only' ? { set(value) { calls++; } }
      : { get: undefined, set: undefined };
    rejectsEverywhere(Object.defineProperty({}, 'member', { ...descriptor, enumerable: true }));
    for (const enumerable of [false, true]) {
      rejectsEverywhere(Object.defineProperty([1], '0', { ...descriptor, enumerable }));
    }
    assert.equal(calls, 0);
  });
}

for (const name of ['undefined', 'function', 'self-reference', 'getter', 'setter only']) {
  test(`stableStringify ignores hidden and symbol metadata containing ${name}`, () => {
    let calls = 0;
    for (const array of [false, true]) {
      for (const [key, enumerable] of [['hidden', false], [Symbol('hidden'), false], [Symbol('visible'), true]]) {
        const value = array ? [1] : { a: 1 };
        const descriptor = name === 'getter'
          ? { get() { calls++; throw new Error('ignored getter sentinel'); } }
          : name === 'setter only' ? { set(value) { calls++; } }
          : { value: name === 'self-reference' ? value : name === 'function' ? () => { calls++; } : undefined };
        Object.defineProperty(value, key, { ...descriptor, enumerable });
        assert.equal(stableStringify(value), array ? '[1]' : '{"a":1}');
      }
    }
    assert.equal(calls, 0);
  });
}

for (const key of ['constructor', 'toJSON', 'toString', 'valueOf', Symbol.toPrimitive, Symbol.toStringTag, Symbol.iterator]) {
  test(`stableStringify does not read or call ignored ${String(key)} hooks`, () => {
    let calls = 0;
    const hook = () => { calls++; throw new Error('hook sentinel'); };
    for (const descriptor of [{ value: hook }, { get: hook }]) {
      for (const value of [{ a: 1 }, [1]]) {
        Object.defineProperty(value, key, descriptor);
        assert.equal(stableStringify(value), Array.isArray(value) ? '[1]' : '{"a":1}');
      }
    }
    assert.equal(calls, 0);
  });
}

test('stableStringify never consults an array constructor or its species', () => {
  let calls = 0;
  for (const descriptor of [
    { value: function () { calls++; throw new Error('species constructor sentinel'); } },
    { get() { calls++; throw new Error('species getter sentinel'); } },
  ]) {
    const constructor = Object.defineProperty({}, Symbol.species, descriptor);
    const array = Object.defineProperty([1, 2], 'constructor', { value: constructor });
    assert.equal(stableStringify(array), '[1,2]');
  }
  assert.equal(calls, 0);
});

test('stableStringify ignores inherited toJSON even on Object.prototype and Array.prototype', () => {
  let calls = 0;
  const hook = () => { calls++; throw new Error('inherited toJSON sentinel'); };
  for (const prototype of [Object.prototype, Array.prototype]) {
    const original = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
    try {
      for (const descriptor of [{ value: hook }, { get: hook }]) {
        Object.defineProperty(prototype, 'toJSON', { ...descriptor, configurable: true });
        assert.equal(stableStringify({ b: [{ a: 1 }], a: [2, 1] }), '{"a":[2,1],"b":[{"a":1}]}');
      }
    } finally {
      if (original) Object.defineProperty(prototype, 'toJSON', original);
      else delete prototype.toJSON;
    }
  }
  assert.equal(calls, 0);
});

test('stableStringify treats own enumerable toJSON as ordinary data', () => {
  let calls = 0;
  const hook = () => { calls++; throw new Error('toJSON sentinel'); };
  rejectsEverywhere({ toJSON: hook });
  rejectsEverywhere(Object.defineProperty({}, 'toJSON', { get: hook, enumerable: true }));
  assert.equal(stableStringify({ toJSON: 'literal' }), '{"toJSON":"literal"}');
  assert.equal(calls, 0);
});

test('stableStringify does not coerce invalid inputs when reporting errors', () => {
  let calls = 0;
  for (const key of ['toString', 'valueOf', Symbol.toPrimitive, Symbol.toStringTag, 'constructor']) {
    const hook = () => { calls++; throw new Error('coercion sentinel'); };
    for (const descriptor of [{ value: hook }, { get: hook }]) {
      rejectsEverywhere(Object.defineProperty(new (class Invalid {})(), key, descriptor));
    }
  }
  assert.equal(calls, 0);
});

test('stableStringify preserves special property names as literal keys on both object prototypes', () => {
  const source = JSON.parse('{"toString":6,"toJSON":5,"prototype":4,"hasOwnProperty":3,"constructor":2,"__proto__":1}');
  const expected = '{"__proto__":1,"constructor":2,"hasOwnProperty":3,"prototype":4,"toJSON":5,"toString":6}';
  assert.equal(stableStringify(source), expected);
  assert.equal(stableStringify(Object.assign(Object.create(null), source)), expected);
});

test('stableStringify serializes shared references separately, including a diamond graph', () => {
  const child = { b: 2, a: 1 };
  assert.equal(stableStringify({ right: child, left: child }), '{"left":{"a":1,"b":2},"right":{"a":1,"b":2}}');
  assert.equal(stableStringify([child, child]), '[{"a":1,"b":2},{"a":1,"b":2}]');
  const left = { child };
  const right = [child];
  assert.equal(stableStringify({ right, left }), '{"left":{"child":{"a":1,"b":2}},"right":[{"a":1,"b":2}]}');
});

test('stableStringify rejects ancestor cycles and retains no cross-call state', () => {
  const object = {};
  object.self = object;
  const array = [];
  array.push(array);
  const mixed = { children: [{}] };
  mixed.children[0].parent = mixed;
  for (const value of [object, array, mixed]) {
    rejectsEverywhere(value);
    assert.equal(stableStringify({ a: [1] }), '{"a":[1]}');
  }
  delete object.self;
  object.a = 1;
  assert.equal(stableStringify(object), '{"a":1}');
  object.a = 2;
  assert.equal(stableStringify(object), '{"a":2}');
});

function snapshot(value) {
  return {
    value, keys: Reflect.ownKeys(value), descriptors: Object.getOwnPropertyDescriptors(value),
    prototype: Object.getPrototypeOf(value), extensible: Object.isExtensible(value),
  };
}

function assertUnchanged(before) {
  for (const state of before) {
    assert.deepEqual(Reflect.ownKeys(state.value), state.keys);
    assert.equal(Object.getPrototypeOf(state.value), state.prototype);
    assert.equal(Object.isExtensible(state.value), state.extensible);
    for (const key of state.keys) {
      const descriptor = Object.getOwnPropertyDescriptor(state.value, key);
      const expected = state.descriptors[key];
      assert.deepEqual(Object.keys(descriptor), Object.keys(expected));
      for (const field of Object.keys(expected)) assert.equal(descriptor[field], expected[field]);
    }
  }
}

for (const mode of ['mutable', 'sealed', 'frozen']) {
  test(`stableStringify preserves ${mode} inputs, descriptors, sharing and negative zero`, () => {
    const child = Object.assign(Object.create(null), { z: -0, a: 1 });
    const array = [child, child, -0];
    Object.defineProperty(array, '2', { enumerable: false, writable: false });
    const root = { z: -0, child, array };
    Object.defineProperty(root, 'readonly', { value: 2, enumerable: true });
    const containers = [root, child, array];
    for (const value of containers) {
      if (mode === 'sealed') Object.seal(value);
      if (mode === 'frozen') Object.freeze(value);
    }
    const before = containers.map(snapshot);
    assert.equal(stableStringify(root), '{"array":[{"a":1,"z":0},{"a":1,"z":0},0],"child":{"a":1,"z":0},"readonly":2,"z":0}');
    assertUnchanged(before);
    assert.ok(Object.is(root.z, -0));
    assert.ok(Object.is(child.z, -0));
    assert.ok(Object.is(array[2], -0));
  });
}

test('stableStringify leaves input ownership unchanged on rejection', () => {
  for (const failure of ['unsupported', 'hole', 'cycle', 'accessor']) {
    const child = { z: -0, a: 1 };
    const array = [child, child];
    const root = { array, child };
    if (failure === 'unsupported') root.z = undefined;
    if (failure === 'hole') array.length = 3;
    if (failure === 'cycle') root.z = root;
    if (failure === 'accessor') Object.defineProperty(root, 'z', {
      enumerable: true, get() { throw new Error('ownership getter sentinel'); },
    });
    const before = [root, child, array].map(snapshot);
    assert.throws(() => stableStringify(root), TypeError);
    assertUnchanged(before);
    assert.ok(Object.is(child.z, -0));
  }
});

test('stableStringify handles deep nesting without recursive call-stack overflow', () => {
  let value = 0;
  for (let i = 0; i < 6_000; i++) value = [{ a: value }];
  assert.equal(stableStringify(value), '[{"a":'.repeat(6_000) + '0' + '}]'.repeat(6_000));
});

test('stableStringify handles moderate width and bounded expanded sharing', () => {
  const values = Array.from({ length: 1_000 }, (_, i) => ({ b: i, a: -0 }));
  assert.equal(stableStringify(values), '[' + values.map((_, i) => `{"a":0,"b":${i}}`).join(',') + ']');
  let shared = { a: 1 };
  let expected = '{"a":1}';
  for (let i = 0; i < 10; i++) {
    shared = [shared, shared];
    expected = `[${expected},${expected}]`;
  }
  assert.equal(stableStringify(shared), expected);
});
