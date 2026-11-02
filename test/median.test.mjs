import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { median } from '../lib/median.mjs';

const selectionCases = [
  ['empty', [], null],
  ['singleton', [7], 7],
  ['numeric ordering', [10, 2, 3], 3],
  ['unsorted even length', [4, 1, 3, 2], 2.5],
  ['duplicates', [3, 1, 3, 2], 2.5],
  ['sorted odd length', [1, 2, 3, 4, 5], 3],
  ['reversed odd length', [5, 4, 3, 2, 1], 3],
  ['sorted even length', [1, 2, 3, 4, 5, 6], 3.5],
  ['reversed even length', [6, 5, 4, 3, 2, 1], 3.5],
  ['all equal', [2, 2, 2, 2], 2],
  ['negative fractions', [-1.5, -4.5, -2.5], -2.5],
  ['unsafe integer singleton', [Number.MAX_SAFE_INTEGER + 1], Number.MAX_SAFE_INTEGER + 1],
  ['negative zero singleton', [-0], -0],
  ['negative zero middle', [1, -0, -1], -0],
  ['stable mixed zeros, negative middle', [0, -0, 0], -0],
  ['stable mixed zeros, positive middle', [-0, 0, -0], 0],
  ['two negative zeros', [-0, -0], -0],
  ['two positive zeros', [0, 0], 0],
  ['mixed even zeros', [-0, 0], 0],
  ['reversed mixed even zeros', [0, -0], 0],
];

for (const [name, values, expected] of selectionCases) {
  test(`median: ${name}, without mutation on repeated calls`, () => {
    const before = Object.getOwnPropertyDescriptors(values);
    for (let call = 0; call < 2; call += 1) {
      assert.equal(median(values), expected);
      assert.deepEqual(Object.getOwnPropertyDescriptors(values), before);
      assert.equal(Object.isExtensible(values), true);
    }
  });
}

const M = Number.MAX_VALUE;
const m = Number.MIN_VALUE;
const meanCases = [
  ['equal positive extremes', M, M, M],
  ['equal negative extremes', -M, -M, -M],
  ['unequal positive extremes', M / 2, M, M / 2 + M / 4],
  ['unequal negative extremes', -M, -M / 2, -M / 2 - M / 4],
  ['symmetric cancellation', -M, M, 0],
  ['asymmetric cancellation', -M, M / 2, -M / 4],
  ['positive subnormals', m, m, m],
  ['negative subnormals', -m, -m, -m],
  ['subnormal cancellation', -m, 3 * m, m],
  ['halfway rounds up', m, 2 * m, 2 * m],
  ['halfway rounds down', 2 * m, 3 * m, 2 * m],
  ['negative halfway rounds down', -2 * m, -m, -2 * m],
  ['negative halfway rounds up', -3 * m, -2 * m, -2 * m],
  ['negative underflow retains sign', -m, 0, -0],
  ['cancellation precision', -1, 1e-16, -0.49999999999999994],
  ['positive fractions', 0.1, 0.2, 0.15000000000000002],
  ['negative fractions', -4.5, -1.5, -3],
  ['unsafe integers', 2 ** 53, 2 ** 53 + 4, 2 ** 53 + 2],
];

for (const [name, lower, upper, expected] of meanCases) {
  test(`median mean: ${name}`, () => {
    for (const values of [[lower, upper], [upper, lower], [upper, M, lower, -M]]) {
      const result = median(values);
      assert.equal(Number.isFinite(result), true);
      // Exact assertions catch subnormal rounding and distinguish signed zero.
      assert.equal(result, expected);
    }
  });
}

test('median rejects non-Arrays, including empty array-like objects', () => {
  const fakeArray = Object.assign(Object.create(Array.prototype), { 0: 1, length: 1 });
  for (const values of [undefined, null, 1, NaN, Infinity, true, false, '', '123',
    1n, Symbol('values'), new Number(1), new String(''), new Boolean(false),
    {}, { length: 0 }, { 0: 1, length: 1 }, () => [], new Set([1]),
    new Float64Array([1, 2]), new Uint8Array(0), fakeArray]) {
    assert.throws(() => median(values), TypeError);
  }
  assert.throws(() => median(), TypeError);
});

const invalidElements = [
  ['NaN', NaN], ['positive infinity', Infinity], ['negative infinity', -Infinity],
  ['numeric string', '2'], ['empty string', ''], ['true', true], ['false', false],
  ['null', null], ['undefined', undefined], ['boxed number', new Number(2)],
  ['bigint', 2n], ['symbol', Symbol('element')], ['object', {}],
  ['empty array', []], ['nested array', [2]], ['function', () => 2],
];

for (const [name, invalid] of invalidElements) {
  test(`median rejects ${name} anywhere, preserving the invalid input`, () => {
    for (const values of [[invalid], [invalid, 3, 1], [3, invalid, 1], [3, 1, invalid],
      [3, 1, 2, invalid]]) {
      const before = Object.getOwnPropertyDescriptors(values);
      assert.throws(() => median(values), TypeError);
      assert.deepEqual(Object.getOwnPropertyDescriptors(values), before);
      assert.equal(Object.isExtensible(values), true);
    }
  });
}

for (const key of ['valueOf', 'toString', Symbol.toPrimitive]) {
  test(`median rejects objects without coercion through ${String(key)}`, () => {
    let calls = 0;
    const invalid = {
      [key]() {
        calls += 1;
        throw new Error('coercion must not run, including in error messages');
      },
    };
    assert.throws(() => median(invalid), TypeError);
    assert.throws(() => median([3, 1, invalid]), TypeError);
    assert.equal(calls, 0);
  });
}

test('median rejects leading, interior, trailing and all-hole arrays', () => {
  for (const values of [[, 1, 2], [1, , 2], [1, 2, ,], new Array(1), new Array(4),
    Object.assign([1, , 3], { extra: 2 }), Object.freeze(new Array(2))]) {
    const before = Object.getOwnPropertyDescriptors(values);
    const extensible = Object.isExtensible(values);
    assert.throws(() => median(values), TypeError);
    assert.deepEqual(Object.getOwnPropertyDescriptors(values), before);
    assert.equal(Object.isExtensible(values), extensible);
  }
});

test('median rejects inherited indices before reading them', () => {
  let reads = 0;
  for (const descriptor of [
    { value: 7 },
    { get() { reads += 1; throw new Error('must not read inherited index'); } },
  ]) {
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, '0', descriptor);
    const values = Object.setPrototypeOf(new Array(1), prototype);
    assert.throws(() => median(values), TypeError);
    assert.equal(Object.hasOwn(values, 0), false);
  }
  assert.equal(reads, 0);
});

test('median accepts non-enumerable, read-only indices and ignores other properties', () => {
  const values = [4, 1, 3, 2];
  Object.defineProperty(values, '1', { enumerable: false, writable: false });
  for (const key of ['extra', '-1', '1.5', Symbol('extra')]) {
    Object.defineProperty(values, key, { get() { assert.fail('not an element'); } });
  }
  const before = Object.getOwnPropertyDescriptors(values);
  assert.equal(median(values), 2.5);
  assert.deepEqual(Object.getOwnPropertyDescriptors(values), before);
  assert.equal(Object.isExtensible(values), true);
});

test('median accepts frozen empty, odd and even arrays', () => {
  for (const [values, expected] of [[[], null], [[3, 1, 2], 2], [[4, 1, 3, 2], 2.5]]) {
    Object.freeze(values);
    const before = Object.getOwnPropertyDescriptors(values);
    assert.equal(median(values), expected);
    assert.deepEqual(Object.getOwnPropertyDescriptors(values), before);
    assert.equal(Object.isFrozen(values), true);
  }
});

test('median performs no temporary writes on success or failure', () => {
  for (const [values, expected] of [
    [[], null], [[3, 1, 2], 2], [[4, 1, 3, 2], 2.5], [[3, 1, NaN], TypeError],
  ]) {
    const rejectWrite = () => assert.fail('must not write to the input');
    const observed = new Proxy(values, {
      set: rejectWrite, defineProperty: rejectWrite, deleteProperty: rejectWrite,
      preventExtensions: rejectWrite, setPrototypeOf: rejectWrite,
    });
    if (expected === TypeError) assert.throws(() => median(observed), TypeError);
    else assert.equal(median(observed), expected);
  }
});

test('median never uses species that alias an ordinary Array or subclass input', () => {
  let speciesReads = 0;
  class Input extends Array {
    static get [Symbol.species]() {
      speciesReads += 1;
      return function () { return subclass; };
    }
  }
  const subclass = new Input(3, 1, 2);
  const ordinary = [3, 1, 2];
  ordinary.constructor = {
    get [Symbol.species]() {
      speciesReads += 1;
      return function () { return ordinary; };
    },
  };
  for (const values of [ordinary, subclass]) {
    const before = Object.getOwnPropertyDescriptors(values);
    assert.equal(median(values), 2);
    assert.deepEqual(Object.getOwnPropertyDescriptors(values), before);
  }
  assert.equal(speciesReads, 0);
});

test('median ignores input methods, constructors and misleading iterators', () => {
  let iteratorCalls = 0;
  for (const values of [[3, 1, 2], [NaN]]) {
    for (const key of ['slice', 'sort', 'hasOwnProperty', 'constructor']) {
      Object.defineProperty(values, key, { get() { assert.fail('must not read source hooks'); } });
    }
    values[Symbol.iterator] = function* () { iteratorCalls += 1; yield 42; };
    if (values.length === 1) assert.throws(() => median(values), TypeError);
    else assert.equal(median(values), 2);
  }
  assert.equal(iteratorCalls, 0);
});

test('median accepts foreign-realm Arrays and Arrays with a null prototype', () => {
  for (const values of [runInNewContext('[4, 1, 3, 2]'), Object.setPrototypeOf([4, 1, 3, 2], null)]) {
    const before = Object.getOwnPropertyDescriptors(values);
    const prototype = Object.getPrototypeOf(values);
    assert.equal(median(values), 2.5);
    assert.deepEqual(Object.getOwnPropertyDescriptors(values), before);
    assert.equal(Object.getPrototypeOf(values), prototype);
  }
});

test('median reads each getter once and validates the value it retains', () => {
  for (const first of [3, NaN]) {
    const reads = [0, 0, 0];
    const values = new Array(3);
    for (const [index, value] of [first, 1, 2].entries()) {
      Object.defineProperty(values, index, {
        get() { reads[index] += 1; return reads[index] === 1 ? value : NaN; },
      });
    }
    const before = Object.getOwnPropertyDescriptors(values);
    if (Number.isNaN(first)) {
      assert.throws(() => median(values), TypeError);
      assert.deepEqual(reads, [1, 0, 0]);
    } else {
      assert.equal(median(values), 2);
      assert.deepEqual(reads, [1, 1, 1]);
    }
    assert.deepEqual(Object.getOwnPropertyDescriptors(values), before);
  }
});

test('median captures initial length before getters can append elements', () => {
  const values = [3, 1, 2];
  Object.defineProperty(values, '0', {
    get() { values.push(NaN); return 3; },
  });
  assert.equal(median(values), 2);
  assert.equal(values.length, 4);
  assert.equal(Number.isNaN(values[3]), true);
});
