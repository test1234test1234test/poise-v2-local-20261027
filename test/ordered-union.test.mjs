import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderedUnion } from '../lib/ordered-union.mjs';

function assertReferences(actual, expected) {
  assert.equal(actual.length, expected.length);
  expected.forEach((value, index) => {
    assert.ok(Object.is(actual[index], value), `original value at index ${index}`);
  });
}

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

function assertTerminal(union, events) {
  const before = [...events];
  const marker = {};
  assert.deepEqual(union.next(), { done: true, value: undefined });
  assert.deepEqual(union.return(marker), { done: true, value: marker });
  assertThrownValue(() => union.throw(marker), marker);
  assert.deepEqual(union.next(), { done: true, value: undefined });
  assert.deepEqual(events, before, 'terminal operations must not revisit source hooks');
}

// Record effects and calls before invoking user hooks. Assertions live outside
// cleanup so preserving a primary error cannot mask a fixture assertion failure.
function tracked(name, values, events, close = () => ({})) {
  const calls = [];
  let index = 0;
  const iterator = {
    get next() {
      events.push(`${name}:get next`);
      return function (...args) {
        events.push(`${name}:next`);
        calls.push({ method: 'next', receiver: this, args });
        return index < values.length ? { value: values[index++] } : { done: true };
      };
    },
    get return() {
      events.push(`${name}:get return`);
      return function (...args) {
        events.push(`${name}:return`);
        calls.push({ method: 'return', receiver: this, args });
        return close();
      };
    },
    get throw() {
      events.push(`${name}:forbidden throw`);
      throw new Error('must close through return');
    },
  };
  const source = {
    get [Symbol.iterator]() {
      events.push(`${name}:get iterator`);
      return function (...args) {
        events.push(`${name}:iterator`);
        calls.push({ method: 'iterator', receiver: this, args });
        return iterator;
      };
    },
  };
  return { source, iterator, calls };
}

function assertCalls(fixture) {
  for (const { method, receiver, args } of fixture.calls) {
    assert.strictEqual(receiver, method === 'iterator' ? fixture.source : fixture.iterator);
    assert.deepEqual(args, [], `${method} receives no arguments`);
  }
}

function guarded(events, name = 'future') {
  return {
    get [Symbol.iterator]() {
      events.push(`${name}:forbidden iterator`);
      throw new Error('must not open a future source');
    },
    get return() {
      events.push(`${name}:forbidden return`);
      throw new Error('must not close an unopened source');
    },
  };
}

test('no sources, empty sources, and unsorted sources preserve first occurrence order', () => {
  assert.deepEqual([...orderedUnion()], []);
  assert.deepEqual([...orderedUnion([], new Set(), '')], []);
  assert.deepEqual([...orderedUnion([3, 1, 3], [], [2, 1], [2, 4])], [3, 1, 2, 4]);
  const union = orderedUnion([1]);
  assert.strictEqual(union[Symbol.iterator](), union);
  assert.deepEqual([...union], [1]);
});

test('SameValueZero membership preserves original zeros, objects, symbols, and opaque values', () => {
  let coerced = 0;
  let thenReads = 0;
  const a = Object.freeze({ key: 1, [Symbol.toPrimitive]() { coerced++; throw new Error(); } });
  const b = Object.freeze({ key: 1 });
  const s = Symbol('same');
  const t = Symbol('same');
  const thenable = Object.freeze({ get then() { thenReads++; throw new Error(); } });
  const promise = Promise.resolve(1);
  const array = Object.freeze([1]);
  const set = new Set([2]);
  for (const zero of [-0, 0]) {
    const first = Object.freeze([NaN, NaN, zero, -zero, a, a, s, 1, '1', 1n, thenable]);
    const second = Object.freeze([NaN, -zero, b, a, t, s, promise, promise, thenable,
      array, set, array, '__proto__', 'constructor', 'toString', '__proto__', null, undefined, false]);
    assertReferences([...orderedUnion(first, second)], [NaN, zero, a, s, 1, '1', 1n,
      thenable, b, t, promise, array, set, '__proto__', 'constructor', 'toString', null, undefined, false]);
  }
  assert.equal(coerced, 0);
  assert.equal(thenReads, 0);
});

test('uses normal iterators for Unicode strings, sparse arrays, Sets, and overridden arrays', () => {
  const overridden = [99];
  overridden[Symbol.iterator] = function* () { yield 'override'; yield 'override'; };
  assert.deepEqual([...orderedUnion('a😀a\ud800', new String('😀b\ud800'),
    [, 'hole', , undefined], new Set(['hole', 'set']), overridden)],
  ['a', '😀', '\ud800', 'b', undefined, 'hole', 'set', 'override']);
});

test('repeated iterable and iterator occurrences are each visited normally', () => {
  const array = [3, 1, 3];
  function* values() { yield 2; yield 1; }
  const generator = values();
  assert.deepEqual([...orderedUnion(array, array, generator, generator)], [3, 1, 2]);

  const events = [];
  const fixture = tracked('same', [1], events);
  assert.equal(fixture.iterator[Symbol.iterator], undefined);
  assert.deepEqual([...orderedUnion(fixture.source, fixture.source)], [1]);
  assert.deepEqual(events, ['same:get iterator', 'same:iterator', 'same:get next',
    'same:next', 'same:next', 'same:get iterator', 'same:iterator', 'same:get next', 'same:next']);
  assertCalls(fixture);
});

test('construction and cancellation before first next touch no source', () => {
  const events = [];
  const source = guarded(events);
  const returned = orderedUnion(source, undefined);
  assert.deepEqual(events, []);
  const marker = {};
  assert.deepEqual(returned.return(marker), { done: true, value: marker });
  assertTerminal(returned, events);
  const thrown = orderedUnion(source);
  assertThrownValue(() => thrown.throw(undefined), undefined);
  assertTerminal(thrown, events);
  assert.deepEqual(events, []);
});

test('delivers fresh values without lookahead, skipping only finite duplicate runs', () => {
  const events = [];
  const first = tracked('first', [1, ...Array(100).fill(1), 2], events);
  const duplicates = tracked('duplicates', [1, 2, 1], events);
  const last = tracked('last', [3], events);
  const union = orderedUnion(first.source, duplicates.source, last.source);
  assert.deepEqual(union.next(), { done: false, value: 1 });
  assert.deepEqual(events, ['first:get iterator', 'first:iterator', 'first:get next', 'first:next']);
  assert.deepEqual(union.next(), { done: false, value: 2 });
  assert.deepEqual(events, ['first:get iterator', 'first:iterator', 'first:get next',
    ...Array(102).fill('first:next')]);
  assert.deepEqual(union.next(), { done: false, value: 3 });
  assert.deepEqual(events, ['first:get iterator', 'first:iterator', 'first:get next',
    ...Array(103).fill('first:next'), 'duplicates:get iterator', 'duplicates:iterator',
    'duplicates:get next', ...Array(4).fill('duplicates:next'),
    'last:get iterator', 'last:iterator', 'last:get next', 'last:next']);
  assert.deepEqual(union.next(), { done: true, value: undefined });
  assert.equal(events.at(-1), 'last:next');
  assert.equal(events.some(event => event.includes('return')), false);
  [first, duplicates, last].forEach(assertCalls);
  assertTerminal(union, events);
});

test('bounded consumption of an infinite source never opens a later source', () => {
  const events = [];
  let pulls = 0;
  let closes = 0;
  function* infinite() {
    try {
      while (true) {
        if (++pulls > 6) throw new Error('eager traversal exceeded the pull budget');
        yield pulls;
      }
    } finally {
      closes++;
    }
  }
  const union = orderedUnion(infinite(), guarded(events));
  const result = [];
  for (const value of union) {
    result.push(value);
    if (result.length === 5) break;
  }
  assert.deepEqual(result, [1, 2, 3, 4, 5]);
  assert.equal(pulls, 5);
  assert.equal(closes, 1);
  assert.deepEqual(events, []);
  assertTerminal(union, events);
});

test('observes mutations to later sources only when reached', () => {
  const later = [2];
  const union = orderedUnion([1], later);
  assert.equal(union.next().value, 1);
  later.push(3);
  later[0] = 4;
  assert.deepEqual([...union], [4, 3]);
});

test('invalid sources fail when reached without coercion or cleanup of exhausted sources', () => {
  const events = [];
  const invalid = [undefined, null, false, 0, 1n, Symbol(), {}, { next() {} },
    { [Symbol.iterator]: null }, { [Symbol.iterator]: 3 },
    { async *[Symbol.asyncIterator]() { yield 1; } },
    { [Symbol.toPrimitive]() { events.push('forbidden coercion'); throw new Error(); } }];
  for (const source of invalid) {
    events.length = 0;
    const prior = tracked('prior', [1, 1, 2], events, () => { throw new Error('forbidden cleanup'); });
    const union = orderedUnion(prior.source, source, guarded(events));
    assert.equal(union.next().value, 1);
    assert.equal(union.next().value, 2);
    assert.throws(() => union.next(), TypeError);
    assert.deepEqual(events, ['prior:get iterator', 'prior:iterator', 'prior:get next',
      ...Array(4).fill('prior:next')]);
    assertTerminal(union, events);
  }
});

const thrownValues = [undefined, null, false, 0, -0, NaN, '', Object.freeze({ error: true })];
const primitives = [undefined, null, false, 0, 'result', 1n, Symbol('result')];

test('factory lookup and call errors preserve exact throws without acquiring an iterator', () => {
  for (const primary of thrownValues) {
    for (const stage of ['lookup', 'call']) {
      const events = [];
      const prior = tracked('prior', [], events);
      const source = {
        get [Symbol.iterator]() {
          events.push('factory:get');
          if (stage === 'lookup') throw primary;
          return function () { events.push('factory:call'); throw primary; };
        },
        get return() { events.push('forbidden cleanup'); throw new Error(); },
      };
      const union = orderedUnion(prior.source, source, guarded(events));
      assertThrownValue(() => union.next(), primary);
      assert.deepEqual(events, ['prior:get iterator', 'prior:iterator', 'prior:get next', 'prior:next',
        'factory:get', ...(stage === 'call' ? ['factory:call'] : [])]);
      assertTerminal(union, events);
    }
  }
});

test('primitive factory results are rejected without attempting cleanup', () => {
  for (const value of primitives) {
    const events = [];
    const source = {
      [Symbol.iterator]() { events.push('factory'); return value; },
      get return() { events.push('forbidden cleanup'); throw new Error(); },
    };
    const union = orderedUnion(source, guarded(events));
    assert.throws(() => union.next(), TypeError);
    assert.deepEqual(events, ['factory']);
    assertTerminal(union, events);
  }
});

test('empty and exhausted sources are never closed; a last yield is still active', () => {
  for (const finish of [false, true]) {
    const events = [];
    const empty = tracked('empty', [], events);
    const first = tracked('first', [1], events);
    const active = tracked('active', [2], events);
    const union = orderedUnion(empty.source, first.source, active.source);
    assert.equal(union.next().value, 1);
    assert.equal(union.next().value, 2);
    const expected = ['empty:get iterator', 'empty:iterator', 'empty:get next', 'empty:next',
      'first:get iterator', 'first:iterator', 'first:get next', 'first:next', 'first:next',
      'active:get iterator', 'active:iterator', 'active:get next', 'active:next'];
    if (finish) {
      assert.deepEqual(union.next(), { done: true, value: undefined });
      expected.push('active:next');
    } else {
      union.return();
      expected.push('active:get return', 'active:return');
    }
    assert.deepEqual(events, expected);
    assertTerminal(union, events);
  }
});

test('break, function return, and loop-body throw close the active iterator once', () => {
  for (const exit of ['break', 'return', 'throw']) {
    for (const failCleanup of [false, true]) {
      const events = [];
      const primary = {};
      const cleanup = {};
      const marker = {};
      const fixture = tracked('active', [1, 2], events, () => {
        if (failCleanup) throw cleanup;
        return {};
      });
      const union = orderedUnion(fixture.source, guarded(events));
      const consume = () => {
        for (const value of union) {
          assert.equal(value, 1);
          if (exit === 'throw') throw primary;
          if (exit === 'return') return marker;
          break;
        }
        return marker;
      };
      if (exit === 'throw' || failCleanup) {
        assertThrownValue(consume, exit === 'throw' ? primary : cleanup);
      } else {
        assert.strictEqual(consume(), marker);
      }
      assert.deepEqual(events, ['active:get iterator', 'active:iterator', 'active:get next',
        'active:next', 'active:get return', 'active:return']);
      assertCalls(fixture);
      assertTerminal(union, events);
    }
  }
});

const cleanupModes = ['absent', 'undefined', 'null', 'success', 'done false', 'callable result',
  'unread properties', 'getter throws', 'call throws', 'noncallable', 'primitive result'];

function cleanupHook(iterator, mode, events, calls, error) {
  delete iterator.return;
  if (mode === 'absent') return [];
  const expected = ['active:get return'];
  if (!['undefined', 'null', 'getter throws', 'noncallable'].includes(mode)) {
    expected.push('active:return');
  }
  Object.defineProperty(iterator, 'return', {
    configurable: true,
    get() {
      events.push('active:get return');
      if (mode === 'getter throws') throw error;
      if (mode === 'undefined') return undefined;
      if (mode === 'null') return null;
      if (mode === 'noncallable') return 1;
      return function (...args) {
        events.push('active:return');
        calls.push({ method: 'return', receiver: this, args });
        if (mode === 'call throws') throw error;
        if (mode === 'primitive result') return null;
        if (mode === 'callable result') return () => {};
        if (mode === 'unread properties') return {
          get done() { events.push('forbidden cleanup done'); throw error; },
          get value() { events.push('forbidden cleanup value'); throw error; },
        };
        return { done: mode !== 'done false', value: 'ignored cleanup value' };
      };
    },
  });
  return expected;
}

for (const stage of ['next lookup', 'next call', 'done lookup', 'value lookup', 'consumer throw']) {
  for (const mode of cleanupModes) {
    test(`${stage} preserves exact primary throws with ${mode} cleanup`, () => {
      for (const primary of thrownValues) {
        const events = [];
        const cleanup = { cleanup: true };
        const prior = tracked('prior', [], events);
        const active = tracked('active', [1], events);
        const cleanupEvents = cleanupHook(active.iterator, mode, events, active.calls, cleanup);
        const expected = ['prior:get iterator', 'prior:iterator', 'prior:get next', 'prior:next',
          'active:get iterator', 'active:iterator', 'active:get next'];
        Object.defineProperty(active.iterator, 'next', {
          get() {
            events.push('active:get next');
            if (stage === 'next lookup') throw primary;
            return function (...args) {
              events.push('active:next');
              active.calls.push({ method: 'next', receiver: this, args });
              if (stage === 'next call') throw primary;
              return {
                get done() {
                  events.push('active:done');
                  if (stage === 'done lookup') throw primary;
                  return false;
                },
                get value() {
                  events.push('active:value');
                  if (stage === 'value lookup') throw primary;
                  return 1;
                },
              };
            };
          },
        });
        if (stage !== 'next lookup') expected.push('active:next');
        if (['done lookup', 'value lookup', 'consumer throw'].includes(stage)) expected.push('active:done');
        if (['value lookup', 'consumer throw'].includes(stage)) expected.push('active:value');
        const union = orderedUnion(prior.source, active.source, guarded(events));
        if (stage === 'consumer throw') {
          assert.equal(union.next().value, 1);
          assertThrownValue(() => union.throw(primary), primary);
        } else {
          assertThrownValue(() => union.next(), primary);
        }
        assert.deepEqual(events, [...expected, ...cleanupEvents]);
        assertCalls(active);
        assertCalls(prior);
        assertTerminal(union, events);
      }
    });
  }
}

test('invalid next methods and primitive next results close the owned iterator', () => {
  for (const stage of ['next method', 'next result']) {
    for (const value of [...primitives, {}]) {
      if (stage === 'next result' && value !== null && typeof value === 'object') continue;
      for (const mode of cleanupModes) {
        const events = [];
        const active = tracked('active', [], events);
        const cleanupEvents = cleanupHook(active.iterator, mode, events, active.calls, {});
        Object.defineProperty(active.iterator, 'next', {
          get() {
            events.push('active:get next');
            if (stage === 'next method') return value;
            return () => { events.push('active:next'); return value; };
          },
        });
        const union = orderedUnion(active.source, guarded(events));
        assert.throws(() => union.next(), {
          name: 'TypeError',
          message: stage === 'next method' ? 'Iterator next must be a function' : 'Iterator results must be objects',
        });
        assert.deepEqual(events, ['active:get iterator', 'active:iterator', 'active:get next',
          ...(stage === 'next result' ? ['active:next'] : []), ...cleanupEvents]);
        assertCalls(active);
        assertTerminal(union, events);
      }
    }
  }
});

test('ordinary return preserves its marker or propagates exact cleanup failures', () => {
  for (const mode of cleanupModes) {
    for (const cleanup of thrownValues) {
      const events = [];
      const active = tracked('active', [1], events);
      const cleanupEvents = cleanupHook(active.iterator, mode, events, active.calls, cleanup);
      const union = orderedUnion(active.source, guarded(events));
      const marker = {};
      assert.deepEqual(union.next('ignored sent value'), { done: false, value: 1 });
      if (['getter throws', 'call throws'].includes(mode)) {
        assertThrownValue(() => union.return(marker), cleanup);
      } else if (['noncallable', 'primitive result'].includes(mode)) {
        assert.throws(() => union.return(marker), TypeError);
      } else {
        const result = union.return(marker);
        assert.deepEqual(result, { done: true, value: marker });
        assert.strictEqual(result.value, marker);
      }
      assert.deepEqual(events, ['active:get iterator', 'active:iterator', 'active:get next',
        'active:next', ...cleanupEvents]);
      assertCalls(active);
      assertTerminal(union, events);
    }
  }
});

test('all noncallable cleanup hooks and primitive cleanup results fail ordinary return', () => {
  for (const value of [...primitives, {}]) {
    for (const asResult of [false, true]) {
      if (!asResult && (value === undefined || value === null)) continue;
      if (asResult && value !== null && typeof value === 'object') continue;
      const events = [];
      const active = tracked('active', [1], events);
      Object.defineProperty(active.iterator, 'return', {
        get() {
          events.push('active:get return');
          return asResult ? () => { events.push('active:return'); return value; } : value;
        },
      });
      const union = orderedUnion(active.source, guarded(events));
      union.next();
      assert.throws(() => union.return(), TypeError);
      assert.deepEqual(events, ['active:get iterator', 'active:iterator', 'active:get next',
        'active:next', 'active:get return', ...(asResult ? ['active:return'] : [])]);
      assertTerminal(union, events);
    }
  }
});

test('cleanup attempts once even when a source generator yields from finally', () => {
  let released = false;
  function* source() {
    try { yield 1; } finally { yield 2; released = true; }
  }
  const iterator = source();
  const union = orderedUnion(iterator);
  assert.equal(union.next().value, 1);
  assert.deepEqual(union.return('outer'), { done: true, value: 'outer' });
  assert.equal(released, false);
  assertTerminal(union, []);
  assert.equal(released, false);
  assert.deepEqual(iterator.next(), { done: true, value: undefined });
  assert.equal(released, true);
});

test('captures next once and looks up the current return only on cancellation', () => {
  const events = [];
  const active = tracked('active', [1, 2], events);
  const union = orderedUnion(active.source, guarded(events));
  assert.equal(union.next('first sent value').value, 1);
  Object.defineProperty(active.iterator, 'next', {
    get() { events.push('forbidden next lookup'); throw new Error(); },
  });
  Object.defineProperty(active.iterator, 'return', {
    get() {
      events.push('replacement:get return');
      return function (...args) {
        events.push('replacement:return');
        active.calls.push({ method: 'return', receiver: this, args });
        return { done: false, value: 'ignored' };
      };
    },
  });
  assert.equal(union.next('second sent value').value, 2);
  assert.deepEqual(events, ['active:get iterator', 'active:iterator', 'active:get next',
    'active:next', 'active:next']);
  assert.deepEqual(union.return('outer marker'), { done: true, value: 'outer marker' });
  assert.deepEqual(events, ['active:get iterator', 'active:iterator', 'active:get next',
    'active:next', 'active:next', 'replacement:get return', 'replacement:return']);
  assertCalls(active);
  assertTerminal(union, events);
});

test('reads done then value once per pull, including duplicates and reused callable results', () => {
  const events = [];
  const values = [1, 1, 2];
  let index = -1;
  const result = () => {};
  Object.defineProperties(result, {
    done: { get() { events.push(`done:${index}`); return index === values.length ? 'finished' : 0; } },
    value: { get() {
      events.push(`value:${index}`);
      if (index === values.length) throw new Error('must not read terminal value');
      return values[index];
    } },
  });
  const iterator = {
    next() { events.push('next'); index++; return result; },
    get return() { events.push('forbidden cleanup'); throw new Error(); },
  };
  const union = orderedUnion({ [Symbol.iterator]() { return iterator; } });
  assert.deepEqual(union.next(), { done: false, value: 1 });
  assert.deepEqual(events, ['next', 'done:0', 'value:0']);
  assert.deepEqual(union.next(), { done: false, value: 2 });
  assert.deepEqual(events, ['next', 'done:0', 'value:0', 'next', 'done:1', 'value:1',
    'next', 'done:2', 'value:2']);
  assert.deepEqual(union.next(), { done: true, value: undefined });
  assert.deepEqual(events, ['next', 'done:0', 'value:0', 'next', 'done:1', 'value:1',
    'next', 'done:2', 'value:2', 'next', 'done:3']);
  assertTerminal(union, events);
});

test('accepts missing or inherited result properties and interprets done by truthiness', () => {
  const falseFlags = [undefined, null, false, 0, -0, NaN, ''];
  const trueFlags = [true, 1, -1, 'done', {}, Symbol(), 1n];
  for (const done of trueFlags) {
    const events = [];
    const results = [{}, ...falseFlags.map((flag, index) => Object.create({ done: flag, value: index })),
      { done, get value() { events.push('forbidden terminal value'); throw new Error(); } }];
    let index = 0;
    const iterator = {
      next() { return results[index++]; },
      get return() { events.push('forbidden cleanup'); throw new Error(); },
    };
    assert.deepEqual([...orderedUnion({ [Symbol.iterator]() { return iterator; } })],
      [undefined, 0, 1, 2, 3, 4, 5, 6]);
    assert.equal(index, results.length);
    assert.deepEqual(events, []);
  }
});

test('supports callable sources and iterators without consulting hook .call or async hooks', () => {
  const events = [];
  const calls = [];
  const source = () => {};
  const iterator = () => {};
  const hook = (name, result) => {
    const method = function (...args) {
      events.push(name);
      calls.push({ name, receiver: this, args });
      return result;
    };
    Object.defineProperty(method, 'call', {
      get() { events.push('forbidden .call'); throw new Error(); },
    });
    return method;
  };
  source[Symbol.iterator] = hook('factory', iterator);
  Object.defineProperty(source, Symbol.asyncIterator, {
    get() { events.push('forbidden async iterator'); throw new Error(); },
  });
  iterator.next = hook('next', { value: 1 });
  iterator.return = hook('return', () => {});
  const union = orderedUnion(source);
  assert.equal(union.next('sent').value, 1);
  union.return('marker');
  assert.deepEqual(events, ['factory', 'next', 'return']);
  for (const { name, receiver, args } of calls) {
    assert.strictEqual(receiver, name === 'factory' ? source : iterator);
    assert.deepEqual(args, []);
  }
  assertTerminal(union, events);
});

test('separate unions maintain independent membership and cleanup state', () => {
  const events = [];
  const a = tracked('a', [1, 2], events);
  const b = tracked('b', [1, 2, 1, 3], events);
  const first = orderedUnion(a.source, guarded(events));
  const second = orderedUnion(b.source);
  assert.equal(first.next().value, 1);
  assert.equal(second.next().value, 1);
  first.return();
  assert.deepEqual([...second], [2, 3]);
  assert.deepEqual(events, ['a:get iterator', 'a:iterator', 'a:get next', 'a:next',
    'b:get iterator', 'b:iterator', 'b:get next', 'b:next', 'a:get return', 'a:return',
    ...Array(4).fill('b:next')]);
  assertTerminal(first, events);
  assertTerminal(second, events);
});

test('nested unions clean up only active layers on return, source failure, and direct throw', () => {
  for (const exit of ['return', 'source failure', 'throw']) {
    for (const failCleanup of [false, true]) {
      const events = [];
      const primary = {};
      const cleanup = {};
      const leaf = tracked('leaf', [1], events, () => {
        if (failCleanup) throw cleanup;
        return {};
      });
      if (exit === 'source failure') {
        let pulls = 0;
        Object.defineProperty(leaf.iterator, 'next', {
          get() {
            events.push('leaf:get next');
            return () => {
              events.push('leaf:next');
              if (pulls++ > 0) throw primary;
              return { value: 1 };
            };
          },
        });
      }
      const inner = orderedUnion(leaf.source, guarded(events, 'inner future'));
      const closeInner = inner.return;
      inner.return = function (...args) {
        events.push('inner:return');
        return Reflect.apply(closeInner, this, args);
      };
      const outer = orderedUnion(inner, guarded(events, 'outer future'));
      assert.equal(outer.next().value, 1);
      if (exit === 'throw') assertThrownValue(() => outer.throw(primary), primary);
      else if (exit === 'source failure') assertThrownValue(() => outer.next(), primary);
      else if (failCleanup) assertThrownValue(() => outer.return(), cleanup);
      else assert.deepEqual(outer.return('marker'), { done: true, value: 'marker' });
      assert.deepEqual(events, ['leaf:get iterator', 'leaf:iterator', 'leaf:get next', 'leaf:next',
        ...(exit === 'source failure' ? ['leaf:next'] : ['inner:return']),
        'leaf:get return', 'leaf:return', ...(exit === 'source failure' ? ['inner:return'] : [])]);
      assertTerminal(outer, events);
      // Restore the wrapper before checking native terminal behavior on the inner generator.
      inner.return = closeInner;
      assertTerminal(inner, events);
    }
  }
});

test('caught reentrant next, return, and throw calls do not corrupt traversal or cleanup', () => {
  const events = [];
  const attempts = [];
  let union;
  const attempt = stage => {
    for (const method of ['next', 'return', 'throw']) {
      let error;
      try { union[method]('reentrant'); } catch (caught) { error = caught; }
      attempts.push({ stage, method, error });
    }
  };
  let value = 0;
  const iterator = {
    next() { events.push('next'); attempt('next'); return { value: ++value }; },
    return() { events.push('return'); attempt('return'); return {}; },
  };
  const source = {
    [Symbol.iterator]() { events.push('factory'); attempt('factory'); return iterator; },
  };
  union = orderedUnion(source, guarded(events));
  assert.equal(union.next().value, 1);
  assert.equal(union.next().value, 2);
  assert.deepEqual(union.return('done'), { done: true, value: 'done' });
  assert.deepEqual(events, ['factory', 'next', 'next', 'return']);
  assert.deepEqual(attempts.map(({ stage, method }) => [stage, method]),
    ['factory', 'next', 'next', 'return'].flatMap(stage =>
      ['next', 'return', 'throw'].map(method => [stage, method])));
  for (const { error } of attempts) assert.ok(error instanceof TypeError);
  assertTerminal(union, events);
});
