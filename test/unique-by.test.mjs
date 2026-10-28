import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { uniqueBy } from '../lib/unique-by.mjs';

test('keeps first references and key order while calling back for every occurrence', () => {
  const firstA = { key: 'a' };
  const firstB = { key: 'b' };
  const items = [firstA, firstB, { key: 'a' }, { key: 'b' }, firstA];
  const calls = [];
  const result = uniqueBy(items, (...args) => {
    calls.push(args);
    return args[0].key;
  });

  assert.equal(result.length, 2);
  assert.strictEqual(result[0], firstA);
  assert.strictEqual(result[1], firstB);
  assert.deepEqual(calls, items.map((value, index) => [value, index]));
  for (let index = 0; index < items.length; index += 1) {
    assert.strictEqual(calls[index][0], items[index]);
  }
});

test('retains repeated occurrences of the same object when their keys differ', () => {
  const shared = {};
  const result = uniqueBy([shared, shared], (value, index) => index);

  assert.equal(result.length, 2);
  assert.strictEqual(result[0], shared);
  assert.strictEqual(result[1], shared);
});

test('uses SameValueZero keys without conflating primitive types or prototype-like strings', () => {
  const keys = [NaN, -0, 1, '1', 1n, null, undefined, false, '',
    '__proto__', 'constructor', 'toString'];
  const first = keys.map(key => ({ key }));
  const later = [...keys, +0].map(key => ({ key }));
  const result = uniqueBy([...first, ...later], value => value.key);

  assert.equal(result.length, first.length);
  for (let index = 0; index < first.length; index += 1) {
    assert.strictEqual(result[index], first[index]);
  }
});

test('preserves the sign of the first zero value in either order', () => {
  for (const items of [[-0, +0], [+0, -0]]) {
    const result = uniqueBy(items, value => value);
    assert.equal(result.length, 1);
    assert.ok(Object.is(result[0], items[0]));
  }
});

test('compares object and symbol keys by identity without invoking coercion hooks', () => {
  const first = { id: 1 };
  const second = { id: 1 };
  const firstSymbol = Symbol('key');
  const secondSymbol = Symbol('key');
  const uncoercible = {
    [Symbol.toPrimitive]() { assert.fail('must not coerce keys'); },
    toString() { assert.fail('must not stringify keys'); },
    valueOf() { assert.fail('must not coerce keys'); },
  };
  const keys = [first, second, firstSymbol, secondSymbol, uncoercible];
  const result = uniqueBy([...keys, ...keys], value => value);

  assert.equal(result.length, keys.length);
  for (let index = 0; index < keys.length; index += 1) {
    assert.strictEqual(result[index], keys[index]);
  }
});

test('retains falsy first representatives independently of membership', () => {
  for (const first of [undefined, null, false, 0, -0, '', NaN]) {
    const result = uniqueBy([first, 'later'], () => 'same');
    assert.equal(result.length, 1);
    assert.ok(Object.is(result[0], first));
  }
});

test('visits only own indices, including non-enumerable values and explicit undefined', () => {
  class Items extends Array {}
  Object.defineProperty(Items.prototype, 0, {
    get() { assert.fail('must not read inherited indices'); },
  });
  const value = {};
  const items = new Items(6);
  items[1] = undefined;
  Object.defineProperty(items, 3, { value, enumerable: false });
  items[4] = value;
  for (const key of ['name', '-1', '1.5', '01', '4294967295', 'hasOwnProperty',
    Symbol('extra'), Symbol.iterator]) {
    Object.defineProperty(items, key, {
      get() { assert.fail('must not read non-index properties or iteration hooks'); },
    });
  }
  const before = Object.getOwnPropertyDescriptors(items);
  const calls = [];
  const result = uniqueBy(items, (value, index) => {
    calls.push([value, index]);
    return value;
  });

  assert.deepEqual(calls, [[undefined, 1], [value, 3], [value, 4]]);
  assert.deepEqual(result, [undefined, value]);
  assert.strictEqual(result[1], value);
  assert.strictEqual(Object.getPrototypeOf(result), Array.prototype);
  assert.equal(Object.hasOwn(result, 0), true);
  assert.equal(Object.hasOwn(result, 1), true);
  assert.deepEqual(Object.getOwnPropertyDescriptors(items), before);
});

test('passes original sparse indices instead of compacted positions', () => {
  const items = [, , 'first', , 'second', , , 'third'];
  const calls = [];
  const result = uniqueBy(items, (value, index) => {
    calls.push([value, index]);
    return index % 2;
  });

  assert.deepEqual(calls, [['first', 2], ['second', 4], ['third', 7]]);
  assert.deepEqual(result, ['first', 'third']);
});

test('returns fresh ordinary arrays for empty, all-hole, and duplicate-free inputs', () => {
  for (const [items, expected] of [[[], []], [Object.freeze(new Array(3)), []],
    [[1, 2], [1, 2]]]) {
    const calls = [];
    const keyOf = (value, index) => {
      calls.push(index);
      return value;
    };
    const result = uniqueBy(items, keyOf);
    const again = uniqueBy(items, keyOf);

    assert.deepEqual(result, expected);
    assert.deepEqual(again, expected);
    assert.equal(calls.length, expected.length * 2);
    assert.notStrictEqual(result, items);
    assert.notStrictEqual(again, items);
    assert.notStrictEqual(result, again);
    assert.strictEqual(Object.getPrototypeOf(result), Array.prototype);
    assert.strictEqual(Object.getPrototypeOf(again), Array.prototype);
    result.push('extra');
    assert.deepEqual(again, expected);
  }
});

test('ignores constructor and species hooks on empty and populated arrays', () => {
  class Items extends Array {
    static get [Symbol.species]() { assert.fail('must not access species'); }
  }
  for (const values of [[], ['a', 'b', 'a']]) {
    const plain = [...values];
    Object.defineProperty(plain, 'constructor', {
      get() { assert.fail('must not access constructor'); },
    });
    for (const items of [new Items(...values), plain]) {
      const result = uniqueBy(items, value => value);
      assert.deepEqual(result, values.length === 0 ? [] : ['a', 'b']);
      assert.strictEqual(Object.getPrototypeOf(result), Array.prototype);
      assert.notStrictEqual(result, items);
    }
  }
});

test('does not modify or freeze mutable source data and preserves shallow references', () => {
  const object = { key: 'object', count: 0 };
  const nested = ['nested'];
  const items = [object, , nested, object];
  const originals = [items, object, nested];
  const before = originals.map(value => Object.getOwnPropertyDescriptors(value));
  const result = uniqueBy(items, value => value);

  assert.deepEqual(result, [object, nested]);
  for (let index = 0; index < originals.length; index += 1) {
    assert.deepEqual(Object.getOwnPropertyDescriptors(originals[index]), before[index]);
    assert.equal(Object.isExtensible(originals[index]), true);
  }
  assert.strictEqual(result[0], object);
  assert.strictEqual(result[1], nested);
  result[0].count += 1;
  result[1].push('shared');
  assert.equal(items[0].count, 1);
  assert.deepEqual(items[2], ['nested', 'shared']);
  result[0] = 'replacement';
  result.length = 0;
  assert.equal(items.length, 4);
  assert.strictEqual(items[0], object);
  assert.strictEqual(items[2], nested);
  assert.equal(Object.hasOwn(items, 1), false);
});

test('accepts frozen inputs and elements without copying retained objects', () => {
  const object = Object.freeze({ key: 'object' });
  const nested = Object.freeze(['nested']);
  const items = Object.freeze([object, , nested, object]);
  const before = Object.getOwnPropertyDescriptors(items);
  const result = uniqueBy(items, value => value);

  assert.deepEqual(result, [object, nested]);
  assert.strictEqual(result[0], object);
  assert.strictEqual(result[1], nested);
  assert.deepEqual(Object.getOwnPropertyDescriptors(items), before);
});

test('uses initial length and live own presence and values during callback mutations', () => {
  class Items extends Array {}
  Object.defineProperty(Items.prototype, 2, {
    get() { assert.fail('deletion must not expose inherited values to traversal'); },
  });
  const first = { id: 'first' };
  const inserted = { id: 'inserted' };
  const replacement = { id: 'replacement' };
  const items = new Items(4);
  items[0] = first;
  Object.defineProperty(items, 2, { value: { id: 'removed' }, configurable: true });
  items[3] = { id: 'original' };
  const calls = [];
  const result = uniqueBy(items, (value, index) => {
    calls.push([value, index]);
    if (index === 0) {
      items[1] = inserted;
      delete items[2];
      items[3] = replacement;
      items.push({ id: 'appended' });
    }
    return value.id;
  });

  assert.deepEqual(calls, [[first, 0], [inserted, 1], [replacement, 3]]);
  assert.equal(result.length, 3);
  assert.strictEqual(result[0], first);
  assert.strictEqual(result[1], inserted);
  assert.strictEqual(result[2], replacement);
});

test('skips own elements removed by shortening the source', () => {
  const items = ['a', 'b', 'c'];
  const calls = [];
  const result = uniqueBy(items, (value, index) => {
    calls.push(index);
    items.length = 1;
    return value;
  });

  assert.deepEqual(calls, [0]);
  assert.deepEqual(result, ['a']);
});

test('reads each value once immediately before its callback and retains that captured value', () => {
  const values = [{ key: 'a' }, { key: 'b' }, { key: 'a' }];
  const items = new Array(values.length);
  const events = [];
  for (let index = 0; index < values.length; index += 1) {
    Object.defineProperty(items, index, {
      configurable: true,
      get() {
        events.push(`read ${index}`);
        return values[index];
      },
    });
  }
  const result = uniqueBy(items, (value, index) => {
    events.push(`callback ${index}`);
    if (index === 0) {
      Object.defineProperty(items, index, { value: 'replacement' });
    } else {
      delete items[index];
    }
    return value.key;
  });

  assert.deepEqual(events, [
    'read 0', 'callback 0', 'read 1', 'callback 1', 'read 2', 'callback 2',
  ]);
  assert.equal(result.length, 2);
  assert.strictEqual(result[0], values[0]);
  assert.strictEqual(result[1], values[1]);
});

test('observes source changes made by an indexed getter within the initial bound', () => {
  const items = [, , 'original', 'removed'];
  const calls = [];
  let reads = 0;
  Object.defineProperty(items, 0, {
    get() {
      reads += 1;
      items[1] = 'inserted';
      items[2] = 'replacement';
      delete items[3];
      items.push('appended');
      return 'first';
    },
  });
  const result = uniqueBy(items, (value, index) => {
    calls.push(index);
    return value;
  });

  assert.equal(reads, 1);
  assert.deepEqual(calls, [0, 1, 2]);
  assert.deepEqual(result, ['first', 'inserted', 'replacement']);
});

for (const fail of [false, true]) {
  test(`nested calls keep independent state, including a caught inner failure: ${fail}`, () => {
    const failure = {};
    let inner;
    let caught = false;
    const outer = uniqueBy(['a', 'b', 'a'], (value, index) => {
      if (index === 1) {
        try {
          inner = uniqueBy(['nested', 'nested'], (value, index) => {
            if (fail && index === 1) throw failure;
            return value;
          });
        } catch (error) {
          caught = true;
          assert.strictEqual(error, failure);
        }
      }
      return value;
    });

    assert.deepEqual(outer, ['a', 'b']);
    assert.equal(caught, fail);
    assert.deepEqual(inner, fail ? undefined : ['nested']);
    assert.deepEqual(uniqueBy(['a', 'a'], value => value), ['a']);
  });
}

test('accepts arrays and callbacks from another realm and returns a local ordinary array', () => {
  const items = runInNewContext('[1, 2, 1]');
  const keyOf = runInNewContext('value => value');
  for (const input of [items, [1, 2, 1]]) {
    const result = uniqueBy(input, keyOf);
    assert.deepEqual(result, [1, 2]);
    assert.strictEqual(Object.getPrototypeOf(result), Array.prototype);
    assert.notStrictEqual(result, input);
  }
});

test('rejects non-Array inputs without coercion or invoking the callback', () => {
  const invalid = [undefined, null, 'abc', 42, true, 1n, Symbol('input'), {},
    { 0: 'a', length: 1 }, new Set(['a']), new Map(), new Uint8Array([1]),
    Object.create(Array.prototype), () => [],
    { [Symbol.toPrimitive]() { assert.fail('must not coerce inputs'); } }];
  for (const items of invalid) {
    assert.throws(() => uniqueBy(items, () => assert.fail('must validate first')), TypeError);
  }
  assert.throws(() => uniqueBy(), TypeError);
});

test('validates callbacks before traversal, even for empty and all-hole arrays', () => {
  const invalid = [undefined, null, 'key', 42, true, 1n, Symbol('key'), {}, [], /key/,
    { call() {} }, { [Symbol.toPrimitive]() { assert.fail('must not coerce callbacks'); } }];
  const guarded = [];
  Object.defineProperty(guarded, 0, {
    get() { assert.fail('validation must precede indexed reads'); },
  });
  for (const items of [[], new Array(3), [1, 2], guarded]) {
    for (const keyOf of invalid) {
      assert.throws(() => uniqueBy(items, keyOf), TypeError);
    }
    assert.throws(() => uniqueBy(items), TypeError);
  }
});

for (const [label, thrown] of [
  ['Error', new Error('failed')], ['object', { reason: 'failed' }],
  ['primitive', 'failed'], ['undefined', undefined],
]) {
  for (const source of ['callback', 'getter']) {
    test(`propagates the exact ${label} from a ${source} and stops immediately`, () => {
      const items = ['same', 'same', 'later'];
      const calls = [];
      let reads = 0;
      Object.defineProperty(items, 1, {
        get() {
          reads += 1;
          if (source === 'getter') throw thrown;
          return 'same';
        },
      });
      Object.defineProperty(items, 2, {
        get() { assert.fail('must not read after a failure'); },
      });
      const before = Object.getOwnPropertyDescriptors(items);
      const notReturned = Symbol('not returned');
      let result = notReturned;
      let caught = false;
      try {
        result = uniqueBy(items, (value, index) => {
          calls.push([value, index]);
          if (index === 1) throw thrown;
          return value;
        });
      } catch (error) {
        caught = true;
        assert.strictEqual(error, thrown);
      }

      assert.equal(caught, true);
      assert.strictEqual(result, notReturned);
      assert.equal(reads, 1);
      assert.deepEqual(calls, source === 'getter' ? [['same', 0]] : [['same', 0], ['same', 1]]);
      assert.deepEqual(Object.getOwnPropertyDescriptors(items), before);
      assert.equal(Object.isExtensible(items), true);
      assert.deepEqual(uniqueBy(['same', 'same'], value => value), ['same']);
    });
  }
}

test('a non-mutating callback failure leaves source and element descriptors and extensibility unchanged', () => {
  const object = { count: 0 };
  const nested = ['nested'];
  const items = [object, , nested];
  const originals = [items, object, nested];
  const before = originals.map(value => Object.getOwnPropertyDescriptors(value));
  const failure = new Error('failed');

  assert.throws(() => uniqueBy(items, (value, index) => {
    if (index === 2) throw failure;
    return value;
  }), error => error === failure);

  for (let index = 0; index < originals.length; index += 1) {
    assert.deepEqual(Object.getOwnPropertyDescriptors(originals[index]), before[index]);
    assert.equal(Object.isExtensible(originals[index]), true);
  }
});

for (const source of ['callback', 'getter']) {
  test(`does not roll back ${source} side effects when it throws`, () => {
    const value = { count: 0 };
    const items = [value];
    const failure = {};
    const mutateAndThrow = () => {
      value.count += 1;
      items.push('appended');
      throw failure;
    };
    if (source === 'getter') Object.defineProperty(items, 0, { get: mutateAndThrow });

    assert.throws(() => uniqueBy(items, mutateAndThrow), error => error === failure);
    assert.equal(value.count, 1);
    assert.equal(items.length, 2);
    assert.equal(items[1], 'appended');
    assert.equal(Object.isExtensible(items), true);
    assert.equal(Object.isExtensible(value), true);
  });
}
