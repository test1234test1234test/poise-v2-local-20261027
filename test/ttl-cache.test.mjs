import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTtlCache } from '../lib/ttl-cache.mjs';

function createTestCache({ capacity = 2, ttlMs = 10, now = 0 } = {}) {
  const time = { now, calls: 0, throwing: false, error: undefined };
  const cache = createTtlCache({
    capacity,
    ttlMs,
    clock: () => {
      time.calls += 1;
      if (time.throwing) throw time.error;
      return time.now;
    },
  });
  return { cache, time };
}

// Check the call count before any later cache observation can hide a retry.
function once(time, action) {
  const before = time.calls;
  try {
    return action();
  } finally {
    assert.equal(time.calls, before + 1);
  }
}

test('construction and clear never read the clock; every other operation reads once', () => {
  const { cache, time } = createTestCache();
  assert.equal(time.calls, 0);
  assert.equal(cache.clear(), undefined);
  assert.equal(time.calls, 0);
  assert.equal(once(time, () => cache.size), 0);
  assert.deepEqual(once(time, () => cache.entries()), []);
  assert.equal(once(time, () => cache.get('a')), undefined);
  assert.equal(once(time, () => cache.has('a')), false);
  assert.equal(once(time, () => cache.delete('a')), false);
  assert.equal(once(time, () => cache.set('a', 1)), cache);
  assert.equal(once(time, () => cache.set('b', 2)), cache);
  assert.equal(once(time, () => cache.set('b', 20)), cache);
  assert.equal(once(time, () => cache.get('a')), 1);
  assert.equal(once(time, () => cache.get('missing')), undefined);
  assert.equal(once(time, () => cache.has('a')), true);
  assert.equal(once(time, () => cache.has('missing')), false);
  assert.equal(once(time, () => cache.delete('missing')), false);
  assert.equal(once(time, () => cache.size), 2);
  assert.deepEqual(once(time, () => cache.entries()), [['b', 20], ['a', 1]]);
  assert.equal(once(time, () => cache.delete('a')), true);
  assert.equal(once(time, () => cache.delete('b')), true);
  assert.equal(once(time, () => cache.size), 0);
});

for (const [name, read, expected] of [
  ['get', cache => cache.get('a'), undefined],
  ['has', cache => cache.has('a'), false],
  ['delete', cache => cache.delete('a'), false],
  ['size', cache => cache.size, 1],
  ['entries', cache => cache.entries(), [['b', 2]]],
]) {
  test(`${name} excludes an expired MRU entry behind a live LRU entry`, () => {
    const { cache, time } = createTestCache();
    cache.set('a', 1);
    time.now = 5;
    cache.set('b', 2);
    time.now = 6;
    assert.equal(cache.get('a'), 1);
    assert.deepEqual(cache.entries(), [['b', 2], ['a', 1]]);
    time.now = 10;
    assert.deepEqual(once(time, () => read(cache)), expected);
    cache.set('c', 3);
    assert.deepEqual(cache.entries(), [['b', 2], ['c', 3]]);
  });
}

test('set purges an expired MRU entry before choosing an eviction victim', () => {
  const { cache, time } = createTestCache();
  cache.set('a', 1);
  time.now = 5;
  cache.set('b', 2);
  time.now = 6;
  cache.get('a');
  time.now = 10;
  assert.equal(once(time, () => cache.set('c', 3)), cache);
  assert.deepEqual(cache.entries(), [['b', 2], ['c', 3]]);
});

test('get promotes a live entry without extending its exact deadline', () => {
  const { cache, time } = createTestCache();
  cache.set('a', 1);
  time.now = 5;
  cache.set('b', 2);
  time.now = 9;
  assert.equal(cache.get('a'), 1);
  assert.deepEqual(cache.entries(), [['b', 2], ['a', 1]]);
  time.now = 10;
  assert.equal(cache.get('a'), undefined);
  assert.deepEqual(cache.entries(), [['b', 2]]);
  time.now = 100;
  assert.equal(once(time, () => cache.size), 0);
  assert.deepEqual(cache.entries(), []);
});

test('has does not extend expiry', () => {
  const { cache, time } = createTestCache();
  cache.set('a', 1);
  time.now = 9;
  assert.equal(cache.has('a'), true);
  time.now = 10;
  assert.equal(cache.has('a'), false);
});

for (const [name, observe, expected] of [
  ['has hit', cache => cache.has('a'), true],
  ['has miss', cache => cache.has('missing'), false],
  ['get miss', cache => cache.get('missing'), undefined],
  ['delete miss', cache => cache.delete('missing'), false],
  ['size', cache => cache.size, 2],
  ['entries', cache => cache.entries(), [['a', 1], ['b', 2]]],
]) {
  test(`${name} preserves recency and the next eviction victim`, () => {
    const { cache, time } = createTestCache();
    cache.set('a', 1).set('b', 2);
    time.now = 9;
    assert.deepEqual(once(time, () => observe(cache)), expected);
    cache.set('c', 3);
    assert.deepEqual(cache.entries(), [['b', 2], ['c', 3]]);
  });
}

for (const value of [1, undefined]) {
  test(`equal timestamps retain call-order LRU when reading ${String(value)}`, () => {
    const { cache } = createTestCache();
    cache.set('a', value).set('b', 2);
    assert.equal(cache.has('a'), true);
    assert.equal(cache.get('a'), value);
    cache.set('c', 3);
    assert.deepEqual(cache.entries(), [['a', value], ['c', 3]]);
    assert.equal(cache.delete('a'), true);
    assert.equal(cache.delete('a'), false);
  });
}

test('equal-time replacement promotes without growing or evicting another key', () => {
  const { cache } = createTestCache();
  cache.set('a', 1).set('b', 2);
  assert.equal(cache.set('a', 9), cache);
  assert.equal(cache.size, 2);
  assert.deepEqual(cache.entries(), [['b', 2], ['a', 9]]);
  cache.set('c', 3);
  assert.deepEqual(cache.entries(), [['a', 9], ['c', 3]]);
});

test('replacement renews expiry and preserves other live entries at capacity', () => {
  const { cache, time } = createTestCache();
  cache.set('a', 1).set('b', 2);
  time.now = 9;
  cache.set('a', 9);
  assert.equal(cache.size, 2);
  assert.deepEqual(cache.entries(), [['b', 2], ['a', 9]]);
  time.now = 10;
  assert.deepEqual(cache.entries(), [['a', 9]]);
  time.now = 18;
  assert.equal(cache.get('a'), 9);
  time.now = 19;
  assert.equal(cache.get('a'), undefined);
});

test('replacement at the old deadline inserts with a new expiry after cleanup', () => {
  const { cache, time } = createTestCache();
  cache.set('a', 1);
  time.now = 5;
  cache.set('b', 2);
  time.now = 10;
  cache.set('a', 9);
  assert.deepEqual(cache.entries(), [['b', 2], ['a', 9]]);
  time.now = 19;
  assert.equal(cache.get('a'), 9);
  time.now = 20;
  assert.equal(cache.delete('a'), false);
});

for (const [name, remove] of [
  ['deletion', cache => assert.equal(cache.delete('a'), true)],
  ['eviction', cache => cache.set('b', 2)],
]) {
  test(`reinsertion after ${name} is not affected by the old expiry`, () => {
    const { cache, time } = createTestCache({ capacity: 1 });
    cache.set('a', 1);
    time.now = 2;
    remove(cache);
    time.now = 5;
    cache.set('a', 9);
    time.now = 10;
    assert.equal(cache.get('a'), 9);
    time.now = 15;
    assert.equal(cache.has('a'), false);
  });
}

test('stored undefined becomes absent at expiry', () => {
  const { cache, time } = createTestCache();
  cache.set('a', undefined);
  assert.equal(cache.has('a'), true);
  time.now = 10;
  assert.equal(cache.has('a'), false);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.delete('a'), false);
});

test('a single sampled time applies to every entry at a deadline', () => {
  let now = 0;
  let calls = 0;
  let ticking = false;
  const cache = createTtlCache({ capacity: 3, ttlMs: 10, clock: () => {
    calls += 1;
    return ticking ? now++ : now;
  } });
  cache.set('a', 1);
  now = 1;
  cache.set('b', 2);
  now = 2;
  cache.set('c', 3);
  now = 10;
  ticking = true;
  const before = calls;
  assert.deepEqual(cache.entries(), [['b', 2], ['c', 3]]);
  assert.equal(calls, before + 1);
});

const timedOperations = [
  ['set insertion', cache => cache.set('c', 3)],
  ['set replacement', cache => cache.set('a', 9)],
  ['get hit', cache => cache.get('a')],
  ['get miss', cache => cache.get('missing')],
  ['has hit', cache => cache.has('a')],
  ['has miss', cache => cache.has('missing')],
  ['delete hit', cache => cache.delete('a')],
  ['delete miss', cache => cache.delete('missing')],
  ['entries', cache => cache.entries()],
  ['size', cache => cache.size],
];

const wrongTypes = [
  undefined, null, false, true, '10', '', 10n, Symbol('time'),
  new Number(10), {}, [10], () => 10,
];

for (const [name, operate] of timedOperations) {
  test(`${name} rejects invalid clock results once without changing state`, () => {
    for (const [readings, ErrorType] of [
      [wrongTypes, TypeError],
      [[NaN, Infinity, -Infinity], RangeError],
    ]) {
      for (const reading of readings) {
        const { cache, time } = createTestCache({ now: 10 });
        cache.set('a', 1).set('b', 2);
        time.now = reading;
        assert.throws(() => once(time, () => operate(cache)), ErrorType);
        time.now = 10;
        assert.deepEqual(cache.entries(), [['a', 1], ['b', 2]]);
        time.now = 19;
        assert.deepEqual(cache.entries(), [['a', 1], ['b', 2]]);
        cache.set('c', 3);
        assert.deepEqual(cache.entries(), [['b', 2], ['c', 3]]);
        time.now = 20;
        assert.deepEqual(cache.entries(), [['c', 3]]);
      }
    }
  });

  test(`${name} rejects successive backward readings without lowering the baseline`, () => {
    const { cache, time } = createTestCache({ now: 10 });
    cache.set('a', 1).set('b', 2);
    for (const reading of [9, 9.5]) {
      time.now = reading;
      assert.throws(() => once(time, () => operate(cache)), RangeError);
    }
    time.now = 10;
    assert.deepEqual(cache.entries(), [['a', 1], ['b', 2]]);
    time.now = 19;
    assert.deepEqual(cache.entries(), [['a', 1], ['b', 2]]);
    cache.set('c', 3);
    assert.deepEqual(cache.entries(), [['b', 2], ['c', 3]]);
    time.now = 20;
    assert.deepEqual(cache.entries(), [['c', 3]]);
  });

  test(`${name} propagates the exact clock exception without mutation or retry`, () => {
    for (const sentinel of [new Error('clock failed'), Symbol('failure'), undefined]) {
      const { cache, time } = createTestCache({ now: 10 });
      cache.set('a', 1).set('b', 2);
      time.throwing = true;
      time.error = sentinel;
      assert.throws(() => once(time, () => operate(cache)), error => error === sentinel);
      time.throwing = false;
      assert.deepEqual(cache.entries(), [['a', 1], ['b', 2]]);
      cache.set('c', 3);
      assert.deepEqual(cache.entries(), [['b', 2], ['c', 3]]);
      time.now = 20;
      assert.deepEqual(cache.entries(), []);
    }
  });

  test(`${name} still validates the clock on an empty cache`, () => {
    const { cache, time } = createTestCache();
    time.now = Infinity;
    assert.throws(() => once(time, () => operate(cache)), RangeError);
    time.now = '0';
    assert.throws(() => once(time, () => operate(cache)), TypeError);
    time.throwing = true;
    time.error = new Error('empty cache clock');
    assert.throws(() => once(time, () => operate(cache)), error => error === time.error);
    time.throwing = false;
    time.now = -10;
    assert.deepEqual(cache.entries(), []);
    time.now = -11;
    assert.throws(() => once(time, () => operate(cache)), RangeError);
  });
}

test('clock results are rejected without invoking conversion hooks', () => {
  const { cache, time } = createTestCache();
  let coercions = 0;
  time.now = {
    valueOf() { coercions += 1; return 0; },
    toString() { coercions += 1; return '0'; },
    [Symbol.toPrimitive]() { coercions += 1; return 0; },
  };
  assert.throws(() => once(time, () => cache.set('a', 1)), TypeError);
  assert.equal(coercions, 0);
  time.now = -10;
  assert.equal(cache.set('a', 1), cache);
});

test('zero is an accepted baseline and negative finite starting times are valid', () => {
  const { cache, time } = createTestCache({ now: -10 });
  cache.set('a', 1); // Expires at exactly zero.
  time.now = -1;
  assert.equal(cache.get('a'), 1);
  time.now = 0;
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0);
  time.now = -1;
  assert.throws(() => cache.set('b', 2), RangeError);
  time.now = 0;
  cache.set('b', 2);
  assert.equal(cache.get('b'), 2);
});

for (const [name, empty] of [
  ['get miss', cache => cache.get('missing')],
  ['has miss', cache => cache.has('missing')],
  ['delete miss', cache => cache.delete('missing')],
  ['empty entries', cache => cache.entries()],
  ['empty size', cache => cache.size],
  ['final deletion', cache => { cache.set('a', 1); cache.delete('a'); }],
  ['full expiry', (cache, time) => { cache.set('a', 1); time.now = 20; cache.entries(); }],
  ['clear', cache => { cache.set('a', 1); cache.clear(); }],
]) {
  test(`clock history survives ${name}`, () => {
    const { cache, time } = createTestCache({ now: 10 });
    empty(cache, time);
    const accepted = time.now;
    time.now -= 1;
    assert.throws(() => once(time, () => cache.size), RangeError);
    time.now = accepted;
    assert.deepEqual(cache.entries(), []);
  });
}

test('clear works with a broken clock, preserves history, and retains capacity and TTL', () => {
  const { cache, time } = createTestCache({ now: 10 });
  cache.set('a', 1).set('b', 2);
  time.throwing = true;
  time.error = new Error('broken clock');
  const before = time.calls;
  assert.equal(cache.clear(), undefined);
  assert.equal(cache.clear(), undefined);
  assert.equal(time.calls, before);
  time.throwing = false;
  time.now = 5;
  assert.throws(() => once(time, () => cache.size), RangeError);
  time.now = 10;
  assert.deepEqual(cache.entries(), []);
  cache.set('c', 3).set('d', 4).set('e', 5);
  assert.deepEqual(cache.entries(), [['d', 4], ['e', 5]]);
  time.now = 19;
  assert.equal(cache.size, 2);
  time.now = 20;
  assert.equal(cache.size, 0);
});

for (const key of ['a', 'c']) {
  for (const consequence of ['expiry', 'eviction']) {
    test(`overflowing set(${key}) preserves values, history, and ${consequence}`, () => {
      const { cache, time } = createTestCache({ ttlMs: Number.MAX_VALUE });
      cache.set('a', 1).set('b', 2);
      time.now = Number.MAX_VALUE / 2;
      assert.throws(() => once(time, () => cache.set(key, 9)), RangeError);
      time.now = 0;
      assert.deepEqual(cache.entries(), [['a', 1], ['b', 2]]);
      if (consequence === 'eviction') {
        cache.set('c', 3);
        assert.deepEqual(cache.entries(), [['b', 2], ['c', 3]]);
      } else {
        time.now = Number.MAX_VALUE / 2;
        assert.deepEqual(cache.entries(), [['a', 1], ['b', 2]]);
        time.now = Number.MAX_VALUE;
        assert.deepEqual(cache.entries(), []);
      }
    });
  }
}

for (const failedTime of [Number.MAX_VALUE / 4, Number.MAX_VALUE]) {
  test(`overflow at ${failedTime} does not purge stale entries or advance time`, () => {
    const M = Number.MAX_VALUE;
    const { cache, time } = createTestCache({ now: -M, ttlMs: M });
    cache.set('a', 1); // Expires at 0.
    time.now = -M / 2;
    cache.set('b', 2); // Expires at M / 2.
    time.now = failedTime;
    assert.throws(() => once(time, () => cache.set('c', 3)), RangeError);
    // Recover below the failed time so observation cannot mask an illicit purge.
    time.now = -M / 4;
    assert.deepEqual(cache.entries(), [['a', 1], ['b', 2]]);
  });
}

test('a first overflowing set leaves the time baseline unset', () => {
  const { cache, time } = createTestCache({
    now: Number.MAX_VALUE,
    ttlMs: Number.MAX_VALUE,
  });
  assert.throws(() => once(time, () => cache.set('a', 1)), RangeError);
  time.now = -1;
  assert.deepEqual(cache.entries(), []);
  cache.set('a', 2);
  assert.equal(cache.get('a'), 2);
});

test('finite expiry addition at the maximum magnitude is accepted', () => {
  const { cache, time } = createTestCache({ now: 1, ttlMs: Number.MAX_VALUE });
  assert.equal(cache.set('a', 1), cache);
  assert.equal(cache.get('a'), 1);
  time.now = Number.MAX_VALUE / 2;
  assert.equal(cache.has('a'), true);
  time.now = Number.MAX_VALUE;
  assert.equal(cache.has('a'), false);
});

for (const ttlMs of [0.5, Number.MIN_VALUE]) {
  test(`positive fractional TTL ${ttlMs} expires at the exact deadline`, () => {
    const { cache, time } = createTestCache({ ttlMs });
    cache.set('a', 1);
    assert.equal(cache.get('a'), 1);
    time.now = ttlMs;
    assert.equal(cache.get('a'), undefined);
  });
}

test('rounding an expiry to now is accepted and expires on the next operation', () => {
  const { cache, time } = createTestCache({ now: 1_800_000_000_000, ttlMs: 0.0001 });
  assert.equal(once(time, () => cache.set('a', 1)), cache);
  assert.equal(once(time, () => cache.has('a')), false);
});

test('object keys use identity through lookup, promotion, replacement, and eviction', () => {
  const { cache } = createTestCache();
  const first = { id: 1 };
  const second = { id: 1 };
  const third = { id: 1 };
  cache.set(first, 'first').set(second, 'second');
  assert.equal(cache.has(third), false);
  assert.equal(cache.get(first), 'first');
  assert.equal(cache.entries()[0][0], second);
  cache.set(second, 'updated');
  assert.equal(cache.entries()[0][0], first);
  cache.set(third, 'third');
  assert.equal(cache.has(first), false);
  assert.equal(cache.delete(second), true);
  assert.equal(cache.delete(second), false);
  assert.equal(cache.entries()[0][0], third);
});

test('NaN is one key, signed zero aliases, and numeric and string keys differ', () => {
  const { cache } = createTestCache({ capacity: 4 });
  cache.set(NaN, 'first').set(-0, 'zero').set(1, 'number').set('1', 'string');
  assert.equal(cache.has(Number('NaN')), true);
  assert.equal(cache.get(NaN), 'first');
  cache.set(Number('NaN'), 'updated');
  assert.equal(cache.size, 4);
  assert.equal(cache.get(+0), 'zero');
  cache.set(+0, 'updated zero');
  assert.deepEqual(cache.entries(), [
    [1, 'number'], ['1', 'string'], [NaN, 'updated'], [0, 'updated zero'],
  ]);
  assert.equal(cache.delete(-0), true);
  assert.equal(cache.delete(+0), false);
  assert.equal(cache.delete(NaN), true);
  assert.deepEqual(cache.entries(), [[1, 'number'], ['1', 'string']]);
});

test('an actual undefined LRU key is evicted normally', () => {
  const { cache } = createTestCache();
  cache.set(undefined, 1).set('b', 2).set('c', 3);
  assert.equal(cache.has(undefined), false);
  assert.deepEqual(cache.entries(), [['b', 2], ['c', 3]]);
});

for (const [name, mutate] of [
  ['pair replacement', snapshot => { snapshot[0] = ['x', 9]; }],
  ['key replacement', snapshot => { snapshot[0][0] = 'x'; }],
  ['value replacement', snapshot => { snapshot[0][1] = 9; }],
  ['reordering', snapshot => { snapshot.reverse(); }],
  ['splicing', snapshot => { snapshot.splice(0, 1); }],
  ['appending', snapshot => { snapshot.push(['x', 9]); }],
]) {
  test(`snapshot ${name} cannot alter cache contents or eviction order`, () => {
    const { cache } = createTestCache();
    cache.set('a', 1).set('b', 2);
    const snapshot = cache.entries();
    const another = cache.entries();
    assert.equal(Object.getPrototypeOf(snapshot), Array.prototype);
    assert.notEqual(snapshot, another);
    for (let index = 0; index < snapshot.length; index += 1) {
      assert.equal(Object.getPrototypeOf(snapshot[index]), Array.prototype);
      assert.notEqual(snapshot[index], another[index]);
    }
    mutate(snapshot);
    assert.deepEqual(another, [['a', 1], ['b', 2]]);
    assert.deepEqual(cache.entries(), [['a', 1], ['b', 2]]);
    cache.set('c', 3);
    assert.deepEqual(cache.entries(), [['b', 2], ['c', 3]]);
  });
}

test('snapshots stay unchanged through replacement, eviction, deletion, expiry, and clear', () => {
  const { cache, time } = createTestCache();
  const empty = cache.entries();
  assert.notEqual(empty, cache.entries());
  assert.equal(Object.getPrototypeOf(empty), Array.prototype);
  cache.set('a', 1).set('b', 2);
  const original = cache.entries();
  cache.get('a');
  cache.set('b', 20);
  cache.set('c', 3);
  const beforeDelete = cache.entries();
  cache.delete('b');
  const beforeExpiry = cache.entries();
  time.now = 10;
  assert.deepEqual(cache.entries(), []);
  cache.set('d', 4);
  const beforeClear = cache.entries();
  cache.clear();
  assert.deepEqual(empty, []);
  assert.deepEqual(original, [['a', 1], ['b', 2]]);
  assert.deepEqual(beforeDelete, [['b', 20], ['c', 3]]);
  assert.deepEqual(beforeExpiry, [['c', 3]]);
  assert.deepEqual(beforeClear, [['d', 4]]);
});

test('snapshot isolation preserves shared object key and value references', () => {
  const { cache } = createTestCache();
  const key = { id: 1 };
  const value = { count: 1 };
  cache.set(key, value).set('b', 2);
  const snapshot = cache.entries();
  assert.equal(snapshot[0][0], key);
  assert.equal(snapshot[0][1], value);
  snapshot[0][0].id = 2;
  snapshot[0][1].count = 3;
  assert.equal(cache.entries()[0][1], value);
  assert.equal(value.count, 3);
  assert.equal(key.id, 2);
  cache.set('c', 3);
  assert.equal(cache.has(key), false);
  assert.deepEqual(cache.entries(), [['b', 2], ['c', 3]]);
});

test('interleaved caches have independent contents, recency, capacity, TTL, and time', () => {
  const first = createTestCache({ now: 100 });
  const second = createTestCache({ now: -10, capacity: 1, ttlMs: 20 });
  first.cache.set('a', 1).set('b', 2);
  second.cache.set('a', 'other');
  first.cache.get('a');
  second.cache.set('b', 'new');
  first.cache.set('c', 3);
  assert.deepEqual(first.cache.entries(), [['a', 1], ['c', 3]]);
  assert.deepEqual(second.cache.entries(), [['b', 'new']]);
  first.time.now = 110;
  assert.equal(first.cache.size, 0);
  second.time.now = 0;
  assert.equal(second.cache.get('b'), 'new');
  first.cache.clear();
  first.time.now = 109;
  assert.throws(() => first.cache.entries(), RangeError);
  second.time.now = 9;
  assert.equal(second.cache.has('b'), true);
  second.time.now = 10;
  assert.equal(second.cache.has('b'), false);
});

test('missing configuration throws TypeError', () => {
  assert.throws(() => createTtlCache(), TypeError);
  assert.throws(() => createTtlCache(null), TypeError);
  assert.throws(() => createTtlCache({}), TypeError);
  assert.throws(() => createTtlCache({ capacity: 2 }), TypeError);
  assert.throws(() => createTtlCache({ ttlMs: 10 }), TypeError);
});

for (const field of ['capacity', 'ttlMs']) {
  test(`${field} rejects non-number types before calling the clock`, () => {
    let calls = 0;
    for (const value of wrongTypes) {
      assert.throws(() => createTtlCache({
        capacity: 2,
        ttlMs: 10,
        [field]: value,
        clock: () => { calls += 1; return 0; },
      }), TypeError);
    }
    assert.equal(calls, 0);
  });

  test(`${field} rejects numeric domain violations before calling the clock`, () => {
    const invalid = [0, -0, -1, NaN, Infinity, -Infinity];
    if (field === 'capacity') {
      invalid.push(0.5, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE);
    }
    let calls = 0;
    for (const value of invalid) {
      assert.throws(() => createTtlCache({
        capacity: 2,
        ttlMs: 10,
        [field]: value,
        clock: () => { calls += 1; return 0; },
      }), RangeError);
    }
    assert.equal(calls, 0);
  });
}

test('configuration rejects coercible objects without invoking their hooks', () => {
  let coercions = 0;
  const value = {
    valueOf() { coercions += 1; return 2; },
    toString() { coercions += 1; return '2'; },
    [Symbol.toPrimitive]() { coercions += 1; return 2; },
  };
  for (const field of ['capacity', 'ttlMs', 'clock']) {
    assert.throws(() => createTtlCache({
      capacity: 2, ttlMs: 10, clock: () => 0, [field]: value,
    }), TypeError);
  }
  assert.equal(coercions, 0);
});

test('non-function supplied clocks throw TypeError', () => {
  const invalid = wrongTypes.filter(value => value !== undefined && typeof value !== 'function');
  invalid.push(0, 1, NaN, Infinity, -Infinity);
  for (const clock of invalid) {
    assert.throws(() => createTtlCache({ capacity: 2, ttlMs: 10, clock }), TypeError);
  }
});

test('maximum safe capacity and large finite TTL work without allocating to capacity', () => {
  const { cache } = createTestCache({
    capacity: Number.MAX_SAFE_INTEGER,
    ttlMs: Number.MAX_SAFE_INTEGER + 1,
  });
  cache.set('a', 1).set('b', 2).set('c', 3);
  assert.equal(cache.size, 3);
  assert.equal(cache.get('a'), 1);
  assert.deepEqual(cache.entries(), [['b', 2], ['c', 3], ['a', 1]]);
});

for (const [name, options] of [['omitted', {}], ['explicit undefined', { clock: undefined }]]) {
  test(`${name} clock uses Date.now and rejects its backward readings`, t => {
    const time = { now: 100, calls: 0 };
    t.mock.method(Date, 'now', () => { time.calls += 1; return time.now; });
    const cache = createTtlCache({ capacity: 2, ttlMs: 10, ...options });
    assert.equal(time.calls, 0);
    assert.equal(once(time, () => cache.set('a', 1)), cache);
    time.now = 109;
    assert.equal(once(time, () => cache.get('a')), 1);
    time.now = 110;
    assert.deepEqual(once(time, () => cache.entries()), []);
    time.now = 109;
    assert.throws(() => once(time, () => cache.size), RangeError);
    assert.throws(() => once(time, () => cache.entries()), RangeError);
    time.now = 110;
    assert.equal(once(time, () => cache.size), 0);
  });
}
