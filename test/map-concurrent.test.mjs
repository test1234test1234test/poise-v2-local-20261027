import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mapConcurrent } from '../lib/map-concurrent.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const checkpoint = () => new Promise(resolve => setImmediate(resolve));

// Observe only the public promise. Raw mapper promises deliberately have no
// test-side rejection handlers, so node:test detects unconsumed rejections.
function observe(promise) {
  const state = { status: 'pending' };
  state.done = promise.then(
    value => { state.status = 'fulfilled'; state.value = value; },
    reason => { state.status = 'rejected'; state.reason = reason; },
  );
  return state;
}

function controlled(count) {
  const gates = Array.from({ length: count }, deferred);
  const starts = [];
  const waiting = new Map();
  let active = 0, maximum = 0;
  return {
    starts,
    get maximum() { return maximum; },
    mapper(value, index, signal) {
      starts.push({ value, index, signal });
      maximum = Math.max(maximum, ++active);
      waiting.get(starts.length)?.resolve();
      return gates[index].promise;
    },
    started(count) {
      if (starts.length >= count) return Promise.resolve();
      if (!waiting.has(count)) waiting.set(count, deferred());
      return waiting.get(count).promise;
    },
    resolve(index, value) { active--; gates[index].resolve(value); },
    reject(index, reason) { active--; gates[index].reject(reason); },
  };
}

async function pending(state, work, indices) {
  await checkpoint();
  assert.equal(state.status, 'pending');
  assert.deepEqual(work.starts.map(call => call.index), indices);
}

test('default four slots refill in ascending order and preserve actual results', async () => {
  const items = Array.from({ length: 7 }, (_, index) => ({ index }));
  const results = items.map(({ index }) => ({ mapped: index }));
  const work = controlled(items.length);
  const state = observe(mapConcurrent(items, work.mapper));
  await work.started(4);
  await pending(state, work, [0, 1, 2, 3]);
  for (const [index, count] of [[3, 5], [1, 6], [5, 7]]) {
    work.resolve(index, results[index]);
    await work.started(count);
    await pending(state, work, Array.from({ length: count }, (_, i) => i));
  }
  for (const index of [6, 4, 2, 0]) work.resolve(index, results[index]);
  await state.done;
  assert.equal(state.status, 'fulfilled');
  assert.deepEqual(state.value, results);
  state.value.forEach((value, index) => assert.equal(value, results[index]));
  assert.equal(work.maximum, 4);
  work.starts.forEach((call, index) => {
    assert.equal(call.value, items[index]);
    assert.equal(call.signal, undefined);
  });
});

for (const concurrency of [1, 8, Number.MAX_SAFE_INTEGER]) {
  test(`bounded deferred work with concurrency ${concurrency}`, async () => {
    const work = controlled(3);
    const state = observe(mapConcurrent(['a', 'b', 'c'], work.mapper, { concurrency }));
    await work.started(Math.min(concurrency, 3));
    for (let index = 0; index < 3; index++) {
      await work.started(index + 1);
      assert.ok(work.starts.length <= Math.min(index + concurrency, 3));
      work.resolve(index, index * 10);
    }
    await state.done;
    assert.equal(state.status, 'fulfilled');
    assert.deepEqual(state.value, [0, 10, 20]);
    assert.equal(work.maximum, Math.min(concurrency, 3));
    assert.deepEqual(work.starts.map(call => call.index), [0, 1, 2]);
  });
}

test('plain values, promises, and thenables are assimilated', async () => {
  assert.deepEqual(await mapConcurrent([1, 2, 3, 4, 5], (value, index) => {
    if (index === 1) return Promise.resolve(value * 2);
    if (index === 2) return { then(resolve) { resolve(value * 2); } };
    return value * 2;
  }), [2, 4, 6, 8, 10]);
});

test('synchronous initial throw stops launches and drains the earlier call', async () => {
  const gate = deferred();
  const failure = { failure: 'sync' };
  const starts = [];
  const state = observe(mapConcurrent([0, 1, 2, 3], (_, index) => {
    starts.push({ index });
    if (index === 1) throw failure;
    return gate.promise;
  }, { concurrency: 3 }));
  await pending(state, { starts }, [0, 1]);
  gate.reject({ failure: 'late' });
  await state.done;
  assert.equal(state.status, 'rejected');
  assert.equal(state.reason, failure);
  await checkpoint();
});

test('synchronous throw during refill also stops and drains', async () => {
  const work = controlled(4);
  const failure = new Error('refill');
  const starts = [];
  const state = observe(mapConcurrent([0, 1, 2, 3], (value, index, signal) => {
    starts.push({ index });
    if (index === 2) throw failure;
    return work.mapper(value, index, signal);
  }, { concurrency: 2 }));
  await work.started(2);
  work.resolve(1, 'one');
  await pending(state, { starts }, [0, 1, 2]);
  work.resolve(0, 'zero');
  await state.done;
  assert.equal(state.status, 'rejected');
  assert.equal(state.reason, failure);
});

test('first asynchronous failure owns outcome while later failures and successes drain', async () => {
  const work = controlled(7);
  const failure = { index: 2 };
  const state = observe(mapConcurrent(Array(7), work.mapper));
  await work.started(4);
  work.reject(2, failure);
  await pending(state, work, [0, 1, 2, 3]);
  work.reject(0, { index: 0 });
  await pending(state, work, [0, 1, 2, 3]);
  work.resolve(1, 'late success');
  await pending(state, work, [0, 1, 2, 3]);
  work.reject(3, { index: 3 });
  await state.done;
  assert.equal(state.status, 'rejected');
  assert.equal(state.reason, failure);
  await checkpoint();
});

test('mid-flight abort drains all active work and never refills', async () => {
  const controller = new AbortController();
  const reason = { cancelled: true };
  const work = controlled(6);
  const state = observe(mapConcurrent(Array(6), work.mapper, {
    concurrency: 3, signal: controller.signal,
  }));
  await work.started(3);
  work.starts.forEach(call => assert.equal(call.signal, controller.signal));
  controller.abort(reason);
  await pending(state, work, [0, 1, 2]);
  work.resolve(0, 'success');
  await pending(state, work, [0, 1, 2]);
  work.reject(1, new Error('late failure'));
  await pending(state, work, [0, 1, 2]);
  work.resolve(2, 'last');
  await state.done;
  assert.equal(state.status, 'rejected');
  assert.equal(state.reason, reason);
  await checkpoint();
});

for (const ending of ['resolve', 'reject', 'throw', 'value']) {
  test(`abort inside mapper stops initial loop and handles ${ending}`, async () => {
    const controller = new AbortController();
    const reason = { source: 'abort' };
    const later = { source: 'mapper' };
    const gate = deferred();
    const starts = [];
    const state = observe(mapConcurrent([0, 1, 2], (_, index, signal) => {
      starts.push({ index });
      assert.equal(signal, controller.signal);
      controller.abort(reason);
      if (ending === 'throw') throw later;
      if (ending === 'value') return 42;
      return gate.promise;
    }, { signal: controller.signal }));
    if (ending === 'resolve' || ending === 'reject') {
      await pending(state, { starts }, [0]);
      gate[ending](later);
    }
    await state.done;
    assert.deepEqual(starts, [{ index: 0 }]);
    assert.equal(state.status, 'rejected');
    assert.equal(state.reason, reason);
    await checkpoint();
  });
}

for (const ordering of ['failure first', 'abort first', 'reject then abort in same turn']) {
  test(`first observed ownership: ${ordering}`, async () => {
    const controller = new AbortController();
    const work = controlled(3);
    const failure = { source: 'failure' }, abort = { source: 'abort' };
    const state = observe(mapConcurrent([0, 1, 2], work.mapper, {
      concurrency: 2, signal: controller.signal,
    }));
    await work.started(2);
    if (ordering === 'abort first') controller.abort(abort);
    work.reject(1, failure);
    if (ordering === 'failure first') {
      await pending(state, work, [0, 1]);
      assert.equal(controller.signal.aborted, false);
    }
    controller.abort(abort);
    await pending(state, work, [0, 1]);
    work.reject(0, 'later');
    await state.done;
    assert.equal(state.status, 'rejected');
    assert.equal(state.reason, ordering === 'failure first' ? failure : abort);
    await checkpoint();
  });
}

for (const reason of [undefined, null, false, 0, '', Symbol('reason'), { reason: 'object' }]) {
  for (const kind of ['throw', 'reject', 'abort']) {
    test(`preserves ${String(reason)} reason via ${kind}`, async () => {
      const work = controlled(3);
      const controller = new AbortController();
      const state = observe(mapConcurrent([0, 1, 2], (value, index, signal) => {
        if (kind === 'throw' && index === 1) throw reason;
        return work.mapper(value, index, signal);
      }, { concurrency: 2, signal: controller.signal }));
      if (kind === 'reject') work.reject(1, reason);
      if (kind === 'abort') controller.abort(reason);
      await checkpoint();
      assert.equal(state.status, 'pending');
      assert.equal(work.starts.length, kind === 'throw' ? 1 : 2);
      work.resolve(0, 'done');
      if (kind === 'abort') work.reject(1, 'late');
      await state.done;
      assert.equal(state.status, 'rejected');
      assert.equal(state.reason, kind === 'abort' ? controller.signal.reason : reason);
      if (kind !== 'abort') assert.equal(controller.signal.aborted, false);
      await checkpoint();
    });
  }
}

for (const items of [[], [1, 2]]) {
  test(`pre-abort precedes empty fast path, length ${items.length}`, async () => {
    const reason = { cancelled: 'already' };
    const signal = AbortSignal.abort(reason);
    let calls = 0;
    const state = observe(mapConcurrent(items, () => calls++, { signal }));
    await state.done;
    assert.equal(state.status, 'rejected');
    assert.equal(state.reason, reason);
    assert.equal(calls, 0);
    assert.deepEqual(getEventListeners(signal, 'abort'), []);
  });
}

for (const outcome of ['success', 'failure', 'abort', 'empty', 'pre-abort']) {
  test(`cleans up only its own listener after ${outcome}`, async () => {
    const controller = new AbortController();
    let callerEvents = 0;
    const caller = () => callerEvents++;
    controller.signal.addEventListener('abort', caller);
    const baseline = getEventListeners(controller.signal, 'abort');
    if (outcome === 'pre-abort') controller.abort('early');
    const work = controlled(2);
    const state = observe(mapConcurrent(outcome === 'empty' ? [] : [0, 1], work.mapper, {
      signal: controller.signal,
    }));
    if (!['empty', 'pre-abort'].includes(outcome)) {
      await work.started(2);
      assert.equal(getEventListeners(controller.signal, 'abort').length, baseline.length + 1);
      if (outcome === 'abort') controller.abort('abort');
      if (outcome === 'failure') work.reject(0, 'failure');
      else work.resolve(0, 'zero');
      await pending(state, work, [0, 1]);
      work.resolve(1, 'one');
    }
    await state.done;
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), baseline);
    assert.equal(state.status, ['success', 'empty'].includes(outcome) ? 'fulfilled' : 'rejected');
    if (!controller.signal.aborted) controller.abort('caller afterwards');
    assert.equal(callerEvents, 1);
  });
}

test('independent invocations maintain their own limits and failures', async () => {
  const first = controlled(3), second = controlled(4);
  const a = observe(mapConcurrent([0, 1, 2], first.mapper, { concurrency: 1 }));
  const b = observe(mapConcurrent([0, 1, 2, 3], second.mapper, { concurrency: 2 }));
  await Promise.all([first.started(1), second.started(2)]);
  first.reject(0, 'first failed');
  await a.done;
  assert.equal(a.reason, 'first failed');
  second.resolve(1, 'b');
  await second.started(3);
  second.resolve(0, 'a');
  await second.started(4);
  second.resolve(3, 'd');
  second.resolve(2, 'c');
  await b.done;
  assert.equal(b.status, 'fulfilled');
  assert.deepEqual(b.value, ['a', 'b', 'c', 'd']);
  assert.equal(first.maximum, 1);
  assert.equal(second.maximum, 2);
  assert.deepEqual(first.starts.map(call => call.index), [0]);
});

test('calls sharing a signal retain separate listener ownership', async () => {
  const controller = new AbortController();
  const caller = () => {};
  controller.signal.addEventListener('abort', caller);
  const first = controlled(1), second = controlled(2);
  const a = observe(mapConcurrent([0], first.mapper, { signal: controller.signal }));
  const b = observe(mapConcurrent([0, 1], second.mapper, { concurrency: 1, signal: controller.signal }));
  await Promise.all([first.started(1), second.started(1)]);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 3);
  first.resolve(0, 'first');
  await a.done;
  assert.deepEqual(a.value, ['first']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 2);
  controller.abort(null);
  await pending(b, second, [0]);
  second.resolve(0, 'second');
  await b.done;
  assert.equal(b.status, 'rejected');
  assert.equal(b.reason, null);
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), [caller]);
});

test('empty results are fresh and no mapper runs', async () => {
  const input = Object.freeze([]);
  const mapper = () => assert.fail('empty mapper');
  const first = await mapConcurrent(input, mapper);
  const second = await mapConcurrent(input, mapper);
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.notEqual(first, input);
  assert.notEqual(first, second);
});

test('frozen inputs and element objects remain untouched and retain identity', async () => {
  const a = Object.freeze({ value: 1 }), b = Object.freeze({ value: 2 });
  const input = Object.freeze([a, b, a]);
  const before = Object.getOwnPropertyDescriptors(input);
  const result = await mapConcurrent(input, value => value);
  assert.notEqual(result, input);
  assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
  assert.deepEqual(input, [{ value: 1 }, { value: 2 }, { value: 1 }]);
  assert.equal(result[0], a);
  assert.equal(result[1], b);
  assert.equal(result[2], a);
});

test('sparse inputs visit every initial index without changing holes', async () => {
  const input = Object.freeze([, 'present', ,]);
  const calls = [];
  assert.deepEqual(await mapConcurrent(input, (value, index) => {
    calls.push([value, index]);
    return `${index}:${value}`;
  }), ['0:undefined', '1:present', '2:undefined']);
  assert.deepEqual(calls, [[undefined, 0], ['present', 1], [undefined, 2]]);
  assert.equal(0 in input, false);
  assert.equal(2 in input, false);
});

test('captures initial length and reads each value only when its index starts', async () => {
  const input = [0, 1, 2];
  assert.deepEqual(await mapConcurrent(input, (value, index) => {
    if (index === 0) { input[1] = 10; input.push(3); }
    return value;
  }, { concurrency: 1 }), [0, 10, 2]);
});

async function rejectsWithoutThrow(call, ErrorType) {
  let promise;
  assert.doesNotThrow(() => { promise = call(); });
  assert.ok(promise instanceof Promise);
  await assert.rejects(promise, ErrorType);
}

for (const items of [undefined, null, {}, 'abc', 1, new Set(), new Uint8Array(2)]) {
  test(`rejects non-array items: ${String(items)}`, async () => {
    await rejectsWithoutThrow(() => mapConcurrent(items, () => assert.fail('mapper ran')), TypeError);
  });
}

for (const mapper of [undefined, null, {}, [], 'mapper', 1, true]) {
  test(`rejects non-function mapper: ${String(mapper)}`, async () => {
    for (const items of [[], [1]]) {
      await rejectsWithoutThrow(() => mapConcurrent(items, mapper), TypeError);
    }
  });
}

const badOptions = [null, [], 1, 'options', true, () => {},
  { timeout: 1 }, { [Symbol('unknown')]: 1 },
  Object.defineProperty({}, 'hidden', { value: true })];
badOptions.forEach((options, index) => {
  test(`rejects invalid options ${index} before mapping or empty fast path`, async () => {
    for (const items of [[], [1]]) {
      await rejectsWithoutThrow(() => mapConcurrent(items, () => assert.fail('mapper ran'), options), TypeError);
    }
  });
});

for (const concurrency of [undefined, null, '4', true, 4n, {}, new Number(4)]) {
  test(`rejects nonnumeric concurrency: ${String(concurrency)}`, async () => {
    for (const items of [[], [1]]) {
      await rejectsWithoutThrow(() => mapConcurrent(items, () => assert.fail('mapper ran'), { concurrency }), TypeError);
    }
  });
}

for (const concurrency of [0, -0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`rejects invalid numeric concurrency: ${concurrency}`, async () => {
    for (const items of [[], [1]]) {
      await rejectsWithoutThrow(() => mapConcurrent(items, () => assert.fail('mapper ran'), { concurrency }), RangeError);
    }
  });
}

const signalShape = { aborted: false, reason: undefined, addEventListener() {}, removeEventListener() {} };
const badSignals = [null, false, 1, 'signal', {}, [], () => {},
  { ...signalShape, aborted: 0 }, { ...signalShape, addEventListener: null },
  { ...signalShape, removeEventListener: null },
  ...Object.keys(signalShape).map(key => Object.fromEntries(Object.entries(signalShape).filter(([name]) => name !== key)))];
badSignals.forEach((signal, index) => {
  test(`rejects plainly invalid signal ${index} before starting work`, async () => {
    for (const items of [[], [1]]) {
      await rejectsWithoutThrow(() => mapConcurrent(items, () => assert.fail('mapper ran'), { signal }), TypeError);
    }
  });
});

test('validates arguments before handling a pre-aborted signal', async () => {
  const signal = AbortSignal.abort('abort');
  await rejectsWithoutThrow(() => mapConcurrent([], null, { signal }), TypeError);
  await rejectsWithoutThrow(() => mapConcurrent([], () => {}, { signal, concurrency: 0 }), RangeError);
});

test('undefined signal is omitted and inherited options are ignored', async () => {
  assert.deepEqual(await mapConcurrent([1], (value, index, signal) => {
    assert.equal(signal, undefined);
    return value;
  }, { signal: undefined }), [1]);
  const options = Object.create({ concurrency: 0, signal: null, timeout: 1 });
  assert.deepEqual(await mapConcurrent([1], value => value, options), [1]);
  assert.deepEqual(await mapConcurrent([1], value => value, undefined), [1]);
});

test('accepts inherited AbortSignal-like members and preserves an undefined abort reason', async () => {
  const target = new EventTarget();
  const signal = Object.create({
    aborted: false, reason: undefined,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  });
  const work = controlled(2);
  const state = observe(mapConcurrent([0, 1], work.mapper, { concurrency: 1, signal }));
  await work.started(1);
  assert.equal(work.starts[0].signal, signal);
  signal.aborted = true;
  target.dispatchEvent(new Event('abort'));
  await pending(state, work, [0]);
  work.reject(0, 'later');
  await state.done;
  assert.equal(state.status, 'rejected');
  assert.equal(state.reason, undefined);
  assert.deepEqual(getEventListeners(target, 'abort'), []);
});

test('thenable rejection and throwing then getter stop and drain normally', async () => {
  for (const getter of [false, true]) {
    const gate = deferred();
    const reason = { getter };
    const starts = [];
    const thenable = getter
      ? Object.defineProperty({}, 'then', { get() { throw reason; } })
      : { then(resolve, reject) { reject(reason); } };
    const state = observe(mapConcurrent([0, 1, 2], (_, index) => {
      starts.push({ index });
      return index === 0 ? gate.promise : thenable;
    }, { concurrency: 2 }));
    await pending(state, { starts }, [0, 1]);
    gate.resolve('done');
    await state.done;
    assert.equal(state.status, 'rejected');
    assert.equal(state.reason, reason);
  }
});

test('large plain-value input uses iterative bounded scheduling', async () => {
  const input = Array.from({ length: 20000 }, (_, index) => index);
  const result = await mapConcurrent(input, value => value + 1, { concurrency: 1 });
  assert.deepEqual(result, input.map(value => value + 1));
});
