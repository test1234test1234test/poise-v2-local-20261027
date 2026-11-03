import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchAsync } from '../lib/batch-async.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function observe(promise) {
  const state = { status: 'pending' };
  state.done = promise.then(
    value => { state.status = 'fulfilled'; state.value = value; },
    reason => { state.status = 'rejected'; state.reason = reason; },
  );
  return state;
}

async function rejected(state, reason) {
  await state.done;
  assert.equal(state.status, 'rejected');
  assert.equal(state.reason, reason);
}

async function collect(source) {
  const values = [];
  for await (const value of source) values.push(value);
  return values;
}

const done = { value: undefined, done: true };
const protocols = [Symbol.iterator, Symbol.asyncIterator];
const label = protocol => protocol === Symbol.iterator ? 'sync' : 'async';
const iterable = (protocol, iterator) => ({ [protocol]() { return iterator; } });
const output = (source, size = 2) => batchAsync(source, size)[Symbol.asyncIterator]();
// Gates establish progress. A turn checkpoint only checks that blocked work
// stays blocked; assertions never depend on a sleep or a count of microtasks.
const checkpoint = () => new Promise(resolve => setImmediate(resolve));

for (const protocol of protocols) {
  for (const [values, size, expected] of [
    [[], 2, []],
    [[1, 2, 3, 4], 2, [[1, 2], [3, 4]]],
    [[1, 2, 3, 4, 5], 2, [[1, 2], [3, 4], [5]]],
    [[1, 2, 3], 1, [[1], [2], [3]]],
    [[1, 2, 3], Number.MAX_SAFE_INTEGER, [[1, 2, 3]]],
  ]) {
    test(`${label(protocol)} generator batches ${values.length} values with size ${size}`, async () => {
      const source = protocol === Symbol.iterator
        ? (function* () { yield* values; })()
        : (async function* () { yield* values; })();
      assert.deepEqual(await collect(batchAsync(source, size)), expected);
    });
  }

  test(`${label(protocol)} groups are fresh ordinary mutable arrays preserving identity`, async () => {
    const object = Object.freeze({ key: 'value' });
    const nested = Object.freeze([1]);
    const values = Object.freeze([object, nested, object, nested, undefined, NaN, -0, 3n]);
    let index = 0;
    const source = iterable(protocol, {
      next() { return index < values.length ? { value: values[index++] } : done; },
    });
    const iterator = output(source);
    const first = (await iterator.next()).value;
    assert.equal(first[0], object);
    assert.equal(first[1], nested);
    first[0] = 'changed';
    first.push('extra');
    const rest = await collect(iterator);
    assert.deepEqual(rest, [[object, nested], [undefined, NaN], [-0, 3n]]);
    for (const group of [first, ...rest]) {
      assert.equal(Object.getPrototypeOf(group), Array.prototype);
      assert.equal(Object.isFrozen(group), false);
    }
    assert.equal(new Set([first, ...rest]).size, 4);
    assert.equal(values[0], object);
    assert.equal(rest[0][0], object);
    assert.equal(rest[0][1], nested);
    assert.ok(Object.is(rest[2][0], -0));
  });
}

test('size is validated immediately without inspecting the source or coercing arguments', () => {
  let accesses = 0;
  const hostile = new Proxy({}, { get() { accesses++; throw new Error('access'); } });
  for (const size of [undefined, null, false, true, '2', 2n, Symbol('size'), {}, [],
    new Number(2), () => 2, hostile]) {
    assert.throws(() => batchAsync(hostile, size), TypeError);
  }
  for (const size of [0, -0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => batchAsync(hostile, size), RangeError);
  }
  assert.equal(accesses, 0);
});

test('construction, iterator creation and unused return/throw never inspect the source', async () => {
  let accesses = 0;
  const source = new Proxy({}, { get() { accesses++; throw new Error('access'); } });
  const adapter = batchAsync(source, 1);
  const unused = adapter[Symbol.asyncIterator]();
  assert.equal(unused[Symbol.asyncIterator](), unused);
  const returning = adapter[Symbol.asyncIterator]();
  assert.deepEqual(await returning.return('end'), { value: 'end', done: true });
  assert.deepEqual(await returning.next(), done);
  const throwing = adapter[Symbol.asyncIterator]();
  const reason = { consumer: true };
  await rejected(observe(throwing.throw(reason)), reason);
  assert.deepEqual(await throwing.next(), done);
  assert.equal(accesses, 0);
});

test('async protocol is preferred without even reading the sync protocol', async () => {
  let asyncReads = 0, factoryCalls = 0, nextReads = 0, syncReads = 0, index = 0;
  const next = function () {
    assert.equal(this, inner);
    assert.equal(arguments.length, 0);
    return Promise.resolve(index++ === 0 ? { value: 'async' } : done);
  };
  Object.defineProperty(next, 'call', { get() { assert.fail('method.call access'); } });
  const inner = { get next() { nextReads++; return next; } };
  const source = {
    get [Symbol.asyncIterator]() {
      asyncReads++;
      return function () {
        assert.equal(this, source);
        assert.equal(arguments.length, 0);
        factoryCalls++;
        return inner;
      };
    },
    get [Symbol.iterator]() { syncReads++; throw new Error('sync access'); },
  };
  const adapter = batchAsync(source, 1);
  const iterator = adapter[Symbol.asyncIterator]();
  assert.equal(asyncReads, 0);
  assert.deepEqual(await collect(iterator), [['async']]);
  assert.deepEqual({ asyncReads, factoryCalls, nextReads, syncReads }, {
    asyncReads: 1, factoryCalls: 1, nextReads: 1, syncReads: 0,
  });
});

test('absent or null async methods permit the sync protocol, including primitive strings', async () => {
  assert.deepEqual(await collect(batchAsync('abc', 2)), [['a', 'b'], ['c']]);
  for (const absent of [null, undefined]) {
    const source = { [Symbol.asyncIterator]: absent, *[Symbol.iterator]() { yield 1; } };
    assert.deepEqual(await collect(batchAsync(source, 2)), [[1]]);
  }
});

for (const source of [null, undefined, 1, false, 1n, Symbol('source'), {},
  { 0: 'array-like', length: 1 }, { next() { return done; } }]) {
  test(`invalid source of type ${typeof source} fails only on first next`, async () => {
    const iterator = output(source);
    await assert.rejects(iterator.next(), TypeError);
    assert.deepEqual(await iterator.next(), done);
  });
}

for (const protocol of protocols) {
  for (const method of [false, 0, 'iterator', {}, []]) {
    test(`${label(protocol)} noncallable factory rejects without fallback`, async () => {
      let fallbacks = 0;
      const source = {
        get [Symbol.iterator]() { fallbacks++; return function* () { yield 'fallback'; }; },
      };
      Object.defineProperty(source, protocol, { value: method });
      await assert.rejects(output(source).next(), TypeError);
      assert.equal(fallbacks, 0);
    });
  }

  for (const result of [undefined, null, false, 1, 'iterator', 1n, Symbol('iterator'),
    {}, { next: 1 }, Promise.resolve({ next() { return done; } })]) {
    test(`${label(protocol)} malformed iterator factory result rejects without fallback`, async () => {
      let fallbacks = 0;
      const source = {
        get [Symbol.iterator]() { fallbacks++; return function* () { yield 'fallback'; }; },
      };
      Object.defineProperty(source, protocol, { value() { return result; } });
      const iterator = output(source);
      await assert.rejects(iterator.next(), TypeError);
      assert.deepEqual(await iterator.next(), done);
      assert.equal(fallbacks, 0);
    });
  }

  for (const result of [undefined, null, false, 1, 'result', 1n, Symbol('result')]) {
    test(`${label(protocol)} malformed next result closes once and becomes terminal`, async () => {
      let reads = 0, closes = 0;
      const source = iterable(protocol, {
        next() { reads++; return result; },
        return() { closes++; return done; },
      });
      const iterator = output(source);
      await assert.rejects(iterator.next(), TypeError);
      assert.deepEqual(await iterator.next(), done);
      assert.deepEqual(await iterator.return(), done);
      assert.deepEqual({ reads, closes }, { reads: 1, closes: 1 });
    });
  }

  test(`${label(protocol)} callable objects are valid iterators and iterator results`, async () => {
    const inner = () => {};
    const result = () => {};
    result.value = 'function value';
    let reads = 0;
    inner.next = () => reads++ === 0 ? result : done;
    assert.deepEqual(await collect(batchAsync(iterable(protocol, inner), 2)), [['function value']]);
  });

  test(`${label(protocol)} next is captured once and result accessors follow protocol order`, async () => {
    const events = [];
    let index = 0, nextReads = 0;
    const source = iterable(protocol, {
      get next() {
        nextReads++;
        return () => {
          const current = index++;
          return {
            get done() { events.push(`done${current}`); return current === 2 ? 'truthy' : 0; },
            get value() { events.push(`value${current}`); return current; },
          };
        };
      },
      get return() { assert.fail('natural exhaustion must not inspect return'); },
    });
    assert.deepEqual(await collect(batchAsync(source, 3)), [[0, 1]]);
    assert.equal(nextReads, 1);
    assert.deepEqual(events, protocol === Symbol.iterator
      ? ['done0', 'value0', 'done1', 'value1', 'done2', 'value2']
      : ['done0', 'value0', 'done1', 'value1', 'done2']);
  });

  test(`${label(protocol)} infinite input has bounded reads and closes on for-await break`, async () => {
    let reads = 0, closes = 0;
    const source = iterable(protocol, {
      next() { return { value: reads++ }; },
      return() { closes++; return done; },
    });
    const groups = [];
    for await (const group of batchAsync(source, 3)) {
      groups.push(group);
      assert.equal(reads, groups.length * 3);
      await checkpoint();
      assert.equal(reads, groups.length * 3);
      if (groups.length === 2) break;
    }
    assert.deepEqual(groups, [[0, 1, 2], [3, 4, 5]]);
    assert.deepEqual({ reads, closes }, { reads: 6, closes: 1 });
  });

  test(`${label(protocol)} exact exhaustion is discovered only by the next requested group`, async () => {
    let reads = 0;
    const source = iterable(protocol, {
      next() { return reads++ < 2 ? { value: reads } : done; },
      get return() { assert.fail('return after exhaustion'); },
    });
    const iterator = output(source);
    assert.deepEqual(await iterator.next(), { value: [1, 2], done: false });
    assert.equal(reads, 2);
    assert.deepEqual(await iterator.next(), done);
    assert.equal(reads, 3);
    assert.deepEqual(await iterator.next(), done);
    assert.deepEqual(await iterator.return(), done);
    const reason = new Error('already done');
    await rejected(observe(iterator.throw(reason)), reason);
    assert.equal(reads, 3);
  });

  test(`${label(protocol)} partial final group marks exhaustion before consumer return`, async () => {
    let reads = 0;
    const iterator = output(iterable(protocol, {
      next() { return reads++ === 0 ? { value: 'last' } : done; },
      get return() { assert.fail('return after exhaustion'); },
    }));
    assert.deepEqual(await iterator.next(), { value: ['last'], done: false });
    assert.deepEqual(await iterator.return(), done);
    assert.deepEqual(await iterator.next(), done);
    assert.equal(reads, 2);
  });
}

test('reusability comes from the source, with a separate lazy factory call per output iterator', async () => {
  let factories = 0;
  const adapter = batchAsync({
    *[Symbol.iterator]() { factories++; yield 1; yield 2; yield 3; },
  }, 2);
  const first = adapter[Symbol.asyncIterator](), second = adapter[Symbol.asyncIterator]();
  assert.equal(factories, 0);
  assert.deepEqual(await first.next(), { value: [1, 2], done: false });
  assert.equal(factories, 1);
  assert.deepEqual(await collect(second), [[1, 2], [3]]);
  assert.equal(factories, 2);
  assert.deepEqual(await collect(first), [[3]]);
  const oneShot = batchAsync((function* () { yield 1; yield 2; })(), 2);
  assert.deepEqual(await collect(oneShot), [[1, 2]]);
  assert.deepEqual(await collect(oneShot), []);
});

test('separate output iterators progress independently while another source read is pending', async () => {
  const gate = deferred(), started = deferred();
  let factories = 0, closes = 0;
  const adapter = batchAsync({
    [Symbol.asyncIterator]() {
      const id = factories++;
      return {
        next() {
          if (id === 0) { started.resolve(); return gate.promise; }
          return { value: id };
        },
        return() { closes++; return done; },
      };
    },
  }, 1);
  const first = adapter[Symbol.asyncIterator](), second = adapter[Symbol.asyncIterator]();
  const pending = observe(first.next());
  await started.promise;
  assert.deepEqual(await second.next(), { value: [1], done: false });
  await second.return();
  assert.equal(pending.status, 'pending');
  assert.equal(closes, 1);
  gate.resolve({ value: 0 });
  await pending.done;
  assert.deepEqual(pending.value, { value: [0], done: false });
  await first.return();
  assert.equal(closes, 2);
});

test('sync values assimilate nested thenables once and block the next source read', async () => {
  const gate = deferred(), started = deferred();
  let reads = 0, thenReads = 0;
  const value = { identity: true };
  const thenable = {
    get then() {
      thenReads++;
      return function (resolve) {
        assert.equal(this, thenable);
        started.resolve();
        resolve({ then(yes) { yes(gate.promise); } });
      };
    },
  };
  const iterator = output(iterable(Symbol.iterator, {
    next() {
      reads++;
      return reads === 1 ? { value: thenable } : { value: Promise.resolve(2) };
    },
    return() { return done; },
  }));
  const result = observe(iterator.next());
  await started.promise;
  await checkpoint();
  assert.equal(result.status, 'pending');
  assert.equal(reads, 1);
  gate.resolve(value);
  await result.done;
  assert.deepEqual(result.value, { value: [value, 2], done: false });
  assert.equal(result.value.value[0], value);
  assert.equal(thenReads, 1);
  await iterator.return();
});

test('async values preserve promises and hostile thenables without inspecting then', async () => {
  const gate = deferred();
  let thenReads = 0, reads = 0;
  const hostile = { get then() { thenReads++; throw new Error('must not assimilate'); } };
  const values = [gate.promise, hostile];
  const source = iterable(Symbol.asyncIterator, {
    next() { return { then(resolve) { resolve({ value: values[reads++] }); } }; },
    return() { return done; },
  });
  const iterator = output(source);
  const group = (await iterator.next()).value;
  assert.equal(group[0], gate.promise);
  assert.equal(group[1], hostile);
  assert.equal(thenReads, 0);
  const reason = new Error('promise-valued item belongs to consumer');
  const rejection = observe(group[0]);
  gate.reject(reason);
  await rejected(rejection, reason);
  await iterator.return();
});

test('sync iterator results themselves are not assimilated as thenables', async () => {
  let thenReads = 0;
  const iterator = output(iterable(Symbol.iterator, {
    next() {
      return { value: 'sync', get then() { thenReads++; throw new Error('result assimilation'); } };
    },
    return() { return done; },
  }), 1);
  assert.deepEqual(await iterator.next(), { value: ['sync'], done: false });
  assert.equal(thenReads, 0);
  await iterator.return();
});

test('concurrent next requests yield groups in arrival order without overlapping source reads', async () => {
  const gates = Array.from({ length: 6 }, deferred);
  const starts = Array.from({ length: 6 }, deferred);
  let reads = 0, active = 0, maximum = 0, closes = 0;
  const iterator = output(iterable(Symbol.asyncIterator, {
    next() {
      const index = reads++;
      maximum = Math.max(maximum, ++active);
      starts[index].resolve();
      return gates[index].promise.finally(() => active--);
    },
    return() { closes++; return done; },
  }));
  const requests = [observe(iterator.next()), observe(iterator.next()), observe(iterator.next())];
  for (let index = 0; index < 6; index++) {
    await starts[index].promise;
    await checkpoint();
    assert.equal(reads, index + 1);
    assert.equal(active, 1);
    gates[index].resolve({ value: index });
  }
  await Promise.all(requests.map(request => request.done));
  assert.deepEqual(requests.map(request => request.value), [
    { value: [0, 1], done: false }, { value: [2, 3], done: false }, { value: [4, 5], done: false },
  ]);
  assert.equal(maximum, 1);
  assert.equal(reads, 6);
  await iterator.return();
  assert.equal(closes, 1);
});

for (const action of ['return', 'throw']) {
  test(`queued ${action} follows accepted reads and waits for cleanup before later requests`, async () => {
    const gate = deferred(), started = deferred(), cleanup = deferred(), closing = deferred();
    const reason = { consumer: true };
    let reads = 0, closes = 0, sourceThrows = 0;
    const inner = {
      next() {
        reads++;
        if (reads === 1) { started.resolve(); return gate.promise; }
        return { value: reads };
      },
      return() {
        assert.equal(this, inner);
        assert.equal(arguments.length, 0);
        closes++;
        closing.resolve();
        return cleanup.promise;
      },
      throw() { sourceThrows++; return done; },
    };
    const iterator = output(iterable(Symbol.asyncIterator, inner));
    const first = observe(iterator.next());
    const second = observe(iterator.next());
    const ending = observe(iterator[action](reason));
    const later = observe(iterator.next());
    const again = observe(iterator.return());
    await started.promise;
    await checkpoint();
    assert.equal(reads, 1);
    assert.equal(closes, 0);
    for (const request of [first, second, ending, later, again]) assert.equal(request.status, 'pending');
    gate.resolve({ value: 1 });
    await closing.promise;
    await checkpoint();
    assert.deepEqual(first.value, { value: [1, 2], done: false });
    assert.deepEqual(second.value, { value: [3, 4], done: false });
    assert.equal(reads, 4);
    assert.equal(closes, 1);
    for (const request of [ending, later, again]) assert.equal(request.status, 'pending');
    cleanup.resolve({ done: false, value: 'not an output group' });
    await Promise.all([ending.done, later.done, again.done]);
    if (action === 'throw') await rejected(ending, reason);
    else assert.deepEqual(ending.value, { value: reason, done: true });
    assert.deepEqual(later.value, done);
    assert.deepEqual(again.value, done);
    assert.equal(closes, 1);
    assert.equal(reads, 4);
    assert.equal(sourceThrows, 0);
  });
}

for (const failure of ['sync next throw', 'async next reject', 'sync value reject',
  'sync then getter throw', 'done getter throw', 'value getter throw']) {
  test(`${failure} discards a partial group and preserves the failure through pending cleanup`, async () => {
    const cleanup = deferred(), closing = deferred();
    const reason = new Error(failure), cleanupError = new Error('cleanup');
    let reads = 0, closes = 0;
    const synchronous = failure.startsWith('sync');
    const inner = {
      next() {
        if (++reads === 1) return { value: 'partial' };
        if (failure === 'sync next throw') throw reason;
        if (failure === 'async next reject') return Promise.reject(reason);
        if (failure === 'sync value reject') return { value: Promise.reject(reason) };
        if (failure === 'sync then getter throw') return { value: { get then() { throw reason; } } };
        if (failure === 'done getter throw') return { get done() { throw reason; } };
        return { get value() { throw reason; } };
      },
      return() {
        closes++;
        closing.resolve();
        return synchronous ? { done: true, value: cleanup.promise } : cleanup.promise;
      },
    };
    const iterator = output(iterable(synchronous ? Symbol.iterator : Symbol.asyncIterator, inner), 3);
    const first = observe(iterator.next()), later = observe(iterator.next());
    const returned = observe(iterator.return());
    await closing.promise;
    await checkpoint();
    assert.equal(first.status, 'pending');
    assert.equal(later.status, 'pending');
    assert.equal(returned.status, 'pending');
    assert.equal(reads, 2);
    cleanup.reject(cleanupError);
    await rejected(first, reason);
    await Promise.all([later.done, returned.done]);
    assert.deepEqual(later.value, done);
    assert.deepEqual(returned.value, done);
    assert.equal(closes, 1);
    assert.equal(reads, 2);
  });
}

for (const reason of [undefined, null, false, 0, '', Symbol('error'), { error: true }]) {
  for (const action of ['throw', 'next']) {
    test(`original ${typeof reason} ${action} error survives a cleanup rejection`, async () => {
      let reads = 0, closes = 0;
      const iterator = output(iterable(Symbol.asyncIterator, {
        next() { if (reads++ > 0) throw reason; return { value: 1 }; },
        return() { closes++; return Promise.reject(new Error('cleanup')); },
      }), 1);
      await iterator.next();
      await rejected(observe(iterator[action](reason)), reason);
      assert.deepEqual(await iterator.next(), done);
      assert.deepEqual(await iterator.return(), done);
      assert.equal(closes, 1);
    });
  }
}

for (const protocol of protocols) {
  for (const failure of ['getter', 'noncallable', 'throw', 'primitive', 'reject']) {
    for (const action of ['return', 'throw']) {
      test(`${label(protocol)} cleanup ${failure} on consumer ${action} has correct error precedence`, async () => {
        const cleanupError = new Error('cleanup'), original = new Error('consumer');
        let closeReads = 0, closes = 0;
        const inner = {
          next() { return { value: 1 }; },
          get return() {
            closeReads++;
            if (failure === 'getter') throw cleanupError;
            if (failure === 'noncallable') return 1;
            return function () {
              closes++;
              if (failure === 'throw') throw cleanupError;
              if (failure === 'primitive') return 1;
              const rejected = Promise.reject(cleanupError);
              return protocol === Symbol.iterator ? { done: true, value: rejected } : rejected;
            };
          },
        };
        const iterator = output(iterable(protocol, inner), 1);
        await iterator.next();
        const result = observe(iterator[action](original));
        await result.done;
        assert.equal(result.status, 'rejected');
        if (action === 'throw') assert.equal(result.reason, original);
        else if (failure === 'primitive' || failure === 'noncallable') assert.ok(result.reason instanceof TypeError);
        else assert.equal(result.reason, cleanupError);
        assert.deepEqual(await iterator.next(), done);
        assert.deepEqual(await iterator.return(), done);
        assert.equal(closeReads, 1);
        assert.equal(closes, failure === 'getter' || failure === 'noncallable' ? 0 : 1);
      });
    }
  }

  for (const close of [undefined, null]) {
    test(`${label(protocol)} absent return is allowed on early completion`, async () => {
      const iterator = output(iterable(protocol, { next() { return { value: 1 }; }, return: close }), 1);
      await iterator.next();
      assert.deepEqual(await iterator.return(), done);
      assert.deepEqual(await iterator.next(), done);
    });
  }
}

test('sync cleanup awaits its value and accesses done then value once', async () => {
  const cleanup = deferred(), closing = deferred();
  const events = [];
  const iterator = output(iterable(Symbol.iterator, {
    next() { return { value: 1 }; },
    return() {
      closing.resolve();
      return {
        get done() { events.push('done'); return true; },
        get value() { events.push('value'); return cleanup.promise; },
      };
    },
  }), 1);
  await iterator.next();
  const ending = observe(iterator.return()), later = observe(iterator.next());
  await closing.promise;
  await checkpoint();
  assert.deepEqual(events, ['done', 'value']);
  assert.equal(ending.status, 'pending');
  assert.equal(later.status, 'pending');
  cleanup.resolve('ignored');
  await Promise.all([ending.done, later.done]);
  assert.deepEqual(ending.value, done);
  assert.deepEqual(later.value, done);
});

test('async cleanup validates the result object without reading done or value', async () => {
  const iterator = output(iterable(Symbol.asyncIterator, {
    next() { return { value: 1 }; },
    return() {
      return Promise.resolve({
        get done() { assert.fail('cleanup done access'); },
        get value() { assert.fail('cleanup value access'); },
      });
    },
  }), 1);
  await iterator.next();
  assert.deepEqual(await iterator.return(), done);
});

for (const protocol of protocols) {
  for (const outcome of ['object', 'primitive', 'rejection']) {
    test(`${label(protocol)} promise-returning cleanup is awaited before its ${outcome} outcome`, async () => {
      const cleanup = deferred(), closing = deferred();
      const cleanupError = new Error('cleanup');
      let closes = 0;
      const iterator = output(iterable(protocol, {
        next() { return { value: 1 }; },
        return() {
          closes++;
          closing.resolve();
          return cleanup.promise;
        },
      }), 1);
      await iterator.next();
      const ending = observe(iterator.return()), later = observe(iterator.next());
      await closing.promise;
      await checkpoint();
      assert.equal(ending.status, 'pending');
      assert.equal(later.status, 'pending');
      if (outcome === 'rejection') cleanup.reject(cleanupError);
      else cleanup.resolve(outcome === 'object' ? done : null);
      await Promise.all([ending.done, later.done]);
      if (outcome === 'object') assert.deepEqual(ending.value, done);
      else {
        assert.equal(ending.status, 'rejected');
        if (outcome === 'rejection') assert.equal(ending.reason, cleanupError);
        else assert.ok(ending.reason instanceof TypeError);
      }
      assert.deepEqual(later.value, done);
      await iterator.return();
      assert.equal(closes, 1);
    });
  }
}

test('sync terminal values are awaited without closing a naturally exhausted source', async () => {
  const terminal = deferred(), reached = deferred();
  let reads = 0, closes = 0;
  const iterator = output(iterable(Symbol.iterator, {
    next() {
      reads++;
      if (reads === 1) return { value: 'last' };
      reached.resolve();
      return { done: true, value: terminal.promise };
    },
    get return() { closes++; return () => done; },
  }));
  const last = observe(iterator.next()), later = observe(iterator.next());
  await reached.promise;
  await checkpoint();
  assert.equal(last.status, 'pending');
  assert.equal(later.status, 'pending');
  terminal.resolve('ignored terminal value');
  await Promise.all([last.done, later.done]);
  assert.deepEqual(last.value, { value: ['last'], done: false });
  assert.deepEqual(later.value, done);
  await iterator.return();
  assert.deepEqual({ reads, closes }, { reads: 2, closes: 0 });
});

test('source acquisition errors remain terminal and preserve exact errors', async () => {
  const reason = new Error('acquisition');
  for (const source of [
    { get [Symbol.asyncIterator]() { throw reason; } },
    { get [Symbol.iterator]() { throw reason; } },
    { [Symbol.asyncIterator]() { throw reason; } },
    { [Symbol.iterator]() { throw reason; } },
  ]) {
    const iterator = output(source);
    await rejected(observe(iterator.next()), reason);
    assert.deepEqual(await iterator.next(), done);
    assert.deepEqual(await iterator.return(), done);
  }
  let closes = 0;
  const iterator = output(iterable(Symbol.asyncIterator, {
    get next() { throw reason; },
    return() { closes++; throw new Error('cleanup'); },
  }));
  await rejected(observe(iterator.next()), reason);
  assert.equal(closes, 1);
});

test('reentrant requests from source callbacks join the existing queue', async () => {
  let iterator, nestedNext, nestedReturn, reads = 0, closes = 0;
  const inner = {
    next() {
      reads++;
      if (reads === 1) nestedNext = observe(iterator.next());
      return { value: reads };
    },
    return() {
      closes++;
      nestedReturn = observe(iterator.return());
      return done;
    },
  };
  iterator = output(iterable(Symbol.asyncIterator, inner), 1);
  assert.deepEqual(await iterator.next(), { value: [1], done: false });
  await nestedNext.done;
  assert.deepEqual(nestedNext.value, { value: [2], done: false });
  await iterator.return();
  await nestedReturn.done;
  assert.deepEqual(nestedReturn.value, done);
  assert.deepEqual({ reads, closes }, { reads: 2, closes: 1 });
});
