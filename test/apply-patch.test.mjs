import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch } from '../lib/apply-patch.mjs';

function freeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) freeze(value[key]);
  }
  return value;
}

function fails(document, operations, ErrorType, operationIndex, name = ErrorType.name) {
  assert.throws(() => applyPatch(document, operations), error => {
    assert.ok(error instanceof ErrorType);
    assert.equal(error.name, name);
    assert.equal(error.operationIndex, operationIndex);
    return true;
  });
}

test('composes all six operations, retaining frozen inputs and their references', () => {
  const rows = ['a', 'b', 'c', 'd'];
  const document = freeze({ rows });
  const operations = freeze([
    { op: 'test', path: '/rows/0', value: 'a' },
    { op: 'add', path: '/rows/1', value: 'x' },
    { op: 'replace', path: '/rows/2', value: 'B' },
    { op: 'copy', from: '/rows/0', path: '/saved' },
    { op: 'move', from: '/rows/1', path: '/rows/4' },
    { op: 'remove', path: '/rows/3' },
  ]);
  const operationReferences = [...operations];
  const before = JSON.stringify({ document, operations });
  const result = applyPatch(document, operations);
  assert.deepEqual(result, { rows: ['a', 'B', 'c', 'x'], saved: 'a' });
  assert.equal(JSON.stringify({ document, operations }), before);
  assert.equal(document.rows, rows);
  operations.forEach((operation, i) => assert.equal(operation, operationReferences[i]));
  assert.notEqual(result, document);
  assert.notEqual(result.rows, rows);
  result.rows.push('independent');
  assert.deepEqual(rows, ['a', 'b', 'c', 'd']);
});

test('later operations see newly created parents and changed positions', () => {
  assert.deepEqual(applyPatch({}, [
    { op: 'add', path: '/rows', value: [] },
    { op: 'add', path: '/rows/-', value: { n: 1 } },
    { op: 'add', path: '/rows/0', value: { n: 2 } },
    { op: 'replace', path: '/rows/1/n', value: 3 },
    { op: 'remove', path: '/rows/0' },
    { op: 'test', path: '/rows/0/n', value: 3 },
  ]), { rows: [{ n: 3 }] });
});

test('success deeply isolates payloads, original branches, and repeated references', () => {
  const shared = { nested: [1] };
  const document = { left: shared, right: shared };
  const payload = { nested: [2] };
  const operations = [
    { op: 'add', path: '/added', value: payload },
    { op: 'replace', path: '/right', value: payload },
    { op: 'replace', path: '/added/nested/0', value: 3 },
  ];
  const result = applyPatch(document, operations);
  assert.deepEqual(result, { left: { nested: [1] }, right: { nested: [2] }, added: { nested: [3] } });
  result.left.nested.push(4);
  result.right.nested[0] = 5;
  assert.deepEqual(shared, { nested: [1] });
  assert.deepEqual(payload, { nested: [2] });
  assert.equal(document.left, shared);
  assert.equal(document.right, shared);
  assert.equal(operations[0].value, payload);
  assert.equal(operations[1].value, payload);
  assert.notEqual(result.added, result.right);
  assert.notEqual(result.left, shared);
});

test('late failure after source removal discards all internal changes', () => {
  const first = { n: 1 };
  const rows = [first];
  const document = { rows };
  const payload = { n: 7 };
  const operations = [
    { op: 'add', path: '/rows/0', value: payload },
    { op: 'replace', path: '/rows/0/n', value: 2 },
    { op: 'move', from: '/rows/1', path: '/missing/slot' },
  ];
  const before = JSON.stringify({ document, operations });
  fails(document, operations, RangeError, 2);
  assert.equal(JSON.stringify({ document, operations }), before);
  assert.equal(document.rows, rows);
  assert.equal(rows[0], first);
  assert.equal(operations[0].value, payload);
  assert.equal(payload.n, 7);
});

test('late unequal test reports its index and preserves inputs', () => {
  const document = { nested: { n: 1 } };
  const nested = document.nested;
  fails(document, [
    { op: 'replace', path: '/nested/n', value: 2 },
    { op: 'test', path: '/nested/n', value: 1 },
  ], Error, 1, 'PatchTestError');
  assert.deepEqual(document, { nested: { n: 1 } });
  assert.equal(document.nested, nested);
});

test('empty operations clone every occurrence of a shared reference independently', () => {
  const shared = { array: [{ value: -0 }] };
  const document = freeze({ a: shared, b: shared });
  const output = applyPatch(document, freeze([]));
  assert.deepEqual(output, document);
  assert.notEqual(output.a, output.b);
  assert.notEqual(output.a.array, output.b.array);
  assert.notEqual(output.a.array[0], output.b.array[0]);
  output.a.array[0].value = 3;
  assert.ok(Object.is(output.b.array[0].value, -0));
  assert.ok(Object.is(shared.array[0].value, -0));
});

for (const value of [null, false, true, 0, -0, 0.125, Number.MAX_VALUE, '', 'hello']) {
  test(`accepts scalar JSON root ${String(value)}`, () => {
    assert.ok(Object.is(applyPatch(value, []), value));
    assert.ok(Object.is(applyPatch(value, [{ op: 'test', path: '', value }]), value));
  });
}

for (const op of ['add', 'replace']) {
  test(`${op} replaces the root with an independent payload`, () => {
    const payload = freeze({ items: [{ n: 1 }] });
    const result = applyPatch(null, [{ op, path: '', value: payload }]);
    assert.deepEqual(result, payload);
    assert.notEqual(result, payload);
    assert.notEqual(result.items, payload.items);
    result.items[0].n = 2;
    assert.equal(payload.items[0].n, 1);
    assert.equal(applyPatch({ previous: true }, [{ op, path: '', value: 42 }]), 42);
  });
}

test('root removal is forbidden and a nonroot move to root is allowed', () => {
  fails({ n: 1 }, [{ op: 'remove', path: '' }], RangeError, 0);
  assert.equal(applyPatch({ n: 1 }, [{ op: 'move', from: '/n', path: '' }]), 1);
  assert.deepEqual(applyPatch({ n: [1] }, [{ op: 'move', from: '/n', path: '' }]), [1]);
  fails({ n: 1 }, [{ op: 'move', from: '', path: '/n' }], RangeError, 0);
});

for (const [document, path] of [[{ x: { n: 1 } }, '/x'], [[1], '/0'], [{ x: 1 }, '']]) {
  test(`same-path move ${path || 'root'} proves existence and returns an independent clone`, () => {
    const result = applyPatch(document, [{ op: 'move', from: path, path }]);
    assert.deepEqual(result, document);
    assert.notEqual(result, document);
  });
}

test('same-path moves still reject missing sources and malformed pointers', () => {
  fails({}, [{ op: 'move', from: '/x', path: '/x' }], RangeError, 0);
  fails([], [{ op: 'move', from: '/0', path: '/0' }], RangeError, 0);
  fails({}, [{ op: 'move', from: 'x', path: 'x' }], SyntaxError, 0);
  fails({}, [{ op: 'move', from: '/~2', path: '/~2' }], SyntaxError, 0);
});

test('move ancestry compares decoded tokens, not raw pointer prefixes', () => {
  fails({ 'a/b': { v: 1 } }, [{ op: 'move', from: '/a~1b', path: '/a~1b/child' }], RangeError, 0);
  fails({ 'a~1': { v: 1 } }, [{ op: 'move', from: '/a~01', path: '/a~01/v/child' }], RangeError, 0);
  assert.deepEqual(applyPatch({ a: 1, 'a/b': {} }, [
    { op: 'move', from: '/a', path: '/a~1b/child' },
  ]), { 'a/b': { child: 1 } });
  assert.deepEqual(applyPatch({ a: 1, ab: {} }, [
    { op: 'move', from: '/a', path: '/ab/child' },
  ]), { ab: { child: 1 } });
});

test('copying root into its descendant captures a finite, independent snapshot', () => {
  const document = { n: 1, nested: { values: [1] } };
  const result = applyPatch(document, [
    { op: 'copy', from: '', path: '/snapshot' },
    { op: 'replace', path: '/snapshot/n', value: 2 },
    { op: 'replace', path: '/n', value: 3 },
    { op: 'add', path: '/snapshot/nested/values/-', value: 2 },
  ]);
  assert.deepEqual(result, {
    n: 3, nested: { values: [1] }, snapshot: { n: 2, nested: { values: [1, 2] } },
  });
  assert.equal(Object.hasOwn(result.snapshot, 'snapshot'), false);
  assert.notEqual(result.snapshot.nested, result.nested);
  assert.notEqual(result.snapshot.nested.values, result.nested.values);
  assert.deepEqual(document, { n: 1, nested: { values: [1] } });
});

test('copy to root and between branches copies every nested value', () => {
  const document = { source: { values: [1] } };
  const rootCopy = applyPatch(document, [{ op: 'copy', from: '/source', path: '' }]);
  assert.deepEqual(rootCopy, { values: [1] });
  assert.notEqual(rootCopy.values, document.source.values);
  const result = applyPatch(document, [{ op: 'copy', from: '/source', path: '/copy' }]);
  result.copy.values.push(2);
  assert.deepEqual(result.source.values, [1]);
  assert.deepEqual(document.source.values, [1]);
  assert.deepEqual(applyPatch([1], [{ op: 'copy', from: '', path: '/-' }]), [1, [1]]);
});

test('Array add inserts, replace overwrites, remove shifts, and append accepts length or dash', () => {
  assert.deepEqual(applyPatch(['a', 'b'], [
    { op: 'add', path: '/0', value: 'first' },
    { op: 'add', path: '/3', value: 'end' },
    { op: 'add', path: '/-', value: 'last' },
    { op: 'replace', path: '/2', value: 'B' },
    { op: 'remove', path: '/1' },
  ]), ['first', 'B', 'end', 'last']);
  assert.deepEqual(applyPatch([], [{ op: 'add', path: '/0', value: null }]), [null]);
  fails([], [{ op: 'add', path: '/1', value: null }], RangeError, 0);
});

test('move uses post-removal indices, including the new length', () => {
  const document = ['a', 'b', 'c', 'd'];
  assert.deepEqual(applyPatch(document, [{ op: 'move', from: '/1', path: '/3' }]), ['a', 'c', 'd', 'b']);
  fails(document, [{ op: 'move', from: '/1', path: '/4' }], RangeError, 0);
  assert.deepEqual(document, ['a', 'b', 'c', 'd']);
  // Exhaust all same-array moves through length eight with a separate sequence oracle.
  for (let length = 1; length <= 8; length++) {
    const input = Array.from({ length }, (_, i) => i);
    for (let from = 0; from < length; from++) {
      for (let to = 0; to < length; to++) {
        const remaining = input.filter((_, i) => i !== from);
        const expected = [...remaining.slice(0, to), from, ...remaining.slice(to)];
        assert.deepEqual(applyPatch(input, [{ op: 'move', from: `/${from}`, path: `/${to}` }]), expected);
        assert.deepEqual(input, Array.from({ length }, (_, i) => i));
      }
    }
  }
});

for (const op of ['copy', 'move']) {
  test(`${op} destination supports dash and numeric end insertion`, () => {
    const result = op === 'copy' ? [1, 2, 1] : [2, 1];
    for (const path of ['/-', op === 'copy' ? '/2' : '/1']) {
      assert.deepEqual(applyPatch([1, 2], [{ op, from: '/0', path }]), result);
    }
    fails([1], [{ op, from: '/-', path: '/0' }], RangeError, 0);
    fails([[1]], [{ op, from: '/-/0', path: '/0' }], RangeError, 0);
    fails([[1]], [{ op, from: '/0/0', path: '/-/0' }], RangeError, 0);
    fails({}, [{ op, from: '/missing', path: '/copy' }], RangeError, 0);
  });
}

for (const token of ['00', '01', '+1', '-1', '1.0', ' ', ' 0', '1e0', '9007199254740992', '999999999999999999999']) {
  test(`rejects Array index ${JSON.stringify(token)} but accepts it as an object key`, () => {
    for (const op of ['add', 'replace', 'test']) {
      fails([0, 1], [{ op, path: `/${token}`, value: 2 }], RangeError, 0);
    }
    fails([0, 1], [{ op: 'remove', path: `/${token}` }], RangeError, 0);
    fails([0, 1], [{ op: 'copy', from: `/${token}`, path: '/-' }], RangeError, 0);
    fails([[0]], [{ op: 'add', path: `/${token}/0`, value: 1 }], RangeError, 0);
    assert.deepEqual(applyPatch({}, [{ op: 'add', path: `/${token}`, value: 1 }]), { [token]: 1 });
  });
}

test('dash is legal on objects but not for Array lookup or intermediate traversal', () => {
  assert.deepEqual(applyPatch({ '-': { '-': 1 } }, [
    { op: 'test', path: '/-/-', value: 1 },
    { op: 'replace', path: '/-/-', value: 2 },
    { op: 'copy', from: '/-/-', path: '/copy' },
    { op: 'remove', path: '/-' },
  ]), { copy: 2 });
  for (const op of ['replace', 'test']) fails([1], [{ op, path: '/-', value: 1 }], RangeError, 0);
  fails([1], [{ op: 'remove', path: '/-' }], RangeError, 0);
  fails([{}], [{ op: 'add', path: '/-/x', value: 1 }], RangeError, 0);
});

test('pointer tokens preserve empty names, percent sequences, dots and brackets', () => {
  const document = { '': { '': 0 }, 'a/b': 1, 'a~1': 2, '%2F': 3, 'a.b[0]': 4, '~': 5 };
  assert.deepEqual(applyPatch(document, [
    { op: 'replace', path: '//', value: 10 },
    { op: 'test', path: '/a~1b', value: 1 },
    { op: 'test', path: '/a~01', value: 2 },
    { op: 'test', path: '/%2F', value: 3 },
    { op: 'test', path: '/a.b[0]', value: 4 },
    { op: 'test', path: '/~0', value: 5 },
    { op: 'copy', from: '/', path: '/empty' },
  ]), { ...document, '': { '': 10 }, empty: { '': 10 } });
  assert.deepEqual(document[''], { '': 0 });
  fails({ '/': 1 }, [{ op: 'replace', path: '/%2F', value: 2 }], RangeError, 0);
});

for (const path of ['x', 'x.y', '[0]', '/~', '/~2', '/a~x', '/~00~', '/ok/~10~2']) {
  test(`rejects malformed path and from ${JSON.stringify(path)} with SyntaxError and index`, () => {
    fails({}, [{ op: 'add', path: '/valid', value: 1 }, { op: 'add', path, value: 1 }], SyntaxError, 1);
    for (const op of ['copy', 'move']) fails({}, [{ op, from: path, path: '/valid' }], SyntaxError, 0);
  });
}

test('test equality ignores object order and prototypes, but preserves JSON distinctions', () => {
  const expected = Object.assign(Object.create(null), { b: [2, 3], a: { x: 1 } });
  const input = { a: { x: 1 }, b: [2, 3] };
  assert.deepEqual(applyPatch(input, [{ op: 'test', path: '', value: expected }]), input);
  assert.ok(Object.is(applyPatch(-0, [{ op: 'test', path: '', value: 0 }]), -0));
  assert.equal(applyPatch(0, [{ op: 'test', path: '', value: -0 }]), 0);
  for (const [document, value] of [
    [[1, 2], [2, 1]], [[1], [1, 2]], [[1], { 0: 1 }], [1, '1'], [false, 0],
    [null, {}], [{ a: null }, {}], [{ a: 1 }, { b: 1 }], [{ a: { b: 1 } }, { a: { b: 2 } }],
  ]) fails(document, [{ op: 'test', path: '', value }], Error, 0, 'PatchTestError');
});

test('test missing-final precedence is distinct from invalid traversal or index syntax', () => {
  for (const [document, path] of [[{}, '/x'], [[], '/0'], [[null], '/1'], [[], '/9007199254740991']]) {
    fails(document, [{ op: 'test', path, value: null }], Error, 0, 'PatchTestError');
  }
  assert.deepEqual(applyPatch({ x: null }, [{ op: 'test', path: '/x', value: null }]), { x: null });
  for (const [document, path] of [
    [{}, '/missing/child'], [{ x: null }, '/x/child'], [{ x: 1 }, '/x/child'],
    [[], '/0/child'], [[], '/00'], [[], '/9007199254740992'], [null, '/x'],
  ]) fails(document, [{ op: 'test', path, value: null }], RangeError, 0);
});

test('non-test missing targets, missing parents and scalar parents are RangeErrors', () => {
  for (const op of ['remove', 'replace']) {
    for (const [document, path] of [[{}, '/x'], [[1], '/1'], [[], '/0']]) {
      const operation = op === 'replace' ? { op, path, value: 1 } : { op, path };
      fails(document, [operation], RangeError, 0);
    }
  }
  for (const document of [{}, { parent: null }, { parent: false }, { parent: 1 }, { parent: 'x' }]) {
    fails(document, [{ op: 'add', path: '/parent/child', value: 1 }], RangeError, 0);
  }
});

test('prototype-like own keys are ordinary data for add, replace, copy and move', () => {
  const document = JSON.parse('{"__proto__":{"old":1},"constructor":{"prototype":2}}');
  const prototype = Object.getPrototypeOf(document);
  const result = applyPatch(document, [
    { op: 'replace', path: '/__proto__/old', value: 3 },
    { op: 'add', path: '/prototype', value: { marker: 4 } },
    { op: 'copy', from: '/prototype', path: '/__proto__/copy' },
    { op: 'move', from: '/constructor/prototype', path: '/hasOwnProperty' },
    { op: 'copy', from: '/__proto__', path: '/constructor' },
    { op: 'add', path: '/toString', value: 5 },
  ]);
  assert.deepEqual(result, JSON.parse('{"__proto__":{"old":3,"copy":{"marker":4}},"constructor":{"old":3,"copy":{"marker":4}},"prototype":{"marker":4},"hasOwnProperty":2,"toString":5}'));
  for (const key of ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString']) {
    assert.equal(Object.hasOwn(result, key), true);
    assert.equal(Object.getOwnPropertyDescriptor(result, key).enumerable, true);
  }
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.getPrototypeOf(document), prototype);
  assert.equal(Object.hasOwn(Object.prototype, 'marker'), false);
  assert.deepEqual(document, JSON.parse('{"__proto__":{"old":1},"constructor":{"prototype":2}}'));
  const inserted = applyPatch({}, [{ op: 'add', path: '/__proto__', value: { safe: true } }]);
  assert.equal(Object.hasOwn(inserted, '__proto__'), true);
  assert.deepEqual(inserted.__proto__, { safe: true });
  assert.equal(Object.getPrototypeOf(inserted), Object.prototype);
});

for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
  test(`never looks up inherited ${key}`, () => {
    fails({}, [{ op: 'remove', path: `/${key}` }], RangeError, 0);
    fails({}, [{ op: 'replace', path: `/${key}`, value: 1 }], RangeError, 0);
    fails({}, [{ op: 'copy', from: `/${key}`, path: '/copy' }], RangeError, 0);
    fails({}, [{ op: 'add', path: `/${key}/child`, value: 1 }], RangeError, 0);
    fails({}, [{ op: 'test', path: `/${key}`, value: null }], Error, 0, 'PatchTestError');
  });
}

const invalidValues = [
  ['undefined', () => undefined], ['function', () => () => {}], ['symbol', () => Symbol('x')],
  ['bigint', () => 1n], ['NaN', () => NaN], ['infinity', () => Infinity], ['negative infinity', () => -Infinity],
  ['Date', () => new Date(0)], ['Map', () => new Map()], ['Set', () => new Set()],
  ['boxed number', () => new Number(1)], ['class instance', () => new (class Value {})()],
  ['custom prototype', () => Object.create({})], ['sparse Array', () => new Array(1)],
  ['extra Array property', () => Object.assign([1], { extra: true })],
  ['Array symbol', () => Object.assign([1], { [Symbol('x')]: 1 })],
  ['hidden Array extra', () => Object.defineProperty([1], 'extra', { value: 1 })],
  ['hidden object property', () => Object.defineProperty({}, 'x', { value: 1 })],
  ['symbol object property', () => ({ [Symbol('x')]: 1 })],
  ['self cycle', () => { const value = {}; value.self = value; return value; }],
  ['mutual cycle', () => { const a = {}; const b = { a }; a.b = b; return a; }],
  ['Array cycle', () => { const value = []; value.push(value); return value; }],
];

for (const [label, make] of invalidValues) {
  test(`rejects ${label} as document and as every kind of value payload`, () => {
    const value = make();
    assert.throws(() => applyPatch(value, []), TypeError);
    assert.throws(() => applyPatch(value, [{ op: 'replace', path: '', value: null }]), TypeError);
    for (const op of ['add', 'replace', 'test']) {
      fails(null, [{ op, path: '', value: { nested: value } }], TypeError, 0);
    }
  });
}

test('rejects object and Array accessors without calling getters or setters', () => {
  let calls = 0;
  for (const descriptor of [
    { get() { calls++; return 1; }, enumerable: true },
    { set(_) { calls++; }, enumerable: true },
    { get() { calls++; return 1; }, enumerable: false },
  ]) {
    for (const value of [Object.defineProperty({}, 'x', descriptor), Object.defineProperty([0], '0', descriptor)]) {
      const before = Object.getOwnPropertyDescriptors(value);
      assert.throws(() => applyPatch(value, []), TypeError);
      fails({}, [{ op: 'add', path: '/x', value }], TypeError, 0);
      assert.deepEqual(Object.getOwnPropertyDescriptors(value), before);
    }
  }
  assert.equal(calls, 0);
});

test('sparse Arrays cannot acquire inherited elements or invoke inherited accessors', () => {
  let calls = 0;
  const prototype = Object.defineProperty(Object.create(Array.prototype), '0', {
    get() { calls++; return { op: 'remove', path: '' }; },
  });
  const sparse = Object.setPrototypeOf(new Array(1), prototype);
  assert.throws(() => applyPatch(sparse, []), TypeError);
  assert.throws(() => applyPatch({}, sparse), TypeError);
  assert.equal(calls, 0);
  assert.equal(Object.hasOwn(sparse, '0'), false);
});

test('preflight validates later payloads before an earlier execution failure', () => {
  let calls = 0;
  const invalid = { get nested() { calls++; return 1; } };
  for (const op of ['add', 'replace', 'test']) {
    const document = { n: 1 };
    fails(document, [
      { op: 'add', path: '/added', value: 2 },
      { op: 'test', path: '/n', value: 99 },
      { op, path: '/neverUsed', value: invalid },
    ], TypeError, 2);
    assert.deepEqual(document, { n: 1 });
  }
  assert.equal(calls, 0);
});

test('accepts null-prototype objects, readonly fields and nonenumerable Array indices', () => {
  const input = Object.create(null);
  Object.defineProperty(input, 'values', { value: [1], enumerable: true });
  Object.defineProperty(input.values, '0', { value: 1, enumerable: false, writable: false });
  freeze(input);
  const operation = Object.assign(Object.create(null), { op: 'add', path: '/next', value: input });
  const operations = [freeze(operation)];
  Object.defineProperty(operations, '0', { enumerable: false, writable: false });
  Object.freeze(operations);
  const result = applyPatch(input, operations);
  assert.deepEqual(result, { values: [1], next: { values: [1] } });
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.getPrototypeOf(result.next), Object.prototype);
  assert.notEqual(result.values, result.next.values);
  assert.equal(Object.getOwnPropertyDescriptor(result.values, '0').enumerable, true);
  assert.equal(Object.getOwnPropertyDescriptor(input.values, '0').enumerable, false);
});

const schemas = [
  { op: 'add', path: '', value: null }, { op: 'replace', path: '', value: null },
  { op: 'test', path: '', value: null }, { op: 'remove', path: '/x' },
  { op: 'copy', from: '', path: '' }, { op: 'move', from: '', path: '' },
];

for (const schema of schemas) {
  test(`${schema.op} requires exactly its own enumerable data fields`, () => {
    for (const key of Object.keys(schema)) {
      const missing = { ...schema };
      delete missing[key];
      fails({}, [missing], TypeError, 0);
      for (const descriptor of [
        { value: schema[key], enumerable: false },
        { get() { assert.fail('operation getter called'); }, enumerable: true },
        { set(_) { assert.fail('operation setter called'); }, enumerable: true },
      ]) {
        fails({}, [Object.defineProperty({ ...schema }, key, descriptor)], TypeError, 0);
      }
    }
    for (const extra of ['unknown', 'constructor', '__proto__', ...['value', 'from'].filter(k => !Object.hasOwn(schema, k))]) {
      fails({}, [{ ...schema, [extra]: null }], TypeError, 0);
    }
    fails({}, [Object.assign({ ...schema }, { [Symbol('extra')]: 1 })], TypeError, 0);
    fails({}, [Object.defineProperty({ ...schema }, 'hidden', { value: 1 })], TypeError, 0);
    fails({}, [Object.create(schema)], TypeError, 0);
  });
}

test('operation parameter types are strict and are never coerced', () => {
  const coercible = { toString() { assert.fail('coercion called'); } };
  for (const value of [undefined, null, 1, true, [], {}, Symbol('x'), coercible]) {
    fails({}, [{ op: value, path: '', value: 1 }], TypeError, 0);
    fails({}, [{ op: 'add', path: value, value: 1 }], TypeError, 0);
    for (const op of ['copy', 'move']) fails({}, [{ op, from: value, path: '' }], TypeError, 0);
  }
  for (const op of ['', 'ADD', 'merge', 'constructor', '__proto__', 'toString']) {
    fails({}, [{ op, path: '', value: 1 }], TypeError, 0);
  }
  for (const operation of [null, undefined, 1, '', false, [], () => {}, new Date(0)]) {
    fails({}, [operation], TypeError, 0);
  }
});

test('outer operations must be a dense Array without accessors or extra own properties', () => {
  const valid = { op: 'test', path: '', value: null };
  const accessor = Object.defineProperty([valid], '0', {
    get() { assert.fail('operation element getter called'); },
  });
  for (const operations of [
    undefined, null, {}, '[]', new Array(1), accessor,
    Object.assign([valid], { extra: 1 }), Object.assign([valid], { [Symbol('x')]: 1 }),
    Object.defineProperty([valid], 'hidden', { value: 1 }),
    Object.assign(new Array(1), { replacementForHole: valid }),
  ]) assert.throws(() => applyPatch(null, operations), TypeError);
});

test('operation-specific schema errors carry an index as well as pointer and execution errors', () => {
  const document = { n: 1 };
  fails(document, [
    { op: 'replace', path: '/n', value: 2 },
    { op: 'unknown', path: '/n' },
  ], TypeError, 1);
  fails(document, [
    { op: 'replace', path: '/n', value: 2 },
    { op: 'remove', path: '/~2' },
  ], SyntaxError, 1);
  fails(document, [
    { op: 'replace', path: '/n', value: 2 },
    { op: 'remove', path: '/absent' },
  ], RangeError, 1);
  assert.deepEqual(document, { n: 1 });
});

test('deep valid JSON is cloned and compared without recursive call-stack limits', () => {
  const input = {};
  const expected = {};
  let a = input;
  let b = expected;
  for (let i = 0; i < 12000; i++) {
    a.child = {};
    b.child = {};
    a = a.child;
    b = b.child;
  }
  a.value = 1;
  b.value = 1;
  let result = applyPatch(input, [{ op: 'test', path: '', value: expected }]);
  let original = input;
  for (let i = 0; i < 12000; i++) {
    assert.notEqual(result, original);
    result = result.child;
    original = original.child;
  }
  assert.deepEqual(result, { value: 1 });
  result.value = 2;
  assert.equal(a.value, 1);
  assert.equal(b.value, 1);
});
