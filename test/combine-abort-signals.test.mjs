import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { runInNewContext } from 'node:vm';
import { combineAbortSignals } from '../lib/combine-abort-signals.mjs';

const listeners = signal => getEventListeners(signal, 'abort');

// Observe the implementation's actual registration boundary, including its
// private bridge. Every source and bridge remains a real native AbortSignal.
function observeComposition(t, { created, register } = {}) {
  const records = [];
  const nativeAny = AbortSignal.any;
  t.mock.method(AbortSignal, 'any', function (sources) {
    const signal = nativeAny.call(this, sources);
    created?.(signal);
    const record = { signal, baseline: listeners(signal), registrations: [] };
    records.push(record);
    const nativeAdd = signal.addEventListener;
    t.mock.method(signal, 'addEventListener', function (...args) {
      record.registrations.push(args);
      const install = () => nativeAdd.apply(this, args);
      return register ? register(install, record) : install();
    });
    return signal;
  });
  return records;
}

function assertClean(records) {
  for (const { signal, baseline } of records) {
    assert.deepEqual(listeners(signal), baseline, 'all owned bridge listeners removed');
  }
}

describe('combineAbortSignals', { concurrency: 1 }, () => {
  it('rejects non-arrays before composing or installing listeners', t => {
    const source = new AbortController().signal;
    const records = observeComposition(t);
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    for (const input of [undefined, null, false, 0, '', {}, () => {}, source,
      new Set([source]), { 0: source, length: 1 }, new Uint8Array(), revoked.proxy]) {
      assert.throws(() => combineAbortSignals(input), TypeError);
    }
    assert.equal(records.length, 0);
    assert.deepEqual(listeners(source), []);
  });

  it('validates every entry, including after live and pre-aborted sources', t => {
    const live = new AbortController(), stopped = new AbortController();
    stopped.abort('already stopped');
    const records = observeComposition(t);
    const liveAdd = t.mock.method(live.signal, 'addEventListener');
    const stoppedAdd = t.mock.method(stopped.signal, 'addEventListener');
    const revoked = Proxy.revocable(live.signal, {});
    revoked.revoke();
    const invalid = [undefined, null, false, 0, '', Symbol('signal'), 1n, () => {},
      {}, [], live, new EventTarget(),
      { aborted: false, reason: undefined, addEventListener() {}, removeEventListener() {} },
      AbortSignal.prototype, Object.create(AbortSignal.prototype),
      Object.create(live.signal), new Proxy(live.signal, {}), revoked.proxy];
    for (const first of [live.signal, stopped.signal]) {
      for (const entry of invalid) {
        assert.throws(() => combineAbortSignals([first, first, entry]), TypeError);
      }
    }
    assert.equal(records.length, 0);
    assert.equal(liveAdd.mock.callCount(), 0);
    assert.equal(stoppedAdd.mock.callCount(), 0);
  });

  it('rejects holes even when a missing own index inherits a native signal', t => {
    const source = new AbortController().signal;
    const inherited = new Array(1);
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: source }));
    assert.equal(inherited[0], source);
    assert.equal(Object.hasOwn(inherited, 0), false);
    const records = observeComposition(t);
    for (const input of [new Array(1), [source, , source], inherited]) {
      assert.throws(() => combineAbortSignals(input), TypeError);
    }
    assert.equal(records.length, 0);
  });

  it('enforces the current-realm prototype as well as the native receiver check', () => {
    const source = new AbortController().signal;
    // Node vm contexts do not provide their own AbortController. Exercise the
    // prototype boundary with a native signal and a foreign prototype instead.
    const foreignPrototype = runInNewContext('({})');
    Object.setPrototypeOf(foreignPrototype, AbortSignal.prototype);
    Object.setPrototypeOf(source, foreignPrototype);
    assert.ok(source instanceof AbortSignal);
    assert.equal(source.aborted, false);
    assert.throws(() => combineAbortSignals([source]), TypeError);
  });

  it('uses a validated snapshot of own array entries rather than a custom iterator', () => {
    const source = new AbortController();
    let reads = 0;
    const input = [];
    Object.defineProperty(input, 0, { get() { reads++; return source.signal; } });
    input[Symbol.iterator] = () => { throw new Error('must use validated entries'); };
    Object.freeze(input);
    const combined = combineAbortSignals(input);
    assert.equal(reads, 1);
    source.abort('snapshot');
    assert.equal(combined.signal.reason, 'snapshot');
  });

  it('returns fresh native signals and distinct disposal functions for every call', () => {
    const source = new AbortController(), stopped = new AbortController();
    stopped.abort('stopped');
    for (const inputs of [[], [source.signal], [stopped.signal], [source.signal, source.signal]]) {
      const first = combineAbortSignals(inputs), second = combineAbortSignals(inputs);
      assert.deepEqual(Object.keys(first).sort(), ['dispose', 'signal']);
      assert.ok(first.signal instanceof AbortSignal);
      assert.equal(Object.getPrototypeOf(first.signal), AbortSignal.prototype);
      assert.notEqual(first.signal, second.signal);
      assert.notEqual(first.dispose, second.dispose);
      for (const signal of inputs) {
        assert.notEqual(first.signal, signal);
        assert.notEqual(second.signal, signal);
      }
      assert.equal(first.signal.aborted, inputs[0] === stopped.signal);
      first.dispose();
      second.dispose();
    }
    assert.equal(source.signal.aborted, false);
    assert.equal(stopped.signal.reason, 'stopped');
  });

  it('keeps empty results un-aborted and installs no listeners', t => {
    const records = observeComposition(t);
    const { signal, dispose } = combineAbortSignals([]);
    let events = 0;
    signal.addEventListener('abort', () => events++);
    assert.equal(dispose(), undefined);
    assert.equal(dispose(), undefined);
    assert.equal(signal.aborted, false);
    assert.equal(signal.reason, undefined);
    assert.equal(events, 0);
    assert.ok(records.every(record => record.registrations.length === 0));
    assertClean(records);
  });

  it('accepts native factory signals and compositions as sources', () => {
    const reason = {};
    const preAborted = AbortSignal.abort(reason);
    const stopped = combineAbortSignals([preAborted]);
    assert.equal(stopped.signal.reason, reason);
    assert.notEqual(stopped.signal, preAborted);
    stopped.dispose();

    const source = new AbortController();
    const nativeCombined = AbortSignal.any([source.signal]);
    const combined = combineAbortSignals([nativeCombined, AbortSignal.any([])]);
    source.abort(reason);
    assert.equal(combined.signal.reason, reason);
    assert.notEqual(combined.signal, nativeCombined);
    combined.dispose();
  });

  it('chooses the first pre-aborted entry synchronously without subscribing', t => {
    const live = new AbortController(), a = new AbortController(), b = new AbortController();
    const reasonA = {}, reasonB = {};
    b.abort(reasonB);
    a.abort(reasonA);
    const adds = [live, a, b].map(controller => t.mock.method(controller.signal, 'addEventListener'));
    const records = observeComposition(t);
    const combined = combineAbortSignals([live.signal, a.signal, b.signal, a.signal]);
    assert.equal(combined.signal.aborted, true);
    assert.equal(combined.signal.reason, reasonA);
    assert.equal(live.signal.aborted, false);
    assert.equal(a.signal.reason, reasonA);
    assert.equal(b.signal.reason, reasonB);
    assert.ok(adds.every(add => add.mock.callCount() === 0));
    assert.ok(records.every(record => record.registrations.length === 0));
    combined.dispose();
    assertClean(records);
  });

  const reasons = [
    ['object', { message: 'opaque reason' }], ['Error', new Error('reason')],
    ['null', null], ['false', false], ['zero', 0], ['negative zero', -0],
    ['empty string', ''], ['NaN', NaN], ['symbol', Symbol('reason')],
    ['bigint', 42n], ['default', undefined],
    ['opaque thenable', { get then() { throw new Error('reason must not be assimilated'); } }],
  ];
  for (const [name, reason] of reasons) {
    for (const preAborted of [false, true]) {
      it(`preserves the exact ${name} reason ${preAborted ? 'at construction' : 'from the first later abort'}`, () => {
        const first = new AbortController(), later = new AbortController();
        if (preAborted) later.abort(reason);
        const combined = combineAbortSignals([first.signal, later.signal]);
        let events = 0;
        combined.signal.addEventListener('abort', () => events++);
        if (!preAborted) {
          assert.equal(combined.signal.aborted, false);
          later.abort(reason);
        }
        assert.equal(combined.signal.aborted, true);
        assert.equal(combined.signal.reason, later.signal.reason);
        assert.equal(first.signal.aborted, false, 'the helper never aborts a losing source');
        if (reason !== undefined) assert.equal(combined.signal.reason, reason);
        first.abort('too late');
        assert.equal(combined.signal.reason, later.signal.reason);
        assert.equal(events, preAborted ? 0 : 1);
        combined.dispose();
        combined.dispose();
        assert.equal(combined.signal.reason, later.signal.reason);
      });
    }
  }

  it('does not multiply subscriptions for duplicate references', t => {
    const source = new AbortController();
    const records = observeComposition(t);
    const single = combineAbortSignals([source.signal]);
    const singleSourceListeners = listeners(source.signal).length;
    const singleBridgeListeners = records.reduce((count, record) => count + listeners(record.signal).length, 0);
    single.dispose();
    const previousRecords = records.length;
    const repeated = combineAbortSignals([source.signal, source.signal, source.signal]);
    assert.equal(listeners(source.signal).length, singleSourceListeners);
    assert.equal(records.slice(previousRecords).reduce((count, record) => count + listeners(record.signal).length, 0),
      singleBridgeListeners);
    let events = 0;
    repeated.signal.addEventListener('abort', () => events++);
    source.abort('once');
    assert.equal(repeated.signal.reason, 'once');
    assert.equal(events, 1);
    assert.equal(single.signal.aborted, false);
    assertClean(records);
  });

  it('keeps combinations sharing sources independent when one is disposed', t => {
    const source = new AbortController();
    const records = observeComposition(t);
    const first = combineAbortSignals([source.signal]);
    const second = combineAbortSignals([source.signal]);
    first.dispose();
    first.dispose();
    source.abort('shared');
    assert.equal(first.signal.aborted, false);
    assert.equal(second.signal.reason, source.signal.reason);
    second.dispose();
    assertClean(records);
  });

  for (const ending of ['dispose', 'abort']) {
    it(`cleans every owned listener on ${ending} and preserves external listeners`, t => {
      const sources = [new AbortController(), new AbortController(), new AbortController()];
      const externalCalls = [];
      const baselines = sources.map((source, index) => {
        source.signal.addEventListener('abort', () => externalCalls.push(index));
        return listeners(source.signal);
      });
      let bridgeCalls = 0;
      const records = observeComposition(t, {
        created(signal) { signal.addEventListener('abort', () => bridgeCalls++); },
      });
      const combined = combineAbortSignals(sources.map(source => source.signal));
      let events = 0;
      combined.signal.addEventListener('abort', () => {
        events++;
        assertClean(records);
        sources.forEach((source, index) => assert.deepEqual(listeners(source.signal), baselines[index]));
        combined.dispose();
      });
      if (ending === 'dispose') {
        assert.equal(combined.dispose(), undefined);
        assert.equal(combined.signal.aborted, false);
        assert.ok(sources.every(source => !source.signal.aborted));
      } else {
        sources[1].abort('winner');
        assert.equal(combined.signal.reason, 'winner');
        assert.equal(sources[0].signal.aborted, false);
        assert.equal(sources[2].signal.aborted, false);
      }
      assertClean(records);
      combined.dispose();
      combined.dispose();
      sources.forEach((source, index) => {
        assert.deepEqual(listeners(source.signal), baselines[index]);
        source.abort(index);
        assert.deepEqual(listeners(source.signal), baselines[index]);
      });
      assert.deepEqual(externalCalls.sort(), [0, 1, 2]);
      assert.equal(bridgeCalls, 1, 'even external listeners on the private bridge survive cleanup');
      assert.equal(events, ending === 'dispose' ? 0 : 1);
      assert.equal(combined.signal.aborted, ending === 'abort');
      assert.equal(combined.signal.reason, ending === 'dispose' ? undefined : 'winner');
      assertClean(records);
    });
  }

  for (const reversed of [false, true]) {
    it(`preserves actual abort order during nested dispatch (${reversed ? 'B, A' : 'A, B'})`, () => {
      const a = new AbortController(), b = new AbortController();
      const reasonA = {}, reasonB = {};
      a.signal.addEventListener('abort', () => b.abort(reasonB));
      const combined = combineAbortSignals(reversed ? [b.signal, a.signal] : [a.signal, b.signal]);
      let events = 0;
      combined.signal.addEventListener('abort', () => events++);
      a.abort(reasonA);
      assert.equal(combined.signal.reason, reasonA);
      assert.equal(b.signal.reason, reasonB);
      assert.equal(events, 1);
    });
  }

  it('lets an already-started source abort win over disposal in an earlier source listener', t => {
    const source = new AbortController();
    let combined, events = 0;
    source.signal.addEventListener('abort', () => {
      assert.equal(source.signal.aborted, true);
      combined.dispose();
      assert.equal(combined.signal.reason, source.signal.reason);
    });
    const baseline = listeners(source.signal);
    const records = observeComposition(t);
    combined = combineAbortSignals([source.signal]);
    combined.signal.addEventListener('abort', () => events++);
    source.abort('already started');
    assert.equal(combined.signal.reason, 'already started');
    assert.equal(events, 1);
    assert.deepEqual(listeners(source.signal), baseline);
    assertClean(records);
  });

  it('ignores synthetic source and bridge events without losing the real abort', t => {
    const source = new AbortController();
    const records = observeComposition(t);
    const combined = combineAbortSignals([source.signal]);
    let events = 0;
    combined.signal.addEventListener('abort', () => events++);
    source.signal.dispatchEvent(new Event('abort'));
    for (const record of records) record.signal.dispatchEvent(new Event('abort'));
    assert.equal(source.signal.aborted, false);
    assert.equal(combined.signal.aborted, false);
    assert.equal(events, 0);
    // No microtask or timer turn is needed to restore observation.
    source.abort('real');
    assert.equal(combined.signal.reason, 'real');
    assert.equal(events, 1);
    assertClean(records);
  });

  it('propagates even when an external source listener stops immediate propagation', () => {
    const source = new AbortController();
    let externalCalls = 0;
    source.signal.addEventListener('abort', event => {
      externalCalls++;
      event.stopImmediatePropagation();
    });
    const baseline = listeners(source.signal);
    const combined = combineAbortSignals([source.signal]);
    source.abort('unstoppable');
    assert.equal(combined.signal.reason, 'unstoppable');
    assert.equal(externalCalls, 1);
    assert.deepEqual(listeners(source.signal), baseline);
  });

  // All sources are natively composed before the single owned subscription.
  // Exercise each source at that actual registration boundary, rather than
  // mocking per-source subscriptions that this implementation never installs.
  for (const winner of [0, 1, 2]) {
    for (const phase of ['before registration', 'after registration', 'during registration with a late install']) {
      it(`recognizes source ${winner} aborting ${phase} and leaves no listener behind`, t => {
        const sources = [new AbortController(), new AbortController(), new AbortController()];
        const reason = { winner, phase };
        const records = observeComposition(t, {
          register(install) {
            if (phase !== 'before registration') install();
            sources[winner].abort(reason);
            sources[(winner + 1) % sources.length].abort('later');
            if (phase !== 'after registration') install();
          },
        });
        const combined = combineAbortSignals(sources.map(source => source.signal));
        assert.ok(records.some(record => record.registrations.length > 0), 'the registration hook ran');
        assert.equal(combined.signal.aborted, true);
        assert.equal(combined.signal.reason, reason);
        assertClean(records);
        sources.forEach(source => {
          assert.deepEqual(listeners(source.signal), []);
          source.abort('later still');
        });
        combined.dispose();
        assert.equal(combined.signal.reason, reason);
        assertClean(records);
      });
    }
  }

  for (const phase of ['before registration', 'after registration', 'after abort and late registration']) {
    it(`cleans up and rethrows the original setup error ${phase}`, t => {
      const source = new AbortController();
      let sourceCalls = 0, bridgeCalls = 0;
      source.signal.addEventListener('abort', () => sourceCalls++);
      const baseline = listeners(source.signal);
      const failure = new Error(phase);
      const records = observeComposition(t, {
        created(signal) { signal.addEventListener('abort', () => bridgeCalls++); },
        register(install) {
          if (phase !== 'before registration') install();
          if (phase === 'after abort and late registration') {
            source.abort('during setup');
            install();
          }
          throw failure;
        },
      });
      assert.throws(() => combineAbortSignals([source.signal]), error => error === failure);
      assert.equal(records.length, 1);
      assertClean(records);
      assert.deepEqual(listeners(source.signal), baseline);
      source.abort('after failure');
      assert.equal(sourceCalls, 1);
      assert.equal(bridgeCalls, 1);
      assertClean(records);
    });
  }

  it('leaves an existing successful subscription intact when another setup fails', t => {
    const source = new AbortController();
    let fail = false;
    const failure = {};
    const records = observeComposition(t, {
      register(install) {
        install();
        if (fail) throw failure;
      },
    });
    const first = combineAbortSignals([source.signal]);
    fail = true;
    assert.throws(() => combineAbortSignals([source.signal]), error => error === failure);
    assertClean(records.slice(1));
    source.abort('first still works');
    assert.equal(first.signal.reason, 'first still works');
    assertClean(records);
  });

  it('propagates input access and native composition errors without source subscriptions', t => {
    const source = new AbortController();
    const failure = new Error('setup');
    const input = [source.signal];
    Object.defineProperty(input, 1, { get() { throw failure; } });
    const add = t.mock.method(source.signal, 'addEventListener');
    assert.throws(() => combineAbortSignals(input), error => error === failure);
    t.mock.method(AbortSignal, 'any', () => { throw failure; });
    assert.throws(() => combineAbortSignals([source.signal]), error => error === failure);
    assert.equal(add.mock.callCount(), 0);
    assert.deepEqual(listeners(source.signal), []);
    assert.equal(source.signal.aborted, false);
  });
});
