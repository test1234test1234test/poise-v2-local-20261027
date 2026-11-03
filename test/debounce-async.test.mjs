import { describe, it as nodeIt } from 'node:test';
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { debounceAsync } from '../lib/debounce-async.mjs';

const it = (name, fn) => nodeIt(name, { timeout: 5000 }, fn);
const maximumDelay = 2147483647;
const checkpoint = () => new Promise(resolve => setImmediate(resolve));

function deferred(t) {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  t.after(() => resolve());
  return { promise, resolve, reject };
}

// Observe public results without assimilating their values or rejection reasons
// again. Attach these handlers before any intentional rejection/cancellation.
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

// Observe real timers without replacing global APIs. Clear any leaked maximum
// delay on test failure so a regression cannot keep the process alive for days.
function timers(t) {
  const created = new Map(), destroyed = new Set();
  const hook = createHook({
    init(id, type, trigger, resource) {
      if (type === 'Timeout') created.set(id, resource);
    },
    destroy(id) { if (created.has(id)) destroyed.add(id); },
  });
  t.after(() => {
    hook.disable();
    for (const timer of created.values()) clearTimeout(timer);
  });
  hook.enable();
  return {
    async active(count) {
      await checkpoint();
      await checkpoint();
      assert.equal([...created.keys()].filter(id => !destroyed.has(id)).length, count);
    },
  };
}

describe('debounceAsync', { concurrency: 1, timeout: 30000 }, () => {
  it('validates functions and primitive delays without coercion', () => {
    let coerced = 0;
    const hostile = {
      [Symbol.toPrimitive]() { coerced++; throw new Error('coercion'); },
      valueOf() { coerced++; throw new Error('coercion'); },
      toString() { coerced++; throw new Error('coercion'); },
    };
    const invalidFns = [undefined, null, false, 0, '', [], {}, 1n, Symbol('fn'), hostile];
    for (const fn of invalidFns) assert.throws(() => debounceAsync(fn, 0), TypeError);
    const invalidDelays = [undefined, null, false, true, '0', [], {}, new Number(1),
      1n, Symbol('delay'), () => 0, hostile];
    for (const delay of invalidDelays) {
      assert.throws(() => debounceAsync(() => {}, delay), TypeError);
    }
    assert.throws(() => debounceAsync(() => {}), TypeError);
    for (const delay of [-1, -0.5, 0.5, NaN, Infinity, -Infinity,
      Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 2147483648]) {
      assert.throws(() => debounceAsync(() => {}, delay), RangeError);
    }
    assert.equal(coerced, 0);
  });

  it('accepts both zeros and the maximum delay and creates independent callables', async t => {
    const clock = timers(t);
    for (const delay of [0, -0, maximumDelay]) {
      const fn = value => value;
      const a = debounceAsync(fn, delay), b = debounceAsync(fn, delay);
      assert.notEqual(a, b);
      assert.equal(a.pending, false);
      assert.equal(b.pending, false);
      const first = observe(a('a')), second = observe(b('b'));
      await fulfilled(observe(a.flush()), 'a');
      assert.equal(a.pending, false);
      assert.equal(b.pending, true);
      const reason = {};
      assert.equal(b.cancel(reason), undefined);
      await fulfilled(first, 'a');
      await rejected(second, reason);
    }
    await clock.active(0);
  });

  it('coalesces through microtasks, expires naturally and preserves latest arguments and receiver', async () => {
    const entries = [], oldReceiver = {}, receiver = {}, value = {};
    const d = debounceAsync(function (...args) {
      assert.equal(d.pending, false);
      entries.push({ receiver: this, args });
      return value;
    }, 0);
    const descriptor = Object.getOwnPropertyDescriptor(d, 'pending');
    assert.equal(typeof descriptor.get, 'function');
    assert.equal(descriptor.set, undefined);
    assert.throws(() => { d.pending = true; }, TypeError);
    assert.equal(d.pending, false);
    const first = d.call(oldReceiver, 'obsolete', 'extra');
    assert.equal(d.pending, true);
    const second = d('intermediate');
    await Promise.resolve();
    assert.equal(entries.length, 0, 'zero delay still defers invocation');
    const argument = {};
    const third = d.call(receiver, argument);
    assert.equal(d.pending, true);
    assert.deepEqual(await Promise.all([first, second, third]), [value, value, value]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].receiver, receiver);
    assert.equal(entries[0].args.length, 1);
    assert.equal(entries[0].args[0], argument);
    assert.equal(d.pending, false);

    const bound = d.call(oldReceiver, 'discarded');
    const plain = d();
    await Promise.all([bound, plain]);
    assert.equal(entries.length, 2);
    assert.equal(entries[1].receiver, undefined);
    assert.deepEqual(entries[1].args, []);
  });

  it('restarts the trailing deadline when a call joins in a later timer turn', async t => {
    const events = [];
    const d = debounceAsync(value => { events.push('invoked'); return value; }, 50);
    const first = d('old');
    // This marker has the original deadline. A timer that is not restarted
    // invokes before it; a restarted timer invokes after it. No elapsed-time
    // threshold or sleep is used as evidence that a batch has completed.
    const originalDeadline = new Promise(resolve => {
      const timer = setTimeout(() => { events.push('original deadline'); resolve(); }, 50);
      t.after(() => clearTimeout(timer));
    });
    let second;
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        events.push('joined');
        second = d('latest');
        resolve();
      }, 10);
      t.after(() => clearTimeout(timer));
    });
    assert.deepEqual(await Promise.all([first, second]), ['latest', 'latest']);
    await originalDeadline;
    assert.deepEqual(events, ['joined', 'original deadline', 'invoked']);
    assert.equal(d.pending, false);
  });

  it('flushes synchronously once using the latest inputs, without reading fn.apply', async t => {
    const clock = timers(t), receiver = {}, argument = {}, result = {};
    let calls = 0;
    function fn(...args) {
      calls++;
      assert.equal(d.pending, false);
      assert.equal(this, receiver);
      assert.equal(args.length, 1);
      assert.equal(args[0], argument);
      return result;
    }
    Object.defineProperty(fn, 'apply', { get() { assert.fail('must not read fn.apply'); } });
    const d = debounceAsync(fn, maximumDelay);
    const first = d('old', 'extra'), second = d.call(receiver, argument);
    assert.equal(calls, 0);
    const flushed = d.flush();
    assert.equal(calls, 1, 'flush starts fn before returning');
    assert.equal(d.pending, false);
    assert.deepEqual(await Promise.all([first, second, flushed]), [result, result, result]);
    assert.equal(await d.flush(), undefined);
    assert.equal(await d.flush(), undefined);
    assert.equal(calls, 1);
    await clock.active(0);
  });

  it('returns an already-fulfilled idle flush even while an invocation is unresolved', async t => {
    const gate = deferred(t), started = deferred(t);
    let calls = 0;
    const d = debounceAsync(() => { calls++; started.resolve(); return gate.promise; }, 0);
    async function idleFlush() {
      const order = [];
      const result = d.flush().then(value => {
        assert.equal(value, undefined);
        order.push('flush');
      });
      queueMicrotask(() => order.push('checkpoint'));
      await result;
      assert.deepEqual(order, ['flush', 'checkpoint']);
    }
    await idleFlush();
    assert.equal(calls, 0);
    const first = observe(d());
    await started.promise;
    assert.equal(d.pending, false);
    await idleFlush();
    await idleFlush();
    assert.equal(first.status, 'pending');
    assert.equal(d.cancel('cannot cancel running work'), undefined);
    assert.equal(first.status, 'pending');
    gate.resolve('done');
    await fulfilled(first, 'done');
    assert.equal(calls, 1);
  });

  for (const path of ['expiry', 'flush']) {
    for (const kind of ['throw', 'reject', 'then getter']) {
      it(`shares exact ${kind} failures on ${path} and recovers`, async () => {
        const opaque = { get then() { assert.fail('must not assimilate a rejection reason'); } };
        const reasons = [undefined, null, false, 0, '', Symbol('reason'), {}, opaque, Promise.resolve()];
        for (const reason of reasons) {
          let recovering = false, calls = 0;
          const d = debounceAsync(() => {
            calls++;
            assert.equal(d.pending, false);
            if (recovering) return 'recovered';
            if (kind === 'throw') throw reason;
            if (kind === 'reject') return Promise.reject(reason);
            return { get then() { throw reason; } };
          }, 0);
          const states = [observe(d()), observe(d())];
          if (path === 'flush') states.push(observe(d.flush()));
          await Promise.all(states.map(state => rejected(state, reason)));
          assert.equal(d.pending, false);
          recovering = true;
          const recovery = observe(d());
          if (path === 'flush') await fulfilled(observe(d.flush()), 'recovered');
          await fulfilled(recovery, 'recovered');
          assert.equal(calls, 2);
        }
      });
    }

    it(`assimilates a stateful thenable exactly once on ${path}`, async () => {
      let assimilations = 0;
      const value = { then(resolve) { assert.equal(this, value); resolve(++assimilations); } };
      const d = debounceAsync(() => value, 0);
      const results = [d(), d()];
      if (path === 'flush') results.push(d.flush());
      assert.deepEqual(await Promise.all(results), results.map(() => 1));
      assert.equal(assimilations, 1);
    });

    it(`delivers a mutable then getter's original object without re-assimilation on ${path}`, async () => {
      let reads = 0;
      const value = { get then() {
        const n = ++reads;
        return n === 1 ? undefined : resolve => resolve(n);
      } };
      const d = debounceAsync(() => value, 0);
      const promises = [d(), d()];
      if (path === 'flush') promises.push(d.flush());
      for (const result of await Promise.all(promises)) assert.equal(result, value);
      assert.equal(reads, 1);
    });
  }

  it('adopts nested thenables once and ignores subsequent resolve, reject and throw attempts', async t => {
    const gate = deferred(t), adopted = deferred(t), result = {};
    const entries = [];
    const inner = { then(resolve, reject) {
      assert.equal(this, inner);
      entries.push('inner');
      adopted.resolve();
      resolve(gate.promise);
      reject('ignored rejection');
      resolve('ignored value');
      throw new Error('ignored throw');
    } };
    const outer = { then(resolve) {
      assert.equal(this, outer);
      entries.push('outer');
      resolve(inner);
    } };
    const d = debounceAsync(() => outer, 0);
    const states = [observe(d()), observe(d()), observe(d.flush())];
    await adopted.promise;
    assert.equal(d.pending, false);
    states.forEach(state => assert.equal(state.status, 'pending'));
    gate.resolve(result);
    await Promise.all(states.map(state => fulfilled(state, result)));
    assert.deepEqual(entries, ['outer', 'inner']);
  });

  it('preserves every explicit cancellation reason without coercion or assimilation and permits immediate reuse', async () => {
    let touched = 0;
    const opaque = {
      get then() { touched++; throw new Error('then getter'); },
      [Symbol.toPrimitive]() { touched++; throw new Error('coercion'); },
    };
    const thenable = { then() { touched++; } };
    const reasons = [undefined, null, false, 0, '', Symbol('cancel'), {}, opaque,
      thenable, Promise.resolve('promise reason')];
    const calls = [];
    const d = debounceAsync(value => { calls.push(value); return value; }, 0);
    for (const reason of reasons) {
      const first = observe(d('canceled')), second = observe(d('also canceled'));
      assert.equal(d.pending, true);
      assert.equal(d.cancel(reason), undefined);
      assert.equal(d.pending, false);
      assert.equal(d.cancel(), undefined);
      const recovery = observe(d('next'));
      assert.equal(d.pending, true);
      await Promise.all([rejected(first, reason), rejected(second, reason)]);
      await fulfilled(recovery, 'next');
      assert.equal(d.pending, false);
      assert.equal(await d.flush(), undefined);
    }
    assert.deepEqual(calls, reasons.map(() => 'next'));
    assert.equal(touched, 0);
    assert.equal(d.cancel('idle'), undefined);
  });

  it('creates one new AbortError per omitted-reason cancellation and detaches before reactions run', async () => {
    let calls = 0, previous;
    const d = debounceAsync(() => { calls++; return 'next'; }, 0);
    for (let round = 0; round < 2; round++) {
      const first = observe(d()), second = observe(d());
      assert.equal(d.cancel(), undefined);
      assert.equal(d.pending, false);
      await first.done;
      assert.equal(first.status, 'rejected');
      assert.ok(first.reason instanceof Error);
      assert.equal(first.reason.name, 'AbortError');
      assert.notEqual(first.reason, previous);
      previous = first.reason;
      await rejected(second, first.reason);
      assert.equal(d.pending, false);
      assert.equal(d.cancel(), undefined);
    }
    await fulfilled(observe(d()), 'next');
    assert.equal(calls, 1);
  });

  for (const outcome of ['fulfill', 'reject']) {
    for (const order of ['A finishes while B waits', 'B finishes before A']) {
      it(`keeps overlapping batch ownership when ${order} (${outcome})`, async t => {
        const a = deferred(t), b = deferred(t), aStarted = deferred(t), bStarted = deferred(t);
        const aReceiver = {}, bReceiver = {}, aArg = {}, bArg = {};
        const aResult = {}, bResult = {}, entries = [];
        const d = debounceAsync(function (label, arg) {
          assert.equal(d.pending, false);
          entries.push(label);
          if (label === 'C') return 'recovered';
          assert.equal(this, label === 'A' ? aReceiver : bReceiver);
          assert.equal(arg, label === 'A' ? aArg : bArg);
          (label === 'A' ? aStarted : bStarted).resolve();
          return (label === 'A' ? a : b).promise;
        }, 0);
        const aStates = [observe(d.call(aReceiver, 'A', aArg)), observe(d.call(aReceiver, 'A', aArg))];
        await aStarted.promise;
        const bStates = [observe(d.call(bReceiver, 'B', bArg)), observe(d.call(bReceiver, 'B', bArg))];
        assert.equal(d.pending, true);
        const settle = (gate, value) => outcome === 'fulfill' ? gate.resolve(value) : gate.reject(value);
        const check = outcome === 'fulfill' ? fulfilled : rejected;
        if (order === 'A finishes while B waits') {
          settle(a, aResult);
          await Promise.all(aStates.map(state => check(state, aResult)));
          assert.equal(d.pending, true);
          assert.deepEqual(entries, ['A']);
          bStates.forEach(state => assert.equal(state.status, 'pending'));
          await bStarted.promise;
          settle(b, bResult);
          await Promise.all(bStates.map(state => check(state, bResult)));
        } else {
          await bStarted.promise;
          assert.equal(d.pending, false);
          assert.equal(await d.flush(), undefined);
          settle(b, bResult);
          await Promise.all(bStates.map(state => check(state, bResult)));
          aStates.forEach(state => assert.equal(state.status, 'pending'));
          settle(a, aResult);
          await Promise.all(aStates.map(state => check(state, aResult)));
        }
        await fulfilled(observe(d('C')), 'recovered');
        assert.deepEqual(entries, ['A', 'B', 'C']);
        assert.equal(d.pending, false);
      });
    }

    it(`cancels waiting B beside running A, then preserves C across A's ${outcome}`, async t => {
      const gate = deferred(t), started = deferred(t), entries = [], reason = {}, result = {};
      const d = debounceAsync(label => {
        entries.push(label);
        if (label === 'A') { started.resolve(); return gate.promise; }
        return label;
      }, 0);
      const a = observe(d('A'));
      await started.promise;
      const b = observe(d('B')), b2 = observe(d('B'));
      d.cancel(reason);
      assert.equal(d.pending, false);
      assert.equal(a.status, 'pending');
      const c = observe(d('C'));
      if (outcome === 'fulfill') gate.resolve(result);
      else gate.reject(result);
      await (outcome === 'fulfill' ? fulfilled(a, result) : rejected(a, result));
      await Promise.all([rejected(b, reason), rejected(b2, reason)]);
      assert.equal(d.pending, true);
      assert.equal(c.status, 'pending');
      await fulfilled(c, 'C');
      assert.deepEqual(entries, ['A', 'C']);
      assert.equal(d.pending, false);
    });
  }

  it('lets a following flush start a recursively queued batch while the outer flush owns its parent', async () => {
    const entries = [];
    let child;
    const d = debounceAsync(n => {
      assert.equal(d.pending, false);
      entries.push(n);
      if (n === 0) {
        child = observe(d(1));
        assert.equal(d.pending, true);
      }
      return n;
    }, 0);
    const parent = observe(d(0)), parent2 = observe(d(0)), flushed = observe(d.flush());
    assert.deepEqual(entries, [0]);
    assert.equal(d.pending, true);
    const childFlushed = observe(d.flush());
    assert.deepEqual(entries, [0, 1]);
    assert.equal(d.pending, false);
    assert.equal(await d.flush(), undefined);
    await Promise.all([fulfilled(parent, 0), fulfilled(parent2, 0), fulfilled(flushed, 0),
      fulfilled(child, 1), fulfilled(childFlushed, 1)]);
  });

  it('allows a parent to flush its recursive child before the outer flush returns', async () => {
    const entries = [];
    let child, childFlushed;
    const d = debounceAsync(label => {
      assert.equal(d.pending, false);
      entries.push(label);
      if (label === 'parent') {
        child = observe(d('child'));
        assert.equal(d.pending, true);
        childFlushed = observe(d.flush());
        assert.equal(d.pending, false);
        assert.deepEqual(entries, ['parent', 'child']);
      }
      return label;
    }, 0);
    const parent = observe(d('parent')), flushed = observe(d.flush());
    assert.deepEqual(entries, ['parent', 'child']);
    await Promise.all([fulfilled(parent, 'parent'), fulfilled(flushed, 'parent'),
      fulfilled(child, 'child'), fulfilled(childFlushed, 'child')]);
    assert.equal(await d.flush(), undefined);
  });

  it('allows an invocation to cancel its recursive child without canceling itself', async () => {
    const entries = [], reason = {};
    let child;
    const d = debounceAsync(label => {
      assert.equal(d.pending, false);
      entries.push(label);
      if (label === 'parent') {
        child = observe(d('child'));
        assert.equal(d.pending, true);
        assert.equal(d.cancel(reason), undefined);
        assert.equal(d.pending, false);
      }
      return label;
    }, 0);
    const parent = observe(d('parent')), flushed = observe(d.flush());
    await Promise.all([fulfilled(parent, 'parent'), fulfilled(flushed, 'parent'), rejected(child, reason)]);
    await fulfilled(observe(d('next')), 'next');
    assert.deepEqual(entries, ['parent', 'next']);
  });

  it('makes a recursive flush with no new batch fulfill with undefined while its parent runs', async t => {
    const gate = deferred(t);
    let recursive;
    const d = debounceAsync(() => {
      assert.equal(d.pending, false);
      recursive = observe(d.flush());
      return gate.promise;
    }, 0);
    const parent = observe(d()), flushed = observe(d.flush());
    await fulfilled(recursive, undefined);
    assert.equal(parent.status, 'pending');
    assert.equal(flushed.status, 'pending');
    gate.resolve('parent');
    await Promise.all([fulfilled(parent, 'parent'), fulfilled(flushed, 'parent')]);
  });

  for (const boundary of ['then getter', 'then method']) {
    it(`preserves a new batch created by reentry through a ${boundary}`, async t => {
      const reentered = deferred(t), entries = [];
      let child;
      function reenter() {
        assert.equal(d.pending, false);
        child = observe(d('child'));
        assert.equal(d.pending, true);
        reentered.resolve();
      }
      const value = boundary === 'then getter'
        ? { get then() { reenter(); return resolve => resolve('parent'); } }
        : { then(resolve) { reenter(); resolve('parent'); } };
      const d = debounceAsync(label => {
        assert.equal(d.pending, false);
        entries.push(label);
        return label === 'parent' ? value : 'child';
      }, 0);
      const parent = observe(d('parent')), flushed = observe(d.flush());
      await reentered.promise;
      await Promise.all([fulfilled(parent, 'parent'), fulfilled(flushed, 'parent')]);
      assert.equal(d.pending, true);
      assert.deepEqual(entries, ['parent']);
      await fulfilled(child, 'child');
      assert.deepEqual(entries, ['parent', 'child']);
      assert.equal(d.pending, false);
    });
  }

  for (const outcome of ['fulfill', 'reject']) {
    it(`lets a recursive batch ${outcome} the parent that returns its promise through actual expiry`, async () => {
      const entries = [], result = {};
      let child;
      const d = debounceAsync(n => {
        entries.push(n);
        assert.equal(d.pending, false);
        if (n === 0) {
          const promise = d(1);
          child = observe(promise);
          return promise;
        }
        if (n === 1 && outcome === 'reject') return Promise.reject(result);
        return result;
      }, 0);
      const parent = observe(d(0)), flushed = observe(d.flush());
      assert.equal(d.pending, true);
      assert.deepEqual(entries, [0]);
      const check = outcome === 'fulfill' ? fulfilled : rejected;
      await Promise.all([parent, child, flushed].map(state => check(state, result)));
      assert.deepEqual(entries, [0, 1]);
      assert.equal(d.pending, false);
      await fulfilled(observe(d(2)), result);
      assert.deepEqual(entries, [0, 1, 2]);
    });
  }

  it('uses native self-resolution rejection for a direct return of the same batch promise', async () => {
    let promise, recovering = false;
    const d = debounceAsync(() => recovering ? 'recovered' : promise, 0);
    promise = d();
    const first = observe(promise), second = observe(d()), flushed = observe(d.flush());
    await first.done;
    assert.equal(first.status, 'rejected');
    assert.ok(first.reason instanceof TypeError);
    await Promise.all([rejected(second, first.reason), rejected(flushed, first.reason)]);
    recovering = true;
    await fulfilled(observe(d()), 'recovered');
  });

  it('clears superseded, flushed, canceled and expired timers, including while older work runs', async t => {
    const clock = timers(t), gate = deferred(t);
    const d = debounceAsync(() => gate.promise, maximumDelay);
    await clock.active(0);
    const first = observe(d()), second = observe(d()), third = observe(d());
    await clock.active(1);
    const flushed = observe(d.flush());
    assert.equal(d.pending, false);
    await clock.active(0);
    const canceled = observe(d()), reason = {};
    await clock.active(1);
    d.cancel(reason);
    await rejected(canceled, reason);
    await clock.active(0);
    gate.resolve('done');
    await Promise.all([first, second, third, flushed].map(state => fulfilled(state, 'done')));
    const expiring = debounceAsync(() => 'expired', 0);
    await fulfilled(observe(expiring()), 'expired');
    await clock.active(0);
  });
});
