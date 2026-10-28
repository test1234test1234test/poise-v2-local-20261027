import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { paginate } from '../lib/paginate.mjs';

const max = Number.MAX_SAFE_INTEGER;
const boundaries = [
  ['empty source', [], 1, 2, [], 0, 0, false, false],
  ['empty source with maximum arguments', [], max, max, [], 0, 0, false, false],
  ['first page', [1, 2, 3, 4, 5], 1, 2, [1, 2], 5, 3, false, true],
  ['middle page', [1, 2, 3, 4, 5], 2, 2, [3, 4], 5, 3, true, true],
  ['partial last page', [1, 2, 3, 4, 5], 3, 2, [5], 5, 3, true, false],
  ['beyond last page', [1, 2, 3, 4, 5], 4, 2, [], 5, 3, true, false],
  ['maximum page', [1, 2, 3, 4, 5], max, 2, [], 5, 3, true, false],
  ['exact last page', [1, 2, 3, 4], 2, 2, [3, 4], 4, 2, true, false],
  ['size one', [1, 2, 3], 2, 1, [2], 3, 3, true, true],
  ['size equals length', [1, 2], 1, 2, [1, 2], 2, 1, false, false],
  ['size exceeds length', [1, 2], 1, 3, [1, 2], 2, 1, false, false],
  ['maximum size', [1, 2], 1, max, [1, 2], 2, 1, false, false],
  ['maximum page and size', [1, 2], max, max, [], 2, 1, true, false],
  ['single element', [1], 1, 2, [1], 1, 1, false, false],
  ['all-hole first page', new Array(3), 1, 2, new Array(2), 3, 2, false, true],
  ['all-hole last page', new Array(3), 2, 2, new Array(1), 3, 2, true, false],
  ['beyond all-hole pages', new Array(3), 3, 2, [], 3, 2, true, false],
];

for (const [name, source, page, pageSize, items, totalItems, totalPages,
  hasPrevious, hasNext] of boundaries) {
  test(`paginate: ${name}`, () => {
    const before = Object.getOwnPropertyDescriptors(source);
    const expected = { items, page, pageSize, totalItems, totalPages, hasPrevious, hasNext };
    const result = paginate(source, page, pageSize);
    const again = paginate(source, page, pageSize);

    assert.deepEqual(result, expected);
    assert.deepEqual(again, expected);
    assert.notStrictEqual(result.items, source);
    assert.notStrictEqual(again.items, source);
    assert.notStrictEqual(result.items, again.items);
    assert.strictEqual(Object.getPrototypeOf(result.items), Array.prototype);
    assert.strictEqual(Object.getPrototypeOf(again.items), Array.prototype);
    for (let index = 0; index < items.length; index += 1) {
      assert.equal(Object.hasOwn(result.items, index), Object.hasOwn(items, index));
    }
    assert.deepEqual(Object.getOwnPropertyDescriptors(source), before);
    assert.equal(Object.isExtensible(source), true);
  });
}

test('paginate preserves element identity without modifying or freezing caller data', () => {
  const object = { value: 1 };
  const nested = ['nested'];
  const source = [object, nested, object, nested];
  const originals = [source, object, nested];
  const descriptors = originals.map(value => Object.getOwnPropertyDescriptors(value));
  const first = paginate(source, 1, 2).items;
  const second = paginate(source, 2, 2).items;

  for (const size of [source.length, source.length + 1, max]) {
    const result = paginate(source, 1, size).items;
    assert.notStrictEqual(result, source);
    assert.strictEqual(result[0], object);
    assert.strictEqual(result[1], nested);
    result[0] = 'replacement';
    assert.strictEqual(source[0], object);
  }
  paginate(source, max, max);
  for (let index = 0; index < originals.length; index += 1) {
    assert.deepEqual(Object.getOwnPropertyDescriptors(originals[index]), descriptors[index]);
    assert.equal(Object.isExtensible(originals[index]), true);
  }
  assert.strictEqual(first[0], object);
  assert.strictEqual(first[1], nested);
  assert.strictEqual(second[0], object);
  assert.strictEqual(second[1], nested);
  first[0] = 'replacement';
  first.push('extra');
  assert.deepEqual(source, [object, nested, object, nested]);
  assert.deepEqual(second, [object, nested]);
  object.value = 2;
  nested.push('shared');
  assert.equal(second[0].value, 2);
  assert.deepEqual(first[1], ['nested', 'shared']);
  source[1] = 'source replacement';
  assert.strictEqual(first[1], nested);
});

test('paginate accepts frozen sources and elements', () => {
  const object = Object.freeze({ value: 1 });
  const nested = Object.freeze([object]);
  const source = Object.freeze([object, nested]);

  const result = paginate(source, 1, max).items;
  assert.deepEqual(result, [object, nested]);
  assert.strictEqual(result[0], object);
  assert.strictEqual(result[1], nested);
  assert.deepEqual(paginate(source, max, max).items, []);
  assert.deepEqual(paginate(Object.freeze([]), 1, 1).items, []);
});

test('paginate copies non-enumerable own indices, skips inherited getters and preserves trailing holes', () => {
  class Input extends Array {
    static get [Symbol.species]() { assert.fail('must not read species'); }
  }
  let inheritedReads = 0;
  Object.defineProperty(Input.prototype, '5', {
    get() {
      inheritedReads += 1;
      throw new Error('must not read inherited index');
    },
  });
  const shared = {};
  const source = new Input(8);
  Object.defineProperty(source, '4', { value: shared });
  source[6] = undefined;
  Object.freeze(source);
  const before = Object.getOwnPropertyDescriptors(source);

  const result = paginate(source, 2, 4);

  assert.deepEqual(result, {
    items: [shared, , undefined, ,], page: 2, pageSize: 4,
    totalItems: 8, totalPages: 2, hasPrevious: true, hasNext: false,
  });
  assert.equal(result.items.length, 4);
  assert.strictEqual(result.items[0], shared);
  for (const [index, present] of [true, false, true, false].entries()) {
    assert.equal(Object.hasOwn(result.items, index), present);
  }
  assert.strictEqual(Object.getPrototypeOf(result.items), Array.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(result.items, '0'), {
    value: shared, writable: true, enumerable: true, configurable: true,
  });
  assert.equal(inheritedReads, 0);
  assert.deepEqual(Object.getOwnPropertyDescriptors(source), before);
});

test('paginate defines own output slots even with Array.prototype accessors', () => {
  // Keep global prototype changes out of the test runner and other tests.
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { paginate } from ${JSON.stringify(new URL('../lib/paginate.mjs', import.meta.url).href)};

    for (const mode of ['setter', 'getter']) {
      const shared = {};
      const source = [, shared];
      const original = Object.getOwnPropertyDescriptor(Array.prototype, '0');
      let calls = 0;
      let result;
      let hole;
      const accessor = mode === 'setter'
        ? { set() { calls += 1; }, configurable: true }
        : { get() { calls += 1; throw new Error('inherited getter'); }, configurable: true };
      try {
        Object.defineProperty(Array.prototype, '0', accessor);
        result = paginate(source, 2, 1);
        hole = paginate(source, 1, 1);
      } finally {
        if (original) Object.defineProperty(Array.prototype, '0', original);
        else delete Array.prototype[0];
      }
      assert.equal(calls, 0);
      assert.equal(result.items.length, 1);
      assert.strictEqual(result.items[0], shared);
      assert.deepEqual(Object.getOwnPropertyDescriptor(result.items, '0'), {
        value: shared, writable: true, enumerable: true, configurable: true,
      });
      assert.strictEqual(Object.getPrototypeOf(result.items), Array.prototype);
      assert.equal(hole.items.length, 1);
      assert.equal(Object.hasOwn(hole.items, 0), false);
      assert.strictEqual(Object.getPrototypeOf(hole.items), Array.prototype);
    }
  `], { encoding: 'utf8', timeout: 10_000 });

  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

for (const [name, source] of [
  ['another realm', runInNewContext('[1, , undefined]')],
  ['a null prototype', Object.setPrototypeOf([1, , undefined], null)],
]) {
  test(`paginate accepts Arrays from ${name}`, () => {
    for (const [page, items, hasPrevious, hasNext] of [
      [1, [1, ,], false, true], [2, [undefined], true, false], [3, [], true, false],
    ]) {
      const result = paginate(source, page, 2);
      assert.deepEqual(result, {
        items, page, pageSize: 2, totalItems: 3, totalPages: 2, hasPrevious, hasNext,
      });
      assert.strictEqual(Object.getPrototypeOf(result.items), Array.prototype);
      for (let index = 0; index < items.length; index += 1) {
        assert.equal(Object.hasOwn(result.items, index), Object.hasOwn(items, index));
      }
    }
  });
}

test('paginate ignores source methods, iterators and non-index properties', () => {
  const source = [1, , undefined, 4];
  let calls = 0;
  for (const key of ['hasOwnProperty', 'slice', Symbol.iterator]) {
    source[key] = () => {
      calls += 1;
      throw new Error('must not use source methods');
    };
  }
  source.extra = 'not an item';
  source[-1] = 'negative';
  source[1.5] = 'fraction';

  assert.deepEqual(paginate(source, 1, 3).items, [1, , undefined]);
  assert.deepEqual(paginate(source, 2, 3).items, [4]);
  assert.equal(calls, 0);
});

test('paginate avoids subclass constructors and constructor/species hooks on every return path', () => {
  let constructions = 0;
  let speciesReads = 0;
  let constructorReads = 0;
  class Input extends Array {
    constructor(...args) {
      super(...args);
      constructions += 1;
    }
    static get [Symbol.species]() {
      speciesReads += 1;
      throw new Error('must not read species');
    }
  }
  const sources = [new Input(1, 2), new Input(), [1, 2], []];
  for (const source of sources.slice(2)) {
    Object.defineProperty(source, 'constructor', {
      get() {
        constructorReads += 1;
        throw new Error('must not read constructor');
      },
    });
  }
  const initialConstructions = constructions;
  for (const source of sources) {
    for (const [page, size] of [[1, 1], [1, max], [3, 1], [max, max]]) {
      const expected = source.length === 0 || page > 1 ? [] : size === 1 ? [1] : [1, 2];
      const result = paginate(source, page, size).items;
      const again = paginate(source, page, size).items;
      assert.deepEqual(result, expected);
      assert.deepEqual(again, expected);
      assert.notStrictEqual(result, source);
      assert.notStrictEqual(result, again);
      assert.strictEqual(Object.getPrototypeOf(result), Array.prototype);
      assert.strictEqual(Object.getPrototypeOf(again), Array.prototype);
    }
  }
  assert.equal(constructions, initialConstructions);
  assert.equal(speciesReads, 0);
  assert.equal(constructorReads, 0);
});

for (const [page, size, totalPages] of [
  [2 ** 32 - 1, 1, 2 ** 32 - 1],
  [2 ** 31, 2, 2 ** 31],
  [2, 2 ** 32 - 2, 2],
]) {
  test(`paginate handles a maximum-length sparse Array at page ${page}, size ${size}`, () => {
    const length = 2 ** 32 - 1;
    const shared = {};
    const source = new Array(length);
    source[length - 1] = shared;
    const before = Object.getOwnPropertyDescriptors(source);

    const result = paginate(source, page, size);
    assert.deepEqual(result, {
      items: [shared], page, pageSize: size, totalItems: length, totalPages,
      hasPrevious: true, hasNext: false,
    });
    assert.strictEqual(result.items[0], shared);
    assert.deepEqual(paginate(source, page + 1, size), {
      items: [], page: page + 1, pageSize: size, totalItems: length, totalPages,
      hasPrevious: true, hasNext: false,
    });
    assert.deepEqual(Object.getOwnPropertyDescriptors(source), before);
  });
}

test('paginate rejects non-Array sources with TypeError', () => {
  const fakeArray = Object.assign(Object.create(Array.prototype), { 0: 1, length: 1 });
  for (const source of [undefined, null, 'abc', 3, true, 1n, Symbol('items'), {},
    () => [], { 0: 1, length: 1 }, new Set([1]), new Uint8Array([1]), fakeArray]) {
    assert.throws(() => paginate(source, 1, 2), TypeError);
  }
});

const nonNumbers = [
  ['undefined', undefined], ['null', null], ['string', '2'],
  ['true', true], ['false', false], ['bigint', 2n], ['symbol', Symbol('number')],
  ['boxed number', new Number(2)], ['empty array', []], ['array', [2]],
  ['object', {}], ['function', () => 2],
];

for (const [name, value] of nonNumbers) {
  test(`paginate rejects ${name} in either numeric position, even on empty or beyond-last pages`, () => {
    for (const source of [[], [1, 2]]) {
      assert.throws(() => paginate(source, value, 2), TypeError);
      assert.throws(() => paginate(source, 1, value), TypeError);
      assert.throws(() => paginate(source, max, value), TypeError);
    }
  });
}

test('paginate requires all three arguments', () => {
  assert.throws(() => paginate(), TypeError);
  for (const source of [[], [1, 2]]) {
    assert.throws(() => paginate(source), TypeError);
    assert.throws(() => paginate(source, 1), TypeError);
  }
});

for (const key of [Symbol.toPrimitive, 'valueOf', 'toString']) {
  test(`paginate rejects numeric objects without reading or calling ${String(key)}`, () => {
    let reads = 0;
    let calls = 0;
    const accessor = Object.defineProperty({}, key, {
      get() {
        reads += 1;
        throw new TypeError('coercion access sentinel');
      },
    });
    const method = { [key]() { calls += 1; return 2; } };
    for (const value of [accessor, method]) {
      for (const source of [[], [1, 2]]) {
        assert.throws(() => paginate(source, value, 2), TypeError);
        assert.throws(() => paginate(source, 1, value), TypeError);
        assert.throws(() => paginate(source, max, value), TypeError);
      }
    }
    assert.equal(reads, 0);
    assert.equal(calls, 0);
  });
}

const invalidNumbers = [
  ['zero', 0], ['negative zero', -0], ['negative integer', -1],
  ['fraction', 1.5], ['tiny fraction', Number.MIN_VALUE], ['NaN', NaN],
  ['positive infinity', Infinity], ['negative infinity', -Infinity],
  ['unsafe integer', max + 1], ['negative unsafe integer', -max - 1],
  ['maximum finite number', Number.MAX_VALUE],
];

for (const [name, value] of invalidNumbers) {
  test(`paginate rejects ${name} with RangeError in either numeric position`, () => {
    for (const source of [[], [1, 2]]) {
      assert.throws(() => paginate(source, value, 2), RangeError);
      assert.throws(() => paginate(source, 1, value), RangeError);
      assert.throws(() => paginate(source, max, value), RangeError);
    }
  });
}
