import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { runInNewContext } from 'node:vm';
import { createKeyedSerialExecutor } from '../lib/keyed-serial-executor.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Only observe public promises: observing raw callback results could hide an
// unhandled rejection in the scheduler. Do not assimilate rejection reasons.
function observe(promise) {
  assert.ok(promise instanceof Promise);
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

async function fulfilled(state, value) {
  await state.done;
  assert.equal(state.status, 'fulfilled');
  assert.equal(state.value, value);
}

function controlled(executor, key, options, onStart = () => {}) {
  const gate = deferred(), started = deferred();
  const state = observe(executor.run(key, () => {
    onStart();
    started.resolve();
    return gate.promise;
  }, options));
  return { state, started: started.promise, resolve: gate.resolve, reject: gate.reject };
}

const listeners = signal => getEventListeners(signal, 'abort');
// Gates prove progress; a turn checkpoint only checks that blocked work has
// not progressed. No assertion depends on an exact number of promise turns.
const checkpoint = () => new Promise(resolve => setImmediate(resolve));
let forbiddenCalls = 0;
// Throwing here alone is insufficient: an erroneous late invocation could have
// its throw swallowed by the executor after the public promise already rejected.
const never = () => { forbiddenCalls++; };

describe('createKeyedSerialExecutor', { timeout: 30000 }, () => {
  afterEach(async () => {
    await checkpoint();
    const calls = forbiddenCalls;
    forbiddenCalls = 0;
    assert.equal(calls, 0, 'cancelled, closed or invalid callbacks must never run');
  });

  it('starts asynchronously with getter-only counters and no callback receiver or arguments', async () => {
    const executor = createKeyedSerialExecutor();
    for (const name of ['pending', 'closed']) {
      const descriptor = Object.getOwnPropertyDescriptor(executor, name);
      assert.equal(typeof descriptor.get, 'function');
      assert.equal(descriptor.set, undefined);
      assert.throws(() => { executor[name] = 100; }, TypeError);
    }
    assert.equal(executor.pending, 0);
    assert.equal(executor.closed, false);
    let returned = false, called = false;
    const controller = new AbortController(), external = () => {};
    controller.signal.addEventListener('abort', external);
    const promise = executor.run('key', function (...args) {
      called = true;
      assert.equal(returned, true);
      assert.equal(this, undefined);
      assert.deepEqual(args, []);
      assert.equal(executor.pending, 0);
      assert.deepEqual(listeners(controller.signal), [external]);
      return 42;
    }, { signal: controller.signal });
    assert.equal(called, false);
    assert.equal(executor.pending, 1);
    assert.equal(listeners(controller.signal).length, 2);
    returned = true;
    assert.equal(await promise, 42);
    await executor.close();
    assert.equal(executor.pending, 0);
    assert.equal(executor.closed, true);
  });

  it('runs keys concurrently and preserves FIFO and exclusive ownership through settlement', async () => {
    const executor = createKeyedSerialExecutor();
    const starts = [], active = new Map(), maximum = new Map();
    function work(key, label) {
      const gate = deferred(), started = deferred();
      const state = observe(executor.run(key, () => {
        const count = (active.get(key) ?? 0) + 1;
        active.set(key, count);
        maximum.set(key, Math.max(maximum.get(key) ?? 0, count));
        starts.push(label);
        started.resolve();
        // This is the callback's full result, including its final cleanup.
        return gate.promise.finally(() => active.set(key, active.get(key) - 1));
      }));
      return { ...gate, state, started: started.promise };
    }
    const a1 = work('a', 'a1'), a2 = work('a', 'a2'), a3 = work('a', 'a3');
    const b1 = work('b', 'b1'), b2 = work('b', 'b2');
    assert.equal(executor.pending, 5);
    await Promise.all([a1.started, b1.started]);
    assert.equal(active.get('a'), 1);
    assert.equal(active.get('b'), 1);
    assert.equal(executor.pending, 3);
    b1.resolve('B1');
    await b2.started;
    assert.equal(a1.state.status, 'pending');
    assert.deepEqual(starts.filter(label => label.startsWith('a')), ['a1']);
    assert.equal(executor.pending, 2);
    const failure = { failed: 'a1' };
    a1.reject(failure);
    await a2.started;
    await rejected(a1.state, failure);
    assert.equal(b2.state.status, 'pending');
    a2.resolve('A2');
    await a3.started;
    assert.equal(executor.pending, 0);
    a3.resolve('A3');
    b2.resolve('B2');
    await Promise.all([a2.state.done, a3.state.done, b1.state.done, b2.state.done]);
    assert.deepEqual(starts.filter(label => label.startsWith('a')), ['a1', 'a2', 'a3']);
    assert.deepEqual(starts.filter(label => label.startsWith('b')), ['b1', 'b2']);
    assert.deepEqual([...maximum.values()], [1, 1]);
    assert.deepEqual([...active.values()], [0, 0]);
    await executor.close();
  });

  it('uses Map identity for every kind of key and reuses drained keys without coercion', async () => {
    const executor = createKeyedSerialExecutor();
    const hostile = { [Symbol.toPrimitive]() { throw new Error('coercion'); } };
    const keys = [undefined, null, NaN, 0, 1, '1', 1n, true, false, '', '__proto__',
      Symbol('same'), Symbol('same'), {}, {}, hostile, () => {}, Infinity, -Infinity];
    for (let round = 0; round < 2; round++) {
      const starts = [];
      const heads = keys.map((key, index) => controlled(executor, key, undefined,
        () => starts.push(index)));
      const tails = keys.map((key, index) => observe(executor.run(
        Object.is(key, 0) ? -0 : key,
        () => { starts.push(`tail${index}`); return index; },
      )));
      await Promise.all(heads.map(head => head.started));
      assert.equal(starts.length, keys.length);
      assert.equal(executor.pending, keys.length);
      await checkpoint();
      tails.forEach(tail => assert.equal(tail.status, 'pending'));
      heads.forEach(head => head.resolve());
      await Promise.all(tails.map(tail => tail.done));
      tails.forEach((tail, index) => assert.equal(tail.value, index));
      assert.equal(executor.pending, 0);
    }
    await executor.close();
  });

  for (const value of [undefined, null, false, 0, '', Symbol('value'), { result: true }]) {
    it(`preserves a plain fulfillment of type ${typeof value}`, async () => {
      const executor = createKeyedSerialExecutor();
      await fulfilled(observe(executor.run('k', () => value)), value);
      await executor.close();
    });
  }

  it('adopts nested thenables with their receiver and holds the key until final settlement', async () => {
    const executor = createKeyedSerialExecutor();
    const innerStarted = deferred(), outerStarted = deferred();
    const gate = deferred(), value = { final: true };
    const inner = { then(resolve) {
      assert.equal(this, inner);
      innerStarted.resolve();
      resolve(gate.promise);
    } };
    const outer = { then(resolve, reject) {
      assert.equal(this, outer);
      outerStarted.resolve();
      resolve(inner);
      reject(new Error('ignored rejection'));
      resolve('ignored resolution');
      throw new Error('ignored throw');
    } };
    const first = observe(executor.run('k', () => outer));
    const next = controlled(executor, 'k');
    await Promise.all([outerStarted.promise, innerStarted.promise]);
    await checkpoint();
    assert.equal(first.status, 'pending');
    assert.equal(next.state.status, 'pending');
    assert.equal(executor.pending, 1);
    gate.resolve(value);
    await next.started;
    await fulfilled(first, value);
    next.resolve('next');
    await fulfilled(next.state, 'next');
    await executor.close();
  });

  it('reads a stateful then getter once for public delivery and scheduling', async () => {
    const executor = createKeyedSerialExecutor();
    let reads = 0;
    const result = { get then() {
      reads++;
      return reads === 1 ? undefined : () => assert.fail('second assimilation');
    } };
    const state = observe(executor.run('k', () => result));
    const next = observe(executor.run('k', () => 'next'));
    await fulfilled(state, result);
    await fulfilled(next, 'next');
    assert.equal(reads, 1);
    await executor.close();
  });

  it('rejects direct self-return with TypeError and releases the key', async () => {
    const executor = createKeyedSerialExecutor();
    let promise;
    promise = executor.run('k', () => promise);
    const state = observe(promise);
    const next = observe(executor.run('k', () => 7));
    await state.done;
    assert.equal(state.status, 'rejected');
    assert.ok(state.reason instanceof TypeError);
    await fulfilled(next, 7);
    await executor.close();
  });

  const exoticReason = { get then() { assert.fail('rejection reasons must not be assimilated'); } };
  const callableReason = { then() { assert.fail('rejection reasons must not be invoked'); } };
  const reasons = [undefined, null, false, 0, '', Symbol('reason'), { exact: true },
    exoticReason, callableReason, Promise.resolve('a promise is also a reason')];
  for (const [index, failure] of reasons.entries()) {
    it(`preserves arbitrary rejection reason ${index} across failures and cancellation`, async () => {
      const executor = createKeyedSerialExecutor();
      for (const fn of [() => { throw failure; }, () => Promise.reject(failure),
        () => ({ get then() { throw failure; } })]) {
        const first = observe(executor.run('k', fn));
        const next = observe(executor.run('k', () => 'recovered'));
        await rejected(first, failure);
        await fulfilled(next, 'recovered');
      }
      const invalid = observe(executor.run('k', never, { get signal() { throw failure; } }));
      await rejected(invalid, failure);
      const pre = AbortSignal.abort(failure);
      await rejected(observe(executor.run('k', never, { signal: pre })), pre.reason);
      const head = controlled(executor, 'k');
      await head.started;
      const controller = new AbortController();
      const queued = observe(executor.run('k', never, { signal: controller.signal }));
      controller.abort(failure);
      await rejected(queued, controller.signal.reason);
      assert.equal(executor.pending, 0);
      head.resolve();
      await head.state.done;
      await executor.close();
    });
  }

  for (const phase of ['idle', 'busy', 'closed']) {
    it(`validates without synchronous throws or admission while ${phase}`, async () => {
      const executor = createKeyedSerialExecutor();
      const head = phase === 'busy' ? controlled(executor, 'k') : undefined;
      if (head) await head.started;
      if (phase === 'closed') await executor.close();
      const existing = head ? observe(executor.run('k', () => 'existing')) : undefined;
      const controller = new AbortController(), external = () => {};
      controller.signal.addEventListener('abort', external);
      const signal = controller.signal;
      const invalidFns = [undefined, null, false, 1, 'fn', {}, [], Promise.resolve()];
      const invalidOptions = [null, [], true, 1, 1n, 'options', Symbol(), () => {}];
      const revoked = Proxy.revocable(signal, {});
      revoked.revoke();
      const invalidSignals = [null, false, 1, 'signal', {}, [], () => {},
        { aborted: false, reason: undefined, addEventListener() {}, removeEventListener() {} },
        AbortSignal.prototype, Object.create(AbortSignal.prototype), Object.create(signal),
        new Proxy(signal, {}), revoked.proxy,
        runInNewContext('new (class AbortSignal { get aborted() { return false; } })()')];
      const calls = [
        ...invalidFns.map(fn => () => executor.run('k', fn, { signal })),
        ...invalidOptions.map(options => () => executor.run('k', never, options)),
        ...invalidSignals.map(signal => () => executor.run('k', never, { signal })),
      ];
      for (const call of calls) {
        let promise;
        assert.doesNotThrow(() => { promise = call(); });
        const state = observe(promise);
        assert.equal(executor.pending, head ? 1 : 0);
        assert.deepEqual(listeners(signal), [external]);
        await state.done;
        assert.equal(state.status, 'rejected');
        assert.ok(state.reason instanceof TypeError);
        assert.equal(executor.closed, phase === 'closed');
      }
      let reads = 0;
      const failure = { invalid: true };
      await rejected(observe(executor.run('k', never, { get signal() {
        reads++;
        throw failure;
      } })), failure);
      assert.equal(reads, 1);
      assert.equal(executor.pending, head ? 1 : 0);
      if (head) {
        head.resolve();
        await fulfilled(existing, 'existing');
      }
      await executor.close();
      assert.deepEqual(listeners(signal), [external]);
    });
  }

  it('accepts omitted, undefined, inherited and null-prototype options and ignores unrelated keys', async () => {
    const executor = createKeyedSerialExecutor();
    const controller = new AbortController();
    const signal = controller.signal;
    const options = [undefined, {}, { signal: undefined }, Object.create({ signal }),
      Object.assign(Object.create(null), { signal }), { signal, extra: true, [Symbol()]: 1 }];
    options.push({ get unrelated() { assert.fail('unrelated option read'); } });
    const currentRealmSignalCreatedInContext = runInNewContext('new AbortController().signal', { AbortController });
    options.push({ signal: AbortSignal.any([signal]) }, { signal: currentRealmSignalCreatedInContext });
    for (const option of options) assert.equal(await executor.run('k', () => 3, option), 3);
    const pre = AbortSignal.abort({ pre: true });
    await rejected(observe(executor.run('k', never, { signal: pre })), pre.reason);
    assert.deepEqual(listeners(signal), []);
    await executor.close();
  });

  it('preserves external listeners on pre-aborted rejection without adding owned listeners', async () => {
    const executor = createKeyedSerialExecutor();
    const controller = new AbortController(), external = () => {};
    controller.signal.addEventListener('abort', external);
    controller.abort({ pre: true });
    const state = observe(executor.run('k', never, { signal: controller.signal }));
    assert.equal(executor.pending, 0);
    assert.deepEqual(listeners(controller.signal), [external]);
    await rejected(state, controller.signal.reason);
    await executor.close();
  });

  for (const ending of ['start', 'abort', 'close']) {
    it(`reads an inherited signal getter exactly once through ${ending}`, async () => {
      const executor = createKeyedSerialExecutor();
      const controller = new AbortController();
      let reads = 0;
      const options = Object.create({ get signal() { reads++; return controller.signal; } });
      const state = observe(executor.run('k', ending === 'start' ? () => 1 : never, options));
      assert.equal(reads, 1);
      if (ending === 'abort') controller.abort('abort');
      if (ending === 'close') executor.close();
      await state.done;
      assert.equal(reads, 1);
      assert.equal(state.status, ending === 'start' ? 'fulfilled' : 'rejected');
      assert.deepEqual(listeners(controller.signal), []);
      await executor.close();
    });
  }

  it('orders reentrant getter submissions by successful admission', async () => {
    const executor = createKeyedSerialExecutor();
    const order = [];
    let nested;
    const outer = executor.run('k', () => order.push('outer'), { get signal() {
      nested = executor.run('k', () => order.push('nested'));
      return undefined;
    } });
    assert.equal(executor.pending, 2);
    await Promise.all([outer, nested]);
    assert.deepEqual(order, ['nested', 'outer']);
    await executor.close();
  });

  for (const throwing of [false, true]) {
    it(`rechecks closure after a signal getter${throwing ? ' that throws' : ''}`, async () => {
      const executor = createKeyedSerialExecutor();
      const failure = { getter: true };
      let closePromise;
      const state = observe(executor.run('k', never, { get signal() {
        closePromise = executor.close();
        if (throwing) throw failure;
        return new AbortController().signal;
      } }));
      assert.equal(executor.closed, true);
      assert.equal(executor.pending, 0);
      await state.done;
      if (throwing) assert.equal(state.reason, failure);
      else assert.equal(state.reason.code, 'EXECUTOR_CLOSED');
      assert.equal(executor.close(), closePromise);
      const later = observe(executor.run('k', never));
      await later.done;
      if (!throwing) assert.equal(later.reason, state.reason);
      await closePromise;
    });
  }

  it('preserves getter side effects but does not admit the failed outer call', async () => {
    const executor = createKeyedSerialExecutor();
    const failure = { invalid: true };
    let nested;
    const state = observe(executor.run('k', never, { get signal() {
      nested = executor.run('k', () => 12);
      throw failure;
    } }));
    assert.equal(executor.pending, 1);
    await rejected(state, failure);
    assert.equal(await nested, 12);
    await executor.close();
  });

  it('unlinks queued head, middle and tail cancellations while preserving survivors', async () => {
    const executor = createKeyedSerialExecutor();
    const head = controlled(executor, 'k');
    await head.started;
    const starts = [];
    const controllers = Array.from({ length: 7 }, () => new AbortController());
    const states = controllers.map((controller, index) => observe(executor.run('k', () => {
      starts.push(index);
      return index;
    }, { signal: controller.signal })));
    assert.equal(executor.pending, 7);
    for (const [step, index] of [0, 3, 6].entries()) {
      controllers[index].abort({ index });
      assert.equal(executor.pending, 6 - step);
      await rejected(states[index], controllers[index].signal.reason);
      assert.deepEqual(listeners(controllers[index].signal), []);
    }
    await checkpoint();
    assert.deepEqual(starts, []);
    head.resolve();
    await Promise.all(states.map(state => state.done));
    assert.deepEqual(starts, [1, 2, 4, 5]);
    controllers.forEach(controller => assert.deepEqual(listeners(controller.signal), []));
    await executor.close();
  });

  it('cancels an idle unstarted job and safely replaces its lane before its scheduled start', async () => {
    const executor = createKeyedSerialExecutor();
    const key = {}, controller = new AbortController();
    const first = observe(executor.run(key, never, { signal: controller.signal }));
    controller.abort('cancel');
    assert.equal(executor.pending, 0);
    const replacement = controlled(executor, key);
    const successor = controlled(executor, key);
    assert.equal(executor.pending, 2);
    await replacement.started;
    await rejected(first, 'cancel');
    await checkpoint();
    assert.equal(successor.state.status, 'pending');
    assert.equal(executor.pending, 1);
    replacement.resolve(1);
    await successor.started;
    assert.equal(executor.pending, 0);
    successor.resolve(2);
    await fulfilled(replacement.state, 1);
    await fulfilled(successor.state, 2);
    await executor.close();
  });

  for (const outcome of ['fulfill', 'reject']) {
    it(`ignores running cancellation until the callback result can ${outcome}`, async () => {
      const executor = createKeyedSerialExecutor();
      const controller = new AbortController(), external = () => {};
      controller.signal.addEventListener('abort', external);
      const first = controlled(executor, 'k', { signal: controller.signal });
      const next = controlled(executor, 'k');
      await first.started;
      assert.deepEqual(listeners(controller.signal), [external]);
      controller.abort({ cancelled: true });
      await checkpoint();
      assert.equal(first.state.status, 'pending');
      assert.equal(next.state.status, 'pending');
      assert.equal(executor.pending, 1);
      const result = { actual: outcome };
      if (outcome === 'fulfill') first.resolve(result);
      else first.reject(result);
      await next.started;
      if (outcome === 'fulfill') await fulfilled(first.state, result);
      else await rejected(first.state, result);
      next.resolve();
      await executor.close();
    });
  }

  for (const outcome of ['value', 'throw', 'thenable']) {
    it(`preserves a callback's ${outcome} when it aborts its own signal`, async () => {
      const executor = createKeyedSerialExecutor();
      const controller = new AbortController(), result = { outcome };
      const first = observe(executor.run('k', () => {
        assert.deepEqual(listeners(controller.signal), []);
        controller.abort('ignored');
        if (outcome === 'throw') throw result;
        if (outcome === 'thenable') return { then(resolve) { resolve(result); } };
        return result;
      }, { signal: controller.signal }));
      const next = observe(executor.run('k', () => 'next'));
      if (outcome === 'throw') await rejected(first, result);
      else await fulfilled(first, result);
      await fulfilled(next, 'next');
      await executor.close();
    });
  }

  it('shared signals cancel only queued work across keys and keep external listeners', async () => {
    const executor = createKeyedSerialExecutor();
    const controller = new AbortController(), external = () => {};
    const options = { signal: controller.signal };
    controller.signal.addEventListener('abort', external);
    const a = controlled(executor, 'a', options), b = controlled(executor, 'b', options);
    await Promise.all([a.started, b.started]);
    const queued = ['a', 'a', 'b', 'c'].map(key => observe(executor.run(key, never, options)));
    assert.equal(listeners(controller.signal).length, 5);
    controller.abort('shared');
    assert.equal(executor.pending, 0);
    await Promise.all(queued.map(state => rejected(state, 'shared')));
    assert.deepEqual(listeners(controller.signal), [external]);
    assert.equal(a.state.status, 'pending');
    assert.equal(b.state.status, 'pending');
    a.resolve('a');
    b.resolve('b');
    await fulfilled(a.state, 'a');
    await fulfilled(b.state, 'b');
    await executor.close();
  });

  it('cannot have queued cancellation suppressed by stopImmediatePropagation', async () => {
    const executor = createKeyedSerialExecutor();
    const head = controlled(executor, 'k');
    await head.started;
    const controller = new AbortController(), external = event => event.stopImmediatePropagation();
    controller.signal.addEventListener('abort', external);
    const state = observe(executor.run('k', never, { signal: controller.signal }));
    controller.abort('stopped');
    assert.equal(executor.pending, 0);
    await rejected(state, 'stopped');
    assert.equal(head.state.status, 'pending');
    assert.deepEqual(listeners(controller.signal), [external]);
    head.resolve();
    await executor.close();
  });

  for (const ending of ['abort immediately', 'abort after rearm', 'start before rearm',
    'start after rearm', 'close immediately', 'close after rearm']) {
    it(`ignores synthetic abort events and handles ${ending}`, async () => {
      const executor = createKeyedSerialExecutor();
      const controller = new AbortController(), external = event => event.stopImmediatePropagation();
      controller.signal.addEventListener('abort', external);
      const options = { signal: controller.signal };
      // Initial starts are already scheduled before the synthetic re-arm.
      // Other cases hold a predecessor, proving cancellation without a drain.
      const head = ending === 'start before rearm' ? undefined : controlled(executor, 'k');
      if (head) await head.started;
      const b = controlled(executor, 'k', options), c = controlled(executor, 'k', options);
      controller.signal.dispatchEvent(new Event('abort'));
      assert.equal(controller.signal.aborted, false);
      assert.equal(executor.pending, 2);
      if (ending.endsWith('after rearm')) {
        await checkpoint();
        assert.equal(b.state.status, 'pending');
        assert.equal(c.state.status, 'pending');
        assert.equal(listeners(controller.signal).length, 3);
        controller.signal.dispatchEvent(new Event('abort'));
        await checkpoint();
        assert.equal(listeners(controller.signal).length, 3);
      }
      if (ending.startsWith('abort')) {
        controller.abort('actual abort');
        assert.equal(executor.pending, 0);
        await rejected(b.state, 'actual abort');
        await rejected(c.state, 'actual abort');
      } else if (ending.startsWith('close')) {
        executor.close();
        assert.equal(executor.pending, 0);
        assert.deepEqual(listeners(controller.signal), [external]);
        await b.state.done;
        await rejected(c.state, b.state.reason);
        assert.equal(b.state.reason.code, 'EXECUTOR_CLOSED');
      } else {
        head?.resolve();
        await b.started;
        assert.equal(executor.pending, 1);
        assert.equal(listeners(controller.signal).length, 2);
        b.resolve('b');
        await c.started;
        c.resolve('c');
        await fulfilled(b.state, 'b');
        await fulfilled(c.state, 'c');
      }
      head?.resolve();
      await executor.close();
      await checkpoint();
      assert.deepEqual(listeners(controller.signal), [external]);
    });
  }

  it('reflects abort state in an earlier external listener and gives it precedence over close', async () => {
    const executor = createKeyedSerialExecutor();
    const head = controlled(executor, 'a');
    await head.started;
    const controller = new AbortController(), snapshots = [];
    let closePromise;
    const external = () => {
      snapshots.push(executor.pending);
      closePromise = executor.close();
      snapshots.push(executor.pending);
    };
    controller.signal.addEventListener('abort', external);
    const abortedJobs = ['a', 'b'].map(key => observe(executor.run(key, never, { signal: controller.signal })));
    const closedJob = observe(executor.run('a', never));
    assert.equal(executor.pending, 3);
    const abortReason = { abort: true };
    controller.abort(abortReason);
    assert.deepEqual(snapshots, [1, 0]);
    assert.equal(executor.closed, true);
    await Promise.all(abortedJobs.map(state => rejected(state, abortReason)));
    await closedJob.done;
    assert.equal(closedJob.reason.code, 'EXECUTOR_CLOSED');
    assert.deepEqual(listeners(controller.signal), [external]);
    assert.equal(executor.close(), closePromise);
    head.resolve();
    assert.equal(await closePromise, undefined);
  });

  it('closes idle and unstarted work synchronously and keeps one close promise and error', async () => {
    for (const withJob of [false, true]) {
      const executor = createKeyedSerialExecutor();
      const controller = new AbortController(), external = () => {};
      controller.signal.addEventListener('abort', external);
      const queued = withJob ? observe(executor.run('k', never, { signal: controller.signal })) : undefined;
      const promise = executor.close();
      assert.ok(promise instanceof Promise);
      assert.equal(executor.closed, true);
      assert.equal(executor.pending, 0);
      assert.equal(executor.close(), promise);
      assert.deepEqual(listeners(controller.signal), [external]);
      controller.abort({ tooLate: true });
      const later = observe(executor.run('k', never, { signal: controller.signal }));
      await later.done;
      assert.equal(later.status, 'rejected');
      assert.ok(later.reason instanceof Error);
      assert.equal(later.reason.code, 'EXECUTOR_CLOSED');
      if (queued) await rejected(queued, later.reason);
      assert.equal(await promise, undefined);
      assert.equal(executor.close(), promise);
      await rejected(observe(executor.run('new key', never)), later.reason);
    }
  });

  it('drains two running keys after rejecting all queued work and tolerates running rejection', async () => {
    const executor = createKeyedSerialExecutor();
    const a = controlled(executor, 'a'), b = controlled(executor, 'b');
    await Promise.all([a.started, b.started]);
    const controller = new AbortController(), external = () => {};
    controller.signal.addEventListener('abort', external);
    const queued = ['a', 'b', 'c'].map(key => observe(executor.run(key, never, { signal: controller.signal })));
    const promise = executor.close(), closing = observe(promise);
    assert.equal(executor.closed, true);
    assert.equal(executor.pending, 0);
    assert.deepEqual(listeners(controller.signal), [external]);
    assert.equal(executor.close(), promise);
    await queued[0].done;
    const closeError = queued[0].reason;
    assert.ok(closeError instanceof Error);
    assert.equal(closeError.code, 'EXECUTOR_CLOSED');
    await Promise.all(queued.map(state => rejected(state, closeError)));
    await rejected(observe(executor.run('later', never)), closeError);
    a.reject('running failure');
    await rejected(a.state, 'running failure');
    await checkpoint();
    assert.equal(closing.status, 'pending');
    assert.equal(executor.close(), promise);
    b.resolve('running success');
    await fulfilled(b.state, 'running success');
    await fulfilled(closing, undefined);
    assert.equal(executor.close(), promise);
  });

  it('can initiate close inside a running callback while every running result drains independently', async () => {
    const executor = createKeyedSerialExecutor();
    const other = controlled(executor, 'other');
    await other.started;
    let closePromise;
    const self = controlled(executor, 'self', undefined, () => {
      closePromise = executor.close();
      assert.equal(executor.close(), closePromise);
      assert.equal(executor.closed, true);
      assert.equal(executor.pending, 0);
    });
    const queued = observe(executor.run('self', never));
    await self.started;
    const closing = observe(closePromise);
    assert.equal(executor.close(), closePromise);
    await queued.done;
    assert.equal(queued.reason.code, 'EXECUTOR_CLOSED');
    self.reject({ rejected: 'inside close' });
    await self.state.done;
    await checkpoint();
    assert.equal(closing.status, 'pending');
    other.resolve();
    await fulfilled(closing, undefined);
    assert.equal(executor.close(), closePromise);
  });

  for (const location of ['callback', 'then getter', 'then method']) {
    for (const action of ['abort', 'close']) {
      it(`establishes running ownership before ${action} from ${location}`, async () => {
        const executor = createKeyedSerialExecutor();
        const controller = new AbortController(), external = () => {};
        controller.signal.addEventListener('abort', external);
        const gate = deferred(), acted = deferred();
        let closePromise;
        function act() {
          assert.deepEqual(listeners(controller.signal), [external]);
          assert.equal(executor.pending, 1);
          if (action === 'abort') controller.abort('too late');
          else closePromise = executor.close();
          acted.resolve();
        }
        const first = observe(executor.run('k', () => {
          if (location === 'callback') { act(); return gate.promise; }
          if (location === 'then getter') return { get then() {
            act();
            return resolve => resolve(gate.promise);
          } };
          return { then(resolve) { act(); resolve(gate.promise); } };
        }, { signal: controller.signal }));
        const next = observe(executor.run('k', action === 'close' ? never : () => 'next'));
        await acted.promise;
        await checkpoint();
        assert.equal(first.status, 'pending');
        if (action === 'abort') assert.equal(next.status, 'pending');
        else {
          await next.done;
          assert.equal(next.reason.code, 'EXECUTOR_CLOSED');
          assert.equal(executor.close(), closePromise);
        }
        gate.resolve('actual result');
        await fulfilled(first, 'actual result');
        if (action === 'abort') await fulfilled(next, 'next');
        await executor.close();
      });
    }
  }

  it('queues reentrant submissions behind older jobs without starting a successor twice', async () => {
    const executor = createKeyedSerialExecutor();
    const order = [];
    let nested;
    const head = executor.run('k', () => {
      order.push('head');
      nested = executor.run('k', () => order.push('nested'));
      return 1;
    });
    const older = executor.run('k', () => order.push('older'));
    await Promise.all([head, older]);
    await nested;
    await executor.close();
    assert.deepEqual(order, ['head', 'older', 'nested']);
  });

  it('isolates factories sharing keys and signals, including listener ownership on close', async () => {
    const a = createKeyedSerialExecutor(), b = createKeyedSerialExecutor();
    const key = {}, controller = new AbortController(), external = () => {};
    const options = { signal: controller.signal };
    controller.signal.addEventListener('abort', external);
    const firstA = controlled(a, key, options), firstB = controlled(b, key, options);
    await Promise.all([firstA.started, firstB.started]);
    const nextA = observe(a.run(key, never, options)), nextB = observe(b.run(key, never, options));
    assert.equal(listeners(controller.signal).length, 3);
    const closingA = observe(a.close());
    assert.equal(a.pending, 0);
    assert.equal(b.pending, 1);
    assert.equal(b.closed, false);
    assert.equal(listeners(controller.signal).length, 2);
    controller.abort('shared cancellation');
    await rejected(nextB, 'shared cancellation');
    await nextA.done;
    assert.equal(nextA.reason.code, 'EXECUTOR_CLOSED');
    assert.deepEqual(listeners(controller.signal), [external]);
    firstA.resolve();
    await fulfilled(closingA, undefined);
    assert.equal(firstB.state.status, 'pending');
    const survivorB = observe(b.run(key, () => 'still open'));
    firstB.resolve();
    await fulfilled(survivorB, 'still open');
    await b.close();
  });

  it('handles bounded cancellation and key churn while an unrelated predecessor stays pending', async () => {
    const executor = createKeyedSerialExecutor();
    const head = controlled(executor, 'blocked');
    await head.started;
    for (let index = 0; index < 128; index++) {
      const controller = new AbortController();
      const cancelled = observe(executor.run('blocked', never, { signal: controller.signal }));
      controller.abort(index);
      await rejected(cancelled, index);
      assert.equal(executor.pending, 0);
      assert.deepEqual(listeners(controller.signal), []);
      assert.equal(await executor.run({ index }, () => index), index);
      assert.equal(head.state.status, 'pending');
    }
    const tail = observe(executor.run('blocked', () => 'tail'));
    head.resolve();
    await fulfilled(tail, 'tail');
    await executor.close();
  });
});
