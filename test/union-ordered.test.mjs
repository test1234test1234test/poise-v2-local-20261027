import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unionOrdered } from '../lib/union-ordered.mjs';

function assertThrownValue(action, expected) {
  let threw = false;
  try {
    action();
  } catch (error) {
    threw = true;
    assert.ok(Object.is(error, expected), 'preserves the exact thrown value');
  }
  assert.equal(threw, true, 'must throw, even for undefined');
}

function tracked(name, values, events) {
  let index = 0;
  const calls = [];
  const iterator = {
    get next() {
      events.push(`${name}:get next`);
      return function (...args) {
        events.push(`${name}:next`);
        calls.push({ receiver: this, args });
        return index < values.length ? { value: values[index++] } : { done: true };
      };
    },
    get return() {
      events.push(`${name}:get return`);
      return function (...args) {
        events.push(`${name}:return`);
        calls.push({ receiver: this, args });
        return {};
      };
    },
  };
  const source = {
    get [Symbol.iterator]() {
      events.push(`${name}:get iterator`);
      return function (...args) {
        events.push(`${name}:iterator`);
        calls.push({ factory: true, receiver: this, args });
        return iterator;
      };
    },
  };
  return { source, iterator, calls };
}

function assertCalls({ source, iterator, calls }) {
  for (const { factory, receiver, args } of calls) {
    assert.strictEqual(receiver, factory ? source : iterator);
    assert.deepEqual(args, []);
  }
}

function guarded(events) {
  return {
    get [Symbol.iterator]() {
      events.push('forbidden future iterator');
      throw new Error('must not access later sources after failure');
    },
  };
}

test('returns an eager array in source and first-occurrence order', () => {
  const result = unionOrdered([3, 1, 3], [], [2, 1], [4, 2]);
  assert.ok(Array.isArray(result));
  assert.deepEqual(result, [3, 1, 2, 4]);
  assert.deepEqual(unionOrdered([3, 1, 3], new Set([2, 1]), 'ab'), [3, 1, 2, 'a', 'b']);
});

test('empty and unique inputs produce fresh ordinary arrays and independent membership state', () => {
  const empty = { *[Symbol.iterator]() {} };
  for (const sources of [[], [[], new Set(), '', empty], [[1, 2]]]) {
    const expected = sources.length === 1 ? [1, 2] : [];
    const first = unionOrdered(...sources);
    const second = unionOrdered(...sources);
    assert.deepEqual(first, expected);
    assert.deepEqual(second, expected);
    assert.strictEqual(Object.getPrototypeOf(first), Array.prototype);
    assert.strictEqual(Object.getPrototypeOf(second), Array.prototype);
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first, sources[0]);
    first.push('extra');
    assert.deepEqual(second, expected);
  }
});

test('SameValueZero deduplicates NaN and signed zeros while preserving the first zero', () => {
  for (const zero of [-0, +0]) {
    const custom = { *[Symbol.iterator]() { yield zero; yield -zero; } };
    for (const first of [[zero], custom]) {
      const result = unionOrdered(first, [-zero, NaN, NaN], [NaN, zero]);
      assert.equal(result.length, 2);
      assert.ok(Object.is(result[0], zero));
      assert.ok(Number.isNaN(result[1]));
    }
  }
});

test('preserves value identities without coercion, flattening, or awaiting', () => {
  const first = { id: 1 };
  const second = { id: 1 };
  const nested = [1, 2];
  const set = new Set([3]);
  const symbol = Symbol('same');
  const otherSymbol = Symbol('same');
  const opaque = {
    [Symbol.toPrimitive]() { assert.fail('must not coerce values'); },
    toString() { assert.fail('must not stringify values'); },
    valueOf() { assert.fail('must not coerce values'); },
    get then() { assert.fail('must not await values'); },
    get [Symbol.iterator]() { assert.fail('must not flatten values'); },
  };
  const expected = [first, second, nested, set, symbol, otherSymbol, opaque,
    1, '1', 1n, null, undefined, false, '__proto__', 'constructor'];
  const result = unionOrdered([first, first], expected, expected);
  assert.equal(result.length, expected.length);
  expected.forEach((value, index) => assert.strictEqual(result[index], value));
});

test('honors Unicode strings, sparse arrays, Sets, and overridden array iterators', () => {
  const overridden = [99];
  overridden[Symbol.iterator] = function* () { yield 'override'; yield 'override'; };
  assert.deepEqual(unionOrdered('a😀a', '😀b', [, 'hole', , undefined],
    new Set(['hole', 'set']), overridden),
  ['a', '😀', 'b', undefined, 'hole', 'set', 'override']);
});

test('fully exhausts each source including duplicate tails before accessing the next', () => {
  const events = [];
  const first = tracked('first', [3, 1, 3, 3], events);
  const empty = tracked('empty', [], events);
  const last = tracked('last', [2, 1], events);
  assert.equal(first.iterator[Symbol.iterator], undefined);
  const result = unionOrdered(first.source, empty.source, last.source);
  assert.deepEqual(events, [
    'first:get iterator', 'first:iterator', 'first:get next', ...Array(5).fill('first:next'),
    'empty:get iterator', 'empty:iterator', 'empty:get next', 'empty:next',
    'last:get iterator', 'last:iterator', 'last:get next', ...Array(3).fill('last:next'),
  ]);
  assert.deepEqual(result, [3, 1, 2]);
  [first, empty, last].forEach(assertCalls);
});

test('earlier hooks can make a later argument iterable before it is reached', () => {
  const later = {};
  function* first() {
    yield 'a';
    later[Symbol.iterator] = function* () { yield 'b'; };
  }
  assert.deepEqual(unionOrdered(first(), later), ['a', 'b']);
});

test('reopens repeated sources and consumes a reused generator only from its current state', () => {
  let visits = 0;
  const array = [1];
  array[Symbol.iterator] = function* () { yield* [1, ++visits]; };
  function* values() { yield 'already consumed'; yield 3; yield 3; }
  const generator = values();
  generator.next();
  assert.deepEqual(unionOrdered(array, array, generator, generator), [1, 2, 3]);
  assert.equal(visits, 2);
  assert.deepEqual(generator.next(), { done: true, value: undefined });
});

test('captures next once, reads done before value, and accepts reused callable result objects', () => {
  const events = [];
  const calls = [];
  let index = 0;
  const result = Object.defineProperties(function () {}, {
    done: { get() { events.push('done'); return index > 2 ? 'finished' : 0; } },
    value: { get() { events.push('value'); return index; } },
  });
  const iterator = Object.defineProperty(function () {}, 'next', {
    get() {
      events.push('get next');
      return function (...args) {
        calls.push({ receiver: this, args });
        events.push('next');
        index++;
        return result;
      };
    },
  });
  const source = { [Symbol.iterator]() { return iterator; } };
  assert.deepEqual(unionOrdered(source), [1, 2]);
  assert.deepEqual(events, ['get next', 'next', 'done', 'value', 'next', 'done', 'value',
    'next', 'done']);
  assertCalls({ source, iterator, calls });
});

test('accepts callable sources and inherited or missing iterator result properties', () => {
  const results = [{}, Object.create({ done: false, value: 'inherited' }), {
    done: true,
    get value() { assert.fail('must ignore terminal values'); },
  }];
  let index = 0;
  const source = function () {};
  source[Symbol.iterator] = () => ({ next: () => results[index++] });
  assert.deepEqual(unionOrdered(source), [undefined, 'inherited']);
  assert.equal(index, 3);
});

test('rejects non-iterables synchronously, including after empty sources', () => {
  const invalid = [undefined, null, false, true, 0, 1n, Symbol(), {}, () => {},
    { 0: 'array-like', length: 1 }, { next() {} },
    { async *[Symbol.asyncIterator]() { yield 1; } },
    ...[undefined, null, 0, {}, 'iterator'].map(value => ({ [Symbol.iterator]: value }))];
  for (const source of invalid) {
    assert.throws(() => unionOrdered(source), TypeError);
    for (const values of [[], [1, 1]]) {
      const events = [];
      const prior = tracked('prior', values, events);
      assert.throws(() => unionOrdered(prior.source, source, guarded(events)), TypeError);
      assert.deepEqual(events, ['prior:get iterator', 'prior:iterator', 'prior:get next',
        ...Array(values.length + 1).fill('prior:next')]);
    }
  }
});

const thrownValues = [undefined, null, false, 0, -0, NaN, '', Object.freeze({ error: true })];
const errorStages = ['get iterator', 'iterator', 'get next', 'next', 'done', 'value'];

for (const stage of errorStages) {
  test(`${stage} errors propagate unchanged without cleanup or access to later sources`, () => {
    for (const primary of thrownValues) {
      const events = [];
      const step = name => {
        events.push(name);
        if (name === stage) throw primary;
      };
      const iterator = {
        get next() {
          step('get next');
          return () => {
            step('next');
            return {
              get done() { step('done'); return false; },
              get value() { step('value'); return 1; },
            };
          };
        },
        get return() { events.push('forbidden cleanup'); throw new Error('cleanup'); },
      };
      const source = {
        get [Symbol.iterator]() {
          step('get iterator');
          return () => { step('iterator'); return iterator; };
        },
        get return() { events.push('forbidden source cleanup'); throw new Error('cleanup'); },
      };
      assertThrownValue(() => unionOrdered(source, guarded(events)), primary);
      assert.deepEqual(events, errorStages.slice(0, errorStages.indexOf(stage) + 1));
    }
  });
}

test('malformed iterator protocols throw TypeError without cleanup', () => {
  const primitives = [undefined, null, false, 0, 'result', 1n, Symbol('result')];
  for (const stage of ['iterator result', 'next method', 'next result']) {
    const invalid = stage === 'next method' ? [...primitives, {}] : primitives;
    for (const value of invalid) {
      const events = [];
      const iterator = {
        get next() {
          events.push('get next');
          return stage === 'next method' ? value : () => { events.push('next'); return value; };
        },
        get return() { events.push('forbidden cleanup'); return () => ({}); },
      };
      const source = {
        [Symbol.iterator]() {
          events.push('iterator');
          return stage === 'iterator result' ? value : iterator;
        },
      };
      assert.throws(() => unionOrdered(source, guarded(events)), TypeError);
      assert.deepEqual(events, ['iterator', ...(stage === 'iterator result' ? [] : ['get next']),
        ...(stage === 'next result' ? ['next'] : [])]);
    }
  }
});

test('errors after a finite duplicate tail still propagate without closing exhausted sources', () => {
  const events = [];
  const prior = tracked('prior', [1], events);
  const failure = {};
  let pulls = 0;
  const source = {
    [Symbol.iterator]() {
      return {
        next() {
          events.push('next');
          if (++pulls > 20) throw failure;
          return { value: 1 };
        },
        get return() { events.push('forbidden cleanup'); return () => ({}); },
      };
    },
  };
  assertThrownValue(() => unionOrdered(prior.source, source, guarded(events)), failure);
  assert.equal(pulls, 21);
  assert.deepEqual(events, ['prior:get iterator', 'prior:iterator', 'prior:get next',
    'prior:next', 'prior:next', ...Array(21).fill('next')]);
});

test('processing failures close only the active source once and retain the primary error', () => {
  const modes = ['absent', 'undefined', 'null', 'success', 'getter throws', 'call throws',
    'noncallable', 'primitive result'];
  for (const mode of modes) {
    for (const primary of thrownValues) {
      const events = [];
      const marker = {};
      const cleanupError = {};
      const prior = tracked('prior', [1], events);
      const active = tracked('active', [2, marker, 3], events);
      delete active.iterator.return;
      if (mode !== 'absent') {
        Object.defineProperty(active.iterator, 'return', {
          get() {
            events.push('active:get return');
            if (mode === 'getter throws') throw cleanupError;
            if (mode === 'undefined') return undefined;
            if (mode === 'null') return null;
            if (mode === 'noncallable') return 1;
            return function (...args) {
              events.push('active:return');
              active.calls.push({ receiver: this, args });
              if (mode === 'call throws') throw cleanupError;
              if (mode === 'primitive result') return 1;
              return {
                get done() { events.push('forbidden cleanup done'); return false; },
                get value() { events.push('forbidden cleanup value'); return 'ignored'; },
              };
            };
          },
        });
      }

      // Inject a processing failure, distinct from failures in the source protocol.
      const add = Set.prototype.add;
      let threw = false;
      let caught;
      try {
        Set.prototype.add = function (value) {
          if (value === marker) throw primary;
          return Reflect.apply(add, this, [value]);
        };
        unionOrdered(prior.source, active.source, guarded(events));
      } catch (error) {
        threw = true;
        caught = error;
      } finally {
        Set.prototype.add = add;
      }

      // Assert recorded cleanup effects after the operation: a pending throw can
      // legitimately suppress an assertion thrown from inside return().
      assert.equal(threw, true);
      assert.ok(Object.is(caught, primary));
      assert.deepEqual(events, [
        'prior:get iterator', 'prior:iterator', 'prior:get next', 'prior:next', 'prior:next',
        'active:get iterator', 'active:iterator', 'active:get next', 'active:next', 'active:next',
        ...(mode === 'absent' ? [] : ['active:get return']),
        ...(['success', 'call throws', 'primitive result'].includes(mode) ? ['active:return'] : []),
      ]);
      assertCalls(prior);
      assertCalls(active);
    }
  }
});

test('does not mutate containers or elements on success or failure; results are shallow', () => {
  const frozen = Object.freeze({ id: 1 });
  const shared = { id: 2 };
  const nested = Object.freeze([3]);
  const input = [frozen, shared, nested, frozen];
  const frozenInput = Object.freeze([shared, frozen]);
  const set = new Set([nested, shared]);
  const before = Object.getOwnPropertyDescriptors(input);
  const result = unionOrdered(input, frozenInput, set);
  assert.deepEqual(result, [frozen, shared, nested]);
  assert.strictEqual(result[0], frozen);
  assert.strictEqual(result[1], shared);
  assert.strictEqual(result[2], nested);
  assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
  assert.deepEqual([...set], [nested, shared]);
  result.splice(0, 1);
  assert.deepEqual(input, [frozen, shared, nested, frozen]);
  result[0].id = 4;
  assert.equal(input[1].id, 4);
  const failure = {};
  const broken = { [Symbol.iterator]() { throw failure; } };
  assertThrownValue(() => unionOrdered(input, frozenInput, set, broken), failure);
  assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
  assert.deepEqual([...set], [nested, shared]);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(shared), false);
  assert.equal(frozen.id, 1);
});
