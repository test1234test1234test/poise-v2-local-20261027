import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mapConcurrent } from '../lib.mjs';
import { mapConcurrent as mapWithOptions } from '../lib/map-concurrent.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const checkpoint = () => new Promise(resolve => setImmediate(resolve));

// Only observe the public promise: raw mapper rejections must be handled by
// the scheduler itself, including when running with strict rejection handling.
function observe(promise) {
  const state = { status: 'pending' };
  state.done = promise.then(
    value => { state.status = 'fulfilled'; state.value = value; },
    reason => { state.status = 'rejected'; state.reason = reason; },
  );
  return state;
}

async function pending(state) {
  await checkpoint();
  assert.equal(state.status, 'pending');
}

test('root positional API fills and refills its bound with stable result identities', async () => {
  const items = Array.from({ length: 5 }, (_, index) => ({ index }));
  const results = items.map(item => ({ mapped: item }));
  const gates = items.map(deferred);
  const signal = new AbortController().signal;
  const calls = [];
  let active = 0, maximum = 0;
  const state = observe(mapConcurrent(items, 2, (item, index, receivedSignal) => {
    calls.push({ item, index, signal: receivedSignal });
    maximum = Math.max(maximum, ++active);
    return gates[index].promise;
  }, { signal }));

  assert.deepEqual(calls.map(call => call.index), [0, 1]);
  for (const [index, count] of [[1, 3], [2, 4], [0, 5], [4, 5]]) {
    active--;
    gates[index].resolve(results[index]);
    await pending(state);
    assert.deepEqual(calls.map(call => call.index), Array.from({ length: count }, (_, i) => i));
    assert.ok(active <= 2);
  }
  gates[3].resolve(results[3]);
  await state.done;
  assert.equal(state.status, 'fulfilled');
  assert.equal(maximum, 2);
  assert.deepEqual(state.value, results);
  assert.notEqual(state.value, items);
  state.value.forEach((value, index) => assert.equal(value, results[index]));
  calls.forEach((call, index) => {
    assert.equal(call.item, items[index]);
    assert.equal(call.signal, signal);
  });
});

for (const limit of [1, 8, Number.MAX_SAFE_INTEGER]) {
  test(`root API accepts limit ${limit} without allocating to the limit`, async () => {
    const gates = Array.from({ length: 3 }, deferred);
    const starts = [];
    const result = mapConcurrent([0, 1, 2], limit, (item, index, signal) => {
      assert.equal(item, index);
      assert.equal(signal, undefined);
      starts.push(index);
      return gates[index].promise;
    });
    assert.equal(starts.length, Math.min(limit, 3));
    for (let index = 0; index < 3; index++) {
      assert.equal(starts.length, Math.min(limit + index, 3));
      gates[index].resolve(index * 2);
      await checkpoint();
    }
    assert.deepEqual(await result, [0, 2, 4]);
  });
}

test('root API adopts plain values, promises and thenables', async () => {
  assert.deepEqual(await mapConcurrent([1, 2, 3], 2, value => {
    if (value === 1) return value;
    if (value === 2) return Promise.resolve(value);
    return { then(resolve) { resolve(value); } };
  }), [1, 2, 3]);
});

for (const throwIndex of [1, 2]) {
  test(`synchronous throw during ${throwIndex === 1 ? 'initial fill' : 'refill'} stops and drains`, async () => {
    const gates = [deferred(), deferred()];
    const failure = { throwIndex };
    const starts = [];
    const state = observe(mapConcurrent([0, 1, 2, 3], 2, (_, index) => {
      starts.push(index);
      if (index === throwIndex) throw failure;
      return gates[index].promise;
    }));
    if (throwIndex === 2) gates[1].resolve('refill');
    await pending(state);
    assert.deepEqual(starts, Array.from({ length: throwIndex + 1 }, (_, i) => i));
    gates[0].reject('late rejection');
    await state.done;
    assert.equal(state.status, 'rejected');
    assert.equal(state.reason, failure);
    await checkpoint();
  });
}

test('multiple active rejections drain without unhandled rejection or further starts', async () => {
  const gates = Array.from({ length: 4 }, deferred);
  const starts = [];
  const first = { source: 'first rejection' };
  const state = observe(mapConcurrent([0, 1, 2, 3, 4], 4, (_, index) => {
    starts.push(index);
    return gates[index].promise;
  }));
  gates[2].reject(first);
  await pending(state);
  gates[0].reject(null);
  gates[1].reject(undefined);
  await pending(state);
  gates[3].resolve('late success');
  await state.done;
  assert.equal(state.status, 'rejected');
  assert.equal(state.reason, first);
  assert.deepEqual(starts, [0, 1, 2, 3]);
  await checkpoint();
});

for (const ordering of ['failure first', 'abort first', 'same turn']) {
  test(`failure/cancellation ownership with suppressed dispatch: ${ordering}`, async () => {
    const controller = new AbortController();
    controller.signal.addEventListener('abort', event => event.stopImmediatePropagation());
    const gates = [deferred(), deferred()];
    const failure = { source: 'failure' }, cancellation = { source: 'abort' };
    const starts = [];
    const state = observe(mapConcurrent([0, 1, 2], 2, (_, index) => {
      starts.push(index);
      return gates[index].promise;
    }, { signal: controller.signal }));
    if (ordering === 'abort first') controller.abort(cancellation);
    gates[1].reject(failure);
    if (ordering === 'failure first') await pending(state);
    controller.abort(cancellation);
    await pending(state);
    gates[0].reject('later rejection');
    await state.done;
    assert.equal(state.status, 'rejected');
    assert.equal(state.reason, ordering === 'failure first' ? failure : cancellation);
    assert.deepEqual(starts, [0, 1]);
    await checkpoint();
  });
}

for (const [name, map] of [
  ['root', (items, mapper, signal) => mapConcurrent(items, 2, mapper, { signal })],
  ['legacy', (items, mapper, signal) => mapWithOptions(items, mapper, { concurrency: 2, signal })],
]) {
  for (const insideMapper of [false, true]) {
    test(`${name}: suppressed real abort ${insideMapper ? 'inside mapper' : 'while active'} stops launches`, async () => {
      const controller = new AbortController();
      const caller = event => event.stopImmediatePropagation();
      controller.signal.addEventListener('abort', caller);
      const gate = deferred();
      const starts = [];
      const cancellation = { cancelled: true };
      const state = observe(map([0, 1, 2], (_, index) => {
        starts.push(index);
        if (insideMapper) controller.abort(cancellation);
        return gate.promise;
      }, controller.signal));
      if (!insideMapper) controller.abort(cancellation);
      await pending(state);
      gate.resolve('drained');
      await state.done;
      assert.equal(state.status, 'rejected');
      assert.equal(state.reason, cancellation);
      assert.deepEqual(starts, insideMapper ? [0] : [0, 1]);
      assert.deepEqual(getEventListeners(controller.signal, 'abort'), [caller]);
    });
  }
}

for (const reason of [undefined, null, false, 0, '', NaN]) {
  for (const kind of ['throw', 'reject']) {
    test(`root API preserves falsy reason ${String(reason)} from ${kind}`, async () => {
      const gate = deferred();
      const state = observe(mapConcurrent([0, 1, 2], 2, (_, index) => {
        if (index === 0) return gate.promise;
        assert.equal(index, 1);
        if (kind === 'throw') throw reason;
        return Promise.reject(reason);
      }));
      await pending(state);
      gate.resolve('drained');
      await state.done;
      assert.equal(state.status, 'rejected');
      assert.equal(state.reason, reason);
    });
  }
}

for (const abortIndex of [0, 1, 2]) {
  test(`input getter abort at index ${abortIndex} prevents mapper entry and balances capacity`, async () => {
    const controller = new AbortController();
    controller.signal.addEventListener('abort', event => event.stopImmediatePropagation());
    const gates = [deferred(), deferred()];
    const items = [0, 1, 2, 3];
    Object.defineProperty(items, abortIndex, {
      get() { controller.abort(null); return abortIndex; },
    });
    const starts = [];
    const state = observe(mapConcurrent(items, 2, (_, index) => {
      starts.push(index);
      // If the cancelled index is incorrectly invoked, it will never drain.
      return index >= abortIndex ? new Promise(() => {}) : gates[index].promise;
    }, { signal: controller.signal }));
    if (abortIndex === 2) gates[1].resolve('refill');
    if (abortIndex > 0) {
      await pending(state);
      gates[0].resolve('drained');
    }
    await state.done;
    assert.deepEqual(starts, Array.from({ length: abortIndex }, (_, i) => i));
    assert.equal(state.status, 'rejected');
    assert.equal(state.reason, null);
  });
}

for (const ending of ['success', 'abort after rearm', 'abort during gap']) {
  test(`shared signals ignore synthetic events and handle ${ending}`, async () => {
    const controller = new AbortController();
    const caller = event => event.stopImmediatePropagation();
    controller.signal.addEventListener('abort', caller);
    const gates = [deferred(), deferred()];
    const starts = [[], []];
    const states = gates.map((gate, invocation) => observe(mapConcurrent([0, 1], 1, (_, index) => {
      starts[invocation].push(index);
      return index === 0 ? gate.promise : `${invocation}:1`;
    }, { signal: controller.signal })));
    controller.signal.dispatchEvent(new Event('abort'));
    assert.equal(controller.signal.aborted, false);
    if (ending === 'abort during gap') {
      await checkpoint();
      // The rejection callback runs before re-arm, but must still see the
      // real cancellation that happens in the subscription gap below.
      gates[0].reject('later failure');
      controller.signal.dispatchEvent(new Event('abort'));
      controller.abort(false);
    } else {
      await checkpoint();
      assert.equal(getEventListeners(controller.signal, 'abort').length, 3);
      controller.signal.dispatchEvent(new Event('abort'));
      await checkpoint();
      if (ending === 'abort after rearm') controller.abort(false);
    }
    for (const state of states.slice(ending === 'abort during gap' ? 1 : 0)) await pending(state);
    gates.forEach((gate, index) => gate.resolve(`${index}:0`));
    await Promise.all(states.map(state => state.done));
    states.forEach((state, index) => {
      assert.equal(state.status, ending === 'success' ? 'fulfilled' : 'rejected');
      if (ending === 'success') assert.deepEqual(state.value, [`${index}:0`, `${index}:1`]);
      else assert.equal(state.reason, false);
      assert.deepEqual(starts[index], ending === 'success' ? [0, 1] : [0]);
    });
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), [caller]);
  });
}

test('completion before synthetic-event rearm cannot reinstall listeners', async () => {
  const controller = new AbortController();
  const gate = deferred();
  const result = mapConcurrent([0], 1, () => gate.promise, { signal: controller.signal });
  gate.resolve('done');
  controller.signal.dispatchEvent(new Event('abort'));
  assert.deepEqual(await result, ['done']);
  await checkpoint();
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), []);
});

test('root API validates before pre-abort and honors pre-abort even for empty arrays', async () => {
  const reason = { cancelled: 'already' };
  const signal = AbortSignal.abort(reason);
  for (const items of [[], [1]]) {
    const mapper = () => assert.fail('pre-aborted mapper ran');
    await assert.rejects(mapConcurrent(items, 1, mapper, { signal }), error => error === reason);
    await assert.rejects(mapConcurrent(items, 0, mapper, { signal }), RangeError);
    await assert.rejects(mapConcurrent(items, 1, null, { signal }), TypeError);
  }
  assert.deepEqual(getEventListeners(signal, 'abort'), []);
});

test('root API returns fresh empty arrays after validation', async () => {
  const items = Object.freeze([]);
  const mapper = () => assert.fail('empty mapper ran');
  const first = await mapConcurrent(items, 1, mapper);
  const second = await mapConcurrent(items, 1, mapper);
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.notEqual(first, items);
  assert.notEqual(first, second);
});

test('root API requires an explicit positive safe integer limit before reading or mapping', async () => {
  const input = [1];
  Object.defineProperty(input, 0, { get() { assert.fail('input read before validation'); } });
  for (const items of [[], input]) {
    const mapper = () => assert.fail('invalid limit mapper ran');
    await assert.rejects(mapConcurrent(items), TypeError);
    await assert.rejects(mapConcurrent(items, mapper), TypeError);
    for (const limit of [undefined, null, '2', true, 2n, {}, new Number(2), Symbol('limit')]) {
      await assert.rejects(mapConcurrent(items, limit, mapper), TypeError);
    }
    for (const limit of [0, -0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(mapConcurrent(items, limit, mapper), RangeError);
    }
    for (const mapper of [undefined, null, {}, [], 'mapper', 1, true]) {
      await assert.rejects(mapConcurrent(items, 1, mapper), TypeError);
    }
  }
});
