import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mergeIntervals } from '../lib/merge-intervals.mjs';

function snapshot(...arrays) {
  return arrays.map(array => ({
    array,
    descriptors: Object.getOwnPropertyDescriptors(array),
    prototype: Object.getPrototypeOf(array),
    extensible: Object.isExtensible(array),
  }));
}

function assertUnchanged(before) {
  for (const { array, descriptors, prototype, extensible } of before) {
    const after = Object.getOwnPropertyDescriptors(array);
    assert.deepEqual(after, descriptors);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (Object.hasOwn(descriptors[key], 'value')) {
        assert.equal(after[key].value, descriptors[key].value);
      }
    }
    assert.equal(Object.getPrototypeOf(array), prototype);
    assert.equal(Object.isExtensible(array), extensible);
  }
}

function assertOrdinary(result) {
  assert.equal(Array.isArray(result), true);
  assert.equal(Object.getPrototypeOf(result), Array.prototype);
  for (let index = 0; index < result.length; index += 1) {
    assert.equal(Object.hasOwn(result, index), true);
    const pair = result[index];
    assert.equal(Array.isArray(pair), true);
    assert.equal(Object.getPrototypeOf(pair), Array.prototype);
    assert.equal(pair.length, 2);
    assert.equal(Object.hasOwn(pair, 0), true);
    assert.equal(Object.hasOwn(pair, 1), true);
    assert.ok(pair[0] <= pair[1]);
    if (index > 0) assert.ok(result[index - 1][1] < pair[0]);
    for (const endpoint of pair) assert.equal(Object.is(endpoint, -0), false);
  }
}

const M = Number.MAX_VALUE;
const m = Number.MIN_VALUE;
const shared = [1, 3];
const unionCases = [
  ['empty', [], []],
  ['singleton', [[2, 4]], [[2, 4]]],
  ['single point', [[2, 2]], [[2, 2]]],
  ['unsorted transitive touching', [[5, 7], [1, 3], [3, 5]], [[1, 7]]],
  ['nested without shrinking', [[1, 10], [2, 3], [9, 12]], [[1, 12]]],
  ['duplicates and equal starts', [[1, 4], [1, 2], [1, 4]], [[1, 4]]],
  ['contained and separate points', [[5, 5], [2, 2], [1, 3]], [[1, 3], [5, 5]]],
  ['numeric ordering', [[10, 11], [2, 3], [-4, -2]], [[-4, -2], [2, 3], [10, 11]]],
  ['reversed outer order', [[4, 5], [1, 2]], [[1, 2], [4, 5]]],
  ['integer adjacency', [[1, 2], [3, 4]], [[1, 2], [3, 4]]],
  ['smallest positive gap', [[0, 0], [m, m]], [[0, 0], [m, m]]],
  ['adjacent representable bounds', [[0, 1], [1 + Number.EPSILON, 2]],
    [[0, 1], [1 + Number.EPSILON, 2]]],
  ['extreme finite points', [[M, M], [-M, -M]], [[-M, -M], [M, M]]],
  ['overflowing width', [[-M, M]], [[-M, M]]],
  ['negative fractions', [[-1.5, 0.25], [-4.5, -1.5]], [[-4.5, 0.25]]],
  ['subnormals', [[-m, m], [m, 2 * m]], [[-m, 2 * m]]],
  ['unsafe integers', [[2 ** 53 + 2, 2 ** 53 + 4], [2 ** 53, 2 ** 53 + 2]],
    [[2 ** 53, 2 ** 53 + 4]]],
  ['duplicate pair references', [shared, [5, 6], shared], [[1, 3], [5, 6]]],
  ['README example', [[5, 7], [1, 3], [3, 5], [9, 9]], [[1, 7], [9, 9]]],
];

for (const [name, intervals, expected] of unionCases) {
  test(`mergeIntervals: ${name}, with fresh output and preserved inputs`, () => {
    const before = snapshot(intervals, ...intervals);
    const result = mergeIntervals(intervals);
    const again = mergeIntervals(intervals);
    assert.deepEqual(result, expected);
    assert.deepEqual(again, expected);
    assertOrdinary(result);
    assertOrdinary(again);
    assert.notEqual(result, intervals);
    assert.notEqual(again, intervals);
    assert.notEqual(result, again);
    assert.equal(new Set([...result, ...again]).size, result.length + again.length);
    for (const pair of [...result, ...again]) {
      for (const input of intervals) assert.notEqual(pair, input);
    }
    assertUnchanged(before);
  });
}

test('mergeIntervals isolates input, sibling pairs and repeated calls after mutation', () => {
  const pair = [1, 3];
  const intervals = [[5, 6], pair, [2, 4], pair];
  const result = mergeIntervals(intervals);
  const again = mergeIntervals(intervals);
  result[0][0] = -100;
  result[0].push(99);
  result.push([10, 11]);
  assert.deepEqual(intervals, [[5, 6], [1, 3], [2, 4], [1, 3]]);
  assert.deepEqual(result[1], [5, 6]);
  assert.deepEqual(again, [[1, 4], [5, 6]]);
  intervals[0][0] = 100;
  pair[1] = 200;
  intervals.reverse();
  intervals.push([300, 400]);
  assert.deepEqual(result, [[-100, 4, 99], [5, 6], [10, 11]]);
  assert.deepEqual(again, [[1, 4], [5, 6]]);
});

test('mergeIntervals rejects non-Arrays at both levels', () => {
  const fake = Object.assign(Object.create(Array.prototype), { 0: 1, 1: 2, length: 2 });
  for (const invalid of [undefined, null, 1, NaN, Infinity, true, false, '', '12',
    1n, Symbol('array'), new Number(1), {}, { length: 0 }, { 0: 1, 1: 2, length: 2 },
    () => [], new Set([1, 2]), new Float64Array([1, 2]), new Uint8Array(0), fake,
    { *[Symbol.iterator]() { yield 1; yield 2; } }]) {
    assert.throws(() => mergeIntervals(invalid), TypeError);
    assert.throws(() => mergeIntervals([invalid]), TypeError);
  }
  assert.throws(() => mergeIntervals(), TypeError);
});

const invalidEndpoints = [
  ['NaN', NaN], ['positive infinity', Infinity], ['negative infinity', -Infinity],
  ['numeric string', '2'], ['empty string', ''], ['true', true], ['false', false],
  ['null', null], ['undefined', undefined], ['boxed number', new Number(2)],
  ['bigint', 2n], ['symbol', Symbol('endpoint')], ['object', {}],
  ['empty array', []], ['nested array', [2]], ['function', () => 2],
];

for (const [name, invalid] of invalidEndpoints) {
  test(`mergeIntervals rejects ${name} in either endpoint at every position`, () => {
    for (const pair of [[invalid, 10], [1, invalid]]) {
      for (const intervals of [[pair], [pair, [0, 100], [2, 3]],
        [[0, 100], pair, [2, 3]], [[0, 100], [2, 3], pair]]) {
        const before = snapshot(intervals, ...intervals);
        assert.throws(() => mergeIntervals(intervals), TypeError);
        assertUnchanged(before);
      }
    }
  });
}

test('mergeIntervals rejects malformed pairs even inside a covering interval', () => {
  for (const pair of [[], [1], [1, 2, 3], [2, 1], [, 2], [1, ,], new Array(2)]) {
    for (const intervals of [[pair], [[0, 100], pair]]) {
      const before = snapshot(intervals, ...intervals);
      assert.throws(() => mergeIntervals(intervals), TypeError);
      assertUnchanged(before);
    }
  }
});

test('mergeIntervals rejects objects without coercion, including in error messages', () => {
  for (const key of ['valueOf', 'toString', Symbol.toPrimitive]) {
    let calls = 0;
    const invalid = { [key]() { calls += 1; throw new Error('must not coerce'); } };
    for (const intervals of [invalid, [invalid], [[invalid, 2]], [[1, invalid]]]) {
      assert.throws(() => mergeIntervals(intervals), TypeError);
    }
    assert.equal(calls, 0);
  }
});

test('mergeIntervals rejects leading, interior, trailing and all-hole outer arrays', () => {
  for (const intervals of [[, [1, 2]], [[1, 2], , [3, 4]], [[1, 2], ,],
    new Array(1), new Array(3), Object.freeze(new Array(2))]) {
    const before = snapshot(intervals);
    assert.throws(() => mergeIntervals(intervals), TypeError);
    assertUnchanged(before);
  }
});

test('mergeIntervals rejects inherited slots before reading their getters at either level', () => {
  let reads = 0;
  for (const level of ['outer', 0, 1]) {
    const index = level === 'outer' ? 0 : level;
    for (const descriptor of [
      { value: level === 'outer' ? [1, 2] : 1 },
      { get() { reads += 1; throw new Error('inherited slot read'); } },
    ]) {
      const array = level === 'outer' ? new Array(1) : [1, 2];
      delete array[index];
      const prototype = Object.create(Array.prototype);
      Object.defineProperty(prototype, index, descriptor);
      Object.setPrototypeOf(array, prototype);
      const intervals = level === 'outer' ? array : [array];
      const before = snapshot(array, intervals);
      assert.throws(() => mergeIntervals(intervals), TypeError);
      assertUnchanged(before);
    }
  }
  assert.equal(reads, 0);
});

test('mergeIntervals accepts non-enumerable own indices and ignores unrelated properties', () => {
  const intervals = [[3, 4], [1, 2]];
  for (const array of [intervals, ...intervals]) {
    for (const index of [0, 1]) {
      Object.defineProperty(array, index, { enumerable: false, writable: false });
    }
    for (const key of ['extra', '-1', '1.5', Symbol('extra')]) {
      Object.defineProperty(array, key, { get() { assert.fail('unrelated property read'); } });
    }
  }
  const before = snapshot(intervals, ...intervals);
  assert.deepEqual(mergeIntervals(intervals), [[1, 2], [3, 4]]);
  assertUnchanged(before);
});

test('mergeIntervals accepts every combination of frozen outer arrays and pairs', () => {
  for (const freezeOuter of [false, true]) {
    for (const freezePairs of [false, true]) {
      for (const [intervals, expected] of [
        [[], []], [[[1, 2]], [[1, 2]]], [[[3, 4], [1, 3]], [[1, 4]]],
        [[[-0, 1], [2, NaN]], TypeError],
      ]) {
        if (freezePairs) intervals.forEach(Object.freeze);
        if (freezeOuter) Object.freeze(intervals);
        const before = snapshot(intervals, ...intervals);
        if (expected === TypeError) assert.throws(() => mergeIntervals(intervals), TypeError);
        else {
          const result = mergeIntervals(intervals);
          assert.deepEqual(result, expected);
          assertOrdinary(result);
        }
        assertUnchanged(before);
      }
    }
  }
});

test('mergeIntervals accepts foreign, mixed-realm, subclass and null-prototype Arrays', () => {
  class Input extends Array {}
  const foreign = runInNewContext('({ outer: [[3, 4], [1, 2]], pair: [3, 4], empty: [] })');
  const foreignOuter = runInNewContext('[]');
  foreignOuter.push([3, 4], [1, 2]);
  const nullPair = Object.setPrototypeOf([3, 4], null);
  const nullOuter = Object.setPrototypeOf([nullPair, [1, 2]], null);
  for (const intervals of [foreign.empty, new Input(), Object.setPrototypeOf([], null)]) {
    const result = mergeIntervals(intervals);
    assert.deepEqual(result, []);
    assertOrdinary(result);
    assert.notEqual(result, intervals);
  }
  for (const intervals of [foreign.outer, foreignOuter, [foreign.pair, [1, 2]],
    new Input(new Input(3, 4), [1, 2]), [new Input(3, 4), [1, 2]],
    nullOuter, [nullPair, [1, 2]]]) {
    const before = snapshot(intervals, intervals[0], intervals[1]);
    const result = mergeIntervals(intervals);
    assert.deepEqual(result, [[1, 2], [3, 4]]);
    assertOrdinary(result);
    for (const pair of result) {
      assert.notEqual(pair, intervals[0]);
      assert.notEqual(pair, intervals[1]);
    }
    assertUnchanged(before);
  }
});

test('mergeIntervals never reads constructors at either input level on any path', () => {
  let reads = 0;
  for (const level of ['outer', 'pairs']) {
    for (const [intervals, expected] of [
      [[], []], [[[1, 2]], [[1, 2]]], [[[3, 4], [1, 3]], [[1, 4]]],
      [[[1, NaN]], TypeError], [[[0, 100], [20, 10]], TypeError],
    ]) {
      for (const array of level === 'outer' ? [intervals] : intervals) {
        Object.defineProperty(array, 'constructor', {
          get() { reads += 1; throw new Error('constructor read'); },
        });
      }
      const before = snapshot(intervals, ...intervals);
      if (expected === TypeError) assert.throws(() => mergeIntervals(intervals), TypeError);
      else {
        const result = mergeIntervals(intervals);
        assert.deepEqual(result, expected);
        assertOrdinary(result);
      }
      assertUnchanged(before);
    }
  }
  assert.equal(reads, 0);
});

test('mergeIntervals ignores throwing and input-aliasing species on ordinary and subclass arrays', () => {
  let reads = 0;
  for (const throws of [false, true]) {
    for (const level of ['outer', 'pairs']) {
      for (const useSubclass of [false, true]) {
        for (const values of [[], [[1, 2]], [[3, 4], [1, 3]], [[1, NaN]]]) {
          const makeArray = values => {
            let array;
            const species = () => {
              reads += 1;
              if (throws) throw new Error('species read');
              return function () { return array; };
            };
            class Input extends Array {
              static get [Symbol.species]() { return species(); }
            }
            array = useSubclass ? new Input(...values) : [...values];
            if (!useSubclass) array.constructor = { get [Symbol.species]() { return species(); } };
            return array;
          };
          const intervals = level === 'outer' ? makeArray(values) : values.map(makeArray);
          const before = snapshot(intervals, ...intervals);
          if (values.length === 1 && Number.isNaN(values[0][1])) {
            assert.throws(() => mergeIntervals(intervals), TypeError);
          } else {
            const result = mergeIntervals(intervals);
            assert.deepEqual(result, values.length === 2 ? [[1, 4]] : values);
            assertOrdinary(result);
          }
          assertUnchanged(before);
        }
      }
    }
  }
  assert.equal(reads, 0);
});

test('mergeIntervals ignores input methods and misleading iterators at both levels', () => {
  let iteratorCalls = 0;
  for (const [intervals, expected] of [
    [[], []], [[[3, 4], [1, 3]], [[1, 4]]], [[[1, NaN]], TypeError],
    [[[0, 100], [20, 10]], TypeError],
  ]) {
    for (const array of [intervals, ...intervals]) {
      for (const key of ['slice', 'map', 'sort', 'toSorted', 'hasOwnProperty']) {
        Object.defineProperty(array, key, { get() { assert.fail('input method read'); } });
      }
      array[Symbol.iterator] = function* () {
        iteratorCalls += 1;
        if (array === intervals) yield [1, 2];
        else { yield 1; yield 2; }
      };
    }
    if (expected === TypeError) assert.throws(() => mergeIntervals(intervals), TypeError);
    else assert.deepEqual(mergeIntervals(intervals), expected);
  }
  assert.equal(iteratorCalls, 0);
});

test('mergeIntervals reads lengths and indexed getters once in occurrence order', () => {
  const events = [];
  const observe = (values, label) => {
    const array = values.map((value, index) => {
      let reads = 0;
      return { get() { events.push(`${label}.${index}`); return ++reads === 1 ? value : NaN; } };
    });
    for (let index = 0; index < values.length; index += 1) {
      Object.defineProperty(array, index, array[index]);
    }
    return new Proxy(array, {
      get(target, key, receiver) {
        if (key === 'length') events.push(`${label}.length`);
        return Reflect.get(target, key, receiver);
      },
    });
  };
  const intervals = observe([
    observe([5, 7], 'a'), observe([1, 3], 'b'), observe([3, 5], 'c'),
  ], 'outer');
  assert.deepEqual(mergeIntervals(intervals), [[1, 7]]);
  assert.deepEqual(events, [
    'outer.length', 'outer.0', 'a.length', 'a.0', 'a.1',
    'outer.1', 'b.length', 'b.0', 'b.1', 'outer.2', 'c.length', 'c.0', 'c.1',
  ]);
});

test('mergeIntervals captures shared pairs separately and validates every occurrence', () => {
  for (const invalidSecond of [false, true]) {
    let reads = 0;
    const pair = [0, 1];
    Object.defineProperty(pair, 0, {
      get() { reads += 1; return reads === 1 ? 0 : invalidSecond ? NaN : 3; },
    });
    Object.defineProperty(pair, 1, { get() { return reads === 1 ? 1 : 4; } });
    if (invalidSecond) assert.throws(() => mergeIntervals([pair, pair]), TypeError);
    else assert.deepEqual(mergeIntervals([pair, pair]), [[0, 1], [3, 4]]);
    assert.equal(reads, 2);
  }
});

test('mergeIntervals captures initial lengths and observes changes to later slots', () => {
  const appended = [[1, 2]];
  Object.defineProperty(appended, 0, {
    get() { appended.push([NaN, NaN]); return [1, 2]; },
  });
  assert.deepEqual(mergeIntervals(appended), [[1, 2]]);
  assert.equal(appended.length, 2);

  const pair = [1, 2];
  Object.defineProperty(pair, 0, { get() { pair.push(NaN); return 1; } });
  assert.deepEqual(mergeIntervals([pair]), [[1, 2]]);
  assert.equal(pair.length, 3);

  for (const later of [[2, 3], [2, NaN], undefined]) {
    const intervals = [[0, 1], [5, 6]];
    Object.defineProperty(intervals, 0, {
      get() {
        if (later === undefined) delete intervals[1];
        else intervals[1] = later;
        return [0, 1];
      },
    });
    if (later?.[1] === 3) assert.deepEqual(mergeIntervals(intervals), [[0, 1], [2, 3]]);
    else assert.throws(() => mergeIntervals(intervals), TypeError);
  }
});

test('mergeIntervals checks endpoint ownership after preceding getter side effects', () => {
  const pair = [1, 2];
  const prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, 1, { get() { assert.fail('inherited endpoint read'); } });
  Object.setPrototypeOf(pair, prototype);
  Object.defineProperty(pair, 0, { get() { delete pair[1]; return 1; } });
  assert.throws(() => mergeIntervals([pair]), TypeError);
});

test('mergeIntervals propagates caller exceptions unchanged at both levels', () => {
  const sentinel = { caller: 'exception' };
  for (const level of ['outer', 'pair']) {
    for (const [trap, key] of [['get', 'length'], ['get', '0'], ['get', '1'],
      ['getOwnPropertyDescriptor', '0'], ['getOwnPropertyDescriptor', '1']]) {
      const target = level === 'outer' ? [[1, 2], [3, 4]] : [1, 2];
      const proxy = new Proxy(target, {
        [trap](...args) {
          if (args[1] === key) throw sentinel;
          return Reflect[trap](...args);
        },
      });
      assert.throws(() => mergeIntervals(level === 'outer' ? proxy : [proxy]),
        error => error === sentinel);
    }
  }
});

test('mergeIntervals performs no temporary input writes, including on validation failure', () => {
  const reject = () => assert.fail('input write');
  const protect = array => new Proxy(array, {
    set: reject, defineProperty: reject, deleteProperty: reject,
    preventExtensions: reject, setPrototypeOf: reject,
  });
  for (const [values, expected] of [
    [[], []], [[[-0, 1]], [[0, 1]]], [[[3, 4], [1, 3]], [[1, 4]]],
    [[[-0, 1], [2, NaN]], TypeError],
  ]) {
    const before = snapshot(values, ...values);
    const intervals = protect(values.map(protect));
    if (expected === TypeError) assert.throws(() => mergeIntervals(intervals), TypeError);
    else assert.deepEqual(mergeIntervals(intervals), expected);
    assertUnchanged(before);
  }
});

test('mergeIntervals normalizes every result zero and preserves input zero signs', () => {
  const cases = [
    [[[-1, -0]], [[-1, 0]]], [[[-0, 1]], [[0, 1]]],
    [[[-0, -0], [0, -0], [-0, 0]], [[0, 0]]],
    [[[-1, -0], [-0, 1]], [[-1, 1]]],
    [[[-2, -1], [-0, -0], [m, 1]], [[-2, -1], [0, 0], [m, 1]]],
  ];
  for (const start of [0, -0]) {
    for (const end of [0, -0]) cases.push([[[start, end]], [[0, 0]]]);
  }
  for (const [intervals, expected] of cases) {
    const before = snapshot(intervals, ...intervals);
    const result = mergeIntervals(intervals);
    assert.deepEqual(result, expected);
    assertOrdinary(result);
    assertUnchanged(before);
    const invalid = [...intervals, [-0, NaN]];
    const invalidBefore = snapshot(invalid, ...invalid);
    assert.throws(() => mergeIntervals(invalid), TypeError);
    assertUnchanged(invalidBefore);
  }
});

// Independent small-case oracle: connected components of the overlap graph.
function graphUnion(intervals) {
  const visited = new Set();
  const components = [];
  for (let index = 0; index < intervals.length; index += 1) {
    if (visited.has(index)) continue;
    visited.add(index);
    const pending = [index];
    let start = Infinity;
    let end = -Infinity;
    while (pending.length > 0) {
      const [left, right] = intervals[pending.pop()];
      start = Math.min(start, left);
      end = Math.max(end, right);
      for (let next = 0; next < intervals.length; next += 1) {
        if (!visited.has(next) && left <= intervals[next][1] && intervals[next][0] <= right) {
          visited.add(next);
          pending.push(next);
        }
      }
    }
    components.push([start === 0 ? 0 : start, end === 0 ? 0 : end]);
  }
  return components.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

test('mergeIntervals matches a graph oracle, permutation invariance and idempotence', () => {
  let seed = 0x68;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const endpoints = [-M, -10, -2, -1, -m, -0, 0, m, 1, 1 + Number.EPSILON, 2, 3, 10, M];
  for (let sample = 0; sample < 200; sample += 1) {
    const intervals = Array.from({ length: next() % 10 }, () => {
      const a = endpoints[next() % endpoints.length];
      const b = endpoints[next() % endpoints.length];
      return a <= b ? [a, b] : [b, a];
    });
    const before = snapshot(intervals, ...intervals);
    const expected = graphUnion(intervals);
    const result = mergeIntervals(intervals);
    assert.deepEqual(result, expected);
    assert.deepEqual(mergeIntervals([...intervals].reverse()), expected);
    const shuffled = [...intervals];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const other = next() % (index + 1);
      [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
    }
    assert.deepEqual(mergeIntervals(shuffled), expected);
    assert.deepEqual(mergeIntervals(result), expected);
    assertOrdinary(result);
    assertUnchanged(before);
  }
});

test('mergeIntervals handles large reverse-disjoint, contained and transitive inputs', () => {
  const count = 10000;
  const disjoint = Array.from({ length: count }, (_, index) => [index * 3, index * 3 + 1]);
  assert.deepEqual(mergeIntervals([...disjoint].reverse()), disjoint);
  const contained = Array.from({ length: count }, (_, index) => [index, count * 2 - index]);
  assert.deepEqual(mergeIntervals(contained.reverse()), [[0, count * 2]]);
  const chain = Array.from({ length: count }, (_, index) => [index, index + 1]);
  assert.deepEqual(mergeIntervals(chain.reverse()), [[0, count]]);
});
