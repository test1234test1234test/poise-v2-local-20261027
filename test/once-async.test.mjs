import { describe, it as nodeIt } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { onceAsync } from '../lib/once-async.mjs';

const it = (name, fn) => nodeIt(name, { timeout: 5000 }, fn);

function deferred(t) {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  t.after(() => resolve());
  return { promise, resolve, reject };
}

// Record outcomes without returning (and thus assimilating) an opaque result
// or rejection reason. Attach before deliberate rejection and await done.
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

describe('onceAsync', { concurrency: 1, timeout: 30000 }, () => {
  it('rejects omitted and non-function inputs synchronously without coercion', () => {
    let touched = 0;
    const hostile = {
      [Symbol.toPrimitive]() { touched++; throw new Error('coercion'); },
      toString() { touched++; throw new Error('coercion'); },
      valueOf() { touched++; throw new Error('coercion'); },
      get then() { touched++; throw new Error('then'); },
    };
    assert.throws(() => onceAsync(), TypeError);
    for (const fn of [undefined, null, false, true, 0, NaN, '', 'fn', 1n,
      Symbol('fn'), [], {}, /fn/, Promise.resolve(), hostile]) {
      assert.throws(() => onceAsync(fn), TypeError);
    }
    assert.equal(touched, 0);
  });

  it('constructs lazily and queues invocation between surrounding microtasks', async t => {
    const gate = deferred(t), events = [];
    let calls = 0;
    const wrapped = onceAsync(() => {
      calls++;
      events.push('fn');
      return gate.promise;
    });
    assert.equal(calls, 0);
    await Promise.resolve();
    assert.equal(calls, 0, 'construction does not queue callback work');
    queueMicrotask(() => events.push('A'));
    const promise = wrapped();
    events.push('return');
    const after = new Promise(resolve => queueMicrotask(() => {
      events.push('B');
      resolve();
    }));
    assert.equal(calls, 0, 'the first call returns before callback entry');
    const state = observe(promise);
    await after;
    assert.deepEqual(events, ['return', 'A', 'fn', 'B']);
    assert.equal(calls, 1);
    assert.equal(state.status, 'pending');
    gate.resolve('done');
    await fulfilled(state, 'done');
  });

  for (const outcome of ['fulfill', 'reject']) {
    it(`shares one promise before entry, while pending and after ${outcome}`, async t => {
      const gate = deferred(t), started = deferred(t);
      const receiver = {}, laterReceiver = {}, firstArg = { value: 'before' };
      const secondArg = {}, result = {}, entries = [];
      const wrapped = onceAsync(function (...args) {
        entries.push({ receiver: this, args, value: args[0].value });
        started.resolve();
        return gate.promise;
      });
      const first = wrapped.call(receiver, firstArg, secondArg, undefined);
      const second = wrapped.call(laterReceiver, {}, 'ignored');
      assert.equal(second, first);
      assert.notEqual(first, gate.promise, 'public promise adopts the callback promise');
      assert.equal(entries.length, 0);
      const states = [observe(first), observe(second)];
      firstArg.value = 'changed';
      await started.promise;
      const during = wrapped.call(laterReceiver, 'also ignored');
      assert.equal(during, first);
      states.push(observe(during));
      assert.equal(entries.length, 1);
      assert.equal(entries[0].receiver, receiver);
      assert.equal(entries[0].args.length, 3);
      assert.equal(entries[0].args[0], firstArg);
      assert.equal(entries[0].args[1], secondArg);
      assert.equal(entries[0].args[2], undefined);
      assert.equal(entries[0].value, 'changed', 'capture references, not snapshots');
      for (const state of states) assert.equal(state.status, 'pending');
      if (outcome === 'fulfill') gate.resolve(result);
      else gate.reject(result);
      const check = outcome === 'fulfill' ? fulfilled : rejected;
      await Promise.all(states.map(state => check(state, result)));
      const later = wrapped.call(laterReceiver, 'after settlement');
      assert.equal(later, first);
      await check(observe(later), result);
      assert.equal(entries.length, 1);
    });
  }

  it('keeps an empty first call and exact strict receivers', async () => {
    for (const receiver of [undefined, null, 0, false, 'receiver']) {
      const entries = [], result = {};
      const wrapped = onceAsync(function (...args) {
        entries.push({ receiver: this, args });
        return result;
      });
      const first = receiver === undefined ? wrapped() : wrapped.call(receiver);
      const object = { wrapped };
      assert.equal(object.wrapped('ignored', {}), first);
      await fulfilled(observe(first), result);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].receiver, receiver);
      assert.deepEqual(entries[0].args, []);
    }
  });

  it('invokes functions without reading their own apply or then properties', async () => {
    for (const kind of ['undefined apply', 'throwing apply', 'null prototype']) {
      const receiver = {}, argument = {}, result = {}, entries = [];
      let touched = 0;
      function fn(...args) {
        entries.push({ receiver: this, args });
        return result;
      }
      if (kind === 'undefined apply') fn.apply = undefined;
      if (kind === 'throwing apply') {
        Object.defineProperty(fn, 'apply', {
          get() { touched++; throw new Error('apply'); },
        });
      }
      if (kind === 'null prototype') Object.setPrototypeOf(fn, null);
      Object.defineProperty(fn, 'then', {
        get() { touched++; throw new Error('then'); },
      });
      const wrapped = onceAsync(fn);
      const first = wrapped.call(receiver, argument);
      assert.equal(wrapped(), first);
      await fulfilled(observe(first), result);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].receiver, receiver);
      assert.equal(entries[0].args.length, 1);
      assert.equal(entries[0].args[0], argument);
      assert.equal(touched, 0);
    }
  });

  it('respects async, bound, arrow and cross-realm function semantics', async () => {
    const receiver = {}, ignored = {}, argument = {}, boundArg = {};
    const functions = [
      { fn: async function (...args) { return { receiver: this, args }; }, receiver, args: [argument] },
      { fn: function (...args) { return { receiver: this, args }; }.bind(ignored, boundArg),
        receiver: ignored, args: [boundArg, argument] },
      { fn: (...args) => ({ receiver: this, args }), receiver: undefined, args: [argument] },
      { fn: runInNewContext('"use strict"; (function (...args) { return { receiver: this, args }; })'),
        receiver, args: [argument] },
    ];
    for (const entry of functions) {
      const wrapped = onceAsync(entry.fn);
      const first = wrapped.call(receiver, argument);
      assert.equal(wrapped.call(ignored, 'ignored'), first);
      const result = await first;
      assert.equal(result.receiver, entry.receiver);
      assert.equal(result.args.length, entry.args.length);
      entry.args.forEach((arg, index) => assert.equal(result.args[index], arg));
      assert.equal(wrapped(), first);
    }
  });

  it('permanently preserves ordinary fulfillment identities and falsy values', async () => {
    for (const value of [{}, function result() {}, undefined, null, false, 0, -0,
      '', NaN, Symbol('value')]) {
      let calls = 0;
      const wrapped = onceAsync(() => { calls++; return value; });
      const first = wrapped('first');
      assert.equal(wrapped('second'), first);
      await fulfilled(observe(first), value);
      assert.equal(wrapped('later'), first);
      await fulfilled(observe(first), value);
      assert.equal(calls, 1);
    }
  });

  for (const kind of ['synchronous throw', 'rejected promise', 'throwing then getter']) {
    it(`permanently preserves exact opaque reasons from a ${kind}`, async () => {
      let touched = 0;
      const opaque = { get then() { touched++; throw new Error('opaque then'); } };
      const thenable = { then() { touched++; } };
      const reasons = [new Error('failure'), {}, Symbol('reason'), undefined, null,
        false, 0, '', opaque, thenable, Promise.resolve('reason')];
      for (const reason of reasons) {
        let calls = 0;
        const wrapped = onceAsync(() => {
          calls++;
          if (kind === 'synchronous throw') throw reason;
          if (kind === 'rejected promise') return Promise.reject(reason);
          return { get then() { throw reason; } };
        });
        let first;
        assert.doesNotThrow(() => { first = wrapped('first'); });
        const states = [observe(first), observe(wrapped('second'))];
        assert.equal(wrapped(), first);
        await Promise.all(states.map(state => rejected(state, reason)));
        const later = wrapped('later');
        assert.equal(later, first);
        await rejected(observe(later), reason);
        assert.equal(calls, 1);
      }
      assert.equal(touched, 0, 'reasons must not be assimilated');
    });
  }

  it('adopts a stateful thenable once for all callers', async () => {
    let calls = 0, adoptions = 0, receiver;
    const value = { then(resolve) {
      receiver = this;
      resolve(++adoptions);
    } };
    const wrapped = onceAsync(() => { calls++; return value; });
    const first = wrapped();
    assert.equal(wrapped(), first);
    const states = [observe(first), observe(wrapped())];
    await Promise.all(states.map(state => fulfilled(state, 1)));
    assert.equal(wrapped(), first);
    await fulfilled(observe(wrapped()), 1);
    assert.equal(receiver, value);
    assert.equal(adoptions, 1);
    assert.equal(calls, 1);
  });

  it('does not re-assimilate a directly returned object with a changing then getter', async () => {
    let reads = 0, calls = 0;
    const value = { get then() {
      reads++;
      return reads === 1 ? undefined : resolve => resolve('changed');
    } };
    const wrapped = onceAsync(() => { calls++; return value; });
    const first = wrapped();
    assert.equal(wrapped(), first);
    await fulfilled(observe(first), value);
    assert.equal(wrapped(), first);
    await fulfilled(observe(wrapped()), value);
    assert.equal(reads, 1);
    assert.equal(calls, 1);
  });

  it('adopts nested and function thenables and honors only the first settlement', async t => {
    const gate = deferred(t), adopted = deferred(t), result = {}, entries = [];
    let calls = 0;
    const inner = function () {};
    inner.then = function (resolve, reject) {
      entries.push(this);
      resolve(gate.promise);
      adopted.resolve();
      reject('ignored rejection');
      resolve('ignored value');
      throw new Error('ignored throw');
    };
    const outer = { then(resolve) { entries.push(this); resolve(inner); } };
    const wrapped = onceAsync(() => { calls++; return outer; });
    const first = wrapped();
    assert.equal(wrapped(), first);
    const state = observe(first);
    await adopted.promise;
    assert.equal(state.status, 'pending');
    assert.equal(wrapped(), first);
    gate.resolve(result);
    await fulfilled(state, result);
    assert.equal(wrapped(), first);
    assert.deepEqual(entries, [outer, inner]);
    assert.equal(calls, 1);
  });

  for (const boundary of ['callback', 'then getter', 'then method']) {
    it(`exposes the original promise on reentry through the ${boundary}`, async () => {
      const receiver = {}, argument = {}, result = {}, entries = [], reentries = [];
      const reenter = () => { reentries.push(wrapped.call({}, 'recursive')); };
      const value = boundary === 'then getter'
        ? { get then() { reenter(); return resolve => resolve(result); } }
        : { then(resolve) { reenter(); resolve(result); } };
      const wrapped = onceAsync(function (...args) {
        entries.push({ receiver: this, args });
        // Keep a broken implementation from recursing indefinitely.
        if (entries.length > 1) return result;
        if (boundary === 'callback') { reenter(); return result; }
        return value;
      });
      const first = wrapped.call(receiver, argument);
      await fulfilled(observe(first), result);
      assert.equal(reentries.length, 1);
      assert.equal(reentries[0], first);
      assert.equal(wrapped('later'), first);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].receiver, receiver);
      assert.equal(entries[0].args.length, 1);
      assert.equal(entries[0].args[0], argument);
    });
  }

  it('permanently rejects direct self-return with the same native TypeError', async () => {
    let calls = 0;
    const wrapped = onceAsync(() => { calls++; return wrapped(); });
    const first = wrapped();
    const state = observe(first), other = observe(wrapped());
    assert.equal(wrapped(), first);
    await state.done;
    assert.equal(state.status, 'rejected');
    assert.ok(state.reason instanceof TypeError);
    await rejected(other, state.reason);
    assert.equal(wrapped(), first);
    await rejected(observe(wrapped()), state.reason);
    assert.equal(calls, 1);
  });

  for (const kind of ['throw', 'thenable rejection', 'then getter throw']) {
    it(`preserves the shared promise as an opaque reason from a ${kind}`, async () => {
      let calls = 0;
      const wrapped = onceAsync(() => {
        calls++;
        if (kind === 'throw') throw wrapped();
        if (kind === 'then getter throw') return { get then() { throw wrapped(); } };
        return { then(resolve, reject) { reject(wrapped()); } };
      });
      const first = wrapped();
      assert.equal(wrapped(), first);
      await rejected(observe(first), first);
      assert.equal(wrapped(), first);
      await rejected(observe(wrapped()), first);
      assert.equal(calls, 1);
    });
  }

  it('keeps wrappers around the same callback independent', async () => {
    const entries = [], leftReceiver = {}, rightReceiver = {}, leftArg = {}, rightArg = {};
    function fn(...args) {
      entries.push({ receiver: this, args });
      return args[0];
    }
    const left = onceAsync(fn), right = onceAsync(fn);
    assert.notEqual(left, right);
    const first = left.call(leftReceiver, leftArg), second = right.call(rightReceiver, rightArg);
    assert.notEqual(first, second);
    assert.equal(left('ignored'), first);
    assert.equal(right('ignored'), second);
    await Promise.all([fulfilled(observe(first), leftArg), fulfilled(observe(second), rightArg)]);
    assert.equal(left(), first);
    assert.equal(right(), second);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].receiver, leftReceiver);
    assert.equal(entries[1].receiver, rightReceiver);
    assert.equal(entries[0].args.length, 1);
    assert.equal(entries[1].args.length, 1);
    assert.equal(entries[0].args[0], leftArg);
    assert.equal(entries[1].args[0], rightArg);
  });

  for (const outcome of ['fulfill', 'reject']) {
    it(`isolates consumer transformations from the cached ${outcome} outcome`, async () => {
      const original = {}, transformed = {};
      let calls = 0, observed;
      const wrapped = onceAsync(() => {
        calls++;
        if (outcome === 'reject') throw original;
        return original;
      });
      const first = wrapped();
      const state = observe(first);
      const transform = value => { observed = value; return transformed; };
      const derived = outcome === 'fulfill' ? first.then(transform) : first.catch(transform);
      assert.notEqual(derived, first);
      await fulfilled(observe(derived), transformed);
      assert.equal(observed, original);
      assert.equal(wrapped('later'), first);
      const check = outcome === 'fulfill' ? fulfilled : rejected;
      await check(state, original);
      await check(observe(wrapped()), original);
      assert.equal(calls, 1);
    });
  }
});
