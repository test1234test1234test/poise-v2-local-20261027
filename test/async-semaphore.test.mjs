import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { AsyncSemaphore } from '../lib/async-semaphore.mjs';

const checkpoint = () => new Promise(resolve => setImmediate(resolve));
const listeners = signal => getEventListeners(signal, 'abort');

function observe(promise) {
  assert.ok(promise instanceof Promise);
  const state = { status: 'pending' };
  state.done = promise.then(
    value => { state.status = 'fulfilled'; state.value = value; },
    reason => { state.status = 'rejected'; state.reason = reason; },
  );
  return state;
}

async function granted(state) {
  await state.done;
  assert.equal(state.status, 'fulfilled');
  assert.equal(typeof state.value, 'function');
  assert.equal(state.value.length, 0);
  return state.value;
}

async function rejected(state, reason) {
  await state.done;
  assert.equal(state.status, 'rejected');
  assert.equal(state.reason, reason);
}

function counts(semaphore, capacity, active, waiting, closed = false) {
  assert.deepEqual(
    [semaphore.capacity, semaphore.active, semaphore.waiting, semaphore.closed],
    [capacity, active, waiting, closed],
  );
  assert.ok(active >= 0 && active <= capacity);
  assert.ok(waiting >= 0);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// This is the documented ownership pattern, including the await inside try.
async function doBoundedWork(semaphore, work, signal) {
  const release = await semaphore.acquire({ signal });
  try {
    signal?.throwIfAborted();
    return await work();
  } finally {
    release();
  }
}

// Timeouts diagnose deadlocks; no timer or checkpoint manufactures success.
describe('AsyncSemaphore', { timeout: 15_000 }, () => {
  it('validates capacity without coercion or capacity-sized storage', async () => {
    for (const value of [undefined, null, true, '1', 1n, Symbol('1'), {}, [],
      new Number(1), () => 1]) {
      assert.throws(() => new AsyncSemaphore(value), TypeError);
    }
    for (const value of [0, -0, -1, 0.5, NaN, Infinity, -Infinity,
      Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new AsyncSemaphore(value), RangeError);
    }
    for (const capacity of [1, Number.MAX_SAFE_INTEGER]) {
      const semaphore = new AsyncSemaphore(capacity);
      counts(semaphore, capacity, 0, 0);
      const promise = semaphore.acquire();
      counts(semaphore, capacity, 1, 0);
      const release = await granted(observe(promise));
      assert.equal(release(), undefined);
      counts(semaphore, capacity, 0, 0);
    }
  });

  for (const ending of ['abort', 'close']) {
    it(`immediate ownership survives ${ending} before the await continuation`, async () => {
      const semaphore = new AsyncSemaphore(1);
      const controller = new AbortController();
      const caller = () => {};
      controller.signal.addEventListener('abort', caller);
      const baseline = listeners(controller.signal);
      const state = observe(semaphore.acquire({ signal: controller.signal }));
      counts(semaphore, 1, 1, 0);
      assert.deepEqual(listeners(controller.signal), baseline);
      if (ending === 'abort') controller.abort({ aborted: true });
      else semaphore.close({ closed: true });
      counts(semaphore, 1, 1, 0, ending === 'close');
      const release = await granted(state);
      release();
      release();
      counts(semaphore, 1, 0, 0, ending === 'close');
      assert.deepEqual(listeners(controller.signal), baseline);
    });
  }

  it('hands off in FIFO order before same-turn arrivals and reacquisitions', async () => {
    const semaphore = new AsyncSemaphore(1);
    const releaseA = await semaphore.acquire();
    const b = observe(semaphore.acquire());
    const c = observe(semaphore.acquire());
    counts(semaphore, 1, 1, 2);
    releaseA();
    counts(semaphore, 1, 1, 1);
    const d = observe(semaphore.acquire());
    const aAgain = observe(semaphore.acquire());
    counts(semaphore, 1, 1, 3);
    for (const [index, state] of [b, c, d, aAgain].entries()) {
      const release = await granted(state);
      await checkpoint();
      for (const later of [b, c, d, aAgain].slice(index + 1)) {
        assert.equal(later.status, 'pending');
      }
      counts(semaphore, 1, 1, 3 - index);
      release();
    }
    counts(semaphore, 1, 0, 0);
  });

  it('keeps FIFO with multiple permits and out-of-order releases', async () => {
    const semaphore = new AsyncSemaphore(3);
    const holders = await Promise.all([semaphore.acquire(), semaphore.acquire(), semaphore.acquire()]);
    const queued = Array.from({ length: 5 }, () => observe(semaphore.acquire()));
    counts(semaphore, 3, 3, 5);
    holders[2]();
    counts(semaphore, 3, 3, 4);
    holders[0]();
    counts(semaphore, 3, 3, 3);
    const first = await granted(queued[0]);
    const second = await granted(queued[1]);
    await checkpoint();
    queued.slice(2).forEach(state => assert.equal(state.status, 'pending'));
    second();
    const third = await granted(queued[2]);
    holders[1]();
    const fourth = await granted(queued[3]);
    counts(semaphore, 3, 3, 1);
    first();
    const fifth = await granted(queued[4]);
    counts(semaphore, 3, 3, 0);
    fourth();
    fifth();
    third();
    counts(semaphore, 3, 0, 0);
  });

  it('stale releases never release later owners, even after closure', async () => {
    const semaphore = new AsyncSemaphore(1);
    const releaseA = await semaphore.acquire();
    const b = observe(semaphore.acquire());
    releaseA();
    const releaseB = await granted(b);
    releaseA();
    const c = observe(semaphore.acquire());
    await checkpoint();
    assert.equal(c.status, 'pending');
    counts(semaphore, 1, 1, 1);
    releaseA();
    releaseB();
    const releaseC = await granted(c);
    releaseA();
    releaseB();
    counts(semaphore, 1, 1, 0);
    semaphore.close();
    releaseA();
    releaseB();
    counts(semaphore, 1, 1, 0, true);
    releaseC();
    releaseC();
    counts(semaphore, 1, 0, 0, true);
  });

  const invalidOptions = [
    null, [], true, 1, 'options', 1n, Symbol('options'), () => {},
    { extra: true }, { [Symbol('extra')]: true },
    Object.defineProperty({}, 'extra', { value: true }),
    ...[null, false, 0, 'signal', 1n, Symbol('signal'), [], {}, () => {},
      { aborted: false, reason: undefined, addEventListener() {}, removeEventListener() {} },
      { aborted: true, reason: 'fake' }, Object.create(AbortSignal.prototype),
    ].map(signal => ({ signal })),
  ];

  for (const setup of ['free', 'saturated', 'closed']) {
    it(`invalid inputs return rejected Promises without mutation when ${setup}`, async () => {
      const semaphore = new AsyncSemaphore(1);
      const controller = new AbortController();
      const caller = () => {};
      controller.signal.addEventListener('abort', caller);
      let releaseA, b, c;
      if (setup === 'saturated') {
        releaseA = await semaphore.acquire();
        b = observe(semaphore.acquire({ signal: controller.signal }));
        c = observe(semaphore.acquire());
      }
      const closeReason = { closed: true };
      if (setup === 'closed') semaphore.close(closeReason);
      const baseline = listeners(controller.signal);
      for (const options of [...invalidOptions, { signal: controller.signal, extra: true }]) {
        let promise;
        assert.doesNotThrow(() => { promise = semaphore.acquire(options); });
        const state = observe(promise);
        await state.done;
        assert.equal(state.status, 'rejected');
        assert.ok(state.reason instanceof TypeError);
        counts(semaphore, 1, setup === 'saturated' ? 1 : 0,
          setup === 'saturated' ? 2 : 0, setup === 'closed');
        assert.deepEqual(listeners(controller.signal), baseline);
      }
      const failure = { getter: true };
      let reads = 0;
      let promise;
      assert.doesNotThrow(() => {
        promise = semaphore.acquire({ get signal() { reads++; throw failure; } });
      });
      await rejected(observe(promise), failure);
      assert.equal(reads, 1);
      counts(semaphore, 1, setup === 'saturated' ? 1 : 0,
        setup === 'saturated' ? 2 : 0, setup === 'closed');
      assert.deepEqual(listeners(controller.signal), baseline);
      if (releaseA) {
        releaseA();
        const releaseB = await granted(b);
        await checkpoint();
        assert.equal(c.status, 'pending');
        releaseB();
        (await granted(c))();
        assert.deepEqual(listeners(controller.signal), [caller]);
      }
      counts(semaphore, 1, 0, 0, setup === 'closed');
    });
  }

  it('accepts omitted, undefined, null-prototype, and own signal options only', async () => {
    const semaphore = new AsyncSemaphore(1);
    const inherited = Object.create({
      get signal() { assert.fail('inherited signal must not be read'); },
      unknown: true,
    });
    const controller = new AbortController();
    let reads = 0;
    const getter = { get signal() { reads++; return controller.signal; } };
    for (const options of [undefined, {}, { signal: undefined }, Object.create(null), inherited,
      getter, Object.defineProperty({}, 'signal', { value: controller.signal })]) {
      const release = await granted(observe(semaphore.acquire(options)));
      counts(semaphore, 1, 1, 0);
      release();
      counts(semaphore, 1, 0, 0);
    }
    assert.equal(reads, 1);
    assert.deepEqual(listeners(controller.signal), []);
  });

  it('accepts composed native signals and cancels their queued acquisitions', async () => {
    const semaphore = new AsyncSemaphore(1);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal]);
    const releaseA = await semaphore.acquire({ signal });
    const b = observe(semaphore.acquire({ signal }));
    const reason = { composed: true };
    controller.abort(reason);
    counts(semaphore, 1, 1, 0);
    await rejected(b, reason);
    assert.deepEqual(listeners(signal), []);
    releaseA();
    counts(semaphore, 1, 0, 0);
  });

  for (const occupied of [false, true]) {
    it(`pre-abort never consumes capacity (${occupied ? 'occupied' : 'free'})`, async () => {
      const semaphore = new AsyncSemaphore(1);
      const release = occupied ? await semaphore.acquire() : undefined;
      for (const reason of [undefined, null, false, 0, '', Symbol('abort'), { abort: true }]) {
        const signal = AbortSignal.abort(reason);
        const state = observe(semaphore.acquire({ signal }));
        counts(semaphore, 1, occupied ? 1 : 0, 0);
        await rejected(state, signal.reason);
        assert.deepEqual(listeners(signal), []);
      }
      release?.();
      counts(semaphore, 1, 0, 0);
    });
  }

  for (const canceled of [[0], [1], [3], [0, 1, 2, 3]]) {
    it(`unlinks canceled queue positions ${canceled} and preserves surviving FIFO`, async () => {
      const semaphore = new AsyncSemaphore(1);
      const releaseA = await semaphore.acquire();
      const controllers = Array.from({ length: 4 }, () => new AbortController());
      const states = controllers.map(controller => observe(semaphore.acquire({ signal: controller.signal })));
      const reasons = controllers.map((_, index) => ({ canceled: index }));
      counts(semaphore, 1, 1, 4);
      for (const [index, position] of canceled.entries()) {
        controllers[position].abort(reasons[position]);
        counts(semaphore, 1, 1, 3 - index);
        assert.deepEqual(listeners(controllers[position].signal), []);
        await rejected(states[position], reasons[position]);
      }
      const fresh = observe(semaphore.acquire());
      releaseA();
      const survivors = states.filter((_, index) => !canceled.includes(index));
      for (const [index, state] of [...survivors, fresh].entries()) {
        const release = await granted(state);
        await checkpoint();
        [...survivors, fresh].slice(index + 1).forEach(later => assert.equal(later.status, 'pending'));
        counts(semaphore, 1, 1, survivors.length - index);
        release();
      }
      controllers.forEach(controller => assert.deepEqual(listeners(controller.signal), []));
      counts(semaphore, 1, 0, 0);
    });
  }

  for (const action of ['abort', 'close']) {
    for (const first of ['release', action]) {
      it(`synchronous handoff race: ${first} before ${first === 'release' ? action : 'release'}`, async () => {
        const semaphore = new AsyncSemaphore(1);
        const releaseA = await semaphore.acquire();
        const controller = new AbortController();
        const reason = { action };
        const b = observe(semaphore.acquire({ signal: controller.signal }));
        const c = observe(semaphore.acquire());
        const act = () => action === 'abort' ? controller.abort(reason) : semaphore.close(reason);
        if (first === 'release') {
          releaseA();
          counts(semaphore, 1, 1, 1);
          assert.deepEqual(listeners(controller.signal), []);
          act();
          const releaseB = await granted(b);
          counts(semaphore, 1, 1, action === 'abort' ? 1 : 0, action === 'close');
          releaseB();
        } else {
          act();
          releaseA();
          counts(semaphore, 1, action === 'abort' ? 1 : 0, 0, action === 'close');
          await rejected(b, reason);
        }
        if (action === 'abort') (await granted(c))();
        else await rejected(c, reason);
        assert.deepEqual(listeners(controller.signal), []);
        counts(semaphore, 1, 0, 0, action === 'close');
      });
    }
  }

  for (const action of ['read', 'release', 'close']) {
    it(`honors current abort state during an earlier caller listener's ${action}`, async () => {
      const semaphore = new AsyncSemaphore(1);
      const releaseA = await semaphore.acquire();
      const controller = new AbortController();
      const abortReason = { source: 'abort' }, closeReason = { source: 'close' };
      const snapshots = [];
      const caller = () => {
        snapshots.push([semaphore.active, semaphore.waiting, semaphore.closed]);
        if (action === 'release') releaseA();
        if (action === 'close') semaphore.close(closeReason);
        snapshots.push([semaphore.active, semaphore.waiting, semaphore.closed]);
      };
      controller.signal.addEventListener('abort', caller);
      const b = observe(semaphore.acquire({ signal: controller.signal }));
      const c = observe(semaphore.acquire());
      controller.abort(abortReason);
      assert.deepEqual(snapshots, [
        [1, 1, false],
        [1, action === 'read' ? 1 : 0, action === 'close'],
      ]);
      await rejected(b, abortReason);
      assert.deepEqual(listeners(controller.signal), [caller]);
      if (action !== 'release') releaseA();
      if (action === 'close') await rejected(c, closeReason);
      else (await granted(c))();
      counts(semaphore, 1, 0, 0, action === 'close');
    });
  }

  it('queued cancellation survives stopImmediatePropagation without a release', async () => {
    const semaphore = new AsyncSemaphore(1);
    const releaseA = await semaphore.acquire();
    const controller = new AbortController();
    const caller = event => event.stopImmediatePropagation();
    controller.signal.addEventListener('abort', caller);
    const b = observe(semaphore.acquire({ signal: controller.signal }));
    const c = observe(semaphore.acquire());
    const reason = { stopped: true };
    controller.abort(reason);
    counts(semaphore, 1, 1, 1);
    await rejected(b, reason);
    assert.deepEqual(listeners(controller.signal), [caller]);
    releaseA();
    (await granted(c))();
    counts(semaphore, 1, 0, 0);
  });

  for (const ending of ['abort immediately', 'abort after rearm', 'grant immediately', 'grant after rearm', 'close immediately']) {
    it(`ignores synthetic abort events and still handles ${ending}`, async () => {
      const semaphore = new AsyncSemaphore(1);
      const releaseA = await semaphore.acquire();
      const controller = new AbortController();
      const caller = event => event.stopImmediatePropagation();
      controller.signal.addEventListener('abort', caller);
      // Shared-signal listeners also exercise safe re-arming outside dispatch.
      const b = observe(semaphore.acquire({ signal: controller.signal }));
      const c = observe(semaphore.acquire({ signal: controller.signal }));
      const d = observe(semaphore.acquire());
      controller.signal.dispatchEvent(new Event('abort'));
      assert.equal(controller.signal.aborted, false);
      counts(semaphore, 1, 1, 3);
      if (ending.endsWith('after rearm')) {
        await checkpoint();
        assert.equal(b.status, 'pending');
        assert.equal(c.status, 'pending');
        assert.equal(listeners(controller.signal).length, 3);
        controller.signal.dispatchEvent(new Event('abort'));
        await checkpoint();
        assert.equal(listeners(controller.signal).length, 3);
      }
      const reason = { ending };
      if (ending.startsWith('abort')) {
        controller.abort(reason);
        counts(semaphore, 1, 1, 1);
        await rejected(b, reason);
        await rejected(c, reason);
        counts(semaphore, 1, 1, 1);
        releaseA();
        (await granted(d))();
      } else if (ending.startsWith('grant')) {
        releaseA();
        const releaseB = await granted(b);
        await checkpoint();
        assert.equal(c.status, 'pending');
        assert.equal(d.status, 'pending');
        releaseB();
        const releaseC = await granted(c);
        releaseC();
        (await granted(d))();
      } else {
        semaphore.close(reason);
        counts(semaphore, 1, 1, 0, true);
        await rejected(b, reason);
        await rejected(c, reason);
        await rejected(d, reason);
        releaseA();
      }
      await checkpoint();
      assert.deepEqual(listeners(controller.signal), [caller]);
      counts(semaphore, 1, 0, 0, ending.startsWith('close'));
    });
  }

  it('shared-signal cancellation only rejects requests still waiting', async () => {
    const semaphore = new AsyncSemaphore(1);
    const releaseA = await semaphore.acquire();
    const controller = new AbortController();
    const caller = () => {};
    controller.signal.addEventListener('abort', caller);
    const b = observe(semaphore.acquire({ signal: controller.signal }));
    const c = observe(semaphore.acquire({ signal: controller.signal }));
    assert.equal(listeners(controller.signal).length, 3);
    releaseA();
    assert.equal(listeners(controller.signal).length, 2);
    const reason = { shared: true };
    controller.abort(reason);
    counts(semaphore, 1, 1, 0);
    const releaseB = await granted(b);
    await rejected(c, reason);
    assert.deepEqual(listeners(controller.signal), [caller]);
    releaseB();
    counts(semaphore, 1, 0, 0);
  });

  for (const ending of ['grant', 'close']) {
    it(`${ending} on one instance preserves another's subscription and state`, async () => {
      const one = new AsyncSemaphore(1), two = new AsyncSemaphore(2);
      const releaseOne = await one.acquire();
      const releaseTwo = await two.acquire(), releaseOther = await two.acquire();
      const controller = new AbortController();
      const a = observe(one.acquire({ signal: controller.signal }));
      const b = observe(two.acquire({ signal: controller.signal }));
      const original = listeners(controller.signal);
      assert.equal(original.length, 2);
      const closeReason = { closed: true };
      if (ending === 'grant') releaseOne();
      else one.close(closeReason);
      assert.deepEqual(listeners(controller.signal), [original[1]]);
      counts(two, 2, 2, 1);
      const abortReason = { aborted: true };
      controller.abort(abortReason);
      await rejected(b, abortReason);
      if (ending === 'grant') (await granted(a))();
      else { await rejected(a, closeReason); releaseOne(); }
      releaseTwo();
      releaseOther();
      counts(one, 1, 0, 0, ending === 'close');
      counts(two, 2, 0, 0);
      assert.deepEqual(listeners(controller.signal), []);
    });
  }

  for (const closeReason of [null, false, 0, '', Symbol('close'), { closed: true }]) {
    it(`close preserves ${String(closeReason)} and all active holders`, async () => {
      const semaphore = new AsyncSemaphore(2);
      const releaseA = await semaphore.acquire(), releaseB = await semaphore.acquire();
      const controller = new AbortController();
      const caller = () => {};
      controller.signal.addEventListener('abort', caller);
      const queued = [
        observe(semaphore.acquire({ signal: controller.signal })),
        observe(semaphore.acquire({ signal: controller.signal })),
        observe(semaphore.acquire()),
      ];
      counts(semaphore, 2, 2, 3);
      assert.equal(semaphore.close(closeReason), undefined);
      counts(semaphore, 2, 2, 0, true);
      assert.deepEqual(listeners(controller.signal), [caller]);
      semaphore.close({ ignored: true });
      semaphore.close();
      for (const state of queued) await rejected(state, closeReason);
      for (const signal of [undefined, controller.signal, AbortSignal.abort({ other: true })]) {
        const baseline = signal ? listeners(signal) : [];
        await rejected(observe(semaphore.acquire({ signal })), closeReason);
        if (signal) assert.deepEqual(listeners(signal), baseline);
      }
      releaseB();
      counts(semaphore, 2, 1, 0, true);
      releaseB();
      counts(semaphore, 2, 1, 0, true);
      releaseA();
      releaseA();
      counts(semaphore, 2, 0, 0, true);
    });
  }

  for (const explicit of [false, true]) {
    for (const occupied of [false, true]) {
      it(`default close reason is one Error (${explicit ? 'undefined' : 'omitted'}, ${occupied ? 'occupied' : 'empty'})`, async () => {
        const semaphore = new AsyncSemaphore(1);
        const release = occupied ? await semaphore.acquire() : undefined;
        const queued = occupied ? observe(semaphore.acquire()) : undefined;
        if (explicit) semaphore.close(undefined);
        else semaphore.close();
        counts(semaphore, 1, occupied ? 1 : 0, 0, true);
        const first = observe(semaphore.acquire());
        await first.done;
        assert.equal(first.status, 'rejected');
        assert.ok(first.reason instanceof Error);
        if (queued) await rejected(queued, first.reason);
        semaphore.close({ ignored: true });
        await rejected(observe(semaphore.acquire()), first.reason);
        release?.();
        counts(semaphore, 1, 0, 0, true);
      });
    }
  }

  it('exposes read-only properties without requiring a frozen instance', async () => {
    const semaphore = new AsyncSemaphore(2);
    const a = observe(semaphore.acquire());
    for (const key of ['capacity', 'active', 'waiting', 'closed']) {
      assert.throws(() => { semaphore[key] = 99; }, TypeError);
    }
    counts(semaphore, 2, 1, 0);
    (await granted(a))();
    counts(semaphore, 2, 0, 0);
  });

  it('repeated cancellation behind a long-lived holder cleans listeners and queue entries', async () => {
    const semaphore = new AsyncSemaphore(1);
    const releaseA = await semaphore.acquire();
    for (let index = 0; index < 250; index++) {
      const controller = new AbortController();
      const reason = { index };
      const state = observe(semaphore.acquire({ signal: controller.signal }));
      counts(semaphore, 1, 1, 1);
      assert.equal(listeners(controller.signal).length, 1);
      controller.abort(reason);
      counts(semaphore, 1, 1, 0);
      await rejected(state, reason);
      assert.deepEqual(listeners(controller.signal), []);
    }
    const fresh = observe(semaphore.acquire());
    releaseA();
    (await granted(fresh))();
    counts(semaphore, 1, 0, 0);
  });

  for (const outcome of ['success', 'throw', 'reject']) {
    it(`documented try/finally holds ownership through work ${outcome}`, async () => {
      const semaphore = new AsyncSemaphore(1);
      const gate = deferred();
      const failure = { failure: outcome };
      const result = { result: true };
      let starts = 0;
      const work = observe(doBoundedWork(semaphore, () => {
        starts++;
        if (outcome === 'throw') throw failure;
        return gate.promise;
      }));
      counts(semaphore, 1, 1, 0);
      const successor = observe(semaphore.acquire());
      counts(semaphore, 1, 1, 1);
      if (outcome !== 'throw') {
        await checkpoint();
        assert.equal(starts, 1);
        assert.equal(work.status, 'pending');
        assert.equal(successor.status, 'pending');
        counts(semaphore, 1, 1, 1);
        if (outcome === 'success') gate.resolve(result);
        else gate.reject(failure);
      }
      await work.done;
      assert.equal(starts, 1);
      if (outcome === 'success') {
        assert.equal(work.status, 'fulfilled');
        assert.equal(work.value, result);
      } else await rejected(work, failure);
      (await granted(successor))();
      counts(semaphore, 1, 0, 0);
    });
  }

  it('documented post-grant cancellation check releases without starting work', async () => {
    const semaphore = new AsyncSemaphore(1);
    const controller = new AbortController();
    let starts = 0;
    const work = observe(doBoundedWork(semaphore, () => { starts++; }, controller.signal));
    counts(semaphore, 1, 1, 0);
    const successor = observe(semaphore.acquire());
    const reason = { canceled: true };
    controller.abort(reason);
    counts(semaphore, 1, 1, 1);
    await rejected(work, reason);
    assert.equal(starts, 0);
    (await granted(successor))();
    counts(semaphore, 1, 0, 0);
  });

  for (const capacity of [1, 3]) {
    for (const seed of [34, 20261028]) {
      it(`matches a FIFO ownership model (capacity ${capacity}, seed ${seed})`, async () => {
        const semaphore = new AsyncSemaphore(capacity);
        const requests = [];
        const queue = [];
        const owners = new Set();
        const closeReason = { closed: seed };
        let closed = false;
        let randomState = seed;
        const random = limit => {
          randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
          return Math.floor(randomState / 2 ** 32 * limit);
        };

        function acquire() {
          const controller = new AbortController();
          if (random(7) === 0) controller.abort({ preAborted: requests.length });
          const request = {
            controller,
            state: observe(semaphore.acquire({ signal: controller.signal })),
            status: 'pending',
          };
          requests.push(request);
          if (closed || controller.signal.aborted) {
            request.status = 'rejected';
            request.reason = closed ? closeReason : controller.signal.reason;
          } else if (owners.size < capacity) {
            request.status = 'fulfilled';
            owners.add(request);
          } else queue.push(request);
        }

        function release(request) {
          request.state.value();
          if (owners.delete(request) && queue.length > 0) {
            const next = queue.shift();
            next.status = 'fulfilled';
            owners.add(next);
          }
        }

        function abort(request) {
          request.controller.abort({ aborted: requests.indexOf(request) });
          const index = queue.indexOf(request);
          if (index !== -1) {
            queue.splice(index, 1);
            request.status = 'rejected';
            request.reason = request.controller.signal.reason;
          }
        }

        function close() {
          semaphore.close(closed ? { ignored: true } : closeReason);
          closed = true;
          for (const request of queue.splice(0)) {
            request.status = 'rejected';
            request.reason = closeReason;
          }
        }

        async function verify() {
          counts(semaphore, capacity, owners.size, queue.length, closed);
          await checkpoint();
          counts(semaphore, capacity, owners.size, queue.length, closed);
          for (const request of requests) {
            assert.equal(request.state.status, request.status);
            assert.equal(listeners(request.controller.signal).length,
              request.status === 'pending' ? 1 : 0);
            if (request.status === 'rejected') {
              await rejected(request.state, request.reason);
            } else if (request.status === 'fulfilled') {
              await granted(request.state);
            }
          }
        }

        for (let step = 0; step < 250; step++) {
          const operation = random(100);
          if (step === 200 || (closed && operation < 10)) {
            close();
          } else if (operation < 45 || requests.length === 0) {
            acquire();
          } else if (operation < 75) {
            // Include duplicate releases from former owners and same-turn arrivals.
            const grants = requests.filter(request => request.status === 'fulfilled');
            if (grants.length > 0) release(grants[random(grants.length)]);
            if (random(2) === 0) acquire();
          } else {
            const candidates = queue.length > 0 && random(2) === 0 ? queue : requests;
            abort(candidates[random(candidates.length)]);
          }
          await verify();
        }
        close();
        for (const request of [...owners]) release(request);
        await verify();
        await Promise.all(requests.map(request => request.state.done));
        counts(semaphore, capacity, 0, 0, true);
      });
    }
  }
});
