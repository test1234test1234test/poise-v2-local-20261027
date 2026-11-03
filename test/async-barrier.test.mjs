import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createAsyncBarrier } from '../lib/async-barrier.mjs';

const listeners = signal => getEventListeners(signal, 'abort');
const checkpoint = () => new Promise(resolve => setImmediate(resolve));
const stateOf = barrier => [barrier.pending, barrier.generation, barrier.closed];

// Observe before intentional abort/close. Store opaque reasons in a record:
// returning a reason from a rejection handler would assimilate thenables.
function observe(promise, onFulfilled = () => {}) {
  assert.ok(promise instanceof Promise);
  const state = { status: 'pending' };
  state.done = promise.then(
    value => { state.status = 'fulfilled'; state.value = value; onFulfilled(value); },
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
  assert.ok(Object.is(state.reason, reason), 'exact rejection reason');
}

// Timeouts only fail deadlocks; public operations drive all progress.
describe('createAsyncBarrier', { timeout: 15_000 }, () => {
  it('requires a positive safe integer without coercion', () => {
    const coercible = { valueOf() { assert.fail('parties coercion'); } };
    for (const parties of [undefined, null, false, true, '2', 2n, Symbol(), {}, [],
      new Number(2), () => 2, coercible]) {
      assert.throws(() => createAsyncBarrier(parties), TypeError);
    }
    for (const parties of [0, -0, -1, 0.5, NaN, Infinity, -Infinity,
      Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => createAsyncBarrier(parties), RangeError);
    }
  });

  it('exposes getter-only initial state and isolates instances', async () => {
    const one = createAsyncBarrier(1), two = createAsyncBarrier(2);
    assert.deepEqual(stateOf(one), [0, 0, false]);
    assert.deepEqual(stateOf(two), [0, 0, false]);
    for (const name of ['pending', 'generation', 'closed']) {
      const descriptor = Object.getOwnPropertyDescriptor(one, name);
      assert.equal(typeof descriptor.get, 'function');
      assert.equal(descriptor.set, undefined);
      assert.throws(() => { one[name] = 99; }, TypeError);
    }
    const a = observe(two.wait());
    await fulfilled(observe(one.wait()), 0);
    assert.equal(one.close('one'), true);
    assert.deepEqual(stateOf(one), [0, 1, true]);
    assert.deepEqual(stateOf(two), [1, 0, false]);
    const b = observe(two.wait());
    await fulfilled(a, 0);
    await fulfilled(b, 0);
    assert.deepEqual(stateOf(two), [0, 1, false]);
    two.close();
  });

  it('commits three same-stack rounds and settles direct observers in FIFO order', async () => {
    const barrier = createAsyncBarrier(2), order = [];
    const states = Array.from({ length: 6 }, (_, index) => {
      const state = observe(barrier.wait(), round => {
        order.push(index);
        assert.equal(round, Math.floor(index / 2));
        assert.ok(barrier.generation > round);
      });
      assert.deepEqual(stateOf(barrier), [(index + 1) % 2, Math.floor((index + 1) / 2), false]);
      return state;
    });
    assert.deepEqual(order, []);
    assert.deepEqual(stateOf(barrier), [0, 3, false]);
    for (const [index, state] of states.entries()) await fulfilled(state, Math.floor(index / 2));
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
    barrier.close();
  });

  it('reuses the barrier across async gaps and detaches all listeners before reactions', async () => {
    const barrier = createAsyncBarrier(3), controller = new AbortController();
    const external = () => {};
    controller.signal.addEventListener('abort', external);
    const baseline = listeners(controller.signal);
    for (let round = 0; round < 3; round++) {
      const a = observe(barrier.wait({ signal: controller.signal }), () => {
        assert.equal(barrier.generation, round + 1);
        assert.deepEqual(listeners(controller.signal), baseline);
      });
      const b = observe(barrier.wait({ signal: controller.signal }));
      await checkpoint();
      assert.equal(a.status, 'pending');
      assert.equal(b.status, 'pending');
      assert.deepEqual(stateOf(barrier), [2, round, false]);
      const c = observe(barrier.wait({ signal: controller.signal }));
      assert.deepEqual(stateOf(barrier), [0, round + 1, false]);
      assert.deepEqual(listeners(controller.signal), baseline);
      for (const state of [a, b, c]) await fulfilled(state, round);
    }
    barrier.close();
  });

  it('parties=1 immediately completes each valid call as its own round', async () => {
    const barrier = createAsyncBarrier(1), controller = new AbortController();
    const states = Array.from({ length: 3 }, () => observe(barrier.wait({ signal: controller.signal })));
    assert.deepEqual(stateOf(barrier), [0, 3, false]);
    assert.deepEqual(listeners(controller.signal), []);
    controller.abort('late');
    const preAborted = observe(barrier.wait({ signal: controller.signal }));
    const invalid = observe(barrier.wait(null));
    assert.deepEqual(stateOf(barrier), [0, 3, false]);
    barrier.close('closed');
    for (const [index, state] of states.entries()) await fulfilled(state, index);
    await rejected(preAborted, 'late');
    await invalid.done;
    assert.equal(invalid.status, 'rejected');
    assert.ok(invalid.reason instanceof TypeError);
  });

  it('separates arrivals before callbacks from arrivals reentering in callbacks', async () => {
    const barrier = createAsyncBarrier(2);
    let d;
    const a = observe(barrier.wait(), round => {
      assert.equal(round, 0);
      assert.deepEqual(stateOf(barrier), [1, 1, false]);
      d = observe(barrier.wait());
      assert.deepEqual(stateOf(barrier), [0, 2, false]);
    });
    const b = observe(barrier.wait());
    const c = observe(barrier.wait());
    assert.deepEqual(stateOf(barrier), [1, 1, false]);
    await fulfilled(a, 0);
    await fulfilled(b, 0);
    await fulfilled(c, 1);
    await fulfilled(d, 1);
    const e = observe(barrier.wait()), f = observe(barrier.wait());
    await fulfilled(e, 2);
    await fulfilled(f, 2);
    barrier.close();
  });

  for (const canceledIndex of [0, 1, 2]) {
    it(`preserves survivor membership and FIFO after cancelling position ${canceledIndex}`, async () => {
      const barrier = createAsyncBarrier(4), order = [];
      const controllers = Array.from({ length: 3 }, () => new AbortController());
      const baselines = controllers.map(({ signal }) => {
        signal.addEventListener('abort', () => {});
        return listeners(signal);
      });
      const states = controllers.map(({ signal }, index) =>
        observe(barrier.wait({ signal }), () => order.push(index)));
      const reason = { canceledIndex };
      controllers[canceledIndex].abort(reason);
      assert.deepEqual(stateOf(barrier), [2, 0, false]);
      assert.deepEqual(listeners(controllers[canceledIndex].signal), baselines[canceledIndex]);
      const d = observe(barrier.wait(), () => order.push(3));
      await checkpoint();
      assert.deepEqual(stateOf(barrier), [3, 0, false]);
      assert.deepEqual(order, []);
      assert.equal(d.status, 'pending');
      const e = observe(barrier.wait(), () => order.push(4));
      assert.deepEqual(stateOf(barrier), [0, 1, false]);
      controllers.forEach(({ signal }, index) => assert.deepEqual(listeners(signal), baselines[index]));
      for (const [index, state] of states.entries()) {
        if (index === canceledIndex) await rejected(state, reason);
        else await fulfilled(state, 0);
      }
      await fulfilled(d, 0);
      await fulfilled(e, 0);
      assert.deepEqual(order, [0, 1, 2, 3, 4].filter(index => index !== canceledIndex));
      barrier.close();
    });
  }

  it('cancelling every partial arrival leaves the original party count unchanged', async () => {
    const barrier = createAsyncBarrier(4), controller = new AbortController();
    const canceled = Array.from({ length: 3 }, () => observe(barrier.wait({ signal: controller.signal })));
    controller.abort('all');
    assert.deepEqual(stateOf(barrier), [0, 0, false]);
    assert.deepEqual(listeners(controller.signal), []);
    const next = Array.from({ length: 3 }, () => observe(barrier.wait()));
    await checkpoint();
    next.forEach(state => assert.equal(state.status, 'pending'));
    assert.deepEqual(stateOf(barrier), [3, 0, false]);
    next.push(observe(barrier.wait()));
    for (const state of canceled) await rejected(state, 'all');
    for (const state of next) await fulfilled(state, 0);
    barrier.close();
  });

  it('excludes an already-aborted registration during an earlier listener arrival', async () => {
    const barrier = createAsyncBarrier(3), controller = new AbortController();
    let c;
    const external = () => {
      assert.deepEqual(stateOf(barrier), [1, 0, false]);
      c = observe(barrier.wait());
      assert.deepEqual(stateOf(barrier), [2, 0, false]);
    };
    controller.signal.addEventListener('abort', external);
    const a = observe(barrier.wait({ signal: controller.signal })), b = observe(barrier.wait());
    const reason = { aborted: true };
    controller.abort(reason);
    assert.deepEqual(listeners(controller.signal), [external]);
    await rejected(a, reason);
    await checkpoint();
    assert.equal(b.status, 'pending');
    assert.equal(c.status, 'pending');
    const d = observe(barrier.wait());
    for (const state of [b, c, d]) await fulfilled(state, 0);
    barrier.close();
  });

  for (const first of ['release', 'abort', 'close']) {
    it(`commits synchronous ${first} before a later competing operation`, async () => {
      const barrier = createAsyncBarrier(2), controller = new AbortController();
      const external = () => {};
      controller.signal.addEventListener('abort', external);
      const a = observe(barrier.wait({ signal: controller.signal }));
      if (first === 'abort') controller.abort('abort');
      if (first === 'close') barrier.close('close');
      const b = observe(barrier.wait());
      if (first === 'release') {
        assert.deepEqual(stateOf(barrier), [0, 1, false]);
        assert.deepEqual(listeners(controller.signal), [external]);
        controller.abort('abort');
        barrier.close('close');
        await fulfilled(a, 0);
        await fulfilled(b, 0);
      } else if (first === 'abort') {
        assert.deepEqual(stateOf(barrier), [1, 0, false]);
        await checkpoint();
        assert.equal(b.status, 'pending');
        const replacement = observe(barrier.wait());
        await rejected(a, 'abort');
        await fulfilled(b, 0);
        await fulfilled(replacement, 0);
        barrier.close();
      } else {
        controller.abort('abort');
        await rejected(a, 'close');
        await rejected(b, 'close');
        assert.deepEqual(stateOf(barrier), [0, 0, true]);
      }
      assert.deepEqual(listeners(controller.signal), [external]);
    });
  }

  it('retains the abort reason when an earlier abort listener closes the barrier', async () => {
    const barrier = createAsyncBarrier(3), controller = new AbortController();
    const abortReason = { abort: true }, closeReason = { close: true };
    const external = () => {
      assert.deepEqual(stateOf(barrier), [1, 0, false]);
      assert.equal(barrier.close(closeReason), true);
      assert.deepEqual(stateOf(barrier), [0, 0, true]);
    };
    controller.signal.addEventListener('abort', external);
    const a = observe(barrier.wait({ signal: controller.signal })), b = observe(barrier.wait());
    controller.abort(abortReason);
    assert.deepEqual(listeners(controller.signal), [external]);
    await rejected(a, abortReason);
    await rejected(b, closeReason);
    await rejected(observe(barrier.wait({ signal: controller.signal })), closeReason);
  });

  for (const action of ['abort', 'close']) {
    it(`a released callback can ${action} without changing its released sibling`, async () => {
      const barrier = createAsyncBarrier(2), controller = new AbortController();
      const reason = { action };
      const a = observe(barrier.wait(), () => {
        if (action === 'abort') controller.abort(reason);
        else barrier.close(reason);
      });
      const b = observe(barrier.wait({ signal: controller.signal }));
      const next = observe(barrier.wait({ signal: controller.signal }));
      await fulfilled(a, 0);
      await fulfilled(b, 0);
      await rejected(next, reason);
      assert.equal(barrier.pending, 0);
      assert.equal(barrier.generation, 1);
      assert.deepEqual(listeners(controller.signal), []);
      barrier.close();
    });
  }

  for (const phase of ['empty', 'almost-full', 'closed']) {
    it(`rejects invalid options/signals as Promises without admission while ${phase}`, async () => {
      const barrier = createAsyncBarrier(2), controller = new AbortController();
      const external = () => {};
      controller.signal.addEventListener('abort', external);
      const older = phase === 'almost-full' ? observe(barrier.wait({ signal: controller.signal })) : undefined;
      if (phase === 'closed') barrier.close('closed');
      const before = stateOf(barrier), baseline = listeners(controller.signal);
      const revoked = Proxy.revocable(controller.signal, {});
      revoked.revoke();
      const foreignPrototype = Object.setPrototypeOf(new AbortController().signal, {});
      const invalid = [null, [], true, 0, 'options', 1n, Symbol(), () => {},
        ...[null, false, 1, 'signal', {}, [], () => {},
          { aborted: false, addEventListener() {}, removeEventListener() {} },
          AbortSignal.prototype, Object.create(AbortSignal.prototype), Object.create(controller.signal),
          new Proxy(controller.signal, {}), revoked.proxy, foreignPrototype].map(signal => ({ signal }))];
      for (const options of invalid) {
        let promise;
        assert.doesNotThrow(() => { promise = barrier.wait(options); });
        const state = observe(promise);
        assert.deepEqual(stateOf(barrier), before);
        assert.deepEqual(listeners(controller.signal), baseline);
        await state.done;
        assert.equal(state.status, 'rejected');
        assert.ok(state.reason instanceof TypeError);
        if (older) assert.equal(older.status, 'pending');
      }
      const failure = { getter: true };
      let reads = 0;
      const failed = observe(barrier.wait({ get signal() { reads++; throw failure; } }));
      await rejected(failed, failure);
      assert.equal(reads, 1);
      assert.deepEqual(stateOf(barrier), before);
      assert.deepEqual(listeners(controller.signal), baseline);
      if (older) {
        const final = observe(barrier.wait());
        await fulfilled(older, 0);
        await fulfilled(final, 0);
      }
      barrier.close();
      assert.deepEqual(listeners(controller.signal), [external]);
    });
  }

  it('accepts inherited and null-prototype options, reads signal once and ignores unrelated keys', async () => {
    const barrier = createAsyncBarrier(1), controller = new AbortController();
    class Options { constructor() { this.signal = controller.signal; } }
    let reads = 0;
    const options = [undefined, {}, { signal: undefined }, new Options(),
      Object.assign(Object.create(null), { signal: controller.signal }),
      Object.create({ get signal() { reads++; return controller.signal; } }),
      { signal: controller.signal, extra: true, [Symbol()]: 2 },
      { get unrelated() { assert.fail('unrelated option read'); } },
      { signal: AbortSignal.any([controller.signal]) }];
    await fulfilled(observe(barrier.wait()), 0);
    for (const [index, option] of options.entries()) {
      await fulfilled(observe(barrier.wait(option)), index + 1);
    }
    assert.equal(reads, 1);
    assert.deepEqual(listeners(controller.signal), []);
    barrier.close();
  });

  for (const key of ['aborted', 'reason', 'addEventListener', 'removeEventListener']) {
    it(`rejects a shadowed ${key} before reading it or altering a partial group`, async () => {
      const barrier = createAsyncBarrier(2), controller = new AbortController();
      const external = () => {};
      controller.signal.addEventListener('abort', external);
      const baseline = listeners(controller.signal);
      Object.defineProperty(controller.signal, key, {
        get() { assert.fail('shadowed member read'); },
      });
      const older = observe(barrier.wait());
      const invalid = observe(barrier.wait({ signal: controller.signal }));
      await invalid.done;
      assert.equal(invalid.status, 'rejected');
      assert.ok(invalid.reason instanceof TypeError);
      assert.deepEqual(stateOf(barrier), [1, 0, false]);
      assert.deepEqual(listeners(controller.signal), baseline);
      const final = observe(barrier.wait());
      await fulfilled(older, 0);
      await fulfilled(final, 0);
      barrier.close();
    });
  }

  it('rejects an own registration override without installing a listener or invoking caller code', async () => {
    const barrier = createAsyncBarrier(2), controller = new AbortController();
    const nativeAdd = controller.signal.addEventListener;
    const baseline = listeners(controller.signal);
    let calls = 0;
    controller.signal.addEventListener = function (...args) {
      calls++;
      nativeAdd.apply(this, args);
      barrier.close('reentered');
      throw new Error('registration failed after installation');
    };
    const older = observe(barrier.wait());
    const invalid = observe(barrier.wait({ signal: controller.signal }));
    await invalid.done;
    assert.equal(invalid.status, 'rejected');
    assert.ok(invalid.reason instanceof TypeError);
    assert.equal(calls, 0);
    assert.deepEqual(listeners(controller.signal), baseline);
    assert.deepEqual(stateOf(barrier), [1, 0, false]);
    const final = observe(barrier.wait());
    await fulfilled(older, 0);
    await fulfilled(final, 0);
    barrier.close();
  });

  it('admits a getter nested wait before the outer arrival', async () => {
    const barrier = createAsyncBarrier(2), order = [];
    let nested, reads = 0;
    const outer = observe(barrier.wait({ get signal() {
      reads++;
      nested = observe(barrier.wait(), () => order.push('nested'));
      assert.deepEqual(stateOf(barrier), [1, 0, false]);
      return undefined;
    } }), () => order.push('outer'));
    assert.equal(reads, 1);
    assert.deepEqual(stateOf(barrier), [0, 1, false]);
    await fulfilled(nested, 0);
    await fulfilled(outer, 0);
    assert.deepEqual(order, ['nested', 'outer']);
    barrier.close();
  });

  it('keeps nested getter effects when the outer getter throws without admitting the outer call', async () => {
    const barrier = createAsyncBarrier(2), controller = new AbortController();
    const failure = { getter: 'failed' };
    let nested;
    const outer = observe(barrier.wait({ get signal() {
      nested = observe(barrier.wait({ signal: controller.signal }));
      throw failure;
    } }));
    await rejected(outer, failure);
    assert.deepEqual(stateOf(barrier), [1, 0, false]);
    assert.equal(nested.status, 'pending');
    const final = observe(barrier.wait());
    assert.deepEqual(listeners(controller.signal), []);
    await fulfilled(nested, 0);
    await fulfilled(final, 0);
    barrier.close();
  });

  for (const throws of [false, true]) {
    it(`rechecks closure after a getter, preserving a thrown value (throws=${throws})`, async () => {
      const barrier = createAsyncBarrier(2), controller = new AbortController();
      const closeReason = { closed: true }, failure = { thrown: true };
      const older = observe(barrier.wait({ signal: controller.signal }));
      let reads = 0;
      const outer = observe(barrier.wait({ get signal() {
        reads++;
        barrier.close(closeReason);
        if (throws) throw failure;
        return controller.signal;
      } }));
      assert.equal(reads, 1);
      assert.deepEqual(stateOf(barrier), [0, 0, true]);
      assert.deepEqual(listeners(controller.signal), []);
      await rejected(older, closeReason);
      await rejected(outer, throws ? failure : closeReason);
    });
  }

  it('rechecks abort after a getter without counting the aborted outer arrival', async () => {
    const barrier = createAsyncBarrier(2), controller = new AbortController();
    const older = observe(barrier.wait());
    const outer = observe(barrier.wait({ get signal() {
      controller.abort('getter abort');
      return controller.signal;
    } }));
    await rejected(outer, 'getter abort');
    assert.deepEqual(stateOf(barrier), [1, 0, false]);
    assert.deepEqual(listeners(controller.signal), []);
    const final = observe(barrier.wait());
    await fulfilled(older, 0);
    await fulfilled(final, 0);
    barrier.close();
  });

  it('preserves exact pre-abort, waiting abort and close reasons without inspecting thenables', async () => {
    const object = {}, symbol = Symbol('reason');
    let thenReads = 0;
    const thenable = { get then() { thenReads++; throw new Error('reason inspected'); } };
    const reasons = [undefined, null, false, 0, -0, NaN, '', symbol, object,
      Promise.resolve('opaque'), new Promise(() => {}), thenable];
    for (const reason of reasons) {
      const barrier = createAsyncBarrier(3), controller = new AbortController();
      controller.signal.addEventListener('abort', () => {});
      const baseline = listeners(controller.signal);
      const a = observe(barrier.wait({ signal: controller.signal })), b = observe(barrier.wait());
      controller.abort(reason);
      // abort(undefined) supplies a default AbortError: compare the actual
      // reason here; literal undefined pre-abort has its own fixture below.
      await rejected(a, controller.signal.reason);
      assert.deepEqual(stateOf(barrier), [1, 0, false]);
      assert.deepEqual(listeners(controller.signal), baseline);
      await rejected(observe(barrier.wait({ signal: controller.signal })), controller.signal.reason);
      assert.deepEqual(listeners(controller.signal), baseline);
      assert.equal(barrier.close(reason), true);
      assert.deepEqual(stateOf(barrier), [0, 0, true]);
      assert.equal(barrier.close({ later: true }), false);
      await rejected(b, reason);
      await rejected(observe(barrier.wait()), reason);
      await rejected(observe(barrier.wait({ signal: controller.signal })), reason);
      assert.deepEqual(listeners(controller.signal), baseline);
    }
    assert.equal(thenReads, 0);
  });

  it('preserves a native pre-aborted signal with a literal undefined reason', async () => {
    const source = AbortSignal.abort('original');
    Object.defineProperty(source, 'reason', { value: undefined });
    const signal = AbortSignal.any([source]);
    const nativeReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get;
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, undefined);
    assert.equal(nativeReason.call(signal), undefined);
    const baseline = listeners(signal), barrier = createAsyncBarrier(2);
    const older = observe(barrier.wait());
    await rejected(observe(barrier.wait({ signal })), undefined);
    assert.deepEqual(stateOf(barrier), [1, 0, false]);
    assert.deepEqual(listeners(signal), baseline);
    const final = observe(barrier.wait());
    await fulfilled(older, 0);
    await fulfilled(final, 0);
    barrier.close();
  });

  for (const phase of ['empty', 'partial', 'released']) {
    it(`close() preserves its first undefined reason and generation while ${phase}`, async () => {
      const barrier = createAsyncBarrier(2), controller = new AbortController();
      const external = () => {};
      controller.signal.addEventListener('abort', external);
      let a, b;
      if (phase !== 'empty') a = observe(barrier.wait({ signal: controller.signal }));
      if (phase === 'released') b = observe(barrier.wait());
      assert.equal(barrier.close(), true);
      assert.deepEqual(stateOf(barrier), [0, phase === 'released' ? 1 : 0, true]);
      assert.deepEqual(listeners(controller.signal), [external]);
      assert.equal(barrier.close('replacement'), false);
      controller.abort('late');
      if (phase === 'partial') await rejected(a, undefined);
      if (phase === 'released') {
        await fulfilled(a, 0);
        await fulfilled(b, 0);
      }
      await rejected(observe(barrier.wait()), undefined);
      await rejected(observe(barrier.wait({ signal: controller.signal })), undefined);
      const invalid = observe(barrier.wait({ signal: null }));
      await invalid.done;
      assert.equal(invalid.status, 'rejected');
      assert.ok(invalid.reason instanceof TypeError);
      assert.deepEqual(listeners(controller.signal), [external]);
    });
  }

  it('cancels every still-waiting registration on a shared signal across rounds and instances', async () => {
    const one = createAsyncBarrier(3), two = createAsyncBarrier(3), controller = new AbortController();
    const external = () => {};
    controller.signal.addEventListener('abort', external);
    const released = Array.from({ length: 3 }, () => observe(one.wait({ signal: controller.signal })));
    assert.deepEqual(listeners(controller.signal), [external]);
    const waiting = [observe(one.wait({ signal: controller.signal })),
      observe(one.wait({ signal: controller.signal })), observe(two.wait({ signal: controller.signal }))];
    const unrelated = observe(two.wait());
    controller.abort('shared');
    assert.deepEqual(listeners(controller.signal), [external]);
    for (const state of released) await fulfilled(state, 0);
    for (const state of waiting) await rejected(state, 'shared');
    assert.deepEqual(stateOf(one), [0, 1, false]);
    assert.deepEqual(stateOf(two), [1, 0, false]);
    assert.equal(unrelated.status, 'pending');
    const replacements = [observe(two.wait()), observe(two.wait())];
    for (const state of [unrelated, ...replacements]) await fulfilled(state, 0);
    one.close();
    two.close();
  });

  for (const ending of ['release', 'close']) {
    it(`${ending} preserves other barriers' subscriptions and caller listeners`, async () => {
      const one = createAsyncBarrier(2), two = createAsyncBarrier(2), controller = new AbortController();
      const external = () => {};
      controller.signal.addEventListener('abort', external);
      const other = observe(two.wait({ signal: controller.signal }));
      const baseline = listeners(controller.signal);
      const own = observe(one.wait({ signal: controller.signal }));
      let final;
      if (ending === 'release') final = observe(one.wait());
      else one.close('closed');
      assert.deepEqual(listeners(controller.signal), baseline);
      controller.abort('other');
      await rejected(other, 'other');
      if (ending === 'release') {
        await fulfilled(own, 0);
        await fulfilled(final, 0);
      } else await rejected(own, 'closed');
      assert.deepEqual(listeners(controller.signal), [external]);
      one.close();
      two.close();
    });
  }

  it('cancels without another arrival even if an earlier listener suppresses propagation', async () => {
    const barrier = createAsyncBarrier(2), controller = new AbortController();
    const external = event => event.stopImmediatePropagation();
    controller.signal.addEventListener('abort', external);
    const state = observe(barrier.wait({ signal: controller.signal }));
    controller.abort('suppressed');
    assert.deepEqual(stateOf(barrier), [0, 0, false]);
    assert.deepEqual(listeners(controller.signal), [external]);
    await rejected(state, 'suppressed');
    barrier.close();
  });

  for (const action of ['abort', 'release', 'close']) {
    for (const timing of ['during rearm gap', 'after rearm']) {
      it(`ignores synthetic events and handles ${action} ${timing} on a shared signal`, async () => {
        const barrier = createAsyncBarrier(4), controller = new AbortController();
        const external = event => event.stopImmediatePropagation();
        controller.signal.addEventListener('abort', external);
        const a = observe(barrier.wait({ signal: controller.signal }));
        const b = observe(barrier.wait({ signal: controller.signal }));
        const c = observe(barrier.wait());
        controller.signal.dispatchEvent(new Event('abort'));
        assert.equal(controller.signal.aborted, false);
        assert.deepEqual(stateOf(barrier), [3, 0, false]);
        if (timing === 'after rearm') {
          await checkpoint();
          assert.equal(a.status, 'pending');
          assert.equal(b.status, 'pending');
          // A second synthetic event must not permanently consume cancellation.
          controller.signal.dispatchEvent(new Event('abort'));
          await checkpoint();
          assert.equal(a.status, 'pending');
          assert.equal(b.status, 'pending');
        }
        if (action === 'abort') {
          controller.abort('real');
          assert.deepEqual(stateOf(barrier), [1, 0, false]);
          await rejected(a, 'real');
          await rejected(b, 'real');
          assert.equal(c.status, 'pending');
          const replacements = Array.from({ length: 3 }, () => observe(barrier.wait()));
          for (const state of [c, ...replacements]) await fulfilled(state, 0);
        } else if (action === 'release') {
          const d = observe(barrier.wait());
          assert.deepEqual(stateOf(barrier), [0, 1, false]);
          assert.deepEqual(listeners(controller.signal), [external]);
          controller.abort('late');
          for (const state of [a, b, c, d]) await fulfilled(state, 0);
        } else {
          barrier.close('closed');
          assert.deepEqual(stateOf(barrier), [0, 0, true]);
          assert.deepEqual(listeners(controller.signal), [external]);
          for (const state of [a, b, c]) await rejected(state, 'closed');
        }
        // Pending re-arm callbacks must not resurrect settled records/listeners.
        await checkpoint();
        assert.deepEqual(listeners(controller.signal), [external]);
        assert.equal(barrier.pending, 0);
        barrier.close();
      });
    }
  }

  it('supports cancellation through native composed signals', async () => {
    const barrier = createAsyncBarrier(2), controller = new AbortController();
    const signal = AbortSignal.any([controller.signal]);
    const state = observe(barrier.wait({ signal }));
    const reason = { composed: true };
    controller.abort(reason);
    assert.deepEqual(stateOf(barrier), [0, 0, false]);
    assert.deepEqual(listeners(signal), []);
    await rejected(state, reason);
    barrier.close();
  });

  for (const parties of [2 ** 32, Number.MAX_SAFE_INTEGER]) {
    it(`uses demand-sized storage and unlinks cancellation churn with ${parties} parties`, async () => {
      const barrier = createAsyncBarrier(parties), controller = new AbortController();
      const external = () => {};
      controller.signal.addEventListener('abort', external);
      const survivors = [observe(barrier.wait({ signal: controller.signal })), observe(barrier.wait())];
      for (let i = 0; i < 100; i++) {
        const canceled = new AbortController();
        const state = observe(barrier.wait({ signal: canceled.signal }));
        assert.deepEqual(stateOf(barrier), [3, 0, false]);
        canceled.abort(i);
        assert.deepEqual(stateOf(barrier), [2, 0, false]);
        assert.deepEqual(listeners(canceled.signal), []);
        await rejected(state, i);
        survivors.forEach(survivor => assert.equal(survivor.status, 'pending'));
      }
      const reason = { shutdown: true };
      barrier.close(reason);
      assert.deepEqual(stateOf(barrier), [0, 0, true]);
      assert.deepEqual(listeners(controller.signal), [external]);
      for (const state of survivors) await rejected(state, reason);
    });
  }
});
