import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { partitionStable } from '../lib/partition-stable.mjs';

function assertPartition(result, expected) {
  assert.equal(Array.isArray(result), true);
  assert.strictEqual(Object.getPrototypeOf(result), Array.prototype);
  assert.equal(result.length, 2);
  assert.notStrictEqual(result[0], result[1]);
  assert.deepEqual(result, expected);
  for (let bucket = 0; bucket < 2; bucket += 1) {
    const group = result[bucket];
    assert.equal(Object.hasOwn(result, bucket), true);
    assert.equal(Array.isArray(group), true);
    assert.strictEqual(Object.getPrototypeOf(group), Array.prototype);
    for (let index = 0; index < group.length; index += 1) {
      assert.equal(Object.hasOwn(group, index), true);
      assert.strictEqual(group[index], expected[bucket][index]);
    }
  }
}

for (const [name, values, predicate, expected] of [
  ['empty', [], () => true, [[], []]],
  ['all holes', new Array(4), () => false, [[], []]],
  ['matching singleton', [1], () => true, [[1], []]],
  ['remaining singleton', [1], () => false, [[], [1]]],
  ['all matching', [1, 2, 3], () => true, [[1, 2, 3], []]],
  ['none matching', [1, 2, 3], () => false, [[], [1, 2, 3]]],
  ['interleaved', [1, 2, 3, 4, 5], value => value % 2 === 0, [[2, 4], [1, 3, 5]]],
]) {
  test(`partitionStable returns fresh dense groups: ${name}`, () => {
    let calls = 0;
    const classify = (...args) => {
      calls += 1;
      return predicate(...args);
    };
    const result = partitionStable(values, classify);
    const again = partitionStable(values, classify);

    assertPartition(result, expected);
    assertPartition(again, expected);
    assert.equal(calls, 2 * (expected[0].length + expected[1].length));
    assert.equal(new Set([values, result, ...result, again, ...again]).size, 7);
  });
}

test('preserves all values, signed zero and repeated object identities in both groups', () => {
  const symbol = Symbol('value');
  const nested = ['nested'];
  const shared = {};
  const values = [undefined, null, NaN, -0, +0, symbol, nested, shared, shared];
  const result = partitionStable(values, (_value, index) => index % 2 === 0);

  assertPartition(result, [[undefined, NaN, +0, nested, shared], [null, -0, symbol, shared]]);
});

test('classifies synchronously using truthiness without converting predicate results', () => {
  const uncoercible = {
    [Symbol.toPrimitive]() { assert.fail('must not coerce results'); },
    valueOf() { assert.fail('must not coerce results'); },
    toString() { assert.fail('must not coerce results'); },
  };
  const falsy = [false, 0, -0, 0n, '', null, undefined, NaN];
  const truthy = [true, 1, -1, 1n, 'false', Symbol('truthy'), {}, [],
    new Boolean(false), Promise.resolve(false), uncoercible];
  const answers = [...falsy, ...truthy];
  const values = answers.map((_answer, index) => ({ index }));
  let calls = 0;
  const result = partitionStable(values, (_value, index) => {
    calls += 1;
    return answers[index];
  });

  assert.equal(calls, values.length);
  assertPartition(result, [values.slice(falsy.length), values.slice(0, falsy.length)]);
  assertPartition(partitionStable([1, 2], async () => false), [[1, 2], []]);
});

test('visits only own indices numerically and calls the predicate once with exactly three arguments', () => {
  const shared = Object.freeze({ id: 'shared' });
  const values = new Array(12);
  values[10] = shared;
  values[7] = shared;
  Object.defineProperty(values, 2, { value: undefined, enumerable: false });
  const prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, 3, {
    get() { assert.fail('must not read inherited indices'); },
  });
  Object.defineProperty(prototype, 6, { value: 'inherited' });
  Object.setPrototypeOf(values, prototype);
  for (const key of ['name', '-1', '1.5', '01', '4294967295', 'hasOwnProperty',
    Symbol('extra'), Symbol.iterator]) {
    Object.defineProperty(values, key, {
      get() { assert.fail('must not read non-index properties or input methods'); },
    });
  }
  Object.freeze(values);
  const before = Object.getOwnPropertyDescriptors(values);
  const calls = [];
  const result = partitionStable(values, (...args) => {
    calls.push(args);
    return calls.length % 2 === 1;
  });

  assert.deepEqual(calls, [[undefined, 2, values], [shared, 7, values], [shared, 10, values]]);
  for (const args of calls) {
    assert.equal(args.length, 3);
    assert.strictEqual(args[0], values[args[1]]);
    assert.strictEqual(args[2], values);
  }
  assertPartition(result, [[undefined, shared], [shared]]);
  assert.deepEqual(Object.getOwnPropertyDescriptors(values), before);
  assert.strictEqual(Object.getPrototypeOf(values), prototype);
  assert.equal(Object.isExtensible(values), false);
});

test('the sparse README example skips holes but retains own undefined', () => {
  const values = [, 'A', undefined, , 'B'];
  const seen = [];
  const result = partitionStable(values, (_value, index, original) => {
    assert.strictEqual(original, values);
    seen.push(index);
    return index % 2 === 0;
  });

  assert.deepEqual(seen, [1, 2, 4]);
  assertPartition(result, [[undefined, 'B'], ['A']]);
});

test('defines own output slots despite inherited setters, getters or non-writable data', () => {
  // Global prototype changes stay in an isolated process and are restored before assertions.
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { partitionStable } from ${JSON.stringify(new URL('../lib/partition-stable.mjs', import.meta.url).href)};

    for (const mode of ['setter', 'getter', 'data']) {
      const first = Object.freeze({ id: 'first' });
      const second = Object.freeze({ id: 'second' });
      const values = Object.freeze([, first, second]);
      const before = Object.getOwnPropertyDescriptors(values);
      const original = Object.getOwnPropertyDescriptor(Array.prototype, '0');
      let inheritedCalls = 0;
      let seen = '';
      let result;
      const descriptor = mode === 'setter'
        ? { set() { inheritedCalls += 1; }, configurable: true }
        : mode === 'getter'
          ? { get() { inheritedCalls += 1; throw new Error('inherited getter'); }, configurable: true }
          : { value: 'inherited', writable: false, configurable: true };
      try {
        Object.defineProperty(Array.prototype, '0', descriptor);
        result = partitionStable(values, (value, index) => {
          seen += index + ',';
          return value === first;
        });
      } finally {
        if (original) Object.defineProperty(Array.prototype, '0', original);
        else delete Array.prototype[0];
      }
      assert.equal(inheritedCalls, 0);
      assert.equal(seen, '1,2,');
      assert.deepEqual(result, [[first], [second]]);
      assert.strictEqual(Object.getPrototypeOf(result), Array.prototype);
      for (let bucket = 0; bucket < 2; bucket += 1) {
        assert.equal(Object.hasOwn(result, bucket), true);
        assert.strictEqual(Object.getPrototypeOf(result[bucket]), Array.prototype);
        assert.deepEqual(Object.getOwnPropertyDescriptor(result[bucket], '0'), {
          value: bucket === 0 ? first : second,
          writable: true, enumerable: true, configurable: true,
        });
        assert.strictEqual(result[bucket][0], bucket === 0 ? first : second);
      }
      assert.deepEqual(Object.getOwnPropertyDescriptors(values), before);
    }
  `], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });

  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test('accepts Array subclasses, foreign arrays/functions and null-prototype arrays without using hooks', () => {
  class Values extends Array {
    static get [Symbol.species]() { assert.fail('must not access species'); }
  }
  const predicate = runInNewContext('value => value % 2 === 1');
  for (const populated of [false, true]) {
    const plain = populated ? [1, , 2, 3] : [];
    const subclass = new Values(plain.length);
    for (const index of Object.keys(plain)) subclass[index] = plain[index];
    const foreign = runInNewContext(populated ? '[1, , 2, 3]' : '[]');
    const nullPrototype = Object.setPrototypeOf(plain.slice(), null);
    for (const values of [plain, subclass, foreign, nullPrototype]) {
      if (values !== subclass) {
        Object.defineProperty(values, 'constructor', {
          get() { assert.fail('must not access constructor'); },
        });
      }
      for (const key of [Symbol.iterator, 'hasOwnProperty']) {
        Object.defineProperty(values, key, {
          get() { assert.fail('must not access input methods'); },
        });
      }
      assertPartition(partitionStable(values, predicate), populated ? [[1, 3], [2]] : [[], []]);
    }
  }
});

for (const frozen of [false, true]) {
  for (const fail of [false, true]) {
    test(`leaves input descriptors, holes, prototype and extensibility unchanged (frozen=${frozen}, fail=${fail})`, () => {
      const object = { count: 0 };
      const nested = ['nested'];
      const values = [object, , nested, object];
      const originals = [values, object, nested];
      if (frozen) originals.forEach(Object.freeze);
      const before = originals.map(value => ({
        descriptors: Object.getOwnPropertyDescriptors(value),
        prototype: Object.getPrototypeOf(value),
        extensible: Object.isExtensible(value),
      }));
      const failure = {};
      const run = () => partitionStable(values, (_value, index) => {
        if (fail && index === 2) throw failure;
        return index !== 2;
      });

      if (fail) assert.throws(run, error => error === failure);
      else assertPartition(run(), [[object, object], [nested]]);
      for (let index = 0; index < originals.length; index += 1) {
        assert.deepEqual(Object.getOwnPropertyDescriptors(originals[index]), before[index].descriptors);
        assert.strictEqual(Object.getPrototypeOf(originals[index]), before[index].prototype);
        assert.equal(Object.isExtensible(originals[index]), before[index].extensible);
      }
    });
  }
}

test('result slots and lengths are independent while element identity remains shared', () => {
  const object = { count: 0 };
  const nested = ['nested'];
  const values = [object, , nested, object];
  const expected = [[object, object], [nested]];
  for (let bucket = 0; bucket < 2; bucket += 1) {
    const result = partitionStable(values, (_value, index) => index !== 2);
    result[bucket][0] = 'replacement';
    result[bucket].push('extra');
    result[bucket].length = 0;
    assert.deepEqual(result[1 - bucket], expected[1 - bucket]);
    assert.deepEqual(values, [object, , nested, object]);
  }
  const result = partitionStable(values, (_value, index) => index !== 2);
  result[0][0].count += 1;
  result[1][0].push('shared');
  assert.equal(values[0].count, 1);
  assert.equal(result[0][1].count, 1);
  assert.deepEqual(values[2], ['nested', 'shared']);
});

for (const source of ['callback', 'getter']) {
  test(`observes future ${source} mutations within the initial length and skips deleted inherited slots`, () => {
    const values = ['first', , 'old', 'delete'];
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, 3, {
      get() { assert.fail('deleted own indices must not expose inherited values'); },
    });
    Object.setPrototypeOf(values, prototype);
    const mutate = () => {
      Object.defineProperty(values, 0, { value: 'changed' });
      values[1] = 'filled';
      values[2] = 'replacement';
      delete values[3];
      values.push('appended');
    };
    if (source === 'getter') {
      Object.defineProperty(values, 0, {
        configurable: true,
        get() { mutate(); return 'first'; },
      });
    }
    const seen = [];
    const result = partitionStable(values, (_value, index, original) => {
      assert.strictEqual(original, values);
      seen.push(index);
      if (source === 'callback' && index === 0) mutate();
      return index % 2 === 0;
    });

    assert.deepEqual(seen, [0, 1, 2]);
    assertPartition(result, [['first', 'replacement'], ['filled']]);
    assert.equal(values[0], 'changed');
    assert.equal(values[4], 'appended');
    assert.equal(Object.hasOwn(values, 3), false);
  });
}

test('skips elements removed by shortening the input and retains a deleted current value', () => {
  const values = ['first', 'second', 'third'];
  const seen = [];
  const result = partitionStable(values, (_value, index) => {
    seen.push(index);
    values.length = 0;
    return false;
  });

  assert.deepEqual(seen, [0]);
  assertPartition(result, [[], ['first']]);
  assert.equal(values.length, 0);
});

test('reads each value once immediately before its predicate and retains that captured value', () => {
  const captured = [{ id: 0 }, { id: 1 }, { id: 2 }];
  const values = new Array(captured.length);
  const events = [];
  for (let index = 0; index < captured.length; index += 1) {
    Object.defineProperty(values, index, {
      configurable: true,
      get() { events.push(`read ${index}`); return captured[index]; },
    });
  }
  const result = partitionStable(values, (value, index) => {
    events.push(`predicate ${index}`);
    assert.strictEqual(value, captured[index]);
    if (index === 0) Object.defineProperty(values, index, { value: 'replacement' });
    else delete values[index];
    return index % 2 === 0;
  });

  assert.deepEqual(events, [
    'read 0', 'predicate 0', 'read 1', 'predicate 1', 'read 2', 'predicate 2',
  ]);
  assertPartition(result, [[captured[0], captured[2]], [captured[1]]]);
});

test('rejects non-array or missing inputs with TypeError before invoking the callback', () => {
  let calls = 0;
  const predicate = () => { calls += 1; return true; };
  const invalid = [undefined, null, 'abc', 42, false, 1n, Symbol('input'), {},
    { 0: 'a', length: 1 }, new Set(['a']), new Map(), new Uint8Array([1]),
    Object.create(Array.prototype), () => [],
    { [Symbol.toPrimitive]() { assert.fail('must not coerce inputs'); } }];
  for (const values of invalid) {
    assert.throws(() => partitionStable(values, predicate), TypeError);
  }
  assert.throws(() => partitionStable(), TypeError);
  assert.equal(calls, 0);
});

test('rejects nonfunction predicates before indexed reads, even on empty and all-hole arrays', () => {
  let calls = 0;
  let reads = 0;
  const invalid = [undefined, null, 'predicate', 42, false, 1n, Symbol('predicate'),
    {}, [], /predicate/, { call() { calls += 1; } },
    { [Symbol.toPrimitive]() { assert.fail('must not coerce predicates'); } }];
  const guarded = [];
  Object.defineProperty(guarded, 0, {
    get() { reads += 1; throw new Error('must validate before reading'); },
  });
  for (const values of [[], new Array(3), [1, 2], guarded]) {
    for (const predicate of invalid) {
      assert.throws(() => partitionStable(values, predicate), TypeError);
    }
    assert.throws(() => partitionStable(values), TypeError);
  }
  assert.equal(calls, 0);
  assert.equal(reads, 0);
});

for (const [label, thrown] of [
  ['Error', new Error('failed')], ['object', { reason: 'failed' }],
  ['primitive', 'failed'], ['undefined', undefined],
]) {
  for (const failIndex of [1, 3]) {
    for (const source of ['callback', 'getter']) {
      test(`propagates exact ${label} from ${source} at index ${failIndex} with no later reads or calls`, () => {
        const values = new Array(6);
        const events = [];
        for (const index of [1, 3, 5]) {
          Object.defineProperty(values, index, {
            get() {
              events.push(`read ${index}`);
              if (index === 5) throw new Error('must not read later elements');
              if (source === 'getter' && index === failIndex) throw thrown;
              return index;
            },
          });
        }
        const before = Object.getOwnPropertyDescriptors(values);
        const notReturned = Symbol('not returned');
        let result = notReturned;
        let caught = false;
        try {
          result = partitionStable(values, (_value, index) => {
            events.push(`predicate ${index}`);
            if (index === failIndex) throw thrown;
            return true;
          });
        } catch (error) {
          caught = true;
          assert.strictEqual(error, thrown);
        }

        assert.equal(caught, true);
        assert.strictEqual(result, notReturned);
        const expected = failIndex === 1 ? [] : ['read 1', 'predicate 1'];
        expected.push(`read ${failIndex}`);
        if (source === 'callback') expected.push(`predicate ${failIndex}`);
        assert.deepEqual(events, expected);
        assert.deepEqual(Object.getOwnPropertyDescriptors(values), before);
        assertPartition(partitionStable([1, 2], value => value === 1), [[1], [2]]);
      });
    }
  }
}

for (const fail of [false, true]) {
  test(`nested calls have independent groups, including a caught nested failure: ${fail}`, () => {
    const failure = {};
    let inner;
    let caught = false;
    const outer = partitionStable(['a', 'b', 'a'], (_value, index) => {
      if (index === 1) {
        try {
          inner = partitionStable(['inner match', 'inner rest'], (_value, innerIndex) => {
            if (fail && innerIndex === 1) throw failure;
            return innerIndex === 0;
          });
        } catch (error) {
          caught = true;
          assert.strictEqual(error, failure);
        }
      }
      return index !== 1;
    });

    assertPartition(outer, [['a', 'a'], ['b']]);
    assert.equal(caught, fail);
    if (fail) assert.equal(inner, undefined);
    else assertPartition(inner, [['inner match'], ['inner rest']]);
  });
}

for (const source of ['callback', 'getter']) {
  test(`does not undo caller ${source} side effects on failure`, () => {
    const object = { count: 0 };
    const values = [object];
    const failure = {};
    const mutateAndThrow = () => {
      object.count += 1;
      values.push('appended');
      throw failure;
    };
    if (source === 'getter') Object.defineProperty(values, 0, { get: mutateAndThrow });

    assert.throws(() => partitionStable(values, mutateAndThrow), error => error === failure);
    assert.equal(object.count, 1);
    assert.equal(values.length, 2);
    assert.equal(values[1], 'appended');
  });
}
