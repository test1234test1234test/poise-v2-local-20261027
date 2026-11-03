import { afterEach, describe, it as nodeIt } from 'node:test';
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { getEventListeners } from 'node:events';
import { retryAsync } from '../lib/retry-async.mjs';

const it = (name, fn) => nodeIt(name, { timeout: 5000 }, fn);
const checkpoint = () => new Promise(resolve => setImmediate(resolve));
const listeners = signal => getEventListeners(signal, 'abort');

function deferred(t) {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  t.after(() => resolve());
  return { promise, resolve, reject };
}

// Observe only public promises, so missing consumption of a late callback
// rejection cannot be hidden by an independent handler on its raw result.
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

async function rejectsType(call, type) {
  let promise;
  assert.doesNotThrow(() => { promise = call(); });
  const state = observe(promise);
  await state.done;
  assert.equal(state.status, 'rejected');
  assert.ok(state.reason instanceof type);
}

function sleep(t, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    t.after(() => clearTimeout(timer));
  });
}

// Observe real timer creation/destruction, not just the retry promise. Enable
// inside a test, after its timeout has been installed. Cleanup also clears any
// leaked long delay on failure, so a regression cannot hold the process open.
function timers(t, callbacks = {}) {
  const created = new Map(), destroyed = new Set(), started = deferred(t);
  const hook = createHook({
    init(id, type, trigger, resource) {
      if (type === 'Timeout') {
        created.set(id, resource);
        started.resolve();
      }
    },
    before(id) { if (created.has(id)) callbacks.before?.(); },
    after(id) { if (created.has(id)) callbacks.after?.(); },
    destroy(id) { if (created.has(id)) destroyed.add(id); },
  });
  t.after(() => {
    hook.disable();
    for (const timer of created.values()) clearTimeout(timer);
  });
  hook.enable();
  return {
    created,
    started: started.promise,
    async clean() {
      await checkpoint();
      await checkpoint();
      assert.deepEqual([...created.keys()].filter(id => !destroyed.has(id)), [], 'owned timers destroyed');
    },
  };
}

let forbiddenCalls = 0;
const never = () => { forbiddenCalls++; };

describe('retryAsync', { concurrency: 1, timeout: 30000 }, () => {
  afterEach(async () => {
    await checkpoint();
    const calls = forbiddenCalls;
    forbiddenCalls = 0;
    assert.equal(calls, 0, 'forbidden callbacks must not run, even if their outcome would be masked');
  });

  it('returns the first success, including falsy values, without a hook or delay', async t => {
    const clock = timers(t);
    for (const value of [undefined, null, false, 0, '', Symbol('value'), { value: 1 }]) {
      for (const wrap of [value => value, value => Promise.resolve(value)]) {
        let calls = 0;
        await fulfilled(observe(retryAsync(() => { calls++; return wrap(value); }, {
          delayMs: 2147483647, shouldRetry: never,
        })), value);
        assert.equal(calls, 1);
      }
    }
    assert.equal(clock.created.size, 0);
  });

  it('enters operation one synchronously and supplies plain callback receivers and exact arguments', async () => {
    const entries = [], failure = {};
    const pending = retryAsync(function (...args) {
      entries.push({ kind: 'operation', receiver: this, args });
      if (args[0] === 1) throw failure;
      return 'ok';
    }, { shouldRetry: function (...args) {
      entries.push({ kind: 'hook', receiver: this, args });
      return true;
    } });
    assert.equal(entries[0].kind, 'operation');
    assert.equal(await pending, 'ok');
    assert.deepEqual(entries, [
      { kind: 'operation', receiver: undefined, args: [1] },
      { kind: 'hook', receiver: undefined, args: [failure, 1] },
      { kind: 'operation', receiver: undefined, args: [2] },
    ]);
  });

  for (const attempts of [undefined, 1, 1000]) {
    for (const withHook of [false, true]) {
      it(`exhausts ${attempts ?? 'default'} attempts with hook=${withHook} and preserves the final error`, async t => {
        const clock = timers(t), operations = [], decisions = [], errors = [];
        const options = attempts === undefined ? {} : { attempts };
        if (withHook) options.shouldRetry = (error, attempt) => {
          decisions.push(attempt);
          assert.equal(error, errors[attempt - 1]);
          return Promise.resolve(true);
        };
        const state = observe(retryAsync(attempt => {
          operations.push(attempt);
          const error = { attempt };
          errors.push(error);
          if (attempt % 2) throw error;
          return Promise.reject(error);
        }, options));
        await state.done;
        const count = attempts ?? 3;
        await rejected(state, errors[count - 1]);
        assert.deepEqual(operations, Array.from({ length: count }, (_, index) => index + 1));
        assert.deepEqual(decisions, withHook ? operations.slice(0, -1) : []);
        assert.equal(clock.created.size, 0, 'zero delay skips timers');
      });
    }
  }

  for (const withHook of [false, true]) {
    it(`recovers after an earlier rejection with hook=${withHook}`, async () => {
      const failure = {}, value = {}, operations = [], decisions = [];
      await fulfilled(observe(retryAsync(attempt => {
        operations.push(attempt);
        return attempt === 1 ? Promise.reject(failure) : value;
      }, withHook ? { shouldRetry(error, attempt) {
        decisions.push([error, attempt]);
        return { then(resolve) { resolve(true); } };
      } } : undefined)), value);
      assert.deepEqual(operations, [1, 2]);
      assert.deepEqual(decisions, withHook ? [[failure, 1]] : []);
    });
  }

  for (const wrap of [value => value, value => Promise.resolve(value), value => ({ then(resolve) { resolve(value); } })]) {
    it('awaits hook false and preserves the current operation failure', async t => {
      const clock = timers(t), error = {};
      let operations = 0, decisions = 0;
      await rejected(observe(retryAsync(() => { operations++; throw error; }, {
        delayMs: 2147483647,
        shouldRetry: () => { decisions++; return wrap(false); },
      })), error);
      assert.deepEqual([operations, decisions, clock.created.size], [1, 1, 0]);
    });
  }

  const invalidDecisions = [undefined, null, 0, 1, '', 'true', {}, [], new Boolean(true), 1n, Symbol('decision')];
  for (const [index, decision] of invalidDecisions.entries()) {
    it(`rejects nonboolean hook result ${index} without retrying it`, async t => {
      const clock = timers(t);
      let operations = 0, decisions = 0;
      await rejectsType(() => retryAsync(() => { operations++; throw {}; }, {
        delayMs: 2147483647,
        shouldRetry: () => { decisions++; return Promise.resolve(decision); },
      }), TypeError);
      assert.deepEqual([operations, decisions, clock.created.size], [1, 1, 0]);
    });
  }

  it('keeps arbitrary operation/hook/getter rejection reasons opaque and exact', async t => {
    const clock = timers(t);
    let thenReads = 0;
    const opaque = { get then() { thenReads++; throw new Error('must not assimilate a reason'); } };
    const reasons = [undefined, null, false, 0, '', Symbol('reason'), {}, opaque, Promise.resolve('reason')];
    for (const failure of reasons) {
      for (const fail of [() => { throw failure; }, () => Promise.reject(failure)]) {
        let calls = 0;
        await rejected(observe(retryAsync(() => { calls++; return fail(); }, { attempts: 2 })), failure);
        assert.equal(calls, 2);
        await rejected(observe(retryAsync(fail, { shouldRetry: () => false })), failure);
        calls = 0;
        await rejected(observe(retryAsync(() => { calls++; throw 'operation'; }, {
          delayMs: 2147483647, shouldRetry: fail,
        })), failure);
        assert.equal(calls, 1);
      }
      await rejected(observe(retryAsync(never, { get attempts() { throw failure; } })), failure);
    }
    assert.equal(thenReads, 0);
    assert.equal(clock.created.size, 0);
  });

  it('retries AbortError-shaped failures when the supplied signal has not aborted', async () => {
    for (const signal of [undefined, new AbortController().signal]) {
      const failure = Object.assign(new Error('operation failed'), { name: 'AbortError', code: 'ABORT_ERR' });
      let calls = 0;
      assert.equal(await retryAsync(() => { if (++calls === 1) throw failure; return 'recovered'; }, { signal }), 'recovered');
      assert.equal(calls, 2);
      assert.equal(signal?.aborted, signal ? false : undefined);
    }
  });

  it('fully adopts nested thenables with their own receiver and ignores repeated resolutions', async t => {
    const gate = deferred(t), adopted = deferred(t), value = {}, receivers = [];
    let calls = 0;
    const inner = { then(resolve, reject) {
      receivers.push(this);
      adopted.resolve();
      resolve(gate.promise);
      reject('ignored rejection');
      resolve('ignored success');
      throw new Error('ignored throw after resolve');
    } };
    const outer = { then(resolve) { receivers.push(this); resolve(inner); } };
    const state = observe(retryAsync(() => { calls++; return outer; }, { shouldRetry: never }));
    await adopted.promise;
    await checkpoint();
    assert.equal(state.status, 'pending');
    assert.equal(calls, 1);
    gate.resolve(value);
    await fulfilled(state, value);
    assert.deepEqual(receivers, [outer, inner]);
  });

  it('treats a throwing operation then getter as a failure and a throwing hook then getter as terminal', async () => {
    const failure = {}, calls = [];
    const broken = { get then() { throw failure; } };
    assert.equal(await retryAsync(attempt => { calls.push(attempt); return attempt === 1 ? broken : 'ok'; }), 'ok');
    assert.deepEqual(calls, [1, 2]);
    calls.length = 0;
    await rejected(observe(retryAsync(attempt => { calls.push(attempt); throw 'operation'; }, {
      shouldRetry: () => broken,
    })), failure);
    assert.deepEqual(calls, [1]);
  });

  it('serializes operations, the awaited decision and the next attempt without overlap', async t => {
    const operationGate = deferred(t), hookGate = deferred(t), hookStarted = deferred(t);
    const entries = [];
    let active = 0, maximum = 0;
    const enter = name => { entries.push(name); maximum = Math.max(maximum, ++active); };
    const leave = name => { entries.push(name); active--; };
    const state = observe(retryAsync(async attempt => {
      enter(`operation ${attempt}`);
      try {
        if (attempt === 1) { await operationGate.promise; throw 'failure'; }
        return 'ok';
      } finally { leave(`end ${attempt}`); }
    }, { shouldRetry: async () => {
      enter('hook');
      hookStarted.resolve();
      try { return await hookGate.promise; }
      finally { leave('end hook'); }
    } }));
    await checkpoint();
    assert.deepEqual(entries, ['operation 1']);
    operationGate.resolve();
    await hookStarted.promise;
    await checkpoint();
    assert.deepEqual(entries, ['operation 1', 'end 1', 'hook']);
    assert.equal(state.status, 'pending');
    hookGate.resolve(true);
    await fulfilled(state, 'ok');
    assert.deepEqual(entries, ['operation 1', 'end 1', 'hook', 'end hook', 'operation 2', 'end 2']);
    assert.deepEqual([active, maximum], [0, 1]);
  });

  it('validates operation/options/limits/hook before callbacks, pre-abort or owned resources', async t => {
    const controller = new AbortController(), external = () => {};
    controller.signal.addEventListener('abort', external);
    controller.abort('pre-abort');
    const signal = controller.signal, clock = timers(t);
    for (const operation of [undefined, null, true, 1, 'function', {}, [], Promise.resolve()]) {
      await rejectsType(() => retryAsync(operation, { signal }), TypeError);
    }
    for (const options of [null, [], true, 1, 1n, 'options', Symbol(), () => {}]) {
      await rejectsType(() => retryAsync(never, options), TypeError);
    }
    let coercions = 0;
    const coercible = { [Symbol.toPrimitive]() { coercions++; return 1; }, valueOf() { coercions++; return 1; } };
    const nonnumbers = [undefined, null, true, '1', 1n, Symbol(), {}, [], new Number(1), coercible, () => 1];
    for (const name of ['attempts', 'delayMs']) {
      for (const value of nonnumbers) {
        await rejectsType(() => retryAsync(never, { [name]: value, signal }), TypeError);
      }
      const invalidNumbers = name === 'attempts'
        ? [-0, 0, -1, 0.5, 1.5, 1000.5, 1001, NaN, Infinity, -Infinity]
        : [-1, -0.5, 0.5, 2147483646.5, 2147483648, NaN, Infinity, -Infinity];
      for (const value of invalidNumbers) {
        await rejectsType(() => retryAsync(never, { [name]: value, signal }), RangeError);
      }
    }
    for (const shouldRetry of [null, false, 0, 'hook', {}, [], Promise.resolve(true)]) {
      await rejectsType(() => retryAsync(never, { attempts: 1, shouldRetry, signal }), TypeError);
    }
    for (const name of ['attempts', 'delayMs', 'shouldRetry', 'signal']) {
      const failure = { name };
      let reads = 0;
      const options = { signal };
      Object.defineProperty(options, name, { get() { reads++; throw failure; } });
      await rejected(observe(retryAsync(never, options)), failure);
      assert.equal(reads, 1);
    }
    assert.equal(coercions, 0);
    assert.equal(clock.created.size, 0);
    assert.deepEqual(listeners(signal), [external]);
  });

  it('accepts boundary limits and ordinary, frozen, inherited and null-prototype options', async () => {
    for (const options of [undefined, {}, { shouldRetry: undefined, signal: undefined },
      Object.freeze({ attempts: 1 }), Object.assign(Object.create(null), { attempts: 1000 }),
      Object.create({ attempts: 1, delayMs: -0 }),
      { extra: true, [Symbol()]: false, get unrelated() { forbiddenCalls++; } }]) {
      assert.equal(await retryAsync(() => 'ok', options), 'ok');
    }
    for (const delayMs of [0, -0, 1, 2147483646, 2147483647]) {
      assert.equal(await retryAsync(() => 'ok', { delayMs }), 'ok');
    }
    await rejectsType(() => retryAsync(never, Object.create({ attempts: undefined })), TypeError);
    await rejectsType(() => retryAsync(never, Object.create({ delayMs: undefined })), TypeError);
  });

  it('snapshots each supported inherited getter once before callbacks mutate every option', async t => {
    const controller = new AbortController(), replacement = new AbortController();
    const external = () => {};
    controller.signal.addEventListener('abort', external);
    const values = { attempts: 2, delayMs: 1, shouldRetry: () => true, signal: controller.signal };
    const reads = {}, prototype = {};
    for (const name of Object.keys(values)) {
      Object.defineProperty(prototype, name, { get() { reads[name] = (reads[name] ?? 0) + 1; return values[name]; } });
    }
    const clock = timers(t), errors = [], options = Object.create(prototype);
    const state = observe(retryAsync(attempt => {
      values.attempts = 1001;
      values.delayMs = 2147483647;
      values.shouldRetry = never;
      values.signal = replacement.signal;
      replacement.abort('must not affect snapshot');
      const failure = { attempt };
      errors.push(failure);
      throw failure;
    }, options));
    await state.done;
    assert.equal(errors.length, 2);
    await rejected(state, errors[1]);
    assert.deepEqual(reads, { attempts: 1, delayMs: 1, shouldRetry: 1, signal: 1 });
    assert.equal(clock.created.size, 1);
    await clock.clean();
    assert.deepEqual(listeners(controller.signal), [external]);
    assert.deepEqual(listeners(replacement.signal), []);
    assert.equal(controller.signal.aborted, false);
  });

  it('validates native signal identity, accepting factories and rejecting wrappers/proxies', async () => {
    const signal = new AbortController().signal;
    const revoked = Proxy.revocable(signal, {});
    revoked.revoke();
    const invalid = [null, false, 0, '', 1n, Symbol(), {}, [], () => {},
      { aborted: false, reason: undefined, addEventListener() {}, removeEventListener() {} },
      AbortSignal.prototype, Object.create(AbortSignal.prototype), Object.create(signal),
      new Proxy(signal, {}), revoked.proxy];
    for (const signal of invalid) await rejectsType(() => retryAsync(never, { signal }), TypeError);
    // This checks the exact-prototype boundary, not a fabricated foreign realm.
    const altered = new AbortController().signal;
    Object.setPrototypeOf(altered, Object.create(AbortSignal.prototype));
    await rejectsType(() => retryAsync(never, { signal: altered }), TypeError);
    for (const native of [signal, AbortSignal.any([signal])]) {
      assert.equal(await retryAsync(() => 'ok', { signal: native }), 'ok');
      assert.equal(native.aborted, false);
      assert.deepEqual(listeners(native), []);
    }
    const pre = AbortSignal.abort('pre');
    await rejected(observe(retryAsync(never, { signal: pre, shouldRetry: never })), pre.reason);
  });

  const abortReasons = [undefined, null, false, 0, '', Symbol('abort'), { abort: true }];
  for (const [index, abortReason] of abortReasons.entries()) {
    it(`preserves exact pre-abort and delay-abort reason ${index}, clearing the maximum timer`, async t => {
      const pre = AbortSignal.abort(abortReason);
      await rejected(observe(retryAsync(never, { signal: pre, shouldRetry: never })), pre.reason);
      const controller = new AbortController(), external = event => event.stopImmediatePropagation();
      controller.signal.addEventListener('abort', external);
      const externalTimer = sleep(t, 10), clock = timers(t);
      let operations = 0;
      const state = observe(retryAsync(() => { operations++; throw 'retry'; }, {
        signal: controller.signal, delayMs: 2147483647,
      }));
      await clock.started;
      assert.equal(clock.created.size, 1);
      assert.equal(listeners(controller.signal).length, 2);
      controller.abort(abortReason);
      await rejected(state, controller.signal.reason);
      assert.equal(operations, 1);
      assert.deepEqual(listeners(controller.signal), [external]);
      await externalTimer;
      await clock.clean();
    });
  }

  for (const phase of ['operation', 'hook']) {
    const outcomes = phase === 'operation' ? ['fulfill', 'reject'] : ['true', 'false', 'invalid', 'reject'];
    for (const outcome of outcomes) {
      it(`drains an active ${phase} that will ${outcome}, then rejects with abort`, async t => {
        const controller = new AbortController(), gate = deferred(t), started = deferred(t);
        const external = event => event.stopImmediatePropagation();
        controller.signal.addEventListener('abort', external);
        const clock = timers(t), calls = [];
        const held = () => { started.resolve(); return gate.promise; };
        const state = observe(retryAsync(attempt => {
          calls.push(`operation ${attempt}`);
          if (phase === 'operation') return held();
          throw 'operation failure';
        }, { signal: controller.signal, attempts: phase === 'operation' ? 1 : 3,
          shouldRetry: () => { calls.push('hook'); return held(); },
        }));
        await started.promise;
        controller.abort({ abort: phase });
        await checkpoint();
        assert.equal(state.status, 'pending');
        assert.deepEqual(calls, phase === 'operation' ? ['operation 1'] : ['operation 1', 'hook']);
        if (outcome === 'reject') gate.reject('late rejection');
        else gate.resolve(outcome === 'true' ? true : outcome === 'false' ? false : { outcome });
        await rejected(state, controller.signal.reason);
        assert.deepEqual(calls, phase === 'operation' ? ['operation 1'] : ['operation 1', 'hook']);
        assert.deepEqual(listeners(controller.signal), [external]);
        assert.equal(clock.created.size, 0);
      });
    }

    for (const outcome of ['return', 'throw']) {
      it(`honors synchronous abort-and-${outcome} inside the ${phase}`, async () => {
        const controller = new AbortController(), calls = [];
        const act = () => {
          controller.abort({ aborted: true });
          if (outcome === 'throw') throw 'callback failure';
          return phase === 'hook' ? true : 'value';
        };
        const state = observe(retryAsync(() => {
          calls.push('operation');
          if (phase === 'operation') return act();
          throw 'operation failure';
        }, { signal: controller.signal, shouldRetry: () => { calls.push('hook'); return act(); } }));
        await rejected(state, controller.signal.reason);
        assert.deepEqual(calls, phase === 'operation' ? ['operation'] : ['operation', 'hook']);
      });
    }

    for (const outcome of ['resolve', 'reject']) {
      it(`gives abort precedence over same-turn ${phase} ${outcome} before its continuation`, async t => {
        const controller = new AbortController(), gate = deferred(t), started = deferred(t), calls = [];
        const held = () => { started.resolve(); return gate.promise; };
        const state = observe(retryAsync(attempt => {
          calls.push(attempt);
          if (phase === 'operation') return held();
          throw 'failure';
        }, { signal: controller.signal, attempts: phase === 'operation' ? 1 : 3,
          shouldRetry: () => { calls.push('hook'); return held(); },
        }));
        await started.promise;
        gate[outcome](phase === 'hook' ? true : 'value');
        controller.abort('same turn');
        await rejected(state, 'same turn');
        assert.deepEqual(calls, phase === 'operation' ? [1] : [1, 'hook']);
      });
    }

    it(`drains nested thenable adoption during ${phase} abort`, async t => {
      const controller = new AbortController(), gate = deferred(t), adopted = deferred(t);
      let operations = 0, hooks = 0;
      const held = () => ({ then(resolve) {
        resolve({ then(resolveInner) {
          resolveInner(gate.promise);
          controller.abort('during adoption');
          adopted.resolve();
        } });
      } });
      const state = observe(retryAsync(() => {
        operations++;
        if (phase === 'operation') return held();
        throw 'failure';
      }, { signal: controller.signal, shouldRetry: () => { hooks++; return held(); } }));
      await adopted.promise;
      await checkpoint();
      assert.equal(state.status, 'pending');
      gate.reject('nested late rejection');
      await rejected(state, 'during adoption');
      assert.deepEqual([operations, hooks], [1, phase === 'hook' ? 1 : 0]);
    });

    for (const abort of [false, true]) {
      for (const outcome of ['return', 'throw']) {
        it(`retains ${phase} ownership through async finally: ${outcome}, abort=${abort}`, async t => {
          const controller = new AbortController(), cleanup = deferred(t), cleaning = deferred(t);
          const calls = [], failure = {};
          const work = async () => {
            try {
              if (outcome === 'throw') throw failure;
              return phase === 'hook' ? false : 'value';
            } finally { cleaning.resolve(); await cleanup.promise; calls.push('cleaned'); }
          };
          const state = observe(retryAsync(() => {
            calls.push('operation');
            if (phase === 'operation') return work();
            throw failure;
          }, { signal: controller.signal, attempts: phase === 'operation' ? 1 : 3,
            shouldRetry: () => { calls.push('hook'); return work(); },
          }));
          await cleaning.promise;
          if (abort) controller.abort('cleanup abort');
          await checkpoint();
          assert.equal(state.status, 'pending');
          assert.deepEqual(calls, phase === 'operation' ? ['operation'] : ['operation', 'hook']);
          cleanup.resolve();
          if (abort) await rejected(state, 'cleanup abort');
          else if (phase === 'hook' || outcome === 'throw') await rejected(state, failure);
          else await fulfilled(state, 'value');
          assert.deepEqual(calls, phase === 'operation' ? ['operation', 'cleaned'] : ['operation', 'hook', 'cleaned']);
        });
      }
    }
  }

  it('commits success before a later abort even when the caller reaction has not run', async t => {
    const controller = new AbortController(), gate = deferred(t);
    const state = observe(retryAsync(() => gate.promise, { signal: controller.signal, shouldRetry: never }));
    gate.resolve('committed');
    let statusAtAbort;
    queueMicrotask(() => { statusAtAbort = state.status; controller.abort('too late'); });
    await fulfilled(state, 'committed');
    assert.equal(statusAtAbort, 'pending', 'caller reaction was still queued when abort ran');
    await checkpoint();
    assert.deepEqual(listeners(controller.signal), []);
  });

  it('starts a positive retry delay only after the pending hook approves', async t => {
    const elapsed = sleep(t, 20), clock = timers(t), gate = deferred(t), started = deferred(t);
    const calls = [];
    const state = observe(retryAsync(attempt => {
      calls.push(attempt);
      if (attempt === 1) throw 'failure';
      return 'ok';
    }, { delayMs: 10, shouldRetry: () => { started.resolve(); return gate.promise; } }));
    await started.promise;
    await elapsed;
    assert.equal(clock.created.size, 0, 'no timer while hook is pending');
    assert.deepEqual(calls, [1]);
    gate.resolve(true);
    await clock.started;
    assert.equal(state.status, 'pending');
    assert.deepEqual(calls, [1]);
    await fulfilled(state, 'ok');
    assert.deepEqual(calls, [1, 2]);
    assert.equal(clock.created.size, 1, 'no initial or terminal delay');
    await clock.clean();
  });

  it('checks abort after the real delay fires and before the next attempt enters', async t => {
    const controller = new AbortController();
    let timerEnds = 0, calls = 0;
    const clock = timers(t, { after() { timerEnds++; controller.abort('handoff'); } });
    const state = observe(retryAsync(() => { calls++; throw 'failure'; }, { signal: controller.signal, delayMs: 1 }));
    await rejected(state, 'handoff');
    assert.deepEqual([calls, timerEnds], [1, 1]);
    await clock.clean();
    assert.deepEqual(listeners(controller.signal), []);
  });

  for (const phase of ['operation', 'hook', 'delay']) {
    for (const timing of ['immediate', 'after rearm']) {
      it(`ignores synthetic events during ${phase} and observes real abort ${timing}`, async t => {
        const controller = new AbortController(), gate = deferred(t), started = deferred(t);
        const external = event => event.stopImmediatePropagation();
        controller.signal.addEventListener('abort', external);
        const clock = timers(t), calls = [];
        const held = () => { started.resolve(); return gate.promise; };
        const state = observe(retryAsync(() => {
          calls.push('operation');
          if (phase === 'operation') return held();
          throw 'failure';
        }, { signal: controller.signal, delayMs: 2147483647,
          shouldRetry: phase === 'hook' ? () => { calls.push('hook'); return held(); } : undefined,
        }));
        if (phase === 'delay') await clock.started;
        else await started.promise;
        controller.signal.dispatchEvent(new Event('abort'));
        assert.equal(controller.signal.aborted, false);
        if (timing === 'after rearm') {
          await checkpoint();
          assert.equal(state.status, 'pending');
          assert.equal(listeners(controller.signal).length, phase === 'delay' ? 2 : 1);
          controller.signal.dispatchEvent(new Event('abort'));
          await checkpoint();
        }
        controller.abort('real abort');
        if (phase !== 'delay') {
          await checkpoint();
          assert.equal(state.status, 'pending');
          gate.reject('late rejection');
        }
        await rejected(state, 'real abort');
        assert.deepEqual(calls, phase === 'hook' ? ['operation', 'hook'] : ['operation']);
        await clock.clean();
        assert.deepEqual(listeners(controller.signal), [external]);
      });
    }
  }

  it('does not reinstall a synthetic-event subscription after the delay settles before rearm', async t => {
    const controller = new AbortController(), external = () => {};
    controller.signal.addEventListener('abort', external);
    let events = 0;
    const clock = timers(t, { before() {
      events++;
      controller.signal.dispatchEvent(new Event('abort'));
    } });
    let calls = 0;
    assert.equal(await retryAsync(() => { if (++calls === 1) throw 'retry'; return 'ok'; }, {
      signal: controller.signal, delayMs: 1,
    }), 'ok');
    assert.deepEqual([calls, events], [2, 1]);
    await clock.clean();
    assert.deepEqual(listeners(controller.signal), [external]);
    controller.abort('too late');
    await checkpoint();
    assert.equal(calls, 2);
  });

  for (const ending of ['success', 'recovery', 'exhaustion', 'hook false', 'invalid hook', 'hook throw', 'hook reject', 'validation', 'pre-abort']) {
    it(`measures cleanup after ${ending}, preserving external resources and source state`, async t => {
      const controller = new AbortController(), external = () => {};
      controller.signal.addEventListener('abort', external);
      const externalTimer = sleep(t, 10), clock = timers(t), failure = {};
      const options = { signal: controller.signal, attempts: 2, delayMs: 1 };
      if (ending === 'hook false') options.shouldRetry = () => false;
      if (ending === 'invalid hook') options.shouldRetry = () => 'invalid';
      if (ending === 'hook throw') options.shouldRetry = () => { throw failure; };
      if (ending === 'hook reject') options.shouldRetry = () => Promise.reject(failure);
      if (ending === 'validation') options.shouldRetry = false;
      if (ending === 'pre-abort') controller.abort(failure);
      const calls = [];
      const state = observe(retryAsync(attempt => {
        calls.push(attempt);
        if (ending === 'success' || (ending === 'recovery' && attempt === 2)) return 'ok';
        throw failure;
      }, options));
      if (ending === 'success' || ending === 'recovery') await fulfilled(state, 'ok');
      else if (ending === 'invalid hook' || ending === 'validation') {
        await state.done;
        assert.equal(state.status, 'rejected');
        assert.ok(state.reason instanceof TypeError);
      } else await rejected(state, failure);
      const expectedCalls = ending === 'validation' || ending === 'pre-abort' ? []
        : ending === 'recovery' || ending === 'exhaustion' ? [1, 2] : [1];
      assert.deepEqual(calls, expectedCalls);
      assert.equal(clock.created.size, expectedCalls.length === 2 ? 1 : 0);
      await externalTimer;
      await clock.clean();
      assert.deepEqual(listeners(controller.signal), [external]);
      assert.equal(controller.signal.aborted, ending === 'pre-abort');
      controller.abort('later');
      await checkpoint();
      assert.deepEqual(calls, expectedCalls);
    });
  }

  for (const shared of [false, true]) {
    it(`keeps simultaneous invocations independent with shared signal=${shared}`, async t => {
      const a = new AbortController(), b = shared ? a : new AbortController();
      const external = () => {};
      a.signal.addEventListener('abort', external);
      if (!shared) b.signal.addEventListener('abort', external);
      const gate = deferred(t), firstStarted = deferred(t), clock = timers(t);
      const calls = [];
      const first = observe(retryAsync(attempt => {
        calls.push(`a${attempt}`);
        if (attempt === 1) throw 'a failure';
        return 'a success';
      }, { signal: a.signal, delayMs: 1, shouldRetry: () => { firstStarted.resolve(); return gate.promise; } }));
      const second = observe(retryAsync(attempt => { calls.push(`b${attempt}`); throw 'b failure'; }, {
        signal: b.signal, delayMs: 2147483647,
      }));
      await firstStarted.promise;
      await clock.started;
      gate.resolve(true);
      await fulfilled(first, 'a success');
      assert.equal(second.status, 'pending');
      assert.equal(listeners(b.signal).length, 2, 'first settlement leaves second subscription intact');
      b.abort('b abort');
      await rejected(second, 'b abort');
      assert.deepEqual(calls, ['a1', 'b1', 'a2']);
      await clock.clean();
      assert.deepEqual(listeners(a.signal), [external]);
      assert.deepEqual(listeners(b.signal), [external]);
      assert.equal(a.signal.aborted, shared);
    });
  }
});
