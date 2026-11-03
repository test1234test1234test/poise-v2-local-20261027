import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { runInNewContext } from 'node:vm';
import { createPriorityQueue } from '../lib/priority-queue.mjs';
import * as root from '../lib.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Observe only public promises, so missing observation of a callback's late
// rejection (or a rejected bookkeeping chain) remains a test-runner failure.
function observe(promise) {
  assert.ok(promise instanceof Promise);
  const state = { status: 'pending' };
  state.done = promise.then(
    value => { state.status = 'fulfilled'; state.value = value; },
    reason => { state.status = 'rejected'; state.reason = reason; },
  );
  return state;
}

async function fulfilled(state, value) {
  await state.done;
  assert.equal(state.status, 'fulfilled');
  assert.equal(state.value, value);
}

async function rejected(state, reason) {
  await state.done;
  assert.equal(state.status, 'rejected');
  assert.equal(state.reason, reason);
}

function controlled(queue, options, onStart = () => {}) {
  const gate = deferred(), started = deferred();
  const result = queue.submit(signal => {
    onStart(signal);
    started.resolve();
    return gate.promise;
  }, options);
  return { ...gate, result, state: observe(result), started: started.promise };
}

const checkpoint = () => new Promise(resolve => setImmediate(resolve));
const listeners = signal => getEventListeners(signal, 'abort');
let forbiddenCalls = 0;
const never = () => { forbiddenCalls++; };

describe('createPriorityQueue', { timeout: 30000 }, () => {
  afterEach(async () => {
    await checkpoint();
    const calls = forbiddenCalls;
    forbiddenCalls = 0;
    assert.equal(calls, 0, 'invalid, cancelled and post-close callbacks never run');
  });

  it('exposes both entry points and preserves existing root APIs', async () => {
    assert.equal(root.createPriorityQueue, createPriorityQueue);
    assert.equal(root.baseline(), 'sandbox');
    for (const name of ['collectAsync', 'compareBigInts', 'isAsciiToken',
      'isVisibleAscii', 'parseCanonicalUnsignedBigInt']) assert.equal(typeof root[name], 'function');
    const queue = root.createPriorityQueue({ concurrency: 1 });
    assert.equal(await queue.submit(() => 42), 42);
    await queue.close();
  });

  it('validates construction and accepts the largest safe limit without preallocating workers', async () => {
    for (const options of [undefined, null, [], 1, true, 'options', () => {}]) {
      assert.throws(() => createPriorityQueue(options), TypeError);
    }
    for (const concurrency of [undefined, null, false, '1', 1n, {}, Symbol()]) {
      assert.throws(() => createPriorityQueue({ concurrency }), TypeError);
    }
    for (const concurrency of [0, -0, -1, 0.1, NaN, Infinity, -Infinity,
      Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => createPriorityQueue({ concurrency }), RangeError);
    }
    let reads = 0;
    const options = Object.create({ get concurrency() { reads++; return Number.MAX_SAFE_INTEGER; } });
    const queue = createPriorityQueue(options);
    assert.equal(reads, 1);
    const a = controlled(queue), b = controlled(queue);
    await Promise.all([a.started, b.started]);
    assert.equal(queue.active, 2);
    a.resolve(); b.resolve();
    await queue.close();
    const error = { getter: true };
    assert.throws(() => createPriorityQueue({ get concurrency() { throw error; } }), value => value === error);
    await createPriorityQueue(Object.assign(Object.create(null), { concurrency: 1 })).close();
  });

  it('accepts synchronously, dispatches asynchronously, and exposes getter-only counters', async () => {
    const queue = createPriorityQueue({ concurrency: 2 });
    for (const name of ['active', 'pending', 'closed']) {
      const descriptor = Object.getOwnPropertyDescriptor(queue, name);
      assert.equal(typeof descriptor.get, 'function');
      assert.equal(descriptor.set, undefined);
      assert.throws(() => { queue[name] = 123; }, TypeError);
    }
    assert.deepEqual([queue.active, queue.pending, queue.closed], [0, 0, false]);
    let returned = false, entered = false;
    const promise = queue.submit(function (...args) {
      entered = true;
      assert.equal(returned, true);
      assert.equal(this, undefined);
      assert.equal(args.length, 1);
      assert.ok(args[0] instanceof AbortSignal);
      assert.equal(args[0].aborted, false);
      assert.deepEqual([queue.active, queue.pending], [1, 0]);
      return 3;
    });
    assert.equal(entered, false);
    assert.deepEqual([queue.active, queue.pending], [0, 1]);
    returned = true;
    assert.equal(await promise, 3);
    await queue.onIdle();
    assert.deepEqual([queue.active, queue.pending], [0, 0]);
    await queue.close();
  });

  it('uses finite priority descending and acceptance order for ties including signed zero', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const priorities = [undefined, -4, 0.5, -0, Number.MAX_VALUE, 0, -0.25, -Number.MAX_VALUE, 0.5];
    const order = [];
    const promises = priorities.map((priority, index) => queue.submit(() => {
      order.push(index);
      return index;
    }, { priority }));
    assert.equal(queue.pending, priorities.length);
    assert.deepEqual(await Promise.all(promises), priorities.map((_, index) => index));
    assert.deepEqual(order, [4, 2, 8, 0, 3, 5, 6, 1, 7]);
    await queue.close();
  });

  for (const enqueue of [queueMicrotask, fn => { Promise.resolve().then(fn); }]) {
    it('does not batch a later microtask submission ahead of already scheduled dispatch', async () => {
      const queue = createPriorityQueue({ concurrency: 1 });
      const order = [], submitted = deferred();
      const low = controlled(queue, { priority: -1 }, () => order.push('low'));
      let high;
      enqueue(() => {
        high = observe(queue.submit(() => order.push('high'), { priority: 10 }));
        submitted.resolve();
      });
      await submitted.promise;
      await low.started;
      assert.deepEqual(order, ['low']);
      assert.deepEqual([queue.active, queue.pending], [1, 1]);
      low.resolve();
      await high.done;
      assert.deepEqual(order, ['low', 'high']);
      await queue.close();
    });
  }

  it('includes submissions from a microtask queued before dispatch', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const order = [], submitted = deferred();
    let high;
    queueMicrotask(() => {
      high = queue.submit(() => order.push('high'), { priority: 10 });
      submitted.resolve();
    });
    const low = queue.submit(() => order.push('low'));
    await submitted.promise;
    await Promise.all([low, high]);
    assert.deepEqual(order, ['high', 'low']);
    await queue.close();
  });

  it('selects again after synchronous reentrant submission without preselecting a batch', async () => {
    const queue = createPriorityQueue({ concurrency: 2 });
    const starts = [];
    let child;
    const a = controlled(queue, { priority: 10 }, () => {
      starts.push('a');
      child = controlled(queue, { priority: 20 }, () => starts.push('c'));
    });
    const b = controlled(queue, { priority: 0 }, () => starts.push('b'));
    await a.started;
    await child.started;
    assert.deepEqual(starts, ['a', 'c']);
    assert.deepEqual([queue.active, queue.pending], [2, 1]);
    child.resolve();
    await b.started;
    assert.deepEqual(starts, ['a', 'c', 'b']);
    a.resolve(); b.resolve();
    await queue.close();
  });

  it('keeps existing equal-priority jobs ahead of a reentrant child and handles cancellation at entry', async () => {
    const queue = createPriorityQueue({ concurrency: 2 });
    const controller = new AbortController(), order = [];
    let child;
    const a = observe(queue.submit(() => {
      order.push('a');
      controller.abort('removed during entry');
      child = queue.submit(() => order.push('child'));
      throw 'a failed';
    }, { priority: 10 }));
    const removed = observe(queue.submit(never, { signal: controller.signal, priority: 5 }));
    const b = queue.submit(() => order.push('b'));
    await rejected(a, 'a failed');
    await rejected(removed, 'removed during entry');
    await Promise.all([b, child]);
    assert.deepEqual(order, ['a', 'b', 'child']);
    await queue.close();
  });

  for (const concurrency of [1, 3]) {
    it(`bounds independently counted unsettled work at ${concurrency} despite active cancellation`, async () => {
      const queue = createPriorityQueue({ concurrency });
      const controller = new AbortController();
      let unsettled = 0, maximum = 0;
      const starts = [];
      const jobs = Array.from({ length: 8 }, (_, index) => {
        const gate = deferred(), started = deferred();
        const state = observe(queue.submit(async () => {
          unsettled++;
          maximum = Math.max(maximum, unsettled);
          starts.push(index);
          started.resolve();
          try { return await gate.promise; }
          finally { unsettled--; }
        }, index < concurrency ? { signal: controller.signal } : undefined));
        return { ...gate, started: started.promise, state };
      });
      await Promise.all(jobs.slice(0, concurrency).map(job => job.started));
      controller.abort('all active cancelled');
      await Promise.all(jobs.slice(0, concurrency).map(job => rejected(job.state, 'all active cancelled')));
      await checkpoint();
      assert.equal(unsettled, concurrency);
      assert.equal(queue.active, concurrency);
      assert.equal(queue.pending, jobs.length - concurrency);
      assert.equal(starts.length, concurrency);
      for (let index = 0; index < jobs.length; index++) {
        await jobs[index].started;
        if (index % 2) jobs[index].reject(index);
        else jobs[index].resolve(index);
      }
      await queue.close();
      await Promise.all(jobs.map(job => job.state.done));
      assert.equal(maximum, concurrency);
      assert.equal(unsettled, 0);
      assert.deepEqual(starts, jobs.map((_, index) => index));
    });
  }

  for (const value of [undefined, null, false, 0, '', Symbol('result'), { exact: true }]) {
    it(`adopts a synchronous ${typeof value} result`, async () => {
      const queue = createPriorityQueue({ concurrency: 1 });
      await fulfilled(observe(queue.submit(() => value)), value);
      await queue.close();
    });
  }

  const hostileReason = { get then() { assert.fail('rejection reasons must not be assimilated'); } };
  for (const failure of [undefined, null, false, 0, '', Symbol('failure'), { exact: true }, hostileReason]) {
    it(`preserves ${typeof failure} reasons and progresses after every rejection path`, async () => {
      const queue = createPriorityQueue({ concurrency: 1 });
      for (const fn of [() => { throw failure; }, () => Promise.reject(failure),
        () => ({ get then() { throw failure; } })]) {
        const failed = observe(queue.submit(fn));
        const next = observe(queue.submit(() => 'next'));
        await rejected(failed, failure);
        await fulfilled(next, 'next');
      }
      const pre = AbortSignal.abort(failure);
      await rejected(observe(queue.submit(never, { signal: pre })), pre.reason);
      const controller = new AbortController();
      const queued = observe(queue.submit(never, { signal: controller.signal }));
      controller.abort(failure);
      await rejected(queued, controller.signal.reason);
      const activeController = new AbortController();
      const active = controlled(queue, { signal: activeController.signal });
      await active.started;
      activeController.abort(failure);
      await rejected(active.state, activeController.signal.reason);
      active.reject(failure);
      await queue.close();
    });
  }

  it('assimilates a stateful thenable only once and observes its full nested result', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const gate = deferred(), nested = deferred();
    const controller = new AbortController();
    let reads = 0;
    const inner = { then(resolve) {
      assert.equal(this, inner);
      nested.resolve();
      resolve(gate.promise);
    } };
    const result = { get then() {
      reads++;
      assert.equal(reads, 1);
      return function (resolve, reject) {
        assert.equal(this, result);
        resolve(inner);
        reject('ignored');
        resolve('ignored');
        throw 'ignored';
      };
    } };
    const first = observe(queue.submit(() => result, { signal: controller.signal }));
    const next = controlled(queue);
    await nested.promise;
    await checkpoint();
    assert.deepEqual([queue.active, queue.pending], [1, 1]);
    assert.equal(first.status, 'pending');
    gate.resolve(42);
    await fulfilled(first, 42);
    await next.started;
    assert.equal(reads, 1);
    next.resolve();
    await queue.close();
  });

  it('uses a single native resolution for uncancellable plain results with a changing then getter', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    let reads = 0;
    const value = { get then() {
      reads++;
      if (reads === 1) return undefined;
      throw new Error('unexpected second resolution');
    } };
    await fulfilled(observe(queue.submit(() => value)), value);
    assert.equal(reads, 1);
    assert.equal(await queue.submit(() => 'next'), 'next');
    await queue.close();
  });

  it('retains ownership through native forwarding of a cancellable fulfillment value', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const controller = new AbortController();
    let reads = 0, deliveryIdle;
    const value = { get then() {
      reads++;
      assert.deepEqual([queue.active, queue.pending], [1, 1]);
      if (reads === 2) deliveryIdle = observe(queue.onIdle());
      return undefined;
    } };
    const first = observe(queue.submit(() => value, { signal: controller.signal }));
    const next = controlled(queue);
    const earlierIdle = observe(queue.onIdle());
    await fulfilled(first, value);
    await next.started;
    // Native forwarding, like Promise.race, resolves the final fulfillment
    // value again. It must still expose consistent counters to its getter.
    assert.equal(reads, 2);
    assert.equal(deliveryIdle.status, 'pending');
    assert.equal(earlierIdle.status, 'pending');
    next.resolve();
    await fulfilled(deliveryIdle, undefined);
    await fulfilled(earlierIdle, undefined);
    await queue.close();
  });

  it('rejects direct self-return and continues drainage', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    let self;
    self = queue.submit(() => self);
    const state = observe(self), next = observe(queue.submit(() => 'next'));
    await state.done;
    assert.equal(state.status, 'rejected');
    assert.ok(state.reason instanceof TypeError);
    await fulfilled(next, 'next');
    await queue.close();
  });

  for (const phase of ['idle', 'busy', 'closed']) {
    it(`rejects invalid submissions through promises without state or listener changes while ${phase}`, async () => {
      const queue = createPriorityQueue({ concurrency: 1 });
      const head = phase === 'busy' ? controlled(queue) : undefined;
      if (head) await head.started;
      if (phase === 'closed') await queue.close();
      const controller = new AbortController(), external = () => {};
      controller.signal.addEventListener('abort', external);
      const signal = controller.signal;
      const revoked = Proxy.revocable(signal, {}); revoked.revoke();
      const invalidSignals = [null, false, 1, 'signal', {}, [], () => {},
        { aborted: false, addEventListener() {}, removeEventListener() {} },
        AbortSignal.prototype, Object.create(AbortSignal.prototype), Object.create(signal),
        new Proxy(signal, {}), revoked.proxy,
        runInNewContext('new (class AbortSignal { get aborted() { return false; } })()')];
      const calls = [
        ...[undefined, null, false, 1, 'fn', {}, [], Promise.resolve()].map(fn => () => queue.submit(fn, { signal })),
        ...[null, [], true, 1, 1n, 'options', Symbol(), () => {}].map(options => () => queue.submit(never, options)),
        ...[null, false, '1', 1n, {}, Symbol(), NaN, Infinity, -Infinity].map(priority => () => queue.submit(never, { priority, signal })),
        ...invalidSignals.map(signal => () => queue.submit(never, { signal })),
      ];
      for (const call of calls) {
        let promise;
        assert.doesNotThrow(() => { promise = call(); });
        const state = observe(promise);
        assert.deepEqual([queue.active, queue.pending], [head ? 1 : 0, 0]);
        assert.deepEqual(listeners(signal), [external]);
        await state.done;
        assert.equal(state.status, 'rejected');
        assert.ok(state.reason instanceof TypeError);
      }
      for (const property of ['priority', 'signal']) {
        const error = { property };
        let reads = 0;
        const options = { get [property]() { reads++; throw error; } };
        await rejected(observe(queue.submit(never, options)), error);
        assert.equal(reads, 1);
      }
      head?.resolve();
      await queue.close();
      assert.deepEqual(listeners(signal), [external]);
    });
  }

  it('accepts documented option shapes, inherited getters and native signal sources', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const controller = new AbortController(), signal = controller.signal;
    class Options { priority = 0.5; signal = signal; }
    const options = [undefined, {}, { priority: undefined, signal: undefined }, new Options(),
      Object.create({ priority: -1, signal }), Object.assign(Object.create(null), { signal }),
      { signal, get unrelated() { assert.fail('unrelated getter'); } },
      { signal: AbortSignal.any([signal]) },
      { signal: runInNewContext('new AbortController().signal', { AbortController }) }];
    for (const option of options) assert.equal(await queue.submit(() => 1, option), 1);
    let priorityReads = 0, signalReads = 0;
    await queue.submit(() => 2, Object.create({
      get priority() { priorityReads++; return -2; },
      get signal() { signalReads++; return signal; },
    }));
    assert.deepEqual([priorityReads, signalReads], [1, 1]);
    assert.deepEqual(listeners(signal), []);
    await queue.close();
  });

  it('orders getter submissions by successful acceptance and retains their side effects on outer failure', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const order = [];
    let nested;
    const outer = queue.submit(() => order.push('outer'), { get priority() {
      nested = queue.submit(() => order.push('nested'));
      return 0;
    } });
    await Promise.all([outer, nested]);
    assert.deepEqual(order, ['nested', 'outer']);
    const error = {};
    const failed = observe(queue.submit(never, { get signal() {
      nested = queue.submit(() => 'nested result');
      throw error;
    } }));
    assert.equal(queue.pending, 1);
    await rejected(failed, error);
    assert.equal(await nested, 'nested result');
    await queue.close();
  });

  for (const throwing of [false, true]) {
    it(`rechecks close and abort after getters${throwing ? ' that throw' : ''}`, async () => {
      const queue = createPriorityQueue({ concurrency: 1 });
      const controller = new AbortController(), failure = {};
      let closePromise;
      const state = observe(queue.submit(never, { get signal() {
        controller.abort('pre-abort');
        closePromise = queue.close();
        if (throwing) throw failure;
        return controller.signal;
      } }));
      await state.done;
      assert.equal(state.status, 'rejected');
      if (throwing) assert.equal(state.reason, failure);
      else assert.equal(state.reason.code, 'QUEUE_CLOSED');
      const later = observe(queue.submit(never, { signal: controller.signal }));
      await later.done;
      assert.equal(later.reason.code, 'QUEUE_CLOSED');
      if (!throwing) assert.equal(later.reason, state.reason);
      assert.equal(queue.close(), closePromise);
      assert.deepEqual([queue.active, queue.pending], [0, 0]);
      assert.deepEqual(listeners(controller.signal), []);
      await closePromise;
    });
  }

  it('rechecks pre-abort after validation and rejects before adding a listener', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const controller = new AbortController(), reason = {};
    const external = () => {};
    controller.signal.addEventListener('abort', external);
    const state = observe(queue.submit(never, { get signal() {
      controller.abort(reason);
      return controller.signal;
    } }));
    assert.equal(queue.pending, 0);
    await rejected(state, reason);
    assert.deepEqual(listeners(controller.signal), [external]);
    await queue.close();
  });

  it('removes cancellation before initial dispatch and starts a replacement exactly once', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const controller = new AbortController();
    const first = observe(queue.submit(never, { signal: controller.signal }));
    controller.abort('cancelled');
    assert.equal(queue.pending, 0);
    assert.deepEqual(listeners(controller.signal), []);
    let entries = 0;
    const next = queue.submit(() => ++entries);
    await rejected(first, 'cancelled');
    assert.equal(await next, 1);
    assert.equal(entries, 1);
    await queue.close();
  });

  it('immediately unlinks queued head, middle and tail cancellations behind blocked work', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const head = controlled(queue);
    await head.started;
    const controllers = Array.from({ length: 7 }, () => new AbortController()), order = [];
    const jobs = controllers.map((controller, index) => observe(queue.submit(() => {
      order.push(index);
      return index;
    }, { signal: controller.signal })));
    for (const [step, index] of [0, 3, 6].entries()) {
      controllers[index].abort({ index });
      assert.equal(queue.pending, 6 - step);
      await rejected(jobs[index], controllers[index].signal.reason);
      assert.deepEqual(listeners(controllers[index].signal), []);
    }
    await checkpoint();
    assert.deepEqual(order, []);
    head.resolve();
    await Promise.all(jobs.map(job => job.done));
    assert.deepEqual(order, [1, 2, 4, 5]);
    await queue.close();
  });

  for (const outcome of ['fulfill', 'reject']) {
    it(`keeps cancelled active work owned through late ${outcome} and drains close and idle physically`, async () => {
      const queue = createPriorityQueue({ concurrency: 1 });
      const controller = new AbortController(), external = () => {};
      controller.signal.addEventListener('abort', external);
      let callbackSignal, bEntries = 0;
      const a = controlled(queue, { signal: controller.signal }, signal => { callbackSignal = signal; });
      const b = controlled(queue, undefined, () => { bEntries++; });
      await a.started;
      const idle = observe(queue.onIdle()), closePromise = queue.close(), closing = observe(closePromise);
      assert.equal(queue.close(), closePromise);
      assert.equal(callbackSignal, controller.signal);
      const reason = { cancelled: true };
      controller.abort(reason);
      await rejected(a.state, reason);
      assert.equal(callbackSignal.aborted, true);
      assert.equal(callbackSignal.reason, reason);
      assert.deepEqual([queue.active, queue.pending, bEntries], [1, 1, 0]);
      assert.deepEqual(listeners(controller.signal), [external]);
      await checkpoint();
      assert.equal(idle.status, 'pending');
      assert.equal(closing.status, 'pending');
      if (outcome === 'fulfill') a.resolve('late success');
      else a.reject({ late: 'unobserved by the test itself' });
      await b.started;
      assert.equal(bEntries, 1);
      assert.deepEqual([queue.active, queue.pending], [1, 0]);
      await checkpoint();
      assert.equal(idle.status, 'pending');
      assert.equal(closing.status, 'pending');
      b.reject('drain despite rejection');
      await rejected(b.state, 'drain despite rejection');
      await fulfilled(idle, undefined);
      await fulfilled(closing, undefined);
      assert.deepEqual([queue.active, queue.pending], [0, 0]);
      assert.equal(queue.close(), closePromise);
      await rejected(a.state, reason);
    });
  }

  for (const location of ['callback', 'then getter', 'then method']) {
    for (const outcome of ['return', 'throw']) {
      it(`commits self-abort from ${location} before a later ${outcome}`, async () => {
        const queue = createPriorityQueue({ concurrency: 1 });
        const controller = new AbortController(), reason = {};
        let idle;
        function act() {
          assert.deepEqual([queue.active, queue.pending], [1, 1]);
          controller.abort(reason);
          idle = observe(queue.onIdle());
          assert.equal(queue.active, 1);
          if (outcome === 'throw') throw 'late throw';
          return 'late return';
        }
        const fn = location === 'callback' ? act : location === 'then getter'
          ? () => ({ get then() { act(); return resolve => resolve('value'); } })
          : () => ({ then(resolve) { resolve(act()); } });
        const first = observe(queue.submit(fn, { signal: controller.signal }));
        const next = controlled(queue);
        await rejected(first, reason);
        await next.started;
        assert.equal(idle.status, 'pending');
        next.resolve();
        await queue.close();
        await fulfilled(idle, undefined);
        await rejected(first, reason);
      });
    }
  }

  for (const outcome of ['fulfill', 'reject']) {
    for (const abortBeforeReaction of [false, true]) {
      it(`keeps the first committed ${outcome}/abort outcome with abort-before-reaction=${abortBeforeReaction}`, async () => {
        const queue = createPriorityQueue({ concurrency: 1 });
        const controller = new AbortController(), result = {}, reason = {};
        const job = controlled(queue, { signal: controller.signal });
        await job.started;
        if (outcome === 'fulfill') job.resolve(result);
        else job.reject(result);
        if (!abortBeforeReaction) await job.state.done;
        controller.abort(reason);
        if (abortBeforeReaction) await rejected(job.state, reason);
        else if (outcome === 'fulfill') await fulfilled(job.state, result);
        else await rejected(job.state, result);
        await queue.close();
        assert.deepEqual([queue.active, queue.pending], [0, 0]);
        assert.deepEqual(listeners(controller.signal), []);
      });
    }
  }

  it('handles a shared signal independently across active and queued jobs in multiple queues', async () => {
    const queues = [createPriorityQueue({ concurrency: 1 }), createPriorityQueue({ concurrency: 1 })];
    const controller = new AbortController(), external = () => {};
    controller.signal.addEventListener('abort', external);
    const options = { signal: controller.signal };
    const active = queues.map(queue => controlled(queue, options));
    await Promise.all(active.map(job => job.started));
    const pending = queues.flatMap(queue => [observe(queue.submit(never, options)), observe(queue.submit(never, options))]);
    assert.equal(listeners(controller.signal).length, 7);
    controller.abort('shared');
    for (const queue of queues) assert.deepEqual([queue.active, queue.pending], [1, 0]);
    await Promise.all([...active.map(job => job.state), ...pending].map(state => rejected(state, 'shared')));
    assert.deepEqual(listeners(controller.signal), [external]);
    active[0].resolve(); active[1].reject('late');
    await Promise.all(queues.map(queue => queue.close()));
  });

  it('preserves unrelated listeners and other subscriptions when one shared-signal job completes', async () => {
    const queue = createPriorityQueue({ concurrency: 2 });
    const controller = new AbortController(), external = () => {};
    controller.signal.addEventListener('abort', external);
    const a = controlled(queue, { signal: controller.signal }), b = controlled(queue, { signal: controller.signal });
    await Promise.all([a.started, b.started]);
    a.resolve(1);
    await fulfilled(a.state, 1);
    assert.equal(listeners(controller.signal).length, 2);
    controller.abort('only b');
    await rejected(b.state, 'only b');
    await fulfilled(a.state, 1);
    assert.deepEqual(listeners(controller.signal), [external]);
    b.resolve();
    await queue.close();
  });

  for (const active of [false, true]) {
    it(`ignores synthetic abort, re-arms and resists stopImmediatePropagation while active=${active}`, async () => {
      const queue = createPriorityQueue({ concurrency: 1 });
      const controller = new AbortController(), external = event => event.stopImmediatePropagation();
      controller.signal.addEventListener('abort', external);
      const blocker = active ? undefined : controlled(queue);
      if (blocker) await blocker.started;
      const job = controlled(queue, { signal: controller.signal });
      if (active) await job.started;
      for (let index = 0; index < 2; index++) {
        controller.signal.dispatchEvent(new Event('abort'));
        await checkpoint();
        assert.equal(job.state.status, 'pending');
        assert.equal(controller.signal.aborted, false);
        assert.equal(listeners(controller.signal).length, 2);
      }
      controller.abort('real');
      await rejected(job.state, 'real');
      assert.equal(queue.active, 1);
      assert.equal(queue.pending, 0);
      assert.deepEqual(listeners(controller.signal), [external]);
      job.resolve(); blocker?.resolve();
      await queue.close();
    });
  }

  it('observes real abort during a synthetic re-arm gap, including shared queued signals', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const head = controlled(queue);
    await head.started;
    const controller = new AbortController();
    const jobs = [observe(queue.submit(never, { signal: controller.signal })),
      observe(queue.submit(never, { signal: controller.signal }))];
    controller.signal.dispatchEvent(new Event('abort'));
    controller.abort('in gap');
    assert.equal(queue.pending, 0);
    await Promise.all(jobs.map(state => rejected(state, 'in gap')));
    assert.deepEqual(listeners(controller.signal), []);
    head.resolve();
    await queue.close();
    await checkpoint();
    assert.deepEqual(listeners(controller.signal), []);
  });

  it('does not re-arm synthetic-event subscriptions after completion or cancellation at dispatch', async () => {
    const queue = createPriorityQueue({ concurrency: 2 });
    const completed = new AbortController(), cancelled = new AbortController();
    const value = queue.submit(() => 42, { signal: completed.signal });
    const removed = observe(queue.submit(never, { signal: cancelled.signal }));
    completed.signal.dispatchEvent(new Event('abort'));
    cancelled.signal.dispatchEvent(new Event('abort'));
    cancelled.abort('before dispatch');
    const close = queue.close();
    assert.equal(queue.pending, 1);
    assert.equal(await value, 42);
    await rejected(removed, 'before dispatch');
    await close;
    await checkpoint();
    assert.deepEqual(listeners(completed.signal), []);
    assert.deepEqual(listeners(cancelled.signal), []);
  });

  it('handles cancellation triggered reentrantly by another source listener', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const active = new AbortController(), queued = new AbortController();
    active.signal.addEventListener('abort', () => queued.abort(active.signal.reason));
    const a = controlled(queue, { signal: active.signal });
    await a.started;
    const b = observe(queue.submit(never, { signal: queued.signal }));
    active.abort('nested cancellation');
    assert.deepEqual([queue.active, queue.pending], [1, 0]);
    await rejected(a.state, 'nested cancellation');
    await rejected(b, 'nested cancellation');
    a.reject('late');
    await queue.close();
  });

  it('reconciles genuine abort inside an earlier external listener that submits, observes idle and closes', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const controller = new AbortController(), snapshots = [];
    let idle, closePromise, nested;
    const external = () => {
      snapshots.push([queue.active, queue.pending]);
      idle = observe(queue.onIdle());
      nested = observe(queue.submit(never, { signal: controller.signal }));
      closePromise = queue.close();
    };
    controller.signal.addEventListener('abort', external);
    const a = controlled(queue, { signal: controller.signal });
    await a.started;
    const b = observe(queue.submit(never, { signal: controller.signal }));
    controller.abort('external');
    assert.deepEqual(snapshots, [[1, 0]]);
    await Promise.all([a.state, b, nested].map(state => rejected(state, 'external')));
    assert.equal(idle.status, 'pending');
    assert.equal(queue.close(), closePromise);
    assert.deepEqual(listeners(controller.signal), [external]);
    a.resolve();
    await fulfilled(idle, undefined);
    await closePromise;
  });

  it('closes empty with one promise and one retained closed error, after validation and before pre-abort', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const closePromise = queue.close();
    assert.equal(queue.close(), closePromise);
    assert.equal(queue.closed, true);
    assert.equal(await closePromise, undefined);
    assert.equal(queue.close(), closePromise);
    const first = observe(queue.submit(never)), second = observe(queue.submit(never, { signal: AbortSignal.abort('pre') }));
    await first.done;
    assert.ok(first.reason instanceof Error);
    assert.equal(first.reason.code, 'QUEUE_CLOSED');
    await rejected(second, first.reason);
    const invalid = observe(queue.submit(null, { signal: AbortSignal.abort('pre') }));
    await invalid.done;
    assert.ok(invalid.reason instanceof TypeError);
    assert.equal(await queue.onIdle(), undefined);
  });

  it('drains work accepted before close in priority order, without aborting its signals', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const controller = new AbortController(), order = [];
    const low = queue.submit(signal => {
      assert.equal(signal.aborted, false);
      order.push('low');
    }, { signal: controller.signal, priority: -1 });
    const high = observe(queue.submit(() => { order.push('high'); throw 'draining rejection'; }, { priority: 1 }));
    const closePromise = queue.close(), closing = observe(closePromise);
    assert.equal(queue.close(), closePromise);
    assert.deepEqual([queue.active, queue.pending], [0, 2]);
    assert.equal(closing.status, 'pending');
    await rejected(high, 'draining rejection');
    await low;
    await fulfilled(closing, undefined);
    assert.deepEqual(order, ['high', 'low']);
    assert.deepEqual(listeners(controller.signal), []);
    assert.equal(controller.signal.aborted, false);
  });

  it('can close from a callback and register idle waiters while accepted work drains', async () => {
    const queue = createPriorityQueue({ concurrency: 2 });
    let closePromise, idle;
    const a = controlled(queue, { priority: 10 }, () => {
      closePromise = queue.close();
      idle = observe(queue.onIdle());
      assert.deepEqual([queue.active, queue.pending, queue.closed], [1, 1, true]);
    });
    const b = controlled(queue);
    await Promise.all([a.started, b.started]);
    a.reject('a');
    await rejected(a.state, 'a');
    assert.equal(idle.status, 'pending');
    b.resolve('b');
    await fulfilled(b.state, 'b');
    await closePromise;
    await fulfilled(idle, undefined);
    assert.equal(queue.close(), closePromise);
  });

  for (const location of ['then getter', 'then method']) {
    it(`establishes active ownership before close and idle from a ${location}`, async () => {
      const queue = createPriorityQueue({ concurrency: 1 });
      const gate = deferred(), entered = deferred(), controller = new AbortController();
      let idle, closePromise;
      function act() {
        assert.deepEqual([queue.active, queue.pending], [1, 1]);
        closePromise = queue.close();
        idle = observe(queue.onIdle());
        assert.equal(controller.signal.aborted, false);
        entered.resolve();
      }
      const result = location === 'then getter'
        ? { get then() { act(); return resolve => resolve(gate.promise); } }
        : { then(resolve) { act(); resolve(gate.promise); } };
      const first = observe(queue.submit(() => result, { signal: controller.signal }));
      const next = controlled(queue);
      await entered.promise;
      await checkpoint();
      assert.equal(idle.status, 'pending');
      assert.equal(first.status, 'pending');
      assert.equal(next.state.status, 'pending');
      gate.resolve(1);
      await fulfilled(first, 1);
      await next.started;
      assert.equal(idle.status, 'pending');
      next.resolve();
      await closePromise;
      await fulfilled(idle, undefined);
    });
  }

  it('resolves idle when the last unstarted job is cancelled, even in an earlier abort listener', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const controller = new AbortController();
    let duringAbort;
    controller.signal.addEventListener('abort', () => { duringAbort = observe(queue.onIdle()); });
    const job = observe(queue.submit(never, { signal: controller.signal }));
    const beforeAbort = observe(queue.onIdle());
    controller.abort('last pending');
    assert.deepEqual([queue.active, queue.pending], [0, 0]);
    await rejected(job, 'last pending');
    await fulfilled(beforeAbort, undefined);
    await fulfilled(duringAbort, undefined);
    await queue.close();
  });

  it('treats an already-idle call as a boundary that later submission cannot revoke', async () => {
    const queue = createPriorityQueue({ concurrency: 1 });
    const alreadyIdle = observe(queue.onIdle());
    const job = controlled(queue);
    const laterIdle = observe(queue.onIdle());
    await fulfilled(alreadyIdle, undefined);
    await job.started;
    assert.equal(laterIdle.status, 'pending');
    job.resolve();
    await fulfilled(laterIdle, undefined);
    await queue.close();
  });

  for (const source of ['completion handler', 'idle handler']) {
    it(`gives new work and waiters their own idle period from an ${source}`, async () => {
      const queue = createPriorityQueue({ concurrency: 1 });
      const first = controlled(queue);
      await first.started;
      const idle1 = queue.onIdle(), idle2 = queue.onIdle();
      let next, nextIdle;
      const sourcePromise = source === 'completion handler' ? first.result : idle1;
      const submitted = sourcePromise.then(() => {
        next = controlled(queue);
        nextIdle = observe(queue.onIdle());
      });
      first.resolve();
      await submitted;
      await next.started;
      await Promise.all([idle1, idle2]);
      await checkpoint();
      assert.equal(nextIdle.status, 'pending');
      assert.deepEqual([queue.active, queue.pending], [1, 0]);
      next.resolve();
      await fulfilled(nextIdle, undefined);
      const third = controlled(queue);
      const idle3 = observe(queue.onIdle());
      await third.started;
      assert.equal(idle3.status, 'pending');
      third.resolve();
      await fulfilled(idle3, undefined);
      await queue.close();
    });
  }
});
