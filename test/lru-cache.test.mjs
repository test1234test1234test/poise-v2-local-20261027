import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LruCache } from '../lib/lru-cache.mjs';

function assertEntries(cache, expected) {
  assert.equal(cache.size, expected.length);
  assert.deepEqual(cache.entries(), expected);
}

function populatedCache() {
  return new LruCache(2).set('a', 1).set('b', 2);
}

test('a new cache is empty and insertion evicts the least recent key', () => {
  const cache = new LruCache(2);
  assertEntries(cache, []);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.set('a', 1), cache);
  assertEntries(cache, [['a', 1]]);
  assert.equal(cache.set('b', 2), cache);
  assertEntries(cache, [['a', 1], ['b', 2]]);
  assert.equal(cache.set('c', 3), cache);
  assertEntries(cache, [['b', 2], ['c', 3]]);
  assert.equal(cache.has('a'), false);
  cache.set('d', 4);
  assertEntries(cache, [['c', 3], ['d', 4]]);
  assert.equal(cache.has('b'), false);
});

test('reading an old key protects it from the next eviction', () => {
  const cache = populatedCache();
  assert.equal(cache.get('a'), 1);
  assertEntries(cache, [['b', 2], ['a', 1]]);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assertEntries(cache, [['a', 1], ['c', 3]]);
  assert.equal(cache.has('b'), false);
});

test('updating an old key promotes it without evicting or increasing size', () => {
  const cache = populatedCache();
  assert.equal(cache.set('a', 9), cache);
  assertEntries(cache, [['b', 2], ['a', 9]]);
  assert.equal(cache.has('b'), true);
  cache.set('c', 3);
  assertEntries(cache, [['a', 9], ['c', 3]]);
  assert.equal(cache.has('b'), false);
});

for (const [name, observe] of [
  ['has(existing)', cache => assert.equal(cache.has('a'), true)],
  ['has(missing)', cache => assert.equal(cache.has('missing'), false)],
  ['get(missing)', cache => assert.equal(cache.get('missing'), undefined)],
  ['delete(missing)', cache => assert.equal(cache.delete('missing'), false)],
  ['size', cache => assert.equal(cache.size, 2)],
  ['entries()', cache => assert.deepEqual(cache.entries(), [['a', 1], ['b', 2]])],
]) {
  test(`${name} preserves the eviction victim`, () => {
    const cache = populatedCache();
    observe(cache);
    cache.set('c', 3);
    assertEntries(cache, [['b', 2], ['c', 3]]);
    assert.equal(cache.has('a'), false);
  });
}

test('capacity one supports reads and updates before replacing the sole entry', () => {
  const cache = new LruCache(1);
  assertEntries(cache, []);
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.set('a', 9), cache);
  assertEntries(cache, [['a', 9]]);
  cache.set('b', 2);
  assertEntries(cache, [['b', 2]]);
  assert.equal(cache.has('a'), false);
});

test('stored undefined is present and a successful get still promotes it', () => {
  const cache = new LruCache(2).set('a', undefined).set('b', 2);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('missing'), false);
  assert.equal(cache.get('a'), undefined);
  cache.set('c', 3);
  assertEntries(cache, [['a', undefined], ['c', 3]]);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('a'), false);
  assertEntries(cache, [['c', 3]]);
});

test('object keys use identity for lookup, update, eviction and deletion', () => {
  const first = { id: 1 };
  const second = { id: 1 };
  const third = { id: 1 };
  const cache = new LruCache(2).set(first, 'first').set(second, 'second');
  assert.equal(cache.has(third), false);
  assert.equal(cache.get(third), undefined);
  assert.equal(cache.get(first), 'first');
  assert.equal(cache.entries()[0][0], second);
  assert.equal(cache.entries()[1][0], first);
  cache.set(second, 'updated');
  assertEntries(cache, [[first, 'first'], [second, 'updated']]);
  cache.set(third, 'third');
  assert.equal(cache.has(first), false);
  assert.equal(cache.has(second), true);
  assert.equal(cache.entries()[0][0], second);
  assert.equal(cache.entries()[1][0], third);
  assert.equal(cache.delete(first), false);
  assert.equal(cache.delete(second), true);
  assertEntries(cache, [[third, 'third']]);
});

test('NaN is one key across reads, updates, promotion and deletion', () => {
  const cache = new LruCache(2).set(NaN, 'first').set('a', 1);
  assert.equal(cache.has(Number('not a number')), true);
  assert.equal(cache.get(NaN), 'first');
  cache.set('b', 2);
  assertEntries(cache, [[NaN, 'first'], ['b', 2]]);
  assert.equal(cache.has('a'), false);
  cache.set(Number('not a number'), 'updated');
  assertEntries(cache, [['b', 2], [NaN, 'updated']]);
  cache.set('c', 3);
  assertEntries(cache, [[NaN, 'updated'], ['c', 3]]);
  assert.equal(cache.delete(NaN), true);
  assert.equal(cache.delete(NaN), false);
  assertEntries(cache, [['c', 3]]);
});

test('signed zero aliases while numeric and string keys stay distinct', () => {
  const cache = new LruCache(2).set(-0, 'zero').set(1, 'number');
  assert.equal(cache.has(+0), true);
  assert.equal(cache.get(+0), 'zero');
  cache.set(+0, 'updated zero');
  assertEntries(cache, [[1, 'number'], [0, 'updated zero']]);
  cache.set('1', 'string');
  assertEntries(cache, [[0, 'updated zero'], ['1', 'string']]);
  assert.equal(cache.has(1), false);
  cache.set(1, 'number again');
  assertEntries(cache, [['1', 'string'], [1, 'number again']]);
  assert.equal(cache.has(-0), false);
});

for (const key of [undefined, null, false, 0, '', NaN]) {
  test(`an oldest ${String(key)} key can be evicted`, () => {
    const cache = new LruCache(2).set(key, 'oldest').set('b', 2);
    cache.set('c', 3);
    assert.equal(cache.has(key), false);
    assertEntries(cache, [['b', 2], ['c', 3]]);
  });
}

test('deletion frees capacity and reinsertion makes a key most recent', () => {
  const cache = populatedCache();
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('a'), false);
  assertEntries(cache, [['b', 2]]);
  cache.set('c', 3);
  assertEntries(cache, [['b', 2], ['c', 3]]);
  cache.set('a', 9);
  assertEntries(cache, [['c', 3], ['a', 9]]);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.delete('a'), true);
  assertEntries(cache, [['c', 3]]);
});

test('clear returns undefined and preserves capacity when the cache is reused', () => {
  const cache = populatedCache();
  assert.equal(cache.clear(), undefined);
  assertEntries(cache, []);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.clear(), undefined);
  cache.set('d', 4).set('e', 5).set('f', 6);
  assertEntries(cache, [['e', 5], ['f', 6]]);
  assert.equal(cache.has('d'), false);
});

for (const [name, mutate] of [
  ['replace a pair', snapshot => { snapshot[0] = ['x', 9]; }],
  ['replace a key', snapshot => { snapshot[0][0] = 'x'; }],
  ['replace a value', snapshot => { snapshot[0][1] = 9; }],
  ['sort', snapshot => { snapshot.sort((a, b) => b[1] - a[1]); }],
  ['splice', snapshot => { snapshot.splice(0, 1); }],
  ['append', snapshot => { snapshot.push(['x', 9]); }],
]) {
  test(`snapshot edits (${name}) cannot change contents or recency`, () => {
    const cache = populatedCache();
    const snapshot = cache.entries();
    const another = cache.entries();
    assert.ok(Array.isArray(snapshot));
    assert.notEqual(snapshot, another);
    for (let i = 0; i < snapshot.length; i += 1) {
      assert.ok(Array.isArray(snapshot[i]));
      assert.equal(snapshot[i].length, 2);
      assert.notEqual(snapshot[i], another[i]);
    }
    mutate(snapshot);
    assert.deepEqual(another, [['a', 1], ['b', 2]]);
    assertEntries(cache, [['a', 1], ['b', 2]]);
    cache.set('c', 3);
    assertEntries(cache, [['b', 2], ['c', 3]]);
    assert.equal(cache.has('a'), false);
  });
}

test('old snapshots retain associations and order through later cache operations', () => {
  const cache = populatedCache();
  const snapshot = cache.entries();
  cache.get('a');
  cache.set('b', 20);
  cache.set('c', 3);
  cache.delete('b');
  cache.clear();
  assert.deepEqual(snapshot, [['a', 1], ['b', 2]]);
  assertEntries(cache, []);
});

test('snapshots preserve object references under the shallow isolation contract', () => {
  const key = { id: 1 };
  const value = { count: 1 };
  const cache = new LruCache(2).set(key, value).set('b', 2);
  const snapshot = cache.entries();
  assert.equal(snapshot[0][0], key);
  assert.equal(snapshot[0][1], value);
  snapshot[0][0].id = 2;
  snapshot[0][1].count = 3;
  assert.equal(cache.has(key), true);
  assert.equal(cache.entries()[0][1], value);
  assert.equal(value.count, 3);
  cache.set('c', 3);
  assertEntries(cache, [['b', 2], ['c', 3]]);
  assert.equal(cache.has(key), false);
});

test('interleaved instances keep independent contents, recency and capacity', () => {
  const small = new LruCache(1).set('a', 'small');
  const large = populatedCache();
  small.get('a');
  small.set('a', 'updated').set('b', 'replacement');
  assertEntries(large, [['a', 1], ['b', 2]]);
  large.get('a');
  large.set('c', 3);
  assertEntries(large, [['a', 1], ['c', 3]]);
  assert.equal(large.has('b'), false);
  assertEntries(small, [['b', 'replacement']]);
  assert.equal(small.delete('b'), true);
  small.clear();
  assertEntries(large, [['a', 1], ['c', 3]]);
  small.set('a', 'again');
  large.clear();
  assertEntries(small, [['a', 'again']]);
  large.set('a', 10).set('b', 20).set('c', 30);
  small.set('c', 'last');
  assertEntries(large, [['b', 20], ['c', 30]]);
  assertEntries(small, [['c', 'last']]);
});

test('omitting capacity throws TypeError', () => {
  assert.throws(() => new LruCache(), TypeError);
});

for (const [name, capacity] of [
  ['undefined', undefined], ['null', null], ['false', false], ['true', true],
  ['numeric string', '2'], ['empty string', ''], ['BigInt', 2n],
  ['boxed number', new Number(2)], ['object', {}], ['array', [2]],
  ['Symbol', Symbol('capacity')],
]) {
  test(`rejects ${name} capacity with TypeError`, () => {
    assert.throws(() => new LruCache(capacity), TypeError);
  });
}

for (const [name, capacity] of [
  ['zero', 0], ['negative zero', -0], ['negative', -1],
  ['fraction below one', 0.5], ['fraction above one', 1.5], ['NaN', NaN],
  ['positive infinity', Infinity], ['negative infinity', -Infinity],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 1], ['maximum number', Number.MAX_VALUE],
]) {
  test(`rejects ${name} capacity with RangeError`, () => {
    assert.throws(() => new LruCache(capacity), RangeError);
  });
}

test('capacity validation does not invoke coercion hooks', () => {
  let coercions = 0;
  const capacity = {
    valueOf() { coercions += 1; return 2; },
    toString() { coercions += 1; return '2'; },
    [Symbol.toPrimitive]() { coercions += 1; return 2; },
  };
  assert.throws(() => new LruCache(capacity), TypeError);
  assert.equal(coercions, 0);
});

test('maximum safe integer capacity works without allocating to capacity', () => {
  const cache = new LruCache(Number.MAX_SAFE_INTEGER);
  assertEntries(cache, []);
  cache.set('a', 1).set('b', 2).set('c', 3);
  assert.equal(cache.get('a'), 1);
  assertEntries(cache, [['b', 2], ['c', 3], ['a', 1]]);
});
