import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { groupBy } from '../lib/group-by.mjs';

test('groups interleaved values in first-seen key and input value order', () => {
  const items = ['10:a', '2:b', '10:c', 'other:d', '2:e'];
  const calls = [];
  const result = groupBy(items, (value, index) => {
    calls.push([value, index]);
    return value.split(':')[0];
  });

  assert.ok(result instanceof Map);
  assert.deepEqual([...result.keys()], ['10', '2', 'other']);
  assert.deepEqual(result.get('10'), ['10:a', '10:c']);
  assert.deepEqual(result.get('2'), ['2:b', '2:e']);
  assert.deepEqual(result.get('other'), ['other:d']);
  assert.deepEqual(calls, items.map((value, index) => [value, index]));
});

test('passes the value and index to index-aware callbacks', () => {
  const calls = [];
  const result = groupBy(['a', 'b', 'c', 'd', 'e'], (...args) => {
    calls.push(args);
    return args[1] % 2;
  });

  assert.deepEqual(calls, [['a', 0], ['b', 1], ['c', 2], ['d', 3], ['e', 4]]);
  assert.deepEqual([...result.entries()], [[0, ['a', 'c', 'e']], [1, ['b', 'd']]]);
});

test('reads each indexed value once immediately before its callback', () => {
  const events = [];
  const values = ['a', 'b', 'c'];
  const items = values.map((_, index) => index);
  for (let index = 0; index < values.length; index += 1) {
    Object.defineProperty(items, index, {
      get() {
        events.push(`read ${index}`);
        return values[index];
      },
    });
  }

  const result = groupBy(items, (value, index) => {
    events.push(`callback ${index}`);
    return 'all';
  });

  assert.deepEqual(events, [
    'read 0', 'callback 0', 'read 1', 'callback 1', 'read 2', 'callback 2',
  ]);
  assert.deepEqual(result.get('all'), values);
});

test('uses indices even when the array overrides its iterator', () => {
  const items = ['first', 'second', 'third'];
  items[Symbol.iterator] = function* () {
    yield 'unexpected';
  };

  const result = groupBy(items, (value, index) => index);

  assert.deepEqual([...result.entries()], [
    [0, ['first']], [1, ['second']], [2, ['third']],
  ]);
});

test('preserves object key identity, including equal-shaped distinct keys', () => {
  const first = { id: 1 };
  const second = { id: 1 };
  const items = [first, second, first];
  const result = groupBy(items, value => value);
  const keys = [...result.keys()];

  assert.equal(result.size, 2);
  assert.strictEqual(keys[0], first);
  assert.strictEqual(keys[1], second);
  assert.equal(result.has({ id: 1 }), false);
  assert.equal(result.get(first).length, 2);
  assert.strictEqual(result.get(first)[0], first);
  assert.strictEqual(result.get(first)[1], first);
  assert.strictEqual(result.get(second)[0], second);
});

test('groups repeated symbols while keeping same-description symbols distinct', () => {
  const first = Symbol('key');
  const second = Symbol('key');
  const result = groupBy([first, second, first], value => value);

  assert.deepEqual([...result.keys()], [first, second]);
  assert.deepEqual(result.get(first), [first, first]);
  assert.deepEqual(result.get(second), [second]);
  assert.equal(result.has(Symbol('key')), false);
});

test('treats prototype-like strings as ordinary keys', () => {
  const result = groupBy(
    ['__proto__', 'constructor', 'toString', '__proto__', 'constructor'],
    value => value,
  );

  assert.deepEqual([...result.keys()], ['__proto__', 'constructor', 'toString']);
  assert.deepEqual(result.get('__proto__'), ['__proto__', '__proto__']);
  assert.deepEqual(result.get('constructor'), ['constructor', 'constructor']);
  assert.deepEqual(result.get('toString'), ['toString']);
});

test('retains Map equality for NaN, signed zeros, and different primitive types', () => {
  const items = [NaN, -0, 1, '1', null, undefined, NaN, +0, 1n, false];
  const result = groupBy(items, value => value);

  assert.deepEqual([...result.keys()], [NaN, 0, 1, '1', null, undefined, 1n, false]);
  assert.deepEqual(result.get(NaN), [NaN, NaN]);
  assert.deepEqual(result.get(0), [-0, +0]);
  assert.strictEqual(result.get(-0), result.get(+0));
  assert.deepEqual(result.get(1), [1]);
  assert.deepEqual(result.get('1'), ['1']);
  assert.deepEqual(result.get(null), [null]);
  assert.deepEqual(result.get(undefined), [undefined]);
  assert.deepEqual(result.get(1n), [1n]);
  assert.deepEqual(result.get(false), [false]);
});

test('returns fresh independent buckets without changing frozen inputs or copying elements', () => {
  const first = Object.freeze({ key: 'a' });
  const second = Object.freeze({ key: 'b' });
  const items = Object.freeze([first, second, first]);
  const before = Object.getOwnPropertyDescriptors(items);
  const result = groupBy(items, value => value.key);
  const again = groupBy(items, value => value.key);
  const a = result.get('a');
  const b = result.get('b');

  assert.ok(Array.isArray(a));
  assert.ok(Array.isArray(b));
  assert.notStrictEqual(a, items);
  assert.notStrictEqual(b, items);
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(result, again);
  assert.notStrictEqual(a, again.get('a'));
  assert.notStrictEqual(b, again.get('b'));
  assert.strictEqual(a[0], first);
  assert.strictEqual(a[1], first);
  assert.strictEqual(b[0], second);

  a[0] = 'replacement';
  a.push('extra');
  assert.deepEqual(items, [first, second, first]);
  assert.deepEqual(b, [second]);
  assert.deepEqual(again.get('a'), [first, first]);
  assert.deepEqual(Object.getOwnPropertyDescriptors(items), before);
  assert.ok(Object.isFrozen(items));
});

test('a single group never aliases its input array', () => {
  const items = ['a', 'b'];
  const result = groupBy(items, () => 'all');
  const bucket = result.get('all');

  assert.notStrictEqual(bucket, items);
  bucket.pop();
  assert.deepEqual(items, ['a', 'b']);
  items.push('c');
  assert.deepEqual(bucket, ['a']);
});

test('empty inputs return fresh empty Maps and do not invoke the callback', () => {
  const keyOf = () => assert.fail('empty input must not invoke keyOf');
  const first = groupBy([], keyOf);
  const second = groupBy(Object.freeze([]), keyOf);

  assert.ok(first instanceof Map);
  assert.ok(second instanceof Map);
  assert.equal(first.size, 0);
  assert.equal(second.size, 0);
  assert.notStrictEqual(first, second);
  first.set('extra', []);
  assert.equal(second.size, 0);
});

test('visits sparse indices as undefined without filling source holes', () => {
  const items = Object.freeze([, 'x', ,]);
  const before = Object.getOwnPropertyDescriptors(items);
  const calls = [];
  const result = groupBy(items, (value, index) => {
    calls.push([value, index]);
    return value;
  });

  assert.deepEqual(calls, [[undefined, 0], ['x', 1], [undefined, 2]]);
  assert.deepEqual([...result.entries()], [[undefined, [undefined, undefined]], ['x', ['x']]]);
  assert.deepEqual(Object.getOwnPropertyDescriptors(items), before);
});

test('bounds traversal at the initial length when a callback appends values', () => {
  const items = ['a', 'b'];
  const calls = [];
  const result = groupBy(items, (value, index) => {
    calls.push([value, index]);
    if (index === 0) items.push('c');
    return 'all';
  });

  assert.deepEqual(calls, [['a', 0], ['b', 1]]);
  assert.deepEqual(result.get('all'), ['a', 'b']);
  assert.deepEqual(items, ['a', 'b', 'c']);
});

test('reads later values at visit time when a callback replaces or deletes them', () => {
  const items = ['a', 'b', 'c'];
  const calls = [];
  const result = groupBy(items, (value, index) => {
    calls.push([value, index]);
    if (index === 0) {
      items[1] = 'replacement';
      items.length = 2;
    }
    return 'all';
  });

  assert.deepEqual(calls, [['a', 0], ['replacement', 1], [undefined, 2]]);
  assert.deepEqual(result.get('all'), ['a', 'replacement', undefined]);
  assert.deepEqual(items, ['a', 'replacement']);
});

test('accepts Arrays from another realm', () => {
  const items = runInNewContext('[1, 2, 3]');
  const result = groupBy(items, value => value % 2);

  assert.deepEqual([...result.entries()], [[1, [1, 3]], [0, [2]]]);
});

test('rejects non-Array inputs before invoking the callback', () => {
  const invalid = [
    undefined, null, 'abc', 42, true, 1n, Symbol('input'), {},
    { 0: 'a', length: 1 }, new Set(['a']), new Map(), new Uint8Array([1]),
    () => [],
  ];
  let calls = 0;
  for (const items of invalid) {
    assert.throws(() => groupBy(items, () => { calls += 1; }), TypeError);
  }
  assert.equal(calls, 0);
  assert.throws(() => groupBy(), TypeError);
});

test('rejects non-function callbacks on both empty and populated arrays before reading values', () => {
  const invalid = [undefined, null, 'key', 42, true, 1n, Symbol('key'), {}, [], /key/, { call() {} }];
  const items = [];
  Object.defineProperty(items, 0, {
    get() { assert.fail('validation must precede reading input values'); },
  });

  for (const keyOf of invalid) {
    assert.throws(() => groupBy([], keyOf), TypeError);
    assert.throws(() => groupBy(items, keyOf), TypeError);
  }
});

for (const [label, thrown] of [
  ['Error', new Error('callback failed')],
  ['object', { reason: 'callback failed' }],
  ['primitive', 'callback failed'],
  ['undefined', undefined],
]) {
  test(`propagates the original thrown ${label} and stops without returning partial groups`, () => {
    const calls = [];
    const items = ['a', 'b', 'c'];
    Object.defineProperty(items, 2, {
      get() { assert.fail('must stop reading after the callback throws'); },
    });
    const notReturned = Symbol('not returned');
    let result = notReturned;
    let caught = false;
    try {
      result = groupBy(items, (value, index) => {
        calls.push([value, index]);
        if (index === 1) throw thrown;
        return 'all';
      });
    } catch (error) {
      caught = true;
      assert.strictEqual(error, thrown);
    }

    assert.equal(caught, true);
    assert.strictEqual(result, notReturned);
    assert.deepEqual(calls, [['a', 0], ['b', 1]]);
  });
}
