import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk } from '../lib/chunk.mjs';

const partitions = [
  ['partial final chunk', [1, 2, 3, 4, 5], 2, [[1, 2], [3, 4], [5]]],
  ['exact division', [1, 2, 3, 4], 2, [[1, 2], [3, 4]]],
  ['size one', [1, 2], 1, [[1], [2]]],
  ['size equals length', [1, 2], 2, [[1, 2]]],
  ['size exceeds length', [1, 2], 3, [[1, 2]]],
  ['largest safe size', [1, 2], Number.MAX_SAFE_INTEGER, [[1, 2]]],
  ['single element', [1], 2, [[1]]],
  ['empty input', [], 1, []],
  ['empty input with largest safe size', [], Number.MAX_SAFE_INTEGER, []],
];

for (const [name, items, size, expected] of partitions) {
  test(`chunk: ${name}`, () => {
    const before = items.slice();
    const result = chunk(items, size);
    const again = chunk(items, size);

    assert.deepEqual(result, expected);
    assert.deepEqual(again, expected);
    assert.deepEqual(items, before);
    assert.notStrictEqual(result, items);
    assert.notStrictEqual(result, again);
    assert.equal(result.length, Math.ceil(items.length / size));
    assert.equal(result.reduce((total, part) => total + part.length, 0), items.length);
    assert.equal(new Set(result).size, result.length);
    for (let index = 0; index < result.length; index += 1) {
      assert.notStrictEqual(result[index], items);
      assert.notStrictEqual(result[index], again[index]);
      assert.ok(result[index].length > 0 && result[index].length <= size);
      if (index < result.length - 1) assert.equal(result[index].length, size);
    }
  });
}

test('chunk preserves element identity without modifying or freezing caller data', () => {
  const object = { value: 1 };
  const nested = ['nested'];
  const items = [object, nested, object, nested];
  const originals = [items, object, nested];
  const descriptors = originals.map(value => Object.getOwnPropertyDescriptors(value));

  const result = chunk(items, 2);

  for (let index = 0; index < originals.length; index += 1) {
    assert.deepEqual(Object.getOwnPropertyDescriptors(originals[index]), descriptors[index]);
    assert.equal(Object.isExtensible(originals[index]), true);
  }
  assert.strictEqual(result[0][0], object);
  assert.strictEqual(result[0][1], nested);
  assert.strictEqual(result[1][0], object);
  assert.strictEqual(result[1][1], nested);
  assert.notStrictEqual(result[0], result[1]);

  result[0][0] = 'replacement';
  result[0].push('extra');
  assert.deepEqual(items, [object, nested, object, nested]);
  assert.deepEqual(result[1], [object, nested]);
  object.value = 2;
  nested.push('shared');
  assert.equal(result[1][0].value, 2);
  assert.deepEqual(result[0][1], ['nested', 'shared']);
  items[1] = 'source replacement';
  assert.strictEqual(result[0][1], nested);
});

test('chunk preserves object references in equal-size and oversized copies', () => {
  const object = { value: 1 };
  const nested = [object];
  const items = [object, nested];
  for (const size of [2, 3, Number.MAX_SAFE_INTEGER]) {
    const [part] = chunk(items, size);
    assert.notStrictEqual(part, items);
    assert.strictEqual(part[0], object);
    assert.strictEqual(part[1], nested);
    part[0] = 'replacement';
    assert.strictEqual(items[0], object);
  }
});

test('chunk accepts frozen input and elements', () => {
  const object = Object.freeze({ value: 1 });
  const nested = Object.freeze([object]);
  const items = Object.freeze([object, nested, object]);
  const result = chunk(items, 2);

  assert.deepEqual(result, [[object, nested], [object]]);
  assert.strictEqual(result[0][0], object);
  assert.strictEqual(result[0][1], nested);
  assert.strictEqual(result[1][0], object);
  assert.deepEqual(items, [object, nested, object]);
  assert.deepEqual(object, { value: 1 });
  assert.deepEqual(nested, [object]);
});

test('chunk retains sparse positions and distinguishes holes from explicit undefined', () => {
  const items = [, 'a', undefined, , 'b'];
  const before = Object.getOwnPropertyDescriptors(items);
  const result = chunk(items, 2);

  assert.deepEqual(result, [[, 'a'], [undefined, ,], ['b']]);
  assert.deepEqual(result.map(part => part.length), [2, 2, 1]);
  assert.equal(Object.hasOwn(result[0], 0), false);
  assert.equal(Object.hasOwn(result[0], 1), true);
  assert.equal(Object.hasOwn(result[1], 0), true);
  assert.equal(Object.hasOwn(result[1], 1), false);
  assert.equal(Object.hasOwn(result[2], 0), true);
  assert.deepEqual(Object.getOwnPropertyDescriptors(items), before);
});

test('chunk retains all-hole chunks, including the partial tail', () => {
  const items = Object.freeze(new Array(3));
  const result = chunk(items, 2);

  assert.deepEqual(result, [new Array(2), new Array(1)]);
  assert.deepEqual(result.map(part => part.length), [2, 1]);
  assert.notStrictEqual(result[0], result[1]);
  for (const part of result) {
    for (let index = 0; index < part.length; index += 1) {
      assert.equal(Object.hasOwn(part, index), false);
    }
  }
  assert.deepEqual(items, new Array(3));
});

test('chunk returns ordinary arrays when an Array subclass specifies Object species', () => {
  class Items extends Array {
    static get [Symbol.species]() { return Object; }
  }
  const items = new Items(1, 2);
  const before = Object.getOwnPropertyDescriptors(items);

  for (const size of [1, 2, Number.MAX_SAFE_INTEGER]) {
    const result = chunk(items, size);
    assert.deepEqual(result, size === 1 ? [[1], [2]] : [[1, 2]]);
    assert.deepEqual(result.map(part => part.map(value => value * 2)),
      size === 1 ? [[2], [4]] : [[2, 4]]);
    assert.strictEqual(Object.getPrototypeOf(result), Array.prototype);
    for (const part of result) {
      assert.equal(Array.isArray(part), true);
      assert.strictEqual(Object.getPrototypeOf(part), Array.prototype);
      assert.notStrictEqual(part, items);
    }
  }
  assert.deepEqual(Object.getOwnPropertyDescriptors(items), before);
});

test('chunk does not consult input constructor or species hooks', () => {
  class Items extends Array {
    static get [Symbol.species]() { assert.fail('must not read species'); }
  }
  const plain = [1, 2];
  Object.defineProperty(plain, 'constructor', {
    get() { assert.fail('must not read constructor'); },
  });
  for (const items of [new Items(1, 2), plain]) {
    assert.deepEqual(chunk(items, 1), [[1], [2]]);
  }
});

test('chunk preserves holes and inherited indexed values in frozen Array subclasses', () => {
  class Items extends Array {
    static get [Symbol.species]() { return Object; }
  }
  const shared = { value: 1 };
  Items.prototype[4] = shared;
  const items = new Items(5);
  items[1] = 'a';
  items[2] = undefined;
  Object.freeze(items);
  const before = Object.getOwnPropertyDescriptors(items);

  const result = chunk(items, 2);

  assert.deepEqual(result, [[, 'a'], [undefined, ,], [shared]]);
  assert.deepEqual(result.map(part => part.length), [2, 2, 1]);
  assert.equal(Object.hasOwn(result[0], 0), false);
  assert.equal(Object.hasOwn(result[1], 0), true);
  assert.equal(Object.hasOwn(result[1], 1), false);
  assert.equal(Object.hasOwn(items, 4), false);
  assert.equal(Object.hasOwn(result[2], 0), true);
  assert.strictEqual(result[2][0], shared);
  assert.deepEqual(Object.getOwnPropertyDescriptors(items), before);
});

test('chunk rejects non-Array inputs with TypeError', () => {
  for (const items of [null, undefined, 'abc', 3, true, {}, { 0: 'a', length: 1 },
    new Set([1]), new Uint8Array([1]), new ArrayBuffer(1)]) {
    assert.throws(() => chunk(items, 2), TypeError);
  }
});

test('chunk rejects non-number sizes without coercion, including for empty input', () => {
  const sizes = [undefined, null, '2', true, false, 2n, Symbol('size'),
    new Number(2), [], [2], {}, () => 2,
    { valueOf() { assert.fail('size must not be coerced'); } }];
  for (const items of [[], [1, 2]]) {
    for (const size of sizes) assert.throws(() => chunk(items, size), TypeError);
    assert.throws(() => chunk(items), TypeError);
  }
});

const invalidSizes = [
  ['zero', 0], ['negative zero', -0], ['negative integer', -1],
  ['fraction', 1.5], ['tiny fraction', Number.MIN_VALUE], ['NaN', NaN],
  ['positive infinity', Infinity], ['negative infinity', -Infinity],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
];

for (const [name, size] of invalidSizes) {
  test(`chunk rejects ${name} with RangeError, including for empty input`, () => {
    for (const items of [[], [1, 2]]) {
      assert.throws(() => chunk(items, size), RangeError);
    }
  });
}
