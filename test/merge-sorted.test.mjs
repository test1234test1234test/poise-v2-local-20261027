import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSorted } from '../lib/merge-sorted.mjs';

const ascending = (a, b) => a - b;

function tracked(values, { close = () => ({ done: true }), events = [], name = '' } = {}) {
  const stats = { opens: 0, next: 0, returnGets: 0, returns: 0 };
  let index = 0;
  let exhausted = false;
  const iterator = {
    next(...args) {
      assert.strictEqual(this, iterator);
      assert.deepEqual(args, []);
      assert.equal(exhausted, false, 'must not pull an exhausted iterator');
      stats.next++;
      if (index === values.length) {
        exhausted = true;
        return { done: true, get value() { assert.fail('must not read exhausted value'); } };
      }
      return { done: false, value: values[index++] };
    },
    get return() {
      assert.equal(exhausted, false, 'must not look up cleanup after exhaustion');
      stats.returnGets++;
      return function (...args) {
        assert.strictEqual(this, iterator);
        assert.deepEqual(args, []);
        stats.returns++;
        events.push(name);
        return close();
      };
    },
  };
  const source = {
    [Symbol.iterator](...args) {
      assert.strictEqual(this, source);
      assert.deepEqual(args, []);
      stats.opens++;
      return iterator;
    },
  };
  return { source, iterator, stats };
}

function assertReferences(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    assert.ok(Object.is(actual[index], expected[index]), `reference at index ${index}`);
  }
}

function assertThrownValue(action, expected) {
  let threw = false;
  try {
    action();
  } catch (error) {
    threw = true;
    assert.ok(Object.is(error, expected), 'must preserve the exact thrown value');
  }
  assert.equal(threw, true, 'must throw');
}

function assertTerminal(merged, fixtures = []) {
  const before = fixtures.map(({ stats }) => ({ ...stats }));
  assert.deepEqual(merged.next(), { done: true, value: undefined });
  assert.deepEqual(merged.return('finished'), { done: true, value: 'finished' });
  assert.deepEqual(merged.next(), { done: true, value: undefined });
  assert.deepEqual(fixtures.map(({ stats }) => stats), before);
}

test('zero, empty and single sources are iterable iterators without comparison', () => {
  for (const values of [[], [1, 2, 3]]) {
    const fixture = tracked(values);
    const merged = mergeSorted([fixture.source], () => assert.fail('no comparison needed'));
    assert.strictEqual(merged[Symbol.iterator](), merged);
    assert.deepEqual([...merged], values);
    assert.deepEqual(fixture.stats, { opens: 1, next: values.length + 1, returnGets: 0, returns: 0 });
    assertTerminal(merged, [fixture]);
  }
  const empty = mergeSorted([], () => assert.fail('no comparison needed'));
  assert.deepEqual([...empty], []);
  assertTerminal(empty);
  assert.deepEqual([...mergeSorted([[], [], []], ascending)], []);
});

test('merges arrays, strings, generators and iterators that are not iterable', () => {
  function* letters() { yield 'b'; yield 'e'; }
  const custom = tracked(['c', 'f']);
  assert.equal(custom.iterator[Symbol.iterator], undefined);
  assert.deepEqual(
    [...mergeSorted(['ad', letters(), custom.source, ['g']], (a, b) => a < b ? -1 : a > b ? 1 : 0)],
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  );
});

test('preserves duplicate source order and frozen object identities in both directions', () => {
  for (const direction of [1, -1]) {
    const a = Object.freeze({ key: 2 });
    const b = Object.freeze({ key: 2 });
    const c = Object.freeze({ key: 2 });
    const d = Object.freeze({ key: 2 });
    const low = Object.freeze({ key: 1 });
    const high = Object.freeze({ key: 3 });
    const sources = direction === 1
      ? [[low, a, b, a], [], [c, d, high]]
      : [[high, a, b, a], [], [c, d, low]];
    sources.forEach(Object.freeze);
    Object.freeze(sources);
    const expected = direction === 1 ? [low, a, b, a, c, d, high] : [high, a, b, a, c, d, low];
    assertReferences([...mergeSorted(sources, (x, y) => direction * (x.key - y.key))], expected);
  }
});

test('all-equal payloads include non-numbers, infinities and repeated references without coercion', () => {
  const opaque = Object.freeze({ [Symbol.toPrimitive]() { assert.fail('must not coerce elements'); } });
  const values = [undefined, null, false, NaN, Infinity, -Infinity, 1n, Symbol('value'),
    () => {}, Promise.resolve(1), opaque, -0, +0, opaque];
  for (const zero of [0, -0]) {
    const sources = Object.freeze([Object.freeze(values.slice(0, 8)), [], Object.freeze(values.slice(8))]);
    assertReferences([...mergeSorted(sources, () => zero)], values);
  }
  assert.deepEqual([...mergeSorted([[Infinity], [Infinity]], () => 0)], [Infinity, Infinity]);
});

test('repeating an iterable array opens independent iterators', () => {
  const array = Object.freeze([1, 2, 3]);
  assert.deepEqual([...mergeSorted([array, array], ascending)], [1, 1, 2, 2, 3, 3]);
});

test('matches a deterministic finite occurrence oracle across heap sizes and directions', () => {
  let seed = 76;
  const random = limit => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  for (const direction of [1, -1]) {
    for (let run = 0; run < 50; run++) {
      const sources = Array.from({ length: random(17) }, () =>
        Array.from({ length: random(25) }, () => ({ key: random(9) }))
          .sort((a, b) => direction * (a.key - b.key)));
      const expected = sources.flatMap((values, source) =>
        values.map((value, offset) => ({ value, source, offset })))
        .sort((a, b) => direction * (a.value.key - b.value.key) || a.source - b.source || a.offset - b.offset)
        .map(entry => entry.value);
      assertReferences([...mergeSorted(sources, (a, b) => direction * (a.key - b.key))], expected);
    }
  }
});

test('interprets fractional and extreme finite comparator returns only by sign', () => {
  for (const magnitude of [0.25, Number.MIN_VALUE, Number.MAX_VALUE]) {
    for (const direction of [1, -1]) {
      const sources = direction === 1 ? [[1, 3, 5], [2, 4, 6]] : [[5, 3, 1], [6, 4, 2]];
      const result = [...mergeSorted(sources, (a, b) => direction * Math.sign(a - b) * magnitude)];
      assert.deepEqual(result, direction === 1 ? [1, 2, 3, 4, 5, 6] : [6, 5, 4, 3, 2, 1]);
    }
  }
});

test('validates the outer Array and comparator immediately, including empty arrays', () => {
  const invalid = [undefined, null, false, 1, 'source', 1n, Symbol(), {}, { length: 0 }, new Set(), () => {}];
  for (const sources of invalid) assert.throws(() => mergeSorted(sources, ascending), TypeError);
  for (const compare of invalid.filter(value => typeof value !== 'function').concat([[], new Number(0)])) {
    assert.throws(() => mergeSorted([], compare), TypeError);
    assert.throws(() => mergeSorted([[1]], compare), TypeError);
  }
  assert.throws(() => mergeSorted([]), TypeError);
  assert.throws(() => mergeSorted(), TypeError);
});

test('construction and return before first next do not access or open any sources', () => {
  const sources = [];
  Object.defineProperty(sources, 0, { get() { assert.fail('must not read source'); } });
  const merged = mergeSorted(sources, ascending);
  assert.strictEqual(merged[Symbol.iterator](), merged);
  assert.deepEqual(merged.return(42), { done: true, value: 42 });
  assertTerminal(merged);
});

test('opens once per source and refills only the previous winner on the next consumer pull', () => {
  const fixtures = [[0, 3, 6], [1, 4, 7], [2, 5, 8]].map(values => tracked(values));
  const merged = mergeSorted(fixtures.map(f => f.source), ascending);
  assert.deepEqual(fixtures.map(f => f.stats.opens), [0, 0, 0]);
  for (const [value, counts] of [[0, [1, 1, 1]], [1, [2, 1, 1]], [2, [2, 2, 1]], [3, [2, 2, 2]]]) {
    assert.deepEqual(merged.next(), { done: false, value });
    assert.deepEqual(fixtures.map(f => f.stats.next), counts);
    assert.deepEqual(fixtures.map(f => f.stats.returnGets), [0, 0, 0]);
  }
  assert.deepEqual(fixtures.map(f => f.stats.opens), [1, 1, 1]);
  merged.return();
  assert.deepEqual(fixtures.map(f => f.stats.next), [2, 2, 2]);
  assert.deepEqual(fixtures.map(f => f.stats.returns), [1, 1, 1]);
  assertTerminal(merged, fixtures);
});

test('bounds pulls from an infinite-style source and closes it on for-of break', () => {
  let pulls = 0;
  let closes = 0;
  function* infinite() {
    try {
      for (let value = 0; ; value += 2) {
        if (++pulls > 4) throw new Error('lookahead budget exceeded');
        yield value;
      }
    } finally {
      closes++;
    }
  }
  const finite = tracked([1, 3, 5, 7, 9]);
  const merged = mergeSorted([infinite(), finite.source], ascending);
  const values = [];
  for (const value of merged) {
    values.push(value);
    if (values.length === 7) break;
  }
  assert.deepEqual(values, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(pulls, 4);
  assert.equal(finite.stats.next, 4);
  assert.equal(pulls + finite.stats.next, 2 + values.length - 1);
  assert.equal(closes, 1);
  assert.equal(finite.stats.returns, 1);
  assertTerminal(merged, [finite]);
});

test('many interleaved sources use logarithmic comparison work', () => {
  const k = 128;
  const rounds = 64;
  const sources = Array.from({ length: k }, (_, source) =>
    Array.from({ length: rounds }, (_, offset) => offset * k + source));
  const n = k * rounds;
  const bound = 8 * (n + k) * Math.ceil(Math.log2(k));
  let comparisons = 0;
  const actual = [...mergeSorted(sources, (a, b) => {
    assert.ok(++comparisons <= bound, 'comparison budget exceeded');
    return a - b;
  })];
  assert.deepEqual(actual, Array.from({ length: n }, (_, index) => index));
});

test('selection cost shrinks with live sources and a single tail needs no comparisons', () => {
  const short = Array.from({ length: 126 }, (_, index) => [index]);
  const even = Array.from({ length: 1024 }, (_, index) => 126 + index * 2);
  const odd = Array.from({ length: 1024 }, (_, index) => 127 + index * 2);
  let comparisons = 0;
  const merged = mergeSorted([...short, even, odd], (a, b) => { comparisons++; return a - b; });
  for (let value = 0; value <= 126; value++) assert.equal(merged.next().value, value);
  const tailStart = comparisons;
  assert.deepEqual([...merged], Array.from({ length: 2047 }, (_, index) => index + 127));
  assert.ok(comparisons - tailStart <= 4 * 2047, 'tail cost must depend on two live sources');

  comparisons = 0;
  const single = mergeSorted([...short, [126, 127, 128, 129]], (a, b) => { comparisons++; return a - b; });
  for (let value = 0; value <= 126; value++) assert.equal(single.next().value, value);
  const singleStart = comparisons;
  assert.deepEqual([...single], [127, 128, 129]);
  assert.equal(comparisons, singleStart);
});

test('invalid sources fail only when opened, after closing the already opened live prefix', () => {
  const invalid = [undefined, null, 0, false, Symbol(), {}, { next() {} },
    { [Symbol.iterator]: 1 }, { [Symbol.iterator]: null },
    { async *[Symbol.asyncIterator]() { yield 1; } }];
  for (const source of invalid) {
    const live = tracked([1]);
    const empty = tracked([]);
    const never = tracked([3]);
    const merged = mergeSorted([live.source, empty.source, source, never.source], ascending);
    assert.equal(live.stats.opens, 0);
    assert.throws(() => merged.next(), TypeError);
    assert.equal(live.stats.returns, 1);
    assert.equal(empty.stats.returnGets, 0);
    assert.equal(never.stats.opens, 0);
    assertTerminal(merged, [live, empty, never]);
  }
});

test('factory lookup/call failures preserve the original error and do not open later sources', () => {
  const primary = {};
  for (const source of [
    { get [Symbol.iterator]() { throw primary; } },
    { [Symbol.iterator]() { throw primary; } },
  ]) {
    const live = tracked([1], { close() { throw new Error('cleanup'); } });
    const never = tracked([3]);
    const merged = mergeSorted([live.source, source, never.source], ascending);
    assertThrownValue(() => merged.next(), primary);
    assert.equal(live.stats.returns, 1);
    assert.equal(never.stats.opens, 0);
    assertTerminal(merged, [live, never]);
  }
});

test('rejects primitive iterator and next results and non-callable next methods', () => {
  for (const value of [undefined, null, false, 0, 'result', 1n, Symbol()]) {
    const prior = tracked([1]);
    const invalidIterator = { [Symbol.iterator]() { return value; } };
    assert.throws(() => mergeSorted([prior.source, invalidIterator], ascending).next(), TypeError);
    assert.equal(prior.stats.returns, 1);

    const badResult = tracked([]);
    badResult.iterator.next = () => value;
    const merged = mergeSorted([badResult.source], ascending);
    assert.throws(() => merged.next(), TypeError);
    assert.equal(badResult.stats.returns, 1, 'the failing iterator is owned');
    assertTerminal(merged, [badResult]);

    const badNext = tracked([]);
    badNext.iterator.next = value;
    const badMethod = mergeSorted([badNext.source], ascending);
    assert.throws(() => badMethod.next(), TypeError);
    assert.equal(badNext.stats.returns, 1);
    assertTerminal(badMethod, [badNext]);
  }
});

for (const stage of ['next lookup', 'next call', 'done lookup', 'value lookup']) {
  test(`owns the failing iterator during ${stage} and cleans up the live prefix`, () => {
    const primary = new Error(stage);
    const events = [];
    const live = tracked([1], { events, name: 'live' });
    const empty = tracked([]);
    const failing = tracked([], { events, name: 'failing', close() { throw new Error('cleanup'); } });
    const never = tracked([3]);
    if (stage === 'next lookup') {
      Object.defineProperty(failing.iterator, 'next', { get() { throw primary; } });
    } else {
      failing.iterator.next = () => {
        if (stage === 'next call') throw primary;
        if (stage === 'done lookup') return { get done() { throw primary; } };
        return { done: false, get value() { throw primary; } };
      };
    }
    const merged = mergeSorted([live.source, empty.source, failing.source, never.source], ascending);
    assertThrownValue(() => merged.next(), primary);
    assert.deepEqual(events, ['live', 'failing']);
    assert.equal(failing.stats.returns, 1);
    assert.equal(empty.stats.returnGets, 0);
    assert.equal(never.stats.opens, 0);
    assertTerminal(merged, [live, empty, failing, never]);
  });
}

test('captures length on first iteration and uses live indexed reads, ignoring the outer iterator', () => {
  const sources = [];
  const merged = mergeSorted(sources, ascending);
  const first = {
    [Symbol.iterator]() {
      sources[1] = [2];
      sources.push([0]); // Appends during opening are beyond the captured length.
      return [1][Symbol.iterator]();
    },
  };
  sources.push(first, [99]); // Changes before first next are included.
  Object.defineProperty(sources, Symbol.iterator, { get() { assert.fail('must use indices'); } });
  assert.deepEqual([...merged], [1, 2]);

  class Sources extends Array {}
  Sources.prototype[0] = [1];
  assert.deepEqual([...mergeSorted(new Sources(1), ascending)], [1]);
  const sparse = mergeSorted(new Array(1), ascending);
  assert.throws(() => sparse.next(), TypeError);
});

test('an outer indexed getter failure closes the opened prefix', () => {
  const primary = {};
  const live = tracked([1]);
  const never = tracked([3]);
  const sources = [live.source, null, never.source];
  Object.defineProperty(sources, 1, { get() { throw primary; } });
  const merged = mergeSorted(sources, ascending);
  assertThrownValue(() => merged.next(), primary);
  assert.equal(live.stats.returns, 1);
  assert.equal(never.stats.opens, 0);
  assertTerminal(merged, [live, never]);
});

test('accepts callable objects as sources, iterators and results, and observes truthy done', () => {
  const iterator = () => {};
  let pulls = 0;
  iterator.next = () => {
    const result = () => {};
    if (pulls++ === 0) {
      result.done = 0;
      result.value = undefined;
    } else {
      result.done = 'finished';
      Object.defineProperty(result, 'value', { get() { assert.fail('no exhausted value read'); } });
    }
    return result;
  };
  Object.defineProperty(iterator, 'return', { get() { assert.fail('no cleanup after exhaustion'); } });
  const source = () => {};
  source[Symbol.iterator] = () => iterator;
  assertReferences([...mergeSorted([source], ascending)], [undefined]);
  assert.equal(pulls, 2);
});

test('captures next once and looks up the current return only at cleanup', () => {
  let nextGets = 0;
  let pulls = 0;
  let closes = 0;
  let closeGets = 0;
  const iterator = {
    get next() {
      assert.equal(++nextGets, 1);
      return function () {
        assert.strictEqual(this, iterator);
        Object.defineProperty(iterator, 'next', { get() { assert.fail('must use captured next'); } });
        Object.defineProperty(iterator, 'return', {
          configurable: true,
          get() {
            closeGets++;
            return function () {
              assert.strictEqual(this, iterator);
              closes++;
              return { done: true };
            };
          },
        });
        return { value: ++pulls, done: false };
      };
    },
    get return() { assert.fail('must not capture return before cancellation'); },
  };
  const merged = mergeSorted([{ [Symbol.iterator]() { return iterator; } }], ascending);
  assert.equal(merged.next().value, 1);
  assert.equal(merged.next().value, 2);
  assert.equal(closeGets, 0);
  merged.return();
  assert.equal(nextGets, 1);
  assert.equal(closeGets, 1);
  assert.equal(closes, 1);
  assertTerminal(merged);
});

test('buffers each value once even when independent iterators share a result object', () => {
  const result = {};
  const source = values => ({
    [Symbol.iterator]() {
      let index = 0;
      return {
        next() {
          result.done = index === values.length;
          let reads = 0;
          const value = values[index++];
          Object.defineProperty(result, 'value', {
            configurable: true,
            get() {
              assert.equal(result.done, false);
              assert.equal(++reads, 1, 'read each yielded value only once');
              return value;
            },
          });
          return result;
        },
      };
    },
  });
  assert.deepEqual([...mergeSorted([source([1, 3]), source([2, 4])], ascending)], [1, 2, 3, 4]);
});

test('rejects shared iterator objects without pulling or closing them twice', () => {
  for (const values of [[], [1, 2, 3]]) {
    for (const wrappers of [false, true]) {
      const fixture = tracked(values);
      fixture.iterator[Symbol.iterator] = function () { return this; };
      const sources = wrappers
        ? [fixture.source, { [Symbol.iterator]() { return fixture.iterator; } }]
        : [fixture.iterator, fixture.iterator];
      const merged = mergeSorted(sources, ascending);
      assert.throws(() => merged.next(), TypeError);
      assert.equal(fixture.stats.next, 1);
      assert.equal(fixture.stats.returns, values.length === 0 ? 0 : 1);
      assertTerminal(merged, [fixture]);
    }
  }
});

test('rejects every non-finite or non-primitive comparator result without coercion and closes sources', () => {
  const uncoercible = { [Symbol.toPrimitive]() { assert.fail('must not coerce comparison results'); } };
  for (const result of [NaN, Infinity, -Infinity, undefined, null, true, false, '0', 0n,
    Symbol(), new Number(0), {}, [], () => 0, Promise.resolve(0), uncoercible]) {
    const fixtures = [tracked([1]), tracked([2])];
    const merged = mergeSorted(fixtures.map(f => f.source), () => result);
    assert.throws(() => merged.next(), TypeError);
    assert.deepEqual(fixtures.map(f => f.stats.returns), [1, 1]);
    assertTerminal(merged, fixtures);
  }
  const fixtures = [tracked([-Number.MAX_VALUE]), tracked([Number.MAX_VALUE])];
  const overflow = mergeSorted(fixtures.map(f => f.source), ascending);
  assert.throws(() => overflow.next(), TypeError);
  assert.deepEqual(fixtures.map(f => f.stats.returns), [1, 1]);
  assertTerminal(overflow, fixtures);
});

test('comparison failure after delivery closes every owned iterator despite partial heap repair', () => {
  const primary = {};
  const fixtures = Array.from({ length: 15 }, (_, index) =>
    tracked([index, index + 15], { close() { throw new Error('cleanup'); } }));
  let armed = false;
  let laterComparisons = 0;
  const merged = mergeSorted(fixtures.map(f => f.source), (a, b) => {
    if (armed && ++laterComparisons === 3) throw primary;
    return a - b;
  });
  assert.equal(merged.next().value, 0);
  armed = true;
  assertThrownValue(() => merged.next(), primary);
  assert.deepEqual(fixtures.map(f => f.stats.returns), Array(15).fill(1));
  assertTerminal(merged, fixtures);
});

test('comparison failure after a winner exhausts leaves that iterator unclosed', () => {
  const fixtures = [tracked([0]), tracked([1, 4]), tracked([2, 5]), tracked([3, 6])];
  const primary = {};
  let armed = false;
  const merged = mergeSorted(fixtures.map(f => f.source), (a, b) => {
    if (armed) throw primary;
    return a - b;
  });
  assert.equal(merged.next().value, 0);
  armed = true;
  assertThrownValue(() => merged.next(), primary);
  assert.deepEqual(fixtures.map(f => f.stats.returns), [0, 1, 1, 1]);
  assertTerminal(merged, fixtures);
});

for (const shape of ['single source', 'several shrinking to one']) {
  for (const ending of ['complete', 'return', 'next failure', 'done failure', 'value failure']) {
    test(`${shape}: preserves its buffered value and lifecycle on ${ending}`, () => {
      const primary = {};
      const cleanup = {};
      const survivor = tracked([1, 2, 3], { close() { throw cleanup; } });
      if (ending.endsWith('failure')) {
        const next = survivor.iterator.next;
        survivor.iterator.next = function () {
          if (survivor.stats.next === 0) return next.call(this);
          survivor.stats.next++;
          if (ending === 'next failure') throw primary;
          if (ending === 'done failure') return { get done() { throw primary; } };
          return { done: false, get value() { throw primary; } };
        };
      }
      const fixtures = shape === 'single source' ? [survivor] : [tracked([0]), survivor, tracked([])];
      const merged = mergeSorted(fixtures.map(f => f.source), ascending);
      if (shape !== 'single source') assert.equal(merged.next().value, 0);
      assert.deepEqual(merged.next(), { done: false, value: 1 });
      assert.equal(survivor.stats.next, 1, 'deliver before refilling');
      if (ending === 'complete') {
        assert.deepEqual([...merged], [2, 3]);
        assert.equal(survivor.stats.returnGets, 0);
      } else {
        if (ending === 'return') {
          assertThrownValue(() => merged.return(), cleanup);
          assert.equal(survivor.stats.next, 1, 'return must not pull');
        } else {
          assertThrownValue(() => merged.next(), primary);
        }
        assert.equal(survivor.stats.returns, 1);
      }
      for (const fixture of fixtures.filter(f => f !== survivor)) assert.equal(fixture.stats.returnGets, 0);
      assertTerminal(merged, fixtures);
    });
  }
}

test('all exhausted sources stop being pulled and no cleanup hook is accessed on completion', () => {
  const fixtures = [tracked([]), tracked([1]), tracked([2, 3]), tracked([]), tracked([4, 5, 6])];
  const merged = mergeSorted(fixtures.map(f => f.source), ascending);
  assert.deepEqual([...merged], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(fixtures.map(f => f.stats.next), [1, 2, 3, 1, 4]);
  assert.deepEqual(fixtures.map(f => f.stats.returnGets), [0, 0, 0, 0, 0]);
  assertTerminal(merged, fixtures);
});

test('normal cancellation propagates the first cleanup error in source order after trying all hooks', () => {
  for (const firstError of [undefined, null, false, 0, {}]) {
    const events = [];
    const first = tracked([10], { events, name: 'first', close() { throw firstError; } });
    const second = tracked([0]);
    Object.defineProperty(second.iterator, 'return', {
      get() { events.push('second getter'); throw new Error('later lookup failure'); },
    });
    const third = tracked([20], { events, name: 'third', close() { throw new Error('later call failure'); } });
    const fixtures = [first, second, third];
    const merged = mergeSorted(fixtures.map(f => f.source), ascending);
    assert.equal(merged.next().value, 0); // The selected source is not first in cleanup order.
    assertThrownValue(() => merged.return(), firstError);
    assert.deepEqual(events, ['first', 'second getter', 'third']);
    assertTerminal(merged, fixtures);
    assert.deepEqual(events, ['first', 'second getter', 'third']);
  }
});

test('preserves falsy and object primary throws from sources, comparators, and consumer throw', () => {
  for (const primary of [undefined, null, false, 0, {}]) {
    for (const origin of ['source', 'comparator', 'consumer']) {
      const fixtures = [tracked([1], { close() { throw new Error('cleanup'); } }),
        tracked([2], { close() { throw new Error('cleanup'); } })];
      if (origin === 'source') fixtures[1].iterator.next = () => { throw primary; };
      const compare = origin === 'comparator' ? () => { throw primary; } : ascending;
      const merged = mergeSorted(fixtures.map(f => f.source), compare);
      if (origin === 'consumer') {
        assert.equal(merged.next().value, 1);
        assertThrownValue(() => merged.throw(primary), primary);
      } else {
        assertThrownValue(() => merged.next(), primary);
      }
      assert.deepEqual(fixtures.map(f => f.stats.returns), [1, 1]);
      assertTerminal(merged, fixtures);
    }
  }
});

test('for-of body errors retain priority over cleanup failures and break propagates cleanup failure', () => {
  for (const exit of ['throw', 'break']) {
    const primary = {};
    const cleanup = {};
    const fixtures = [tracked([1], { close() { throw cleanup; } }), tracked([2])];
    const merged = mergeSorted(fixtures.map(f => f.source), ascending);
    assertThrownValue(() => {
      for (const value of merged) {
        assert.equal(value, 1);
        if (exit === 'throw') throw primary;
        break;
      }
    }, exit === 'throw' ? primary : cleanup);
    assert.deepEqual(fixtures.map(f => f.stats.returns), [1, 1]);
    assertTerminal(merged, fixtures);
  }
});

test('cleanup skips missing/null return, rejects malformed hooks/results, and still closes siblings', () => {
  for (const hook of [undefined, null, 0, false, 'return', {}, () => undefined, () => null,
    () => 0, () => 'result', () => false, () => Symbol()]) {
    const first = tracked([1]);
    const last = tracked([2]);
    Object.defineProperty(first.iterator, 'return', { value: hook });
    const merged = mergeSorted([first.source, last.source], ascending);
    assert.equal(merged.next().value, 1);
    if (hook === undefined || hook === null) {
      assert.deepEqual(merged.return(), { value: undefined, done: true });
    } else {
      assert.throws(() => merged.return(), TypeError);
    }
    assert.equal(last.stats.returns, 1);
    assertTerminal(merged, [first, last]);
  }
});

test('cleanup does not inspect result properties or retry a done:false cleanup result', () => {
  for (const result of [
    { done: false, get value() { assert.fail('must not read cleanup value'); } },
    { get done() { assert.fail('must not read cleanup done'); } },
    () => {},
  ]) {
    const fixture = tracked([1], { close: () => result });
    const merged = mergeSorted([fixture.source], ascending);
    merged.next();
    assert.deepEqual(merged.return('result'), { done: true, value: 'result' });
    assert.equal(fixture.stats.returns, 1);
    assertTerminal(merged, [fixture]);
  }
});

test('separate merges can interleave and terminate independently', () => {
  const firstSources = [tracked([1, 3]), tracked([2, 4])];
  const secondSources = [tracked([10, 30]), tracked([20, 40])];
  const first = mergeSorted(firstSources.map(f => f.source), ascending);
  const second = mergeSorted(secondSources.map(f => f.source), ascending);
  assert.equal(first.next().value, 1);
  assert.equal(second.next().value, 10);
  first.return();
  assert.deepEqual(firstSources.map(f => f.stats.returns), [1, 1]);
  assert.deepEqual(secondSources.map(f => f.stats.returns), [0, 0]);
  assert.deepEqual([...second], [20, 30, 40]);
  assertTerminal(first, firstSources);
  assertTerminal(second, secondSources);
});

test('nested merges close inner and outer live sources even if inner cleanup fails', () => {
  for (const failCleanup of [false, true]) {
    const primary = {};
    const innerSources = [tracked([1, 3], { close() { if (failCleanup) throw primary; return {}; } }),
      tracked([2, 4])];
    const inner = mergeSorted(innerSources.map(f => f.source), ascending);
    const sibling = tracked([5, 6]);
    const outer = mergeSorted([inner, sibling.source], ascending);
    assert.equal(outer.next().value, 1);
    if (failCleanup) assertThrownValue(() => outer.return(), primary);
    else outer.return();
    assert.deepEqual(innerSources.map(f => f.stats.returns), [1, 1]);
    assert.equal(sibling.stats.returns, 1);
    assertTerminal(inner, innerSources);
    assertTerminal(outer, [sibling]);
  }
});

test('reentrant next/return attempts throw TypeError without corrupting iteration or cleanup', () => {
  let merged;
  const attempt = () => {
    assert.throws(() => merged.next(), TypeError);
    assert.throws(() => merged.return(), TypeError);
  };
  const first = tracked([1, 3], { close() { attempt(); return {}; } });
  const next = first.iterator.next;
  first.iterator.next = function () { attempt(); return next.call(this); };
  const source = { [Symbol.iterator]() { attempt(); return first.iterator; } };
  const last = tracked([2, 4]);
  merged = mergeSorted([source, last.source], (a, b) => { attempt(); return a - b; });
  assert.equal(merged.next().value, 1);
  assert.equal(merged.next().value, 2);
  merged.return();
  assert.equal(first.stats.returns, 1);
  assert.equal(last.stats.returns, 1);
  assertTerminal(merged, [first, last]);
});
