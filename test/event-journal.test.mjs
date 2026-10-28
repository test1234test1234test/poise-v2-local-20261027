import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventJournal, restoreEventJournal } from '../lib/event-journal.mjs';

const event = (id, payload = 1, type = 'add') => ({ id, type, payload });
const options = (requestId, expectedSequence = 0) => ({ requestId, expectedSequence });
const add = (state, event) => state + event.payload;

function history(journal) {
  const records = [];
  let after = 0;
  do {
    const page = journal.read({ after });
    records.push(...page.records);
    after = page.next;
  } while (after !== null);
  return records;
}

function observe(journal) {
  return {
    sequence: journal.sequence,
    snapshot: journal.snapshot(),
    records: history(journal),
    document: journal.export(),
  };
}

function rejectsUnchanged(journal, action, expected) {
  const before = observe(journal);
  assert.throws(action, expected);
  assert.deepEqual(observe(journal), before);
}

function coded(code, details = {}) {
  return error => {
    assert.ok(error instanceof Error);
    assert.ok(Object.hasOwn(error, 'code'));
    assert.equal(error.code, code);
    for (const [key, value] of Object.entries(details)) {
      assert.ok(Object.hasOwn(error, key));
      assert.equal(error[key], value);
    }
    return true;
  };
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

for (const initialState of [null, false, 0, '', true, 'value', 1.25, Number.MAX_VALUE]) {
  test(`scalar initial state ${JSON.stringify(initialState)} and no-op events remain authoritative`, () => {
    let calls = 0;
    const journal = createEventJournal({ initialState, reduce: state => { calls++; return state; } });
    assert.equal(journal.sequence, 0);
    assert.deepEqual(journal.snapshot(), { sequence: 0, state: initialState });
    assert.deepEqual(journal.read(), { records: [], next: null });
    const original = event('e1');
    assert.deepEqual(journal.append([original], options('r1')), {
      requestId: 'r1', fromSequence: 1, toSequence: 1, eventIds: ['e1'],
    });
    assert.equal(calls, 1);
    assert.deepEqual(journal.snapshot(), { sequence: 1, state: initialState });
    assert.deepEqual(journal.read(), { records: [{ sequence: 1, event: original }], next: null });
    assert.throws(() => { journal.sequence = 100; }, TypeError);
    assert.throws(() => Object.defineProperty(journal, 'sequence', { value: 100 }), TypeError);
    assert.equal(journal.sequence, 1);
    assert.deepEqual(restoreEventJournal(journal.export(), state => state).snapshot(), journal.snapshot());
  });
}

test('one event followed by 100 events has contiguous sequences and ordered candidate states', () => {
  const inputs = [];
  const journal = createEventJournal({
    initialState: 0,
    reduce(state, item) { inputs.push([state, item.id]); return state + item.payload; },
  });
  const first = event('e0');
  journal.append([first], options('r0'));
  const batch = Array.from({ length: 100 }, (_, i) => event(`e${i + 1}`));
  assert.deepEqual(journal.append(batch, options('r1', 1)), {
    requestId: 'r1', fromSequence: 2, toSequence: 101, eventIds: batch.map(item => item.id),
  });
  assert.deepEqual(inputs, Array.from({ length: 101 }, (_, i) => [i, `e${i}`]));
  assert.deepEqual(history(journal), [first, ...batch].map((item, i) => ({ sequence: i + 1, event: item })));
  assert.deepEqual(journal.snapshot(), { sequence: 101, state: 101 });
  assert.equal(journal.export().batches.length, 2);
});

test('construction requires exact own data options and a function reducer without calling getters', () => {
  let getters = 0;
  for (const value of [undefined, null, false, 0, '', [], new Date(), Object.create({ initialState: 0, reduce: add })]) {
    assert.throws(() => createEventJournal(value), TypeError);
  }
  for (const reduce of [undefined, null, 1, 'function', {}, []]) {
    assert.throws(() => createEventJournal({ initialState: 0, reduce }), TypeError);
  }
  for (const value of [
    {}, { initialState: 0 }, { reduce: add }, { initialState: 0, reduce: add, extra: true },
    { get initialState() { getters++; return 0; }, reduce: add },
    { initialState: 0, get reduce() { getters++; return add; } },
    Object.defineProperty({ initialState: 0, reduce: add }, 'hidden', { value: 1 }),
    { initialState: 0, reduce: add, [Symbol('extra')]: 1 },
  ]) assert.throws(() => createEventJournal(value), TypeError);
  assert.equal(getters, 0);
});

test('append and read validate option envelopes without getters or inherited defaults', () => {
  let getters = 0;
  let calls = 0;
  const journal = createEventJournal({ initialState: 0, reduce: state => { calls++; return state; } });
  for (const value of [
    undefined, null, [], false, 0, '', new Date(), {},
    { requestId: 'r' }, { expectedSequence: 0 },
    { ...options('r'), extra: 1 }, Object.create(options('r')),
    { requestId: 'r', get expectedSequence() { getters++; return 0; } },
    { expectedSequence: 0, get requestId() { getters++; return 'r'; } },
    Object.defineProperty(options('r'), 'requestId', { enumerable: false }),
    { ...options('r'), [Symbol('extra')]: 1 },
  ]) rejectsUnchanged(journal, () => journal.append([event('e')], value), TypeError);
  for (const value of [
    null, [], false, 0, '', new Date(), { extra: 1 }, Object.create({ after: 1 }),
    { get after() { getters++; return 0; } }, { get limit() { getters++; return 1; } },
    Object.defineProperty({}, 'after', { value: 0 }), { [Symbol('extra')]: 1 },
  ]) rejectsUnchanged(journal, () => journal.read(value), TypeError);
  assert.deepEqual(journal.read({ after: undefined, limit: undefined }), { records: [], next: null });
  assert.equal(getters, 0);
  assert.equal(calls, 0);
  journal.append([event('e')], Object.assign(Object.create(null), options('r')));
  assert.equal(journal.sequence, 1);
  assert.equal(journal.read(Object.create(null)).records.length, 1);
});

const invalidJson = [
  ['undefined', () => undefined], ['function', () => () => 1], ['BigInt', () => 1n],
  ['symbol', () => Symbol('value')], ['NaN', () => NaN],
  ['positive infinity', () => Infinity], ['negative infinity', () => -Infinity],
  ['boxed number', () => new Number(1)], ['boxed string', () => new String('x')],
  ['boxed boolean', () => new Boolean(false)], ['boxed BigInt', () => Object(1n)],
  ['boxed symbol', () => Object(Symbol('x'))],
  ['Date', () => new Date(0)], ['RegExp', () => /x/], ['Map', () => new Map()],
  ['Set', () => new Set()], ['WeakMap', () => new WeakMap()], ['WeakSet', () => new WeakSet()],
  ['Promise', () => Promise.resolve(1)], ['Error', () => new Error('bad')],
  ['typed array', () => new Uint8Array([1])], ['ArrayBuffer', () => new ArrayBuffer(1)],
  ['DataView', () => new DataView(new ArrayBuffer(1))],
  ['custom object prototype', () => Object.create({ inherited: 1 })],
  ['class instance', () => new (class Item {})()],
  ['sparse array', () => [1, , 3]], ['trailing hole', () => new Array(1)],
  ['array metadata', () => Object.assign([1], { note: 2 })],
  ['array symbol', () => Object.assign([1], { [Symbol('x')]: 2 })],
  ['hidden array index', () => Object.defineProperty([1], '0', { enumerable: false })],
  ['custom array prototype', () => Object.setPrototypeOf([1], Object.create(Array.prototype))],
  ['null array prototype', () => Object.setPrototypeOf([1], null)],
  ['array subclass', () => new (class Items extends Array {})(1, 2)],
  ['inherited array index', () => Object.setPrototypeOf(new Array(1), Object.assign(Object.create(Array.prototype), { 0: 1 }))],
  ['hidden member', () => Object.defineProperty({}, 'x', { value: 1 })],
  ['symbol member', () => ({ [Symbol('x')]: 1 })],
  ['toJSON function', () => ({ toJSON() { throw new Error('must not execute'); } })],
  ['object cycle', () => { const value = {}; value.self = value; return value; }],
  ['array cycle', () => { const value = []; value.push(value); return value; }],
  ['null-prototype Date', () => Object.setPrototypeOf(new Date(0), null)],
  ['plain-prototype Map', () => Object.setPrototypeOf(new Map(), Object.prototype)],
  ['null-prototype boxed number', () => Object.setPrototypeOf(new Number(1), null)],
  ['object accessor', count => Object.defineProperty({}, 'x', { enumerable: true, get() { count.calls++; return 1; } })],
  ['array accessor', count => Object.defineProperty([1], '0', { get() { count.calls++; return 1; } })],
  ['proxy', count => new Proxy({}, {
    get() { count.calls++; return 1; }, ownKeys() { count.calls++; return []; },
    getPrototypeOf() { count.calls++; return Object.prototype; },
  })],
  ['revoked proxy', () => { const proxy = Proxy.revocable({}, {}); proxy.revoke(); return proxy.proxy; }],
];

for (const [name, make] of invalidJson) {
  test(`strict JSON rejects ${name} in state, nested payload, reducer result and restore before getters`, () => {
    const count = { calls: 0 };
    assert.throws(() => createEventJournal({ initialState: { nested: make(count) }, reduce: add }), TypeError);
    let calls = 0;
    let badResult = false;
    const journal = createEventJournal({
      initialState: 0,
      reduce(state, item) { calls++; return badResult ? { nested: make(count) } : state + item.payload; },
    });
    journal.append([event('seed')], options('seed'));
    rejectsUnchanged(journal, () => journal.append([
      event('first'), event('last', { nested: make(count) }),
    ], options('attempt', 1)), TypeError);
    assert.equal(calls, 1, 'the invalid last event is rejected before any reduction');
    badResult = true;
    rejectsUnchanged(journal, () => journal.append([event('first'), event('last')], options('attempt', 1)), TypeError);
    assert.equal(calls, 2, 'an invalid returned state is rejected after its reducer call');
    badResult = false;
    const receipt = journal.append([event('first'), event('last')], options('attempt', 1));
    assert.deepEqual(receipt.eventIds, ['first', 'last']);
    assert.deepEqual(journal.snapshot(), { sequence: 3, state: 3 });
    const document = journal.export();
    document.batches[1].events[1].payload = { nested: make(count) };
    let replayCalls = 0;
    assert.throws(() => restoreEventJournal(document, state => { replayCalls++; return state; }), TypeError);
    assert.equal(replayCalls, 0);
    assert.equal(count.calls, 0, 'validation must not invoke accessors, proxy traps or toJSON');
  });
}

test('event envelopes require exactly id, type and payload, including in the last event', () => {
  let getters = 0;
  let calls = 0;
  const journal = createEventJournal({ initialState: 0, reduce: state => { calls++; return state; } });
  const invalid = [
    null, undefined, [], 'event', {}, { id: 'last', type: 'add' },
    { type: 'add', payload: 1 }, { id: 'last', payload: 1 },
    { ...event('last'), extra: 1 },
    Object.create(event('last')),
    { id: 'last', type: 'add', get payload() { getters++; return 1; } },
    { get id() { getters++; return 'last'; }, type: 'add', payload: 1 },
    { id: 'last', get type() { getters++; return 'add'; }, payload: 1 },
    Object.defineProperty(event('last'), 'id', { enumerable: false }),
  ];
  for (const item of invalid) {
    rejectsUnchanged(journal, () => journal.append([event('first'), item], options('r')), TypeError);
  }
  assert.equal(calls, 0);
  assert.equal(getters, 0);
  journal.append([event('first'), event('last')], options('r'));
  assert.deepEqual(history(journal).map(record => record.event.id), ['first', 'last']);
});

test('event containers reject non-arrays, sparse or decorated arrays and out-of-bounds sizes', () => {
  let getters = 0;
  let calls = 0;
  const journal = createEventJournal({ initialState: 0, reduce: state => { calls++; return state; } });
  for (const events of [
    undefined, null, {}, { 0: event('e'), length: 1 }, 'events',
    [event('e'), ,], Object.assign([event('e')], { note: 1 }),
    Object.defineProperty([event('e')], '0', { enumerable: false }),
    Object.defineProperty([event('e')], '0', { get() { getters++; return event('e'); } }),
    Object.assign([event('e')], { [Symbol('note')]: 1 }),
    Object.setPrototypeOf([event('e')], Object.create(Array.prototype)),
    new (class Events extends Array {})(event('e')),
    new Proxy([event('e')], { get() { getters++; return 1; } }),
  ]) rejectsUnchanged(journal, () => journal.append(events, options('r')), TypeError);
  for (const events of [[], Array.from({ length: 101 }, (_, i) => event(`e${i}`))]) {
    rejectsUnchanged(journal, () => journal.append(events, options('r')), RangeError);
  }
  assert.equal(calls, 0);
  assert.equal(getters, 0);
  journal.append(Object.freeze([Object.freeze(event('e'))]), Object.freeze(options('r')));
  assert.equal(journal.sequence, 1);
});

const invalidIdentifiers = [undefined, null, 1, false, {}, [], new String('id'), '', ' ',
  ' leading', 'trailing ', '\u00a0id', 'id\ufeff', 'id\u2028', 'a\n b', 'a\u0000b',
  'a\u001fb', 'a\u007fb', 'a\u0085b', 'a\u009fb'];

for (const field of ['id', 'type', 'requestId']) {
  test(`${field} uses primitive trimmed strings with no C0/C1 controls`, () => {
    let calls = 0;
    const journal = createEventJournal({ initialState: 0, reduce: state => { calls++; return state; } });
    for (const value of invalidIdentifiers) {
      const item = event('e');
      const input = options('r');
      (field === 'requestId' ? input : item)[field] = value;
      rejectsUnchanged(journal, () => journal.append([item], input), TypeError);
    }
    assert.equal(calls, 0);
    const valid = 'é 中\u2028x'; // Interior ECMAScript whitespace is allowed outside C0/C1.
    const item = event(valid, { '': '\u0000\n ', ' \u0000': '' }, valid);
    journal.append([item], options(valid));
    assert.deepEqual(journal.read().records[0].event, item);
  });
}

for (const field of ['expectedSequence', 'after', 'limit']) {
  test(`${field} distinguishes type errors from numeric range errors`, () => {
    const journal = createEventJournal({ initialState: 0, reduce: add });
    const call = value => field === 'expectedSequence'
      ? journal.append([event('e')], { requestId: 'r', expectedSequence: value })
      : journal.read({ [field]: value });
    for (const value of [null, false, '0', {}, [], 0n, new Number(0), () => 0, Symbol('0')]) {
      rejectsUnchanged(journal, () => call(value), TypeError);
    }
    for (const value of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1,
      ...(field === 'limit' ? [0, -0, 101, Number.MAX_SAFE_INTEGER] : [])]) {
      rejectsUnchanged(journal, () => call(value), RangeError);
    }
    if (field === 'expectedSequence') {
      rejectsUnchanged(journal, () => call(undefined), TypeError);
      rejectsUnchanged(journal, () => call(Number.MAX_SAFE_INTEGER), coded('SEQUENCE_CONFLICT', {
        expected: Number.MAX_SAFE_INTEGER, actual: 0,
      }));
      call(-0);
      assert.equal(Object.is(journal.export().batches[0].expectedSequence, -0), false);
    } else if (field === 'after') {
      assert.deepEqual(call(Number.MAX_SAFE_INTEGER), { records: [], next: null });
      assert.deepEqual(call(-0), { records: [], next: null });
    } else {
      assert.deepEqual(call(1), { records: [], next: null });
      assert.deepEqual(call(100), { records: [], next: null });
    }
  });
}

test('JSON numbers allow fractions and unsafe finite integers and normalize signed zero', () => {
  const journal = createEventJournal({ initialState: -0, reduce: (_state, item) => item.payload });
  assert.equal(Object.is(journal.snapshot().state, -0), false);
  const numbers = [-0, 0.25, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE, Number.MIN_VALUE];
  numbers.forEach((value, i) => journal.append([event(`e${i}`, value)], options(`r${i}`, i)));
  assert.deepEqual(history(journal).map(record => record.event.payload), [0, ...numbers.slice(1)]);
  assert.equal(journal.snapshot().state, Number.MIN_VALUE);
});

const sentinel = Object.freeze(new Error('reducer failed'));
const failures = [
  ['frozen Error', () => { throw sentinel; }, error => error === sentinel],
  ['primitive throw', () => { throw 'sentinel'; }, error => error === 'sentinel'],
  ['undefined throw', () => { throw undefined; }, error => error === undefined],
  ['undefined result', () => undefined, TypeError],
  ['cycle result', state => { state.self = state; return state; }, TypeError],
  ['accessor result', (state, counter) => Object.defineProperty(state, 'hidden', {
    enumerable: true, get() { counter.calls++; return 1; },
  }), TypeError],
];

for (const [name, fail, expected] of failures) {
  for (const failAt of [0, 1, 2]) {
    test(`${name} at candidate ${failAt + 1} rolls back the whole batch and releases all reservations`, () => {
      let failing = true;
      let calls = 0;
      const counter = { calls: 0 };
      const retained = [];
      const journal = createEventJournal({
        initialState: { sum: 0 },
        reduce(state, item) {
          calls++;
          const index = ['first', 'middle', 'last'].indexOf(item.id);
          state.sum += item.payload.amount;
          retained.push([state, item]);
          item.id = 'mutated';
          item.type = 'changed';
          item.payload.amount = 500;
          if (failing && index === failAt) return fail(state, counter);
          return state;
        },
      });
      journal.append([event('seed', { amount: 10 })], options('seed'));
      const batch = [event('first', { amount: 2 }), event('middle', { amount: 3 }), event('last', { amount: 4 })];
      const originalBatch = structuredClone(batch);
      const before = observe(journal);
      rejectsUnchanged(journal, () => journal.append(batch, options('attempt', 1)), expected);
      assert.equal(calls, 2 + failAt);
      assert.equal(counter.calls, 0);
      assert.deepEqual(batch, originalBatch);
      for (const [state, item] of retained) { state.sum = -100; item.payload.amount = -100; }
      assert.deepEqual(observe(journal), before, 'retained failed candidates cannot mutate committed data');
      failing = false;
      const receipt = journal.append(batch, options('attempt', 1));
      assert.deepEqual(receipt, {
        requestId: 'attempt', fromSequence: 2, toSequence: 4, eventIds: ['first', 'middle', 'last'],
      });
      assert.deepEqual(journal.snapshot(), { sequence: 4, state: { sum: 19 } });
      assert.deepEqual(history(journal).slice(1).map(record => record.event), originalBatch);
      const committed = observe(journal);
      for (const [state, item] of retained) { state.sum = 900; item.payload.amount = 900; }
      assert.deepEqual(observe(journal), committed);
      const beforeRetry = calls;
      assert.deepEqual(journal.append(batch, options('attempt', 1)), receipt);
      assert.equal(calls, beforeRetry);
    });
  }
}

test('falsy reducer results are validated states, not missing results', () => {
  const values = [null, false, 0, ''];
  const states = [];
  const journal = createEventJournal({
    initialState: 'initial',
    reduce(state, item) { states.push(state); return item.payload; },
  });
  journal.append(values.map((value, i) => event(`e${i}`, value)), options('r'));
  assert.deepEqual(states, ['initial', null, false, 0]);
  assert.deepEqual(journal.snapshot(), { sequence: 4, state: '' });
  assert.deepEqual(history(journal).map(record => record.event.payload), values);
});

test('stale requests report supplied and current sequences and reserve nothing', () => {
  let calls = 0;
  const journal = createEventJournal({ initialState: 0, reduce: (state, item) => { calls++; return add(state, item); } });
  journal.append([event('seed')], options('seed'));
  rejectsUnchanged(journal, () => journal.append([event('next')], options('attempt', 0)),
    coded('SEQUENCE_CONFLICT', { expected: 0, actual: 1 }));
  rejectsUnchanged(journal, () => journal.append([event('next')], options('attempt', 2)),
    coded('SEQUENCE_CONFLICT', { expected: 2, actual: 1 }));
  assert.equal(calls, 1);
  assert.deepEqual(journal.append([event('next')], options('attempt', 1)), {
    requestId: 'attempt', fromSequence: 2, toSequence: 2, eventIds: ['next'],
  });
  assert.deepEqual(journal.snapshot(), { sequence: 2, state: 2 });
});

test('duplicate IDs within and across batches reject every prefix and permit recovery', () => {
  let calls = 0;
  const journal = createEventJournal({ initialState: 0, reduce: (state, item) => { calls++; return add(state, item); } });
  journal.append([event('seed')], options('seed'));
  rejectsUnchanged(journal, () => journal.append([event('a'), event('b'), event('a')], options('attempt', 1)),
    coded('DUPLICATE_EVENT', { eventId: 'a' }));
  rejectsUnchanged(journal, () => journal.append([event('a'), event('b'), event('seed')], options('attempt', 1)),
    coded('DUPLICATE_EVENT', { eventId: 'seed' }));
  assert.equal(calls, 1);
  journal.append([event('a'), event('b'), event('A')], options('attempt', 1));
  assert.deepEqual(journal.snapshot(), { sequence: 4, state: 4 });
  assert.deepEqual(history(journal).map(record => record.event.id), ['seed', 'a', 'b', 'A']);
});

test('old retries use structural input equality and independent original receipts after later work', () => {
  let calls = 0;
  const journal = createEventJournal({ initialState: [], reduce(state, item) { calls++; state.push(item.payload); return state; } });
  const first = [event('a1', { z: [-0, { b: 2, a: 1 }], a: { x: true } }), event('a2', null)];
  const receipt = journal.append(first, options('A'));
  const receiptValue = structuredClone(receipt);
  journal.append([event('b')], options('B', 2));
  const before = observe(journal);
  receipt.eventIds.reverse();
  receipt.eventIds.push('invented');
  receipt.requestId = 'changed';
  receipt.fromSequence = 900;
  const retry = [
    Object.assign(Object.create(null), {
      payload: { a: { x: true }, z: [0, { a: 1, b: 2 }] }, type: 'add', id: 'a1',
    }), event('a2', null),
  ];
  const result = journal.append(deepFreeze(retry), options('A'));
  assert.deepEqual(result, receiptValue);
  assert.notEqual(result, receipt);
  assert.notEqual(result.eventIds, receipt.eventIds);
  result.eventIds[0] = 'also changed';
  assert.deepEqual(journal.append(first, options('A')), receiptValue);
  assert.equal(calls, 3);
  assert.deepEqual(observe(journal), before);
});

test('valid request reuse with different ordered input conflicts without calling reduce', () => {
  let calls = 0;
  const journal = createEventJournal({ initialState: 0, reduce: state => { calls++; return state; } });
  const first = [event('a', { list: [1, 2], nullable: null }), event('b', true)];
  const receipt = journal.append(first, options('A'));
  journal.append([event('later')], options('B', 2));
  const cases = [
    [first, options('A', 1)],
    [[...first].reverse(), options('A')],
    [[{ ...first[0], id: 'different' }, first[1]], options('A')],
    [[{ ...first[0], type: 'different' }, first[1]], options('A')],
    [[event('a', { list: [2, 1], nullable: null }), first[1]], options('A')],
    [[event('a', { list: [1, 2] }), first[1]], options('A')],
    [[event('a', { list: { 0: 1, 1: 2 }, nullable: null }), first[1]], options('A')],
    [[event('a', { list: [1, 2, null], nullable: null }), first[1]], options('A')],
    [[first[0], event('b', 1)], options('A')],
    [[first[0]], options('A')],
  ];
  for (const [batch, input] of cases) {
    rejectsUnchanged(journal, () => journal.append(batch, input), coded('REQUEST_CONFLICT'));
  }
  assert.equal(calls, 3);
  assert.deepEqual(journal.append(first, options('A')), receipt);
  assert.equal(calls, 3);
});

test('argument validation precedes retry conflicts, then sequence precedes duplicate checks', () => {
  let calls = 0;
  const journal = createEventJournal({ initialState: 0, reduce: state => { calls++; return state; } });
  journal.append([event('e')], options('r'));
  rejectsUnchanged(journal, () => journal.append([event('e', NaN)], options('r')), TypeError);
  rejectsUnchanged(journal, () => journal.append([event('e')], options('r', -1)), RangeError);
  rejectsUnchanged(journal, () => journal.append([], options('r')), RangeError);
  rejectsUnchanged(journal, () => journal.append([event('e'), event('e', undefined)], options('other')),
    coded('SEQUENCE_CONFLICT', { expected: 0, actual: 1 }));
  rejectsUnchanged(journal, () => journal.append([event('e'), { id: 'bad', type: 'add', payload: undefined }], options('other')), TypeError);
  assert.equal(calls, 1);
});

test('the entire batch and options are captured before a reducer mutates later caller input', () => {
  const batch = [event('first', { n: 1 }), event('second', { n: 2 })];
  const input = options('original');
  const original = structuredClone(batch);
  const seen = [];
  const journal = createEventJournal({
    initialState: 0,
    reduce(state, item) {
      seen.push(structuredClone(item));
      if (item.id === 'first') {
        batch[1].id = 'external mutation';
        batch[1].type = 'changed';
        batch[1].payload.n = 500;
        batch.push(event('extra'));
        input.requestId = 'changed';
        input.expectedSequence = 999;
      }
      return state + item.payload.n;
    },
  });
  const receipt = journal.append(batch, input);
  assert.deepEqual(seen, original);
  assert.deepEqual(receipt, { requestId: 'original', fromSequence: 1, toSequence: 2, eventIds: ['first', 'second'] });
  assert.deepEqual(journal.snapshot(), { sequence: 2, state: 3 });
  assert.deepEqual(history(journal).map(record => record.event), original);
  assert.deepEqual(journal.export().batches, [{ ...options('original'), events: original }]);
  assert.deepEqual(journal.append(original, options('original')), receipt);
  assert.equal(seen.length, 2);
});

test('returning event.payload or state and retaining callback references never exposes live data', () => {
  const retained = [];
  const initialState = { n: 0 };
  const journal = createEventJournal({
    initialState,
    reduce(state, item) {
      // References from earlier calls must already be detached from this state.
      for (const [oldState, oldEvent, oldResult] of retained) {
        oldState.n = 900; oldEvent.payload.n = 900; oldResult.n = 900;
      }
      const result = item.id === 'first' ? item.payload : state;
      if (item.id !== 'first') result.n += item.payload.n;
      retained.push([state, item, result]);
      item.id = 'rewritten'; item.type = 'rewritten';
      return result;
    },
  });
  initialState.n = 100;
  const batch = [event('first', { n: 2 }), event('second', { n: 3 })];
  const receipt = journal.append(batch, options('r'));
  assert.deepEqual(journal.snapshot(), { sequence: 2, state: { n: 5 } });
  assert.deepEqual(history(journal).map(record => record.event), batch);
  assert.deepEqual(receipt.eventIds, ['first', 'second']);
  assert.deepEqual(journal.export().initialState, { n: 0 });
  for (const [state, item, result] of retained) {
    state.n = 700; item.payload.n = 700; result.n = 700;
  }
  batch[0].payload.n = 800;
  batch[1].id = 'modified later';
  assert.deepEqual(journal.snapshot(), { sequence: 2, state: { n: 5 } });
  assert.deepEqual(history(journal).map(record => record.event), [event('first', { n: 2 }), event('second', { n: 3 })]);
  assert.notEqual(retained[0][0], retained[1][0]);
  assert.notEqual(retained[0][2], retained[1][0]);
});

test('pages, snapshots, receipts and every export branch are independent mutable copies', () => {
  const journal = createEventJournal({ initialState: { n: 0 }, reduce: (_state, item) => item.payload });
  const batch = [event('e', { n: 2 })];
  const receipt = journal.append(batch, options('r'));
  const before = observe(journal);
  const page = journal.read();
  const snapshot = journal.snapshot();
  const document = journal.export();
  page.records[0].sequence = 100;
  page.records[0].event.id = 'changed';
  page.records[0].event.payload.n = 100;
  page.records.push({ sequence: 999, event: event('fake') });
  page.next = 999;
  snapshot.sequence = 100;
  snapshot.state.n = 100;
  receipt.requestId = 'changed'; receipt.eventIds[0] = 'changed'; receipt.toSequence = 100;
  document.formatVersion = 99;
  document.initialState.n = 100;
  document.batches[0].requestId = 'changed';
  document.batches[0].expectedSequence = 100;
  document.batches[0].events[0].payload.n = 100;
  document.batches.push({});
  document.snapshot.state.n = 100;
  document.snapshot.sequence = 100;
  assert.deepEqual(observe(journal), before);
  assert.deepEqual(journal.append(batch, options('r')), {
    requestId: 'r', fromSequence: 1, toSequence: 1, eventIds: ['e'],
  });
  const earlier = observe(journal);
  journal.append([event('next', { n: 3 })], options('next', 1));
  assert.deepEqual(earlier, before, 'later appends cannot mutate previously returned objects');
  assert.deepEqual(journal.snapshot(), { sequence: 2, state: { n: 3 } });
});

test('prototype-like keys and IDs remain ordinary data with independent namespaces', () => {
  const keys = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString'];
  const payload = JSON.parse('{"__proto__":{"polluted":true},"constructor":2,"prototype":3,"hasOwnProperty":4,"toString":5}');
  const journal = createEventJournal({ initialState: payload, reduce: (_state, item) => item.payload });
  for (const [i, key] of keys.entries()) journal.append([event(key, payload)], options(key, i));
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(journal.snapshot(), { sequence: 5, state: payload });
  const returned = journal.snapshot().state;
  assert.equal(Object.getPrototypeOf(returned), Object.prototype);
  assert.ok(Object.hasOwn(returned, '__proto__'));
  assert.deepEqual(Object.getOwnPropertyDescriptor(returned, '__proto__'), {
    value: { polluted: true }, enumerable: true, configurable: true, writable: true,
  });
  assert.deepEqual(history(journal).map(record => record.event.id), keys);
  const before = observe(journal);
  assert.deepEqual(journal.append([event('__proto__', payload)], options('__proto__')), {
    requestId: '__proto__', fromSequence: 1, toSequence: 1, eventIds: ['__proto__'],
  });
  assert.deepEqual(observe(journal), before);
  assert.deepEqual(restoreEventJournal(JSON.parse(JSON.stringify(journal.export())), (_state, item) => item.payload).export(), journal.export());
});

test('shared, frozen, null-prototype data and reducer results normalize across JSON text replay', () => {
  const pair = n => {
    const shared = Object.freeze(Object.assign(Object.create(null), { n }));
    return Object.freeze(Object.assign(Object.create(null), { b: shared, zero: -0, a: shared }));
  };
  let calls = 0;
  const reduce = (state, item) => {
    calls++;
    for (const value of [state, item, item.payload, state.a, item.payload.a]) {
      assert.equal(Object.getPrototypeOf(value), Object.prototype);
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        assert.equal(descriptor.enumerable, true);
        assert.equal(descriptor.writable, true);
        assert.equal(descriptor.configurable, true);
      }
    }
    assert.notEqual(state.a, state.b);
    assert.notEqual(item.payload.a, item.payload.b);
    assert.equal(Object.is(state.zero, -0), false);
    assert.equal(Object.is(item.payload.zero, -0), false);
    state.a.n = 900;
    item.payload.a.n = 900;
    return pair(state.b.n + item.payload.b.n);
  };
  const initialState = pair(1);
  const journal = createEventJournal(Object.freeze(Object.assign(Object.create(null), { initialState, reduce })));
  const batch = Object.freeze([
    Object.freeze(Object.assign(Object.create(null), event('first', pair(2)))),
    Object.freeze(Object.assign(Object.create(null), event('second', pair(4)))),
  ]);
  const receipt = journal.append(batch, Object.freeze(Object.assign(Object.create(null), options('r'))));
  assert.deepEqual(journal.snapshot(), { sequence: 2, state: { a: { n: 7 }, b: { n: 7 }, zero: 0 } });
  assert.equal(initialState.a.n, 1);
  assert.equal(batch[0].payload.a.n, 2);
  const document = JSON.parse(JSON.stringify(journal.export()));
  const restored = restoreEventJournal(document, reduce);
  assert.equal(calls, 4);
  assert.deepEqual(restored.export(), journal.export());
  assert.deepEqual(restored.append(batch, options('r')), receipt);
  assert.equal(calls, 4);
});

test('canonical object member order is consistent before reducers, retries and replay', () => {
  const reduce = (state, item) => [...state, Object.keys(item.payload), Object.keys(item.payload.nested)];
  const journal = createEventJournal({ initialState: [], reduce });
  const first = [event('e', { z: 1, 10: 10, 2: 2, a: 2, nested: { z: 3, a: 4 } })];
  const receipt = journal.append(first, options('r'));
  assert.deepEqual(journal.snapshot().state, [['2', '10', 'a', 'nested', 'z'], ['a', 'z']]);
  const document = journal.export();
  document.batches[0].events[0].payload = { nested: { a: 4, z: 3 }, a: 2, 2: 2, 10: 10, z: 1 };
  const restored = restoreEventJournal(document, reduce);
  assert.deepEqual(restored.snapshot(), journal.snapshot());
  assert.deepEqual(restored.append(first, options('r')), receipt);
});

test('pagination over 201 events uses exclusive cursors and next only when records remain', () => {
  let calls = 0;
  const journal = createEventJournal({ initialState: 0, reduce: state => { calls++; return state + 1; } });
  const events = Array.from({ length: 201 }, (_, i) => event(`e${i + 1}`, { value: i + 1 }));
  journal.append(events.slice(0, 100), options('r1'));
  journal.append(events.slice(100, 200), options('r2', 100));
  journal.append(events.slice(200), options('r3', 200));
  const before = journal.export();
  const cases = [
    [undefined, 0, 100, 100], [{ after: 100 }, 100, 200, 200], [{ after: 200 }, 200, 201, null],
    [{ after: 101, limit: 100 }, 101, 201, null], [{ after: 51, limit: 50 }, 51, 101, 101],
    [{ after: 199, limit: 1 }, 199, 200, 200], [{ after: 200, limit: 1 }, 200, 201, null],
    [{ after: 201 }, 201, 201, null], [{ after: 202 }, 201, 201, null],
    [{ after: Number.MAX_SAFE_INTEGER }, 201, 201, null],
  ];
  for (const [input, start, end, next] of cases) {
    const page = journal.read(input);
    assert.deepEqual(page, {
      records: events.slice(start, end).map((item, i) => ({ sequence: start + i + 1, event: item })), next,
    });
    if (page.records.length) page.records[0].event.payload.value = -1;
  }
  assert.deepEqual(journal.snapshot(), { sequence: 201, state: 201 });
  assert.equal(calls, 201);
  assert.deepEqual(journal.export(), before);
});

test('caught nested appends, including retries, retain the outer guard and committed read view', () => {
  let journal;
  let nesting = false;
  let calls = 0;
  let committed;
  const other = createEventJournal({ initialState: 0, reduce: add });
  journal = createEventJournal({
    initialState: 0,
    reduce(state, item) {
      calls++;
      if (nesting) {
        assert.deepEqual(observe(journal), committed);
        assert.throws(() => journal.append([event('nested')], options('nested', journal.sequence)), coded('REENTRANT_APPEND'));
        assert.throws(() => journal.append([event('seed')], options('seed')), coded('REENTRANT_APPEND'));
        assert.throws(() => journal.append(null, null), coded('REENTRANT_APPEND'));
        assert.deepEqual(observe(journal), committed);
        other.append([event(item.id)], options(item.id, other.sequence));
      }
      return state + item.payload;
    },
  });
  journal.append([event('seed')], options('seed'));
  committed = observe(journal);
  nesting = true;
  journal.append([event('first'), event('last')], options('outer', 1));
  assert.equal(calls, 3);
  assert.deepEqual(journal.snapshot(), { sequence: 3, state: 3 });
  assert.deepEqual(other.snapshot(), { sequence: 2, state: 2 });
  nesting = false;
  journal.append([event('nested')], options('nested', 3));
  assert.deepEqual(journal.snapshot(), { sequence: 4, state: 4 });
});

for (const failAt of ['first', 'last']) {
  test(`propagated reentrant append on ${failAt} rolls back the outer request and releases its guard`, () => {
    let journal;
    let nesting = false;
    let calls = 0;
    journal = createEventJournal({
      initialState: 0,
      reduce(state, item) {
        calls++;
        if (nesting && item.id === failAt) {
          journal.append([event('nested')], options('nested', journal.sequence));
        }
        return state + item.payload;
      },
    });
    journal.append([event('seed')], options('seed'));
    nesting = true;
    const batch = [event('first'), event('last')];
    rejectsUnchanged(journal, () => journal.append(batch, options('outer', 1)), coded('REENTRANT_APPEND'));
    assert.equal(calls, failAt === 'first' ? 2 : 3);
    nesting = false;
    journal.append(batch, options('outer', 1));
    journal.append([event('nested')], options('nested', 3));
    assert.deepEqual(journal.snapshot(), { sequence: 4, state: 4 });
    assert.deepEqual(history(journal).map(record => record.event.id), ['seed', 'first', 'last', 'nested']);
  });
}

function sampleExport() {
  const journal = createEventJournal({ initialState: 0, reduce: add });
  journal.append([event('a', 1), event('b', 2)], options('A'));
  journal.append([event('c', 3)], options('B', 2));
  return journal.export();
}

// Remember descriptors without reading property values through getters. Checking
// each source object separately also detects mutations below retained references.
function rememberDescriptors(value, seen = new Map()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return seen;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  seen.set(value, { prototype: Object.getPrototypeOf(value), descriptors });
  for (const descriptor of Object.values(descriptors)) {
    if (Object.hasOwn(descriptor, 'value')) rememberDescriptors(descriptor.value, seen);
  }
  return seen;
}

function assertDescriptorsUnchanged(remembered) {
  for (const [object, before] of remembered) {
    assert.equal(Object.getPrototypeOf(object), before.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptors(object), before.descriptors);
  }
}

test('export has the documented exact empty and multi-batch schemas', () => {
  const empty = createEventJournal({ initialState: 0, reduce: add });
  assert.deepEqual(empty.export(), {
    formatVersion: 1, initialState: 0, batches: [], snapshot: { sequence: 0, state: 0 },
  });
  let calls = 0;
  const restored = restoreEventJournal(empty.export(), (state, item) => { calls++; return add(state, item); });
  assert.equal(calls, 0);
  assert.deepEqual(restored.export(), empty.export());
  restored.append([event('first', 2)], options('first'));
  assert.deepEqual(restored.snapshot(), { sequence: 1, state: 2 });
  assert.deepEqual(sampleExport(), {
    formatVersion: 1, initialState: 0,
    batches: [
      { requestId: 'A', expectedSequence: 0, events: [event('a', 1), event('b', 2)] },
      { requestId: 'B', expectedSequence: 2, events: [event('c', 3)] },
    ],
    snapshot: { sequence: 3, state: 6 },
  });
});

const schemaLevels = [
  ['root', document => document, ['formatVersion', 'initialState', 'batches', 'snapshot']],
  ['batch', document => document.batches[1], ['requestId', 'expectedSequence', 'events']],
  ['event', document => document.batches[1].events[0], ['id', 'type', 'payload']],
  ['snapshot', document => document.snapshot, ['sequence', 'state']],
];

for (const [name, select, keys] of schemaLevels) {
  test(`restore validates all ${name} schema fields and descriptors before replay`, () => {
    let calls = 0;
    let getters = 0;
    const mutations = [
      target => { target.extra = 1; },
      target => { target[Symbol('extra')] = 1; },
      ...keys.flatMap(key => [
        target => { delete target[key]; },
        target => { Object.defineProperty(target, key, { enumerable: false }); },
        target => { Object.defineProperty(target, key, { get() { getters++; return 1; } }); },
      ]),
    ];
    for (const mutate of mutations) {
      const document = sampleExport();
      mutate(select(document));
      const remembered = rememberDescriptors(document);
      assert.throws(() => restoreEventJournal(document, state => { calls++; return state; }), TypeError);
      assertDescriptorsUnchanged(remembered);
    }
    assert.equal(calls, 0);
    assert.equal(getters, 0);
  });
}

const corruptExports = [
  ['unsupported numeric version', document => { document.formatVersion = 2; }, TypeError],
  ['unsupported version type', document => { document.formatVersion = '1'; }, TypeError],
  ['non-array batches', document => { document.batches = {}; }, TypeError],
  ['sparse batches', document => { delete document.batches[1]; }, TypeError],
  ['batches metadata', document => { document.batches.note = 1; }, TypeError],
  ['custom batches prototype', document => { Object.setPrototypeOf(document.batches, Object.create(Array.prototype)); }, TypeError],
  ['empty events', document => { document.batches[1].events = []; }, RangeError],
  ['too many events', document => { document.batches[1].events = Array.from({ length: 101 }, (_, i) => event(`extra${i}`)); }, RangeError],
  ['non-array events', document => { document.batches[1].events = {}; }, TypeError],
  ['event array metadata', document => { document.batches[1].events.extra = 1; }, TypeError],
  ['hidden event index', document => { Object.defineProperty(document.batches[1].events, '0', { enumerable: false }); }, TypeError],
  ['malformed late identifier', document => { document.batches[1].events[0].id = ' bad'; }, TypeError],
  ['malformed late request ID', document => { document.batches[1].requestId = '\n'; }, TypeError],
  ['negative expectedSequence', document => { document.batches[1].expectedSequence = -1; }, RangeError],
  ['wrong sequence type', document => { document.batches[1].expectedSequence = '2'; }, TypeError],
  ['unsafe sequence', document => { document.batches[1].expectedSequence = Number.MAX_SAFE_INTEGER + 1; }, RangeError],
  ['sequence gap', document => { document.batches[1].expectedSequence = 3; }, coded('SEQUENCE_CONFLICT', { expected: 3, actual: 2 })],
  ['stale sequence', document => { document.batches[1].expectedSequence = 0; }, coded('SEQUENCE_CONFLICT', { expected: 0, actual: 2 })],
  ['first sequence gap', document => { document.batches[0].expectedSequence = 1; }, coded('SEQUENCE_CONFLICT', { expected: 1, actual: 0 })],
  ['identical repeated request row', document => { document.batches.push(document.batches[0]); }, coded('REQUEST_CONFLICT')],
  ['conflicting request row', document => { document.batches[1].requestId = 'A'; }, coded('REQUEST_CONFLICT')],
  ['historical duplicate event', document => { document.batches[1].events[0].id = 'a'; }, coded('DUPLICATE_EVENT', { eventId: 'a' })],
  ['nonadjacent duplicate event', document => { document.batches[0].events.push(event('a')); }, coded('DUPLICATE_EVENT', { eventId: 'a' })],
  ['wrong final sequence', document => { document.snapshot.sequence = 4; }, TypeError],
  ['forged MAX_SAFE_INTEGER snapshot', document => { document.snapshot.sequence = Number.MAX_SAFE_INTEGER; }, TypeError],
  ['negative snapshot sequence', document => { document.snapshot.sequence = -1; }, RangeError],
  ['fractional snapshot sequence', document => { document.snapshot.sequence = 3.5; }, RangeError],
  ['string snapshot sequence', document => { document.snapshot.sequence = '3'; }, TypeError],
  ['malformed snapshot state', document => { document.snapshot.state = undefined; }, TypeError],
  ['malformed initial state', document => { document.initialState = NaN; }, TypeError],
];

for (const [name, corrupt, expected] of corruptExports) {
  test(`restore rejects ${name} without reducing any batch or modifying the document`, () => {
    const document = sampleExport();
    corrupt(document);
    const remembered = rememberDescriptors(document);
    let calls = 0;
    assert.throws(() => restoreEventJournal(document, (state, item) => { calls++; return add(state, item); }), expected);
    assert.equal(calls, 0);
    assertDescriptorsUnchanged(remembered);
    // A valid document still restores normally after a failed restore.
    assert.deepEqual(restoreEventJournal(sampleExport(), add).snapshot(), { sequence: 3, state: 6 });
  });
}

test('restore validates its root and reducer arguments', () => {
  let calls = 0;
  for (const document of [undefined, null, false, 1, 'document', [], new Date()]) {
    assert.throws(() => restoreEventJournal(document, state => { calls++; return state; }), TypeError);
  }
  const document = sampleExport();
  for (const reduce of [undefined, null, false, 1, 'reduce', {}, []]) {
    assert.throws(() => restoreEventJournal(document, reduce), TypeError);
  }
  assert.equal(calls, 0);
});

test('a structurally valid but wrong final state is rejected only after replay, never adopted', () => {
  for (const wrong of [0, '6', null, false, [], { value: 6 }]) {
    const document = sampleExport();
    document.snapshot.state = wrong;
    const before = structuredClone(document);
    let calls = 0;
    assert.throws(() => restoreEventJournal(document, (state, item) => { calls++; return add(state, item); }), TypeError);
    assert.equal(calls, 3);
    assert.deepEqual(document, before);
  }
  const empty = { formatVersion: 1, initialState: 0, batches: [], snapshot: { sequence: 0, state: 1 } };
  assert.throws(() => restoreEventJournal(empty, add), TypeError);
});

test('replay compares final state structure rather than member order, prototypes or sharing', () => {
  const journal = createEventJournal({ initialState: null, reduce: (_state, item) => item.payload });
  const payload = { z: [1, 2], a: { x: 1, y: 2 } };
  journal.append([event('e', payload)], options('r'));
  const document = journal.export();
  document.snapshot.state = Object.assign(Object.create(null), { a: { y: 2, x: 1 }, z: [1, 2] });
  assert.deepEqual(restoreEventJournal(document, (_state, item) => item.payload).snapshot(), journal.snapshot());
  for (const wrong of [
    { z: [2, 1], a: { x: 1, y: 2 } }, { z: [1, 2, null], a: { x: 1, y: 2 } },
    { z: { 0: 1, 1: 2 }, a: { x: 1, y: 2 } }, { z: [1, 2], a: { x: 1, y: 2 }, extra: null },
  ]) {
    document.snapshot.state = wrong;
    assert.throws(() => restoreEventJournal(document, (_state, item) => item.payload), TypeError);
  }
});

test('restored journals retain old retry receipts, isolate the source and accept subsequent appends', () => {
  const document = JSON.parse(JSON.stringify(sampleExport()));
  const before = structuredClone(document);
  const descriptors = rememberDescriptors(document);
  let calls = 0;
  const restored = restoreEventJournal(document, (state, item) => { calls++; return add(state, item); });
  assert.equal(calls, 3);
  assert.deepEqual(restored.export(), before);
  assert.deepEqual(document, before);
  assertDescriptorsUnchanged(descriptors);
  document.initialState = 99;
  document.batches[0].events[0].payload = 99;
  document.batches[1].requestId = 'changed';
  document.snapshot.state = 99;
  assert.deepEqual(restored.export(), before);
  for (const [i, row] of before.batches.entries()) {
    const receipt = restored.append(row.events, options(row.requestId, row.expectedSequence));
    assert.deepEqual(receipt, {
      requestId: row.requestId, fromSequence: i === 0 ? 1 : 3,
      toSequence: i === 0 ? 2 : 3, eventIds: row.events.map(item => item.id),
    });
    receipt.eventIds.reverse();
    assert.deepEqual(restored.append(row.events, options(row.requestId, row.expectedSequence)).eventIds,
      row.events.map(item => item.id));
  }
  assert.equal(calls, 3);
  rejectsUnchanged(restored, () => restored.append([event('a')], options('new', 3)), coded('DUPLICATE_EVENT', { eventId: 'a' }));
  const receipt = restored.append([event('d', 4)], options('new', 3));
  assert.deepEqual(receipt, { requestId: 'new', fromSequence: 4, toSequence: 4, eventIds: ['d'] });
  assert.equal(calls, 4);
  assert.deepEqual(restored.snapshot(), { sequence: 4, state: 10 });
  assert.deepEqual(history(restored).map(record => record.event.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(restored.append(before.batches[0].events, options('A')), {
    requestId: 'A', fromSequence: 1, toSequence: 2, eventIds: ['a', 'b'],
  });
  assert.equal(calls, 4);
});

test('mutating and throwing replay reducers leave source values and descriptors untouched', () => {
  const reduce = (state, item) => {
    state.total += item.payload.amount;
    item.id = 'rewritten'; item.type = 'rewritten'; item.payload.amount = 100;
    return state;
  };
  const original = createEventJournal({ initialState: { total: 0 }, reduce });
  original.append([event('a', { amount: 1 })], options('A'));
  original.append([event('b', { amount: 2 })], options('B', 1));
  const document = original.export();
  const before = structuredClone(document);
  const descriptors = rememberDescriptors(document);
  const retained = [];
  assert.throws(() => restoreEventJournal(document, (state, item) => {
    const id = item.id;
    const result = reduce(state, item);
    retained.push([state, item]);
    if (id === 'b') throw sentinel;
    return result;
  }), error => error === sentinel);
  for (const [state, item] of retained) { state.total = 800; item.payload.amount = 800; }
  assert.deepEqual(document, before);
  assertDescriptorsUnchanged(descriptors);

  function nullPrototype(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(nullPrototype);
    return Object.assign(Object.create(null), Object.fromEntries(
      Object.entries(value).reverse().map(([key, child]) => [key, nullPrototype(child)]),
    ));
  }
  const frozen = deepFreeze(nullPrototype(document));
  const frozenDescriptors = rememberDescriptors(frozen);
  const restored = restoreEventJournal(frozen, reduce);
  assert.deepEqual(restored.export(), before);
  assertDescriptorsUnchanged(frozenDescriptors);
  assert.deepEqual(document, before);
});

test('deep acyclic values can be captured, compared, exported and replayed without recursive traversal', () => {
  let payload = 'leaf';
  const depth = 12000;
  for (let i = 0; i < depth; i++) payload = { child: payload };
  const reduce = (_state, item) => item.payload;
  const journal = createEventJournal({ initialState: null, reduce });
  const receipt = journal.append([event('deep', payload)], options('r'));
  assert.deepEqual(journal.append([event('deep', payload)], options('r')), receipt);
  const restored = restoreEventJournal(journal.export(), reduce);
  let state = restored.snapshot().state;
  for (let i = 0; i < depth; i++) state = state.child;
  assert.equal(state, 'leaf');
  assert.equal(restored.sequence, 1);
});
