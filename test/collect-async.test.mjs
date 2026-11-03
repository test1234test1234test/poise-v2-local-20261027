import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { spawnSync } from 'node:child_process';
import { baseline, collectAsync } from '../lib.mjs';

const protocols = [Symbol.iterator, Symbol.asyncIterator];
const label = protocol => protocol === Symbol.iterator ? 'sync' : 'async';
const iterable = (protocol, iterator) => ({ [protocol]() { return iterator; } });
const done = { done: true };
const checkpoint = () => new Promise(resolve => setImmediate(resolve));
const listeners = signal => getEventListeners(signal, 'abort').length;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Only the public promise is observed by the harness. Source-operation gates
// deliberately have no harness rejection handlers, including during teardown.
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

test('public export preserves baseline and returns fresh ordinary arrays in order', async () => {
  assert.equal(baseline(), 'sandbox');
  const object = {}, nested = [1];
  const input = Object.freeze([object, nested, object, undefined, NaN, -0, 3n]);
  const promise = collectAsync(input);
  assert.ok(promise instanceof Promise);
  const result = await promise;
  assert.deepEqual(result, input);
  assert.equal(result[0], object);
  assert.equal(result[1], nested);
  assert.equal(result[2], object);
  assert.equal(Object.getPrototypeOf(result), Array.prototype);
  result.push('mutable');
  assert.notEqual(await collectAsync([]), await collectAsync([]));
  assert.notEqual(await collectAsync(input), result);
});

for (const options of [undefined, {}, { limit: undefined }, { limit: Infinity },
  { limit: Number.MAX_SAFE_INTEGER }, Object.create(null), Object.freeze({})]) {
  test(`default/large limit accepts options ${JSON.stringify(options)}`, async () => {
    assert.deepEqual(await collectAsync([1, 2], options), [1, 2]);
  });
}

for (const limit of [0, -0]) {
  test(`zero (${Object.is(limit, -0) ? '-0' : '0'}) never touches the input`, async () => {
    const hostile = new Proxy({}, { get() { assert.fail('source access'); } });
    const controller = new AbortController();
    const first = await collectAsync(hostile, { limit, signal: controller.signal });
    assert.deepEqual(first, []);
    assert.notEqual(first, await collectAsync(null, { limit }));
    assert.equal(listeners(controller.signal), 0);
  });
}

for (const limit of [-1, 0.5, NaN, -Infinity, Number.MAX_SAFE_INTEGER + 1,
  '2', false, true, 1n, Object(1), null, Symbol('limit')]) {
  test(`invalid limit ${String(limit)} rejects before signal/source access`, async () => {
    const hostile = new Proxy({}, { get() { assert.fail('source access'); } });
    let promise;
    assert.doesNotThrow(() => {
      promise = collectAsync(hostile, {
        limit,
        get signal() { assert.fail('signal access before limit validation'); },
      });
    });
    await assert.rejects(promise, typeof limit === 'number' ? RangeError : TypeError);
  });
}

test('options and getters reject asynchronously; getters are read once in order', async () => {
  for (const options of [null, [], 1, 'options', true, () => {}]) {
    let promise;
    assert.doesNotThrow(() => { promise = collectAsync([], options); });
    await assert.rejects(promise, TypeError);
  }
  for (const key of ['limit', 'signal']) {
    const error = {};
    const state = observe(collectAsync([], { get [key]() { throw error; } }));
    await rejected(state, error);
  }
  const accesses = [], controller = new AbortController();
  const options = Object.create({
    get limit() { accesses.push('limit'); return 1; },
    get signal() { accesses.push('signal'); return controller.signal; },
    get unused() { assert.fail('unrelated option read'); },
  });
  assert.deepEqual(await collectAsync([1, 2], options), [1]);
  assert.deepEqual(accesses, ['limit', 'signal']);
  assert.equal(listeners(controller.signal), 0);
});

test('signal validation precedes zero/iterator access and rejects unsupported wrappers', async () => {
  const native = new AbortController().signal;
  const hostile = new Proxy({}, { get() { assert.fail('source access'); } });
  for (const signal of [null, false, {}, { aborted: false }, Object.create(native),
    new Proxy(native, {}), Object.create(AbortSignal.prototype),
    Object.setPrototypeOf(new AbortController().signal, Object.create(AbortSignal.prototype))]) {
    await assert.rejects(collectAsync(hostile, { limit: 0, signal }), TypeError);
  }
  assert.deepEqual(await collectAsync([], { signal: AbortSignal.any([native]) }), []);
});

for (const reason of [undefined, null, false, 0, Symbol('abort'), {}, { then() {} }]) {
  test(`pre-abort preserves signal.reason (${String(reason)}) without protocol access`, async () => {
    const controller = new AbortController();
    controller.abort(reason);
    const hostile = new Proxy({}, { get() { assert.fail('source access'); } });
    for (const limit of [0, 1, Infinity]) {
      await rejected(observe(collectAsync(hostile, { limit, signal: controller.signal })),
        controller.signal.reason);
    }
    await assert.rejects(collectAsync(hostile, { limit: -1, signal: controller.signal }), RangeError);
    assert.equal(listeners(controller.signal), 0);
  });
}

for (const protocol of protocols) {
  for (const length of [0, 2]) {
    for (const limit of [1, 2, 3, Infinity, Number.MAX_SAFE_INTEGER]) {
      test(`${label(protocol)} length ${length}, limit ${limit}: exact reads and close`, async () => {
        let reads = 0, closes = 0, nextGets = 0, closeGets = 0;
        const iterator = {
          get next() {
            nextGets++;
            return function () {
              assert.equal(this, iterator);
              const index = reads++;
              return index < length ? { value: index } : done;
            };
          },
          get return() {
            closeGets++;
            return function () { assert.equal(this, iterator); closes++; return done; };
          },
        };
        const source = { [protocol]() { assert.equal(this, source); return iterator; } };
        assert.deepEqual(await collectAsync(source, { limit }),
          Array.from({ length: Math.min(length, limit) }, (_, index) => index));
        assert.equal(reads, Math.min(length + 1, limit));
        assert.equal(nextGets, 1);
        assert.equal(closeGets, limit <= length ? 1 : 0);
        assert.equal(closes, closeGets);
      });
    }
  }

  test(`${label(protocol)} finite limit bounds an infinite source`, async () => {
    let reads = 0, closes = 0;
    assert.deepEqual(await collectAsync(iterable(protocol, {
      next() { return { value: ++reads }; },
      return() { closes++; return { done: false }; },
    }), { limit: 3 }), [1, 2, 3]);
    assert.equal(reads, 3);
    assert.equal(closes, 1);
  });

  for (const absent of [undefined, null]) {
    test(`${label(protocol)} missing/null return is allowed`, async () => {
      assert.deepEqual(await collectAsync(iterable(protocol, {
        next() { return { value: 1 }; }, return: absent,
      }), { limit: 1 }), [1]);
    });
  }

  test(`${label(protocol)} empty generator and ordinary generator preserve order`, async () => {
    const generator = protocol === Symbol.iterator
      ? function* (items) { yield* items; }
      : async function* (items) { yield* items; };
    assert.deepEqual(await collectAsync(generator([])), []);
    assert.deepEqual(await collectAsync(generator([3, 1, 2])), [3, 1, 2]);
  });
}

test('async protocol takes precedence; only null/undefined permits fallback', async () => {
  assert.deepEqual(await collectAsync({
    [Symbol.asyncIterator]() { return { next() { return done; } }; },
    get [Symbol.iterator]() { assert.fail('sync fallback'); },
  }), []);
  for (const asyncMethod of [null, undefined]) {
    assert.deepEqual(await collectAsync({
      [Symbol.asyncIterator]: asyncMethod,
      *[Symbol.iterator]() { yield 1; },
    }), [1]);
  }
  for (const asyncMethod of [0, false, {}]) {
    await assert.rejects(collectAsync({
      [Symbol.asyncIterator]: asyncMethod,
      get [Symbol.iterator]() { assert.fail('broken async fallback'); },
    }), TypeError);
  }
});

test('non-iterables and invalid factories/iterators reject with TypeError', async () => {
  for (const source of [null, undefined, 1, {}, { [Symbol.iterator]: 1 }]) {
    await assert.rejects(collectAsync(source), TypeError);
  }
  for (const protocol of protocols) {
    for (const iterator of [undefined, null, 1, 'iterator']) {
      await assert.rejects(collectAsync(iterable(protocol, iterator)), TypeError);
    }
  }
  assert.deepEqual(await collectAsync('ab'), ['a', 'b']);
});

for (const protocol of protocols) {
  for (const where of ['factory getter', 'factory', 'next getter', 'next', 'done', 'value']) {
    test(`${label(protocol)} throwing ${where} preserves error and closes owned iterator`, async () => {
      const error = {}, controller = new AbortController();
      let closes = 0;
      const result = {};
      if (where === 'done' || where === 'value') {
        Object.defineProperty(result, where, { get() { throw error; } });
      }
      const iterator = {
        get next() {
          if (where === 'next getter') throw error;
          return () => { if (where === 'next') throw error; return result; };
        },
        return() { closes++; throw new Error('secondary cleanup'); },
      };
      const source = {
        get [protocol]() {
          if (where === 'factory getter') throw error;
          return () => { if (where === 'factory') throw error; return iterator; };
        },
      };
      await rejected(observe(collectAsync(source, { signal: controller.signal })), error);
      assert.equal(closes, where.startsWith('factory') ? 0 : 1);
      assert.equal(listeners(controller.signal), 0);
    });
  }

  for (const invalid of [undefined, null, 1, 'result']) {
    test(`${label(protocol)} primitive next result ${String(invalid)} closes once`, async () => {
      let closes = 0;
      await assert.rejects(collectAsync(iterable(protocol, {
        next() { return invalid; },
        return() { closes++; return done; },
      })), TypeError);
      assert.equal(closes, 1);
    });
  }

  test(`${label(protocol)} noncallable next closes an acquired iterator`, async () => {
    let closes = 0;
    await assert.rejects(collectAsync(iterable(protocol, {
      next: 1, return() { closes++; return done; },
    })), TypeError);
    assert.equal(closes, 1);
  });
}

for (const error of [undefined, null, false, 0, Symbol('failure'), {}, { then() {} }]) {
  for (const method of ['throw', 'reject']) {
    test(`${method} source failure preserves exact ${String(error)} through rejected cleanup`, async () => {
      let closes = 0;
      await rejected(observe(collectAsync(iterable(Symbol.asyncIterator, {
        next() {
          if (method === 'throw') throw error;
          return Promise.reject(error);
        },
        return() { closes++; return Promise.reject(new Error('cleanup')); },
      }))), error);
      assert.equal(closes, 1);
    });
  }
}

test('sync values assimilate nested thenables, but sync result objects do not', async () => {
  let reads = 0, resultThenReads = 0;
  const nested = { then(resolve) { resolve(Promise.resolve({ then(yes) { yes(42); } })); } };
  assert.deepEqual(await collectAsync(iterable(Symbol.iterator, {
    next() {
      return {
        done: reads++ > 0,
        value: nested,
        get then() { resultThenReads++; throw new Error('result assimilation'); },
      };
    },
  })), [42]);
  assert.equal(resultThenReads, 0);
});

test('sync rejected values close; rejected terminal values never access return', async () => {
  for (const terminal of [false, true]) {
    const error = {}, events = [];
    await rejected(observe(collectAsync(iterable(Symbol.iterator, {
      next() {
        return {
          get done() { events.push('done'); return terminal; },
          get value() {
            events.push('value');
            return { then(resolve, reject) { reject(error); } };
          },
        };
      },
      get return() { events.push('return'); return () => done; },
    }))), error);
    assert.deepEqual(events, terminal ? ['done', 'value'] : ['done', 'value', 'return']);
  }
});

test('manual async values stay opaque, and terminal values are not read', async () => {
  const promise = Promise.resolve(1), thenable = { get then() { assert.fail('payload assimilation'); } };
  let reads = 0;
  const result = await collectAsync(iterable(Symbol.asyncIterator, {
    next() {
      if (reads++ === 0) return { value: promise };
      if (reads === 2) return { value: thenable };
      return { done: 'truthy', get value() { assert.fail('terminal value'); } };
    },
    get return() { assert.fail('naturally exhausted close'); },
  }));
  assert.equal(result[0], promise);
  assert.equal(result[1], thenable);
});

for (const protocol of protocols) {
  for (const failure of ['getter', 'noncallable', 'throw', 'reject', 'primitive', 'done', 'value', 'nested value']) {
    if (protocol === Symbol.asyncIterator && ['done', 'value', 'nested value'].includes(failure)) continue;
    test(`${label(protocol)} limit cleanup ${failure} rejects with its own error`, async () => {
      const error = {}, controller = new AbortController();
      let closeGets = 0, closes = 0;
      const state = observe(collectAsync(iterable(protocol, {
        next() { return { value: 1 }; },
        get return() {
          closeGets++;
          if (failure === 'getter') throw error;
          if (failure === 'noncallable') return 1;
          return () => {
            closes++;
            if (failure === 'throw') throw error;
            if (failure === 'reject') return { then(resolve, reject) { reject(error); } };
            if (failure === 'primitive') return Promise.resolve(1);
            return {
              get done() { if (failure === 'done') throw error; return false; },
              get value() {
                if (failure === 'value') throw error;
                return { then(resolve) { resolve(Promise.reject(error)); } };
              },
            };
          };
        },
      }), { limit: 1, signal: controller.signal }));
      await state.done;
      assert.equal(state.status, 'rejected');
      if (['noncallable', 'primitive'].includes(failure)) assert.ok(state.reason instanceof TypeError);
      else assert.equal(state.reason, error);
      assert.equal(closeGets, 1);
      assert.equal(closes, ['getter', 'noncallable'].includes(failure) ? 0 : 1);
      assert.equal(listeners(controller.signal), 0);
    });
  }
}

test('async close only validates its result object; it does not read done/value', async () => {
  assert.deepEqual(await collectAsync(iterable(Symbol.asyncIterator, {
    next() { return { value: 1 }; },
    return() {
      return {
        get done() { assert.fail('async close done'); },
        get value() { assert.fail('async close value'); },
      };
    },
  }), { limit: 1 }), [1]);
});

for (const originalFailure of [false, true]) {
  for (const abort of [false, true]) {
    test(`normal cleanup waits; source failure=${originalFailure}, abort=${abort}`, async () => {
      const cleanup = deferred(), entered = deferred(), controller = new AbortController();
      const sourceError = {}, cleanupError = {}, abortReason = {};
      let closes = 0;
      const state = observe(collectAsync(iterable(Symbol.asyncIterator, {
        next() { if (originalFailure) throw sourceError; return { value: 1 }; },
        return() { closes++; entered.resolve(); return cleanup.promise; },
      }), { limit: 1, signal: controller.signal }));
      try {
        await entered.promise;
        await checkpoint();
        assert.equal(state.status, 'pending');
        if (abort) {
          controller.abort(abortReason);
          await checkpoint();
          assert.equal(state.status, 'rejected');
          assert.equal(state.reason, originalFailure ? sourceError : abortReason);
          assert.equal(listeners(controller.signal), 0);
        }
        cleanup.reject(cleanupError);
        await rejected(state, originalFailure ? sourceError : abort ? abortReason : cleanupError);
        await checkpoint();
        assert.equal(closes, 1);
        assert.equal(listeners(controller.signal), 0);
      } finally {
        cleanup.resolve(done);
        await state.done;
      }
    });
  }
}

test('sync cleanup awaits done/value in order, including a pending nested value', async () => {
  const value = deferred(), entered = deferred(), events = [];
  const state = observe(collectAsync(iterable(Symbol.iterator, {
    next() { return { value: 1 }; },
    return() {
      return Promise.resolve({
        get done() { events.push('done'); return false; },
        get value() { events.push('value'); entered.resolve(); return value.promise; },
      });
    },
  }), { limit: 1 }));
  try {
    await entered.promise;
    await checkpoint();
    assert.equal(state.status, 'pending');
    assert.deepEqual(events, ['done', 'value']);
  } finally {
    value.resolve('ignored');
    await state.done;
  }
  assert.deepEqual(state.value, [1]);
});

for (const protocol of protocols) {
  test(`${label(protocol)} return done:false is one attempt, not a cleanup drain`, async () => {
    let released = false, closes = 0, reads = 0;
    const generator = protocol === Symbol.iterator ? (function* () {
      try { yield 1; } finally { yield 'cleanup'; released = true; }
    })() : (async function* () {
      try { yield 1; } finally { yield 'cleanup'; released = true; }
    })();
    try {
      assert.deepEqual(await collectAsync(iterable(protocol, {
        next() { reads++; return generator.next(); },
        return() { closes++; return generator.return(); },
      }), { limit: 1 }), [1]);
      assert.equal(released, false);
      assert.equal(reads, 1);
      assert.equal(closes, 1);
    } finally {
      await generator.next(); // Test-owned generator teardown, not collector work.
    }
    assert.equal(released, true);
  });
}

for (const first of ['read', 'cleanup']) {
  for (const rejectRead of [false, true]) {
    for (const rejectCleanup of [false, true]) {
      test(`abort settles before both gates: ${first} first, rejects ${rejectRead}/${rejectCleanup}`, async () => {
        const read = deferred(), cleanup = deferred(), controller = new AbortController();
        const reason = {}, readError = {}, cleanupError = {};
        let reads = 0, closes = 0;
        const state = observe(collectAsync(iterable(Symbol.asyncIterator, {
          next() { return ++reads === 1 ? read.promise : done; },
          return() { closes++; return cleanup.promise; },
        }), { signal: controller.signal }));
        try {
          assert.equal(reads, 1);
          assert.equal(listeners(controller.signal), 1);
          controller.abort(reason);
          await checkpoint();
          assert.equal(state.status, 'rejected'); // Neither gate has been released.
          assert.equal(state.reason, reason);
          assert.equal(closes, 1);
          assert.equal(listeners(controller.signal), 0);
          const release = {
            read() { if (rejectRead) read.reject(readError); else read.resolve({ value: 1 }); },
            cleanup() { if (rejectCleanup) cleanup.reject(cleanupError); else cleanup.resolve(done); },
          };
          release[first]();
          await checkpoint();
          release[first === 'read' ? 'cleanup' : 'read']();
          await checkpoint();
          assert.equal(reads, 1);
          assert.equal(closes, 1);
          assert.equal(listeners(controller.signal), 0);
          assert.equal(state.reason, reason);
        } finally {
          read.resolve(done);
          cleanup.resolve(done);
          await state.done;
        }
      });
    }
  }
}

for (const reason of [undefined, null, false, 0, Symbol('abort'), {}, { then() {} }]) {
  test(`in-flight abort preserves exact reason ${String(reason)}`, async () => {
    const gate = deferred(), controller = new AbortController();
    const state = observe(collectAsync(iterable(Symbol.asyncIterator, {
      next() { return gate.promise; },
      return() { throw new Error('cleanup'); },
    }), { signal: controller.signal }));
    try {
      controller.abort(reason);
      await checkpoint();
      assert.equal(state.status, 'rejected');
      assert.equal(state.reason, controller.signal.reason);
    } finally {
      gate.resolve(done);
      await state.done;
    }
  });
}

for (const terminal of [false, true]) {
  test(`abort interrupts a sync ${terminal ? 'terminal' : 'item'} value`, async () => {
    const value = deferred(), controller = new AbortController(), reason = {};
    let reads = 0, closes = 0;
    const state = observe(collectAsync(iterable(Symbol.iterator, {
      next() { reads++; return { done: terminal, value: value.promise }; },
      return() { closes++; return done; },
    }), { signal: controller.signal }));
    try {
      await checkpoint();
      assert.equal(state.status, 'pending');
      controller.abort(reason);
      await checkpoint();
      assert.equal(state.status, 'rejected');
      assert.equal(state.reason, reason);
      assert.equal(closes, terminal ? 0 : 1);
      value.reject(new Error('late value rejection'));
      await checkpoint();
      assert.equal(reads, 1);
      assert.equal(listeners(controller.signal), 0);
    } finally {
      value.resolve();
      await state.done;
    }
  });
}

test('abort interrupts sync cleanup value adoption and observes its later rejection', async () => {
  const cleanupValue = deferred(), entered = deferred(), controller = new AbortController();
  const reason = {};
  let closes = 0;
  const state = observe(collectAsync(iterable(Symbol.iterator, {
    next() { return { value: 1 }; },
    return() {
      closes++;
      return { done: true, get value() { entered.resolve(); return cleanupValue.promise; } };
    },
  }), { limit: 1, signal: controller.signal }));
  try {
    await entered.promise;
    controller.abort(reason);
    await checkpoint();
    assert.equal(state.status, 'rejected');
    assert.equal(state.reason, reason);
    cleanupValue.reject(new Error('late nested cleanup'));
    await checkpoint();
    assert.equal(closes, 1);
    assert.equal(listeners(controller.signal), 0);
  } finally {
    cleanupValue.resolve();
    await state.done;
  }
});

for (const rejectGate of [false, true]) {
  test(`real async generator queues return behind next; late gate rejection=${rejectGate}`, async () => {
    const gate = deferred(), controller = new AbortController(), reason = {};
    let finalized = false, reads = 0, closes = 0;
    const generator = (async function* () {
      try { await gate.promise; yield 1; }
      finally { finalized = true; }
    })();
    const state = observe(collectAsync(iterable(Symbol.asyncIterator, {
      next() { reads++; return generator.next(); },
      return() { closes++; return generator.return(); },
    }), { signal: controller.signal }));
    try {
      controller.abort(reason);
      await checkpoint();
      assert.equal(state.status, 'rejected');
      assert.equal(state.reason, reason);
      assert.equal(finalized, false);
      assert.equal(closes, 1);
      assert.equal(listeners(controller.signal), 0);
      if (rejectGate) gate.reject(new Error('generator read'));
      else gate.resolve();
      await checkpoint();
      assert.equal(finalized, true);
      assert.equal(reads, 1);
      assert.equal(closes, 1);
    } finally {
      gate.resolve();
      await state.done;
      await checkpoint();
    }
  });
}

test('reentrant abort in a synchronous generator closes after next unwinds', async () => {
  const controller = new AbortController(), reason = {};
  let finalized = false, reads = 0, closes = 0;
  const generator = (function* () {
    try { controller.abort(reason); yield 1; }
    finally { finalized = true; }
  })();
  await rejected(observe(collectAsync(iterable(Symbol.iterator, {
    next() { reads++; return generator.next(); },
    return() { closes++; return generator.return(); },
  }), { signal: controller.signal })), reason);
  assert.equal(finalized, true);
  assert.equal(reads, 1);
  assert.equal(closes, 1);
  assert.equal(listeners(controller.signal), 0);
});

for (const where of ['async factory getter', 'sync factory getter', 'factory', 'next getter', 'next', 'done', 'value']) {
  test(`abort during ${where} prevents further source work and closes only owned input`, async () => {
    const controller = new AbortController(), reason = {};
    let reads = 0, closes = 0, valueGets = 0;
    const abortHere = position => { if (where === position) controller.abort(reason); };
    const iterator = {
      get next() {
        abortHere('next getter');
        return () => {
          reads++;
          abortHere('next');
          return {
            get done() { abortHere('done'); return false; },
            get value() { valueGets++; abortHere('value'); return 1; },
          };
        };
      },
      return() { closes++; return done; },
    };
    const source = {
      get [Symbol.asyncIterator]() { abortHere('async factory getter'); return undefined; },
      get [Symbol.iterator]() {
        abortHere('sync factory getter');
        return () => { abortHere('factory'); return iterator; };
      },
    };
    await rejected(observe(collectAsync(source, { signal: controller.signal })), reason);
    assert.equal(closes, where.endsWith('factory getter') ? 0 : 1);
    assert.equal(reads, ['next', 'done', 'value'].includes(where) ? 1 : 0);
    assert.equal(valueGets, where === 'value' ? 1 : 0);
    assert.equal(listeners(controller.signal), 0);
  });
}

test('a truthy done returned by an aborting getter establishes exhaustion', async () => {
  const controller = new AbortController(), reason = {};
  await rejected(observe(collectAsync(iterable(Symbol.iterator, {
    next() { return { get done() { controller.abort(reason); return true; } }; },
    get return() { assert.fail('observed exhaustion must not close'); },
  }), { signal: controller.signal })), reason);
});

test('async next aborts before returning a later-rejecting promise', async () => {
  const read = deferred(), controller = new AbortController(), reason = {};
  let closes = 0;
  const state = observe(collectAsync(iterable(Symbol.asyncIterator, {
    next() { controller.abort(reason); return read.promise; },
    return() { closes++; return done; },
  }), { signal: controller.signal }));
  try {
    await checkpoint();
    assert.equal(state.status, 'rejected');
    assert.equal(state.reason, reason);
    read.reject(new Error('late reentrant next'));
    await checkpoint();
    assert.equal(closes, 1);
  } finally {
    read.resolve(done);
    await state.done;
  }
});

test('sync value getter aborts before returning a later-rejecting promise', async () => {
  const value = deferred(), controller = new AbortController(), reason = {};
  const state = observe(collectAsync(iterable(Symbol.iterator, {
    next() { return { get value() { controller.abort(reason); return value.promise; } }; },
  }), { signal: controller.signal }));
  try {
    await checkpoint();
    assert.equal(state.status, 'rejected');
    assert.equal(state.reason, reason);
    value.reject(new Error('late getter value'));
    await checkpoint();
  } finally {
    value.resolve();
    await state.done;
  }
});

for (const where of ['getter', 'method']) {
  for (const sourceFails of [false, true]) {
    test(`cleanup ${where} aborts reentrantly; prior failure=${sourceFails}`, async () => {
      const controller = new AbortController(), reason = {}, original = {};
      let closeGets = 0, closes = 0;
      const state = observe(collectAsync(iterable(Symbol.asyncIterator, {
        next() { if (sourceFails) throw original; return { value: 1 }; },
        get return() {
          closeGets++;
          if (where === 'getter') { controller.abort(reason); throw new Error('close getter'); }
          return () => {
            closes++;
            controller.abort(reason);
            return Promise.reject(new Error('close method'));
          };
        },
      }), { limit: 1, signal: controller.signal }));
      await rejected(state, sourceFails ? original : reason);
      assert.equal(closeGets, 1);
      assert.equal(closes, where === 'getter' ? 0 : 1);
      assert.equal(listeners(controller.signal), 0);
    });
  }
}

for (const order of ['operation first', 'abort first']) {
  for (const outcome of ['value', 'done', 'reject']) {
    test(`read/abort same-turn race: ${order}, ${outcome}`, async () => {
      const gate = deferred(), controller = new AbortController(), reason = {};
      let reads = 0, closes = 0;
      const state = observe(collectAsync(iterable(Symbol.asyncIterator, {
        next() { reads++; return gate.promise; },
        return() { closes++; return done; },
      }), { limit: 1, signal: controller.signal }));
      const release = () => outcome === 'reject' ? gate.reject(new Error('read'))
        : gate.resolve(outcome === 'done' ? done : { value: 1 });
      if (order === 'operation first') release();
      controller.abort(reason);
      if (order === 'abort first') release();
      await rejected(state, reason);
      assert.equal(reads, 1);
      assert.equal(closes, 1); // The terminal result was never observed.
      assert.equal(listeners(controller.signal), 0);
    });
  }
}

for (const order of ['operation first', 'abort first']) {
  for (const rejectCleanup of [false, true]) {
    test(`cleanup/abort same-turn race: ${order}, rejection=${rejectCleanup}`, async () => {
      const gate = deferred(), entered = deferred(), controller = new AbortController(), reason = {};
      let closes = 0;
      const state = observe(collectAsync(iterable(Symbol.asyncIterator, {
        next() { return { value: 1 }; },
        return() { closes++; entered.resolve(); return gate.promise; },
      }), { limit: 1, signal: controller.signal }));
      await entered.promise;
      const release = () => rejectCleanup ? gate.reject(new Error('cleanup')) : gate.resolve(done);
      if (order === 'operation first') release();
      controller.abort(reason);
      if (order === 'abort first') release();
      await rejected(state, reason);
      assert.equal(closes, 1);
    });
  }
}

test('abort after terminal commitment does not replace success or failure', async () => {
  for (const fails of [false, true]) {
    const controller = new AbortController(), original = {};
    const state = observe(collectAsync(iterable(Symbol.asyncIterator, {
      next() { if (fails) throw original; return done; },
    }), { signal: controller.signal }));
    await state.done;
    controller.abort(new Error('too late'));
    assert.equal(state.status, fails ? 'rejected' : 'fulfilled');
    if (fails) assert.equal(state.reason, original);
    else assert.deepEqual(state.value, []);
    assert.equal(listeners(controller.signal), 0);
  }
});

test('terminal commitment precedes caller reactions, including queued abort', async () => {
  for (const outcome of ['success', 'acquisition failure', 'cleanup failure']) {
    const controller = new AbortController(), original = {};
    let abortedBeforeReaction = false;
    const abortLater = () => queueMicrotask(() => {
      controller.abort(new Error('after commitment'));
      abortedBeforeReaction = true;
    });
    const source = outcome === 'acquisition failure' ? {
      get [Symbol.asyncIterator]() { abortLater(); throw original; },
    } : iterable(Symbol.asyncIterator, {
      next() {
        if (outcome === 'cleanup failure') return { value: 1 };
        return { get done() { abortLater(); return true; } };
      },
      return() { abortLater(); throw original; },
    });
    const state = observe(collectAsync(source, { limit: 1, signal: controller.signal }).then(
      value => { assert.equal(abortedBeforeReaction, true); return value; },
      error => { assert.equal(abortedBeforeReaction, true); throw error; },
    ));
    await state.done;
    assert.equal(state.status, outcome === 'success' ? 'fulfilled' : 'rejected');
    if (outcome === 'success') assert.deepEqual(state.value, []);
    else assert.equal(state.reason, original);
    assert.equal(listeners(controller.signal), 0);
  }
});

test('falsy source errors stay committed when cleanup aborts and rejects', async () => {
  for (const original of [undefined, null, false, 0]) {
    const controller = new AbortController();
    await rejected(observe(collectAsync(iterable(Symbol.asyncIterator, {
      next() { return Promise.reject(original); },
      return() {
        controller.abort(new Error('abort during cleanup'));
        return Promise.reject(new Error('cleanup failed'));
      },
    }), { signal: controller.signal })), original);
    assert.equal(listeners(controller.signal), 0);
  }
});

test('async next assimilates nested thenables and observes reentrant assimilation failure', async () => {
  let reads = 0;
  assert.deepEqual(await collectAsync(iterable(Symbol.asyncIterator, {
    next() {
      return { then(resolve) { resolve({ then(yes) { yes(reads++ ? done : { value: 7 }); } }); } };
    },
  })), [7]);
  const controller = new AbortController(), reason = {};
  let closes = 0;
  await rejected(observe(collectAsync(iterable(Symbol.asyncIterator, {
    next() {
      return { get then() { controller.abort(reason); throw new Error('then getter'); } };
    },
    return() { closes++; return done; },
  }), { signal: controller.signal })), reason);
  assert.equal(closes, 1);
});

test('every exit restores the original listener set', async () => {
  for (const outcome of ['invalid limit', 'pre-abort', 'zero', 'exhaustion', 'limit',
    'acquisition failure', 'read failure', 'cleanup failure']) {
    const controller = new AbortController(), external = () => {};
    controller.signal.addEventListener('abort', external);
    if (outcome === 'pre-abort') controller.abort();
    let reads = 0;
    const source = {
      [Symbol.asyncIterator]() {
        if (outcome === 'acquisition failure') throw new Error('factory');
        return this;
      },
      next() {
        if (outcome === 'read failure') return Promise.reject(new Error('read'));
        return reads++ ? done : { value: 1 };
      },
      return() {
        if (outcome === 'cleanup failure') return Promise.reject(new Error('cleanup'));
        return done;
      },
    };
    const limit = outcome === 'invalid limit' ? -1 : outcome === 'zero' ? 0
      : ['limit', 'cleanup failure'].includes(outcome) ? 1 : Infinity;
    const state = observe(collectAsync(source, { limit, signal: controller.signal }));
    await state.done;
    assert.equal(state.status, ['zero', 'exhaustion', 'limit'].includes(outcome) ? 'fulfilled' : 'rejected');
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), [external]);
    controller.signal.removeEventListener('abort', external);
  }
});

test('two blocked collections sharing a signal both cancel after a synthetic event', async () => {
  const controller = new AbortController(), reason = {};
  const gates = [deferred(), deferred()];
  const states = gates.map(gate => observe(collectAsync(iterable(Symbol.asyncIterator, {
    next() { return gate.promise; },
  }), { signal: controller.signal })));
  try {
    assert.equal(listeners(controller.signal), 2);
    controller.signal.dispatchEvent(new Event('abort'));
    await checkpoint();
    assert.equal(listeners(controller.signal), 2);
    controller.abort(reason);
    await checkpoint();
    for (const state of states) {
      assert.equal(state.status, 'rejected');
      assert.equal(state.reason, reason);
    }
    assert.equal(listeners(controller.signal), 0);
  } finally {
    gates.forEach(gate => gate.resolve(done));
    await Promise.all(states.map(state => state.done));
  }
});

test('reads never overlap and limit causes no speculative read', async () => {
  const gates = [deferred(), deferred()];
  let reads = 0, active = 0, closes = 0;
  const state = observe(collectAsync(iterable(Symbol.asyncIterator, {
    next() {
      assert.equal(active, 0);
      const gate = gates[reads++];
      assert.ok(gate, 'unexpected speculative read');
      active++;
      return gate.promise.finally(() => { active--; });
    },
    return() { closes++; return done; },
  }), { limit: 2 }));
  try {
    await checkpoint();
    assert.equal(reads, 1);
    gates[0].resolve({ value: 1 });
    await checkpoint();
    assert.equal(reads, 2);
    assert.equal(active, 1);
    gates[1].resolve({ value: 2 });
    await state.done;
    assert.deepEqual(state.value, [1, 2]);
    assert.equal(reads, 2);
    assert.equal(closes, 1);
  } finally {
    gates.forEach(gate => gate.resolve(done));
    await state.done;
  }
});

test('earlier stopImmediatePropagation does not suppress real cancellation', async () => {
  const gate = deferred(), controller = new AbortController(), reason = {};
  const external = event => event.stopImmediatePropagation();
  controller.signal.addEventListener('abort', external);
  const state = observe(collectAsync(iterable(Symbol.asyncIterator, {
    next() { return gate.promise; },
  }), { signal: controller.signal }));
  try {
    assert.equal(listeners(controller.signal), 2);
    controller.abort(reason);
    await checkpoint();
    assert.equal(state.status, 'rejected');
    assert.equal(state.reason, reason);
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), [external]);
  } finally {
    gate.resolve(done);
    controller.signal.removeEventListener('abort', external);
    await state.done;
  }
});

for (const inGap of [false, true]) {
  test(`synthetic event does not consume later cancellation; abort in re-arm gap=${inGap}`, async () => {
    const gate = deferred(), controller = new AbortController(), reason = {};
    const state = observe(collectAsync(iterable(Symbol.asyncIterator, {
      next() { return gate.promise; },
    }), { signal: controller.signal }));
    try {
      controller.signal.dispatchEvent(new Event('abort'));
      if (!inGap) {
        await checkpoint();
        assert.equal(state.status, 'pending');
        assert.equal(listeners(controller.signal), 1);
      }
      controller.abort(reason);
      await checkpoint();
      assert.equal(state.status, 'rejected');
      assert.equal(state.reason, reason);
      assert.equal(listeners(controller.signal), 0);
    } finally {
      gate.resolve(done);
      await state.done;
    }
  });
}

test('stale synthetic-event re-arm cannot restore a listener after synchronous failure', async () => {
  const controller = new AbortController(), error = {};
  await rejected(observe(collectAsync({
    get [Symbol.asyncIterator]() {
      controller.signal.dispatchEvent(new Event('abort'));
      throw error;
    },
  }, { signal: controller.signal })), error);
  await checkpoint();
  assert.equal(listeners(controller.signal), 0);
});

test('shared-signal invocations own independent listeners and preserve external ones', async () => {
  const controller = new AbortController(), gate = deferred(), reason = {};
  const external = () => {};
  controller.signal.addEventListener('abort', external);
  const waiting = observe(collectAsync(iterable(Symbol.asyncIterator, {
    next() { return gate.promise; },
  }), { signal: controller.signal }));
  try {
    assert.deepEqual(await collectAsync([1, 2], { signal: controller.signal }), [1, 2]);
    assert.equal(listeners(controller.signal), 2);
    controller.signal.dispatchEvent(new Event('abort'));
    await checkpoint();
    assert.equal(listeners(controller.signal), 2);
    controller.abort(reason);
    await checkpoint();
    assert.equal(waiting.status, 'rejected');
    assert.equal(waiting.reason, reason);
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), [external]);
  } finally {
    gate.resolve(done);
    controller.signal.removeEventListener('abort', external);
    await waiting.done;
  }
});

test('immediately ready sources do not promise a task-queue yield', async () => {
  let immediateRan = false;
  const immediate = new Promise(resolve => setImmediate(() => { immediateRan = true; resolve(); }));
  try {
    const input = Array.from({ length: 1024 }, (_, index) => index);
    assert.deepEqual(await collectAsync(input), input);
    assert.equal(immediateRan, false);
  } finally {
    await immediate;
  }
});

// Strict subprocesses establish that the rejection oracle actually detects a
// missing observer. No test catch is attached to an abandoned operation. Each
// subprocess stays alive through Node's rejection reporting, and runs serially.
function strictProbe(script) {
  return spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '--eval', script], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
  });
}

test('strict rejection oracle rejects a deliberately observer-free fixture', () => {
  const result = strictProbe(`
    const gate = Promise.withResolvers();
    gate.reject(new Error('observer-free fixture'));
    await new Promise(resolve => setImmediate(resolve));
  `);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /observer-free fixture/);
});

for (const failure of ['read', 'cleanup', 'both']) {
  test(`strict rejection oracle: late ${failure} errors are observed by the collector`, () => {
    const result = strictProbe(`
      import assert from 'node:assert/strict';
      import { getEventListeners } from 'node:events';
      import { collectAsync } from ${JSON.stringify(new URL('../lib.mjs', import.meta.url).href)};
      const read = Promise.withResolvers(), cleanup = Promise.withResolvers();
      const controller = new AbortController(), reason = {};
      let reads = 0, closes = 0, settled = false;
      const result = collectAsync({
        [Symbol.asyncIterator]() { return this; },
        next() { return ++reads === 1 ? read.promise : { done: true }; },
        return() { closes++; return cleanup.promise; },
      }, { signal: controller.signal });
      const observed = result.then(() => assert.fail('fulfilled'), error => {
        assert.equal(error, reason); settled = true;
      });
      controller.abort(reason);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, true);
      assert.equal(closes, 1);
      ${failure !== 'cleanup' ? "read.reject(new Error('late read'));" : 'read.resolve({ value: 1 });'}
      await new Promise(resolve => setImmediate(resolve));
      ${failure !== 'read' ? "cleanup.reject(new Error('late cleanup'));" : 'cleanup.resolve({ done: true });'}
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reads, 1);
      assert.equal(closes, 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      await observed;
    `);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  });
}

test('collector does not accumulate reactions on a shared pending cancellation promise', () => {
  const result = strictProbe(`
    import assert from 'node:assert/strict';
    import { collectAsync } from ${JSON.stringify(new URL('../lib.mjs', import.meta.url).href)};
    const original = Promise.prototype.then, subscriptions = new Map();
    Promise.prototype.then = function (...args) {
      subscriptions.set(this, (subscriptions.get(this) ?? 0) + 1);
      return Reflect.apply(original, this, args);
    };
    try {
      const controller = new AbortController();
      const input = Array.from({ length: 128 }, (_, index) => index);
      assert.deepEqual(await collectAsync(input, { signal: controller.signal }), input);
      assert.ok(subscriptions.size > 0, 'probe observes promise subscriptions');
      assert.ok(Math.max(...subscriptions.values()) <= 2, 'repeated reactions on one promise');
    } finally {
      Promise.prototype.then = original;
    }
  `);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
