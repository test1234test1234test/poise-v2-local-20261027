import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRingBuffer } from '../lib/ring-buffer.mjs';

function assertValues(actual, expected) {
  assert.equal(Array.isArray(actual), true);
  assert.equal(Object.getPrototypeOf(actual), Array.prototype);
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(Object.hasOwn(actual, index), true, `own slot ${index}`);
    assert.ok(Object.is(actual[index], expected[index]), `identity at slot ${index}`);
  }
}

function assertState(buffer, expected) {
  assert.equal(buffer.size, expected.length);
  assertValues(buffer.toArray(), expected);
}

function assertResult(result, flag, present, value) {
  assert.equal(Reflect.ownKeys(result).length, present ? 2 : 1);
  assert.equal(Object.hasOwn(result, flag), true);
  assert.equal(result[flag], present);
  assert.equal(Object.hasOwn(result, 'value'), present);
  if (present) assert.ok(Object.is(result.value, value), 'payload identity');
}

test('ring buffer rejects every invalid capacity with TypeError', () => {
  assert.throws(() => createRingBuffer(), TypeError);
  const invalid = [undefined, null, true, false, '', '2', [], [2], {},
    new Number(2), () => 2, 2n, Symbol('capacity'), 0, -0, -1, -2.5, 0.5, 1.5,
    Number.MIN_VALUE, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1];
  for (const capacity of invalid) {
    assert.throws(() => createRingBuffer(capacity), TypeError);
  }
});

test('capacity validation neither reads nor calls coercion hooks', () => {
  let accesses = 0;
  for (const property of [Symbol.toPrimitive, 'valueOf', 'toString']) {
    const getter = Object.defineProperty({}, property, {
      get() { accesses += 1; throw new TypeError('coercion sentinel'); },
    });
    const method = {
      [property]() { accesses += 1; throw new TypeError('coercion sentinel'); },
    };
    assert.throws(() => createRingBuffer(getter), TypeError);
    assert.throws(() => createRingBuffer(method), TypeError);
  }
  const opaque = new Proxy({}, {
    get() { accesses += 1; throw new TypeError('property sentinel'); },
  });
  assert.throws(() => createRingBuffer(opaque), TypeError);
  assert.equal(accesses, 0);
});

for (const capacity of [2 ** 32, Number.MAX_SAFE_INTEGER]) {
  test(`capacity ${capacity} supports small occupancy and clear/reuse`, () => {
    const buffer = createRingBuffer(capacity);
    const item = {};
    assertState(buffer, []);
    assertResult(buffer.shift(), 'found', false);
    for (let round = 0; round < 3; round += 1) {
      assertResult(buffer.push(undefined), 'evicted', false);
      assertResult(buffer.push(item), 'evicted', false);
      assertResult(buffer.push(round), 'evicted', false);
      assertState(buffer, [undefined, item, round]);
      assertResult(buffer.shift(), 'found', true, undefined);
      assertResult(buffer.shift(), 'found', true, item);
      assertState(buffer, [round]);
      assert.equal(buffer.clear(), undefined);
      assertState(buffer, []);
    }
  });
}

test('capacity one distinguishes stored undefined from empty, including eviction', () => {
  const buffer = createRingBuffer(1);
  assertState(buffer, []);
  assertResult(buffer.shift(), 'found', false);
  assertResult(buffer.push(undefined), 'evicted', false);
  assertState(buffer, [undefined]);
  assertResult(buffer.shift(), 'found', true, undefined);
  assertState(buffer, []);
  assertResult(buffer.shift(), 'found', false);
  assertResult(buffer.push(undefined), 'evicted', false);
  assertResult(buffer.push('next'), 'evicted', true, undefined);
  assertState(buffer, ['next']);
  assertResult(buffer.push(false), 'evicted', true, 'next');
  assertResult(buffer.shift(), 'found', true, false);
  assertState(buffer, []);
  assertResult(buffer.push('reused'), 'evicted', false);
  assertResult(buffer.shift(), 'found', true, 'reused');
});

test('mixed FIFO operations preserve duplicate references and falsy values', () => {
  const buffer = createRingBuffer(3);
  const item = { id: 1 };
  for (const value of [undefined, item, item]) {
    assertResult(buffer.push(value), 'evicted', false);
  }
  assertState(buffer, [undefined, item, item]);
  assertResult(buffer.push(null), 'evicted', true, undefined);
  assertState(buffer, [item, item, null]);
  assertResult(buffer.shift(), 'found', true, item);
  assertState(buffer, [item, null]);
  assertResult(buffer.push(false), 'evicted', false);
  assertState(buffer, [item, null, false]);
  assertResult(buffer.push(-0), 'evicted', true, item);
  assertState(buffer, [null, false, -0]);
  for (const value of [null, false, -0]) {
    assertResult(buffer.shift(), 'found', true, value);
  }
  assertResult(buffer.shift(), 'found', false);
  assertState(buffer, []);
});

test('all payloads retain identity without inspection, invocation or normalization', () => {
  let accesses = 0;
  const opaque = {};
  for (const property of ['then', 'toJSON', 'toString', 'valueOf',
    Symbol.iterator, Symbol.toPrimitive]) {
    Object.defineProperty(opaque, property, {
      get() { accesses += 1; throw new Error('payload sentinel'); },
    });
  }
  const callable = () => { accesses += 1; throw new Error('call sentinel'); };
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const cyclic = {};
  cyclic.self = cyclic;
  const values = [undefined, null, true, false, '', 'text', 0, -0, 1.5, NaN,
    Infinity, -Infinity, 0n, -2n, Symbol('payload'), callable, Promise.resolve(1),
    Object.freeze({ id: 1 }), [], [undefined, 2], cyclic, opaque, proxy,
    { found: false }, { evicted: true, value: undefined }];
  const buffer = createRingBuffer(1);
  const replacement = {};
  for (const value of values) {
    assertResult(buffer.push(value), 'evicted', false);
    assertState(buffer, [value]);
    assertResult(buffer.shift(), 'found', true, value);
    assertResult(buffer.push(value), 'evicted', false);
    assertResult(buffer.push(value), 'evicted', true, value);
    assertState(buffer, [value]);
    assertResult(buffer.push(replacement), 'evicted', true, value);
    assertResult(buffer.shift(), 'found', true, replacement);
    assertState(buffer, []);
  }
  assert.equal(accesses, 0);
});

test('empty shifts and non-evicting pushes return fresh, isolated status objects', () => {
  const buffer = createRingBuffer(2);
  const other = createRingBuffer(2);
  const empty = buffer.shift();
  const anotherEmpty = buffer.shift();
  assert.notEqual(empty, anotherEmpty);
  assertResult(empty, 'found', false);
  empty.found = true;
  empty.value = 'changed';
  assertResult(anotherEmpty, 'found', false);
  assertResult(buffer.shift(), 'found', false);
  assertResult(other.shift(), 'found', false);

  const firstPush = buffer.push('first');
  const secondPush = buffer.push('second');
  assert.notEqual(firstPush, secondPush);
  assertResult(firstPush, 'evicted', false);
  firstPush.evicted = true;
  firstPush.value = 'changed';
  assertResult(secondPush, 'evicted', false);
  assertResult(other.push('other'), 'evicted', false);
  assertState(buffer, ['first', 'second']);
  assertState(other, ['other']);
  assertResult(buffer.push('third'), 'evicted', true, 'first');
  buffer.clear();
  assertResult(buffer.push('reused'), 'evicted', false);
  assertResult(secondPush, 'evicted', false);
  assertResult(anotherEmpty, 'found', false);
  assert.deepEqual(empty, { found: true, value: 'changed' });
  assert.deepEqual(firstPush, { evicted: true, value: 'changed' });
});

test('successful result wrappers are isolated while their payload references stay shared', () => {
  const buffer = createRingBuffer(2);
  const item = { count: 0 };
  buffer.push(item);
  buffer.push(item);
  const removed = buffer.shift();
  assertResult(removed, 'found', true, item);
  removed.value = 'changed';
  removed.found = false;
  assertState(buffer, [item]);
  const anotherRemoved = buffer.shift();
  assert.notEqual(removed, anotherRemoved);
  buffer.push(item);
  buffer.push(item);
  const evicted = buffer.push(item);
  const anotherEvicted = buffer.push(item);
  assert.notEqual(evicted, anotherEvicted);
  assert.deepEqual(removed, { found: false, value: 'changed' });
  assertResult(anotherRemoved, 'found', true, item);
  assertResult(evicted, 'evicted', true, item);
  assertResult(anotherEvicted, 'evicted', true, item);

  evicted.value = 'changed';
  evicted.evicted = false;
  assertState(buffer, [item, item]);
  const snapshot = buffer.toArray();
  item.count = 1;
  assert.equal(anotherRemoved.value.count, 1);
  assert.equal(anotherEvicted.value.count, 1);
  assert.equal(snapshot[0].count, 1);
  assert.equal(buffer.toArray()[1].count, 1);
  Object.freeze(anotherRemoved);
  Object.freeze(anotherEvicted);
  buffer.shift();
  buffer.push('later');
  buffer.clear();
  assertResult(anotherRemoved, 'found', true, item);
  assertResult(anotherEvicted, 'evicted', true, item);
  assert.deepEqual(removed, { found: false, value: 'changed' });
  assert.deepEqual(evicted, { evicted: false, value: 'changed' });
});

test('snapshots are fresh dense ordinary arrays with independent membership and shared payloads', () => {
  const buffer = createRingBuffer(3);
  const empty = buffer.toArray();
  const anotherEmpty = buffer.toArray();
  assert.notEqual(empty, anotherEmpty);
  assertValues(empty, []);
  assertValues(anotherEmpty, []);
  empty.push('changed');
  assertState(buffer, []);

  const item = { count: 0 };
  const expected = [undefined, item, 'last'];
  for (const value of expected) buffer.push(value);
  const edited = buffer.toArray();
  const retained = buffer.toArray();
  assert.notEqual(edited, retained);
  assertValues(edited, expected);
  assertValues(retained, expected);
  edited.reverse();
  delete edited[0];
  edited[1] = 'replacement';
  edited.push('extra');
  assertState(buffer, expected);
  assertValues(retained, expected);
  item.count = 1;
  assert.equal(retained[1].count, 1);
  assert.equal(buffer.toArray()[1].count, 1);
  assertResult(buffer.push('next'), 'evicted', true, undefined);
  assertResult(buffer.shift(), 'found', true, item);
  buffer.clear();
  buffer.push('reused');
  assertValues(retained, expected);
  assertValues(anotherEmpty, []);
  assertState(buffer, ['reused']);
});

test('size is a live getter without a setter', () => {
  const buffer = createRingBuffer(1);
  const descriptor = Object.getOwnPropertyDescriptor(buffer, 'size');
  assert.equal(typeof descriptor.get, 'function');
  assert.equal(descriptor.set, undefined);
  assert.throws(() => { buffer.size = 99; }, TypeError);
  assert.equal(buffer.size, 0);
  buffer.push('first');
  assert.equal(buffer.size, 1);
  assert.throws(() => { buffer.size = 0; }, TypeError);
  assertState(buffer, ['first']);
  buffer.push('second');
  assert.equal(buffer.size, 1);
  buffer.shift();
  assert.equal(buffer.size, 0);
  buffer.shift();
  assert.equal(buffer.size, 0);
  buffer.push('third');
  buffer.clear();
  assert.equal(buffer.size, 0);
});

test('mixed wraparound, clear and reuse match a FIFO oracle across independent instances', () => {
  const states = [1, 2, 3, 7].map(capacity => ({
    capacity, buffer: createRingBuffer(capacity), expected: [],
  }));
  const shared = {};
  const payloads = [undefined, shared, shared, null, false, '', 0, -0, NaN,
    Infinity, 2n, Symbol('model')];

  function step(state, operation, value) {
    const { buffer, expected, capacity } = state;
    if (operation === 'push') {
      const evicted = expected.length === capacity;
      const dropped = evicted ? expected.shift() : undefined;
      expected.push(value);
      assertResult(buffer.push(value), 'evicted', evicted, dropped);
    } else if (operation === 'shift') {
      const found = expected.length > 0;
      assertResult(buffer.shift(), 'found', found, expected.shift());
    } else if (operation === 'clear') {
      assert.equal(buffer.clear(), undefined);
      expected.length = 0;
    } else {
      assertValues(buffer.toArray(), expected);
    }
    for (const current of states) {
      assert.ok(current.buffer.size >= 0 && current.buffer.size <= current.capacity);
      assertState(current.buffer, current.expected);
    }
  }

  // Force empty, partial, full, repeatedly wrapped and completely drained states.
  for (const state of states) {
    for (let round = 0; round < 4; round += 1) {
      step(state, 'clear');
      step(state, 'clear');
      step(state, 'shift');
      step(state, 'push', shared);
      step(state, 'clear');
      for (let index = 0; index < state.capacity; index += 1) step(state, 'push', index);
      step(state, 'clear');
      for (let index = 0; index < state.capacity * 4; index += 1) {
        step(state, 'push', payloads[index % payloads.length]);
      }
      step(state, 'shift');
      step(state, 'push', shared);
      for (let index = 0; index <= state.capacity; index += 1) step(state, 'shift');
      for (let index = 0; index < state.capacity * 3; index += 1) step(state, 'push', index);
      step(state, 'shift');
      step(state, 'clear');
    }
  }

  let seed = 0x66C0FFEE;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  }
  for (let index = 0; index < 2_000; index += 1) {
    const state = states[(random() >>> 16) % states.length];
    const choice = (random() >>> 16) % 10;
    const operation = choice < 6 ? 'push' : choice < 8 ? 'shift' : choice === 8 ? 'clear' : 'snapshot';
    step(state, operation, payloads[(random() >>> 16) % payloads.length]);
  }
  for (const state of states) {
    while (state.expected.length > 0) step(state, 'shift');
    step(state, 'shift');
    step(state, 'clear');
  }
});
