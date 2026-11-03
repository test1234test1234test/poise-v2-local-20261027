import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { rotateArray } from '../lib/rotate-array.mjs';

function assertValues(result, expected, source) {
  assert.equal(Array.isArray(result), true);
  assert.strictEqual(Object.getPrototypeOf(result), Array.prototype);
  assert.notStrictEqual(result, source);
  assert.equal(result.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(Object.hasOwn(result, index), true);
    assert.equal(Object.is(result[index], expected[index]), true, `value at index ${index}`);
  }
}

function snapshot(value) {
  const prototype = Object.getPrototypeOf(value);
  return {
    descriptors: Object.getOwnPropertyDescriptors(value),
    extensible: Object.isExtensible(value),
    prototype,
    prototypeDescriptors: prototype && Object.getOwnPropertyDescriptors(prototype),
    prototypeExtensible: prototype && Object.isExtensible(prototype),
  };
}

function assertUnchanged(value, before) {
  assert.strictEqual(Object.getPrototypeOf(value), before.prototype);
  assert.deepEqual(snapshot(value), before);
}

const four = ['a', 'b', 'c', 'd'];
const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
for (const [name, source, steps, expected] of [
  ['right', four, 1, ['d', 'a', 'b', 'c']],
  ['left', four, -1, ['b', 'c', 'd', 'a']],
  ['right by two', four, 2, ['c', 'd', 'a', 'b']],
  ['left by two', seven, -2, ['c', 'd', 'e', 'f', 'g', 'a', 'b']],
  ['positive wrapping', four, 9, ['d', 'a', 'b', 'c']],
  ['negative wrapping', four, -10, ['c', 'd', 'a', 'b']],
  ['maximum safe steps, length four', four, Number.MAX_SAFE_INTEGER, ['b', 'c', 'd', 'a']],
  ['minimum safe steps, length four', four, Number.MIN_SAFE_INTEGER, ['d', 'a', 'b', 'c']],
  ['maximum safe steps, length seven', seven, Number.MAX_SAFE_INTEGER, ['e', 'f', 'g', 'a', 'b', 'c', 'd']],
  ['minimum safe steps, length seven', seven, Number.MIN_SAFE_INTEGER, ['d', 'e', 'f', 'g', 'a', 'b', 'c']],
  ['positive steps beyond 32 bits', seven, 2 ** 32 + 1, ['c', 'd', 'e', 'f', 'g', 'a', 'b']],
  ['negative steps beyond 32 bits', seven, -(2 ** 32 + 1), ['f', 'g', 'a', 'b', 'c', 'd', 'e']],
]) {
  test(`rotateArray: ${name}`, () => {
    const before = snapshot(source);
    const result = rotateArray(source, steps);
    const again = rotateArray(source, steps);
    assertValues(result, expected, source);
    assertValues(again, expected, source);
    assert.notStrictEqual(result, again);
    assertUnchanged(source, before);
  });
}

test('rotateArray returns fresh ordinary arrays for every no-op path', () => {
  for (const source of [[], [undefined], ['a', 'b', 'c']]) {
    Object.freeze(source);
    const before = snapshot(source);
    const steps = source.length > 1 ? [0, -0, 3, -3, 9, -9]
      : [0, -0, 1, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
    for (const step of steps) {
      const result = rotateArray(source, step);
      const again = rotateArray(source, step);
      assertValues(result, source, source);
      assertValues(again, source, source);
      assert.notStrictEqual(result, again);
    }
    assertUnchanged(source, before);
  }
});

test('rotateArray preserves unrestricted values and repeated references in frozen input', () => {
  const object = { value: 1 };
  const nested = [object];
  const symbol = Symbol('payload');
  const fn = () => assert.fail('must not call elements');
  const opaque = {};
  for (const key of [Symbol.toPrimitive, 'valueOf', 'toString']) {
    Object.defineProperty(opaque, key, { get() { assert.fail('must not inspect elements'); } });
  }
  const source = Object.freeze([
    undefined, NaN, -0, 0, object, nested, object, symbol, 1n, fn, Infinity, -Infinity, opaque,
  ]);
  const originals = [source, object, nested, opaque];
  const before = originals.map(snapshot);
  const result = rotateArray(source, 2);
  assertValues(result, [
    -Infinity, opaque, undefined, NaN, -0, 0, object, nested, object, symbol, 1n, fn, Infinity,
  ], source);
  for (let index = 0; index < originals.length; index += 1) {
    assertUnchanged(originals[index], before[index]);
  }

  result[6] = 'replacement';
  result.push('extra');
  assert.strictEqual(source[4], object);
  assert.equal(source.length, 13);
  object.value = 2;
  nested.push('shared');
  assert.equal(result[8].value, 2);
  assert.equal(result[7][1], 'shared');
  assert.equal(source[5][1], 'shared');
});

test('rotateArray preserves a reference to the source itself', () => {
  const source = ['first'];
  source.push(source);
  Object.freeze(source);
  assertValues(rotateArray(source, 1), [source, 'first'], source);
});

test('rotateArray rejects non-Arrays with TypeError', () => {
  const fake = Object.assign(Object.create(Array.prototype), { 0: 'a', length: 1 });
  for (const source of [undefined, null, '', 'abc', 1, true, 1n, Symbol('items'),
    {}, { length: 0 }, { 0: 'a', length: 1 }, new Set(['a']), new Uint8Array([1]),
    () => [], fake]) {
    assert.throws(() => rotateArray(source, 1), TypeError);
  }
  assert.throws(() => rotateArray(), TypeError);
});

for (const [name, steps, error] of [
  ['undefined', undefined, TypeError], ['null', null, TypeError],
  ['string', '1', TypeError], ['true', true, TypeError], ['false', false, TypeError],
  ['bigint', 1n, TypeError], ['symbol', Symbol('step'), TypeError],
  ['boxed number', new Number(1), TypeError], ['array', [1], TypeError],
  ['object', {}, TypeError], ['function', () => 1, TypeError],
  ['NaN', NaN, RangeError], ['positive infinity', Infinity, RangeError],
  ['negative infinity', -Infinity, RangeError], ['positive fraction', 1.5, RangeError],
  ['negative fraction', -1.5, RangeError], ['positive subnormal', Number.MIN_VALUE, RangeError],
  ['negative subnormal', -Number.MIN_VALUE, RangeError],
  ['above safe bound', Number.MAX_SAFE_INTEGER + 1, RangeError],
  ['below safe bound', Number.MIN_SAFE_INTEGER - 1, RangeError],
  ['maximum finite number', Number.MAX_VALUE, RangeError],
]) {
  test(`rotateArray rejects ${name} steps even with empty input`, () => {
    for (const source of [[], ['a', 'b']]) {
      const before = snapshot(source);
      assert.throws(() => rotateArray(source, steps), error);
      assertUnchanged(source, before);
    }
  });
}

test('rotateArray requires steps even with empty input', () => {
  for (const source of [[], ['a']]) {
    assert.throws(() => rotateArray(source), TypeError);
  }
});

for (const key of [Symbol.toPrimitive, 'valueOf', 'toString']) {
  test(`rotateArray rejects objects without accessing or calling ${String(key)}`, () => {
    let reads = 0;
    let calls = 0;
    const accessor = Object.defineProperty({}, key, {
      get() { reads += 1; throw new TypeError('coercion access sentinel'); },
    });
    const method = { [key]() { calls += 1; throw new TypeError('coercion call sentinel'); } };
    for (const value of [accessor, method]) {
      for (const source of [[], ['a']]) {
        assert.throws(() => rotateArray(source, value), TypeError);
      }
      assert.throws(() => rotateArray(value, 1), TypeError);
    }
    assert.equal(reads, 0);
    assert.equal(calls, 0);
  });
}

test('rotateArray rejects leading, interior, trailing and all-hole arrays on every path', () => {
  for (const source of [[, 'b', 'c'], ['a', , 'c'], ['a', 'b', ,], new Array(3), new Array(1)]) {
    // Extra named properties must not make a sparse source appear dense.
    source.extra = 'not an index';
    for (const frozen of [false, true]) {
      if (frozen) Object.freeze(source);
      const before = snapshot(source);
      for (const steps of [0, -0, 1, -1, source.length, -source.length]) {
        assert.throws(() => rotateArray(source, steps), TypeError);
      }
      assertUnchanged(source, before);
    }
  }
});

test('rotateArray rejects inherited indices without reading their getters', () => {
  let reads = 0;
  for (const descriptor of [
    { value: 'inherited' },
    { get() { reads += 1; throw new Error('must not read inherited index'); } },
  ]) {
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, '1', descriptor);
    const source = Object.freeze(Object.setPrototypeOf(['a', , 'c'], prototype));
    const before = snapshot(source);
    for (const steps of [0, 1, -1, 3, -3]) {
      assert.throws(() => rotateArray(source, steps), TypeError);
    }
    assertUnchanged(source, before);
  }
  assert.equal(reads, 0);
});

test('rotateArray copies non-enumerable own indices and ignores source hooks and extra properties', () => {
  const source = ['a', undefined, 'c'];
  Object.defineProperty(source, '1', { enumerable: false, writable: false });
  for (const key of ['slice', 'map', 'hasOwnProperty', 'constructor', 'extra', '-1', '1.5', Symbol('extra')]) {
    Object.defineProperty(source, key, { get() { assert.fail('must not read source hooks'); } });
  }
  let iteratorCalls = 0;
  source[Symbol.iterator] = function* () { iteratorCalls += 1; yield 'wrong'; };
  Object.freeze(source);
  const before = snapshot(source);
  assertValues(rotateArray(source, 1), ['c', 'a', undefined], source);
  assertValues(rotateArray(source, 0), ['a', undefined, 'c'], source);
  assert.equal(iteratorCalls, 0);
  assertUnchanged(source, before);
});

test('rotateArray avoids subclass constructors and species for empty, zero and rotated results', () => {
  let allowConstruction = true;
  let constructions = 0;
  let speciesReads = 0;
  class Input extends Array {
    constructor(...args) {
      super(...args);
      constructions += 1;
      assert.equal(allowConstruction, true, 'must not invoke source constructor');
    }
    static get [Symbol.species]() {
      speciesReads += 1;
      throw new Error('must not read species');
    }
  }
  const sources = [new Input(), new Input('a', 'b', 'c')];
  allowConstruction = false;
  for (const source of sources) {
    Object.freeze(source);
    const before = snapshot(source);
    for (const steps of [0, -0, 1, -1, 3, -3]) {
      const expected = source.length === 0 ? [] : steps === 1 ? ['c', 'a', 'b']
        : steps === -1 ? ['b', 'c', 'a'] : ['a', 'b', 'c'];
      const result = rotateArray(source, steps);
      const again = rotateArray(source, steps);
      assertValues(result, expected, source);
      assertValues(again, expected, source);
      assert.notStrictEqual(result, again);
    }
    assertUnchanged(source, before);
  }
  assert.equal(constructions, 2);
  assert.equal(speciesReads, 0);
});

test('rotateArray does not read constructor hooks on empty or populated ordinary arrays', () => {
  let reads = 0;
  for (const source of [[], ['a', 'b']]) {
    Object.defineProperty(source, 'constructor', {
      get() { reads += 1; throw new Error('must not read constructor'); },
    });
    for (const steps of [0, 1, -1, 2]) {
      const expected = source.length === 0 ? [] : steps === 0 || steps === 2 ? ['a', 'b'] : ['b', 'a'];
      assertValues(rotateArray(source, steps), expected, source);
    }
  }
  assert.equal(reads, 0);
});

test('rotateArray accepts cross-realm and null-prototype Arrays', () => {
  for (const source of [runInNewContext("['a', undefined, 'c']"), Object.setPrototypeOf(['a', undefined, 'c'], null)]) {
    const before = snapshot(source);
    assertValues(rotateArray(source, -1), [undefined, 'c', 'a'], source);
    assertUnchanged(source, before);
  }
});

test('rotateArray reads own accessors once without invoking setters, even on frozen arrays', () => {
  const source = new Array(3);
  const reads = [];
  let writes = 0;
  for (const [index, value] of ['a', undefined, 'c'].entries()) {
    Object.defineProperty(source, index, {
      get() { reads.push(index); return value; },
      set() { writes += 1; },
    });
  }
  Object.freeze(source);
  const before = snapshot(source);
  assertValues(rotateArray(source, 2), [undefined, 'c', 'a'], source);
  assert.deepEqual(reads, [0, 1, 2]);
  assert.equal(writes, 0);
  assertUnchanged(source, before);
});

test('rotateArray performs no temporary writes to the source or prototype on success or failure', () => {
  let writes = 0;
  const rejectWrite = () => { writes += 1; assert.fail('must not write'); };
  const guards = {
    set: rejectWrite, defineProperty: rejectWrite, deleteProperty: rejectWrite,
    preventExtensions: rejectWrite, setPrototypeOf: rejectWrite,
  };
  for (const source of [[], ['a', 'b'], ['a', ,]]) {
    Object.setPrototypeOf(source, new Proxy(Object.create(Array.prototype), guards));
    const observed = new Proxy(source, guards);
    const before = snapshot(source);
    for (const steps of [0, 1, -1]) {
      if (source.length && !Object.hasOwn(source, 1)) {
        assert.throws(() => rotateArray(observed, steps), TypeError);
      } else {
        const expected = source.length === 0 ? [] : steps === 0 ? ['a', 'b'] : ['b', 'a'];
        assertValues(rotateArray(observed, steps), expected, source);
      }
    }
    assert.throws(() => rotateArray(observed, '1'), TypeError);
    assert.throws(() => rotateArray(observed, Infinity), RangeError);
    assertUnchanged(source, before);
  }
  assert.equal(writes, 0);
});

test('rotateArray observes later getter changes but ignores appends beyond the initial length', () => {
  const source = ['a', 'before', 'c'];
  Object.defineProperty(source, '0', {
    get() { source[1] = 'after'; source.push('extra'); return 'a'; },
  });
  assertValues(rotateArray(source, 2), ['after', 'c', 'a'], source);
  assert.equal(source.length, 4);
  assert.equal(source[1], 'after');
});

test('rotateArray checks ownership immediately before reads and propagates getter exceptions', () => {
  const source = ['a', 'b', 'c'];
  Object.defineProperty(source, '0', { get() { delete source[1]; return 'a'; } });
  assert.throws(() => rotateArray(source, 2), TypeError);
  assert.equal(Object.hasOwn(source, 1), false);

  const sentinel = new Error('getter sentinel');
  const throwing = [undefined];
  Object.defineProperty(throwing, '0', { get() { throw sentinel; } });
  const before = snapshot(throwing);
  assert.throws(() => rotateArray(throwing, 0), error => error === sentinel);
  assertUnchanged(throwing, before);
});

test('rotateArray defines own output slots despite inherited numeric accessors or read-only values', () => {
  // Isolate global prototype changes and restore them before making assertions.
  const child = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { rotateArray } from ${JSON.stringify(new URL('../lib/rotate-array.mjs', import.meta.url).href)};

    for (const mode of ['setter', 'getter', 'read-only']) {
      const source = Object.freeze(['a', 'b', 'c']);
      const original = Object.getOwnPropertyDescriptor(Array.prototype, '0');
      let calls = 0;
      let result;
      const descriptor = mode === 'setter'
        ? { set() { calls += 1; }, configurable: true }
        : mode === 'getter'
          ? { get() { calls += 1; throw new Error('inherited getter'); }, configurable: true }
          : { value: 'inherited', writable: false, configurable: true };
      try {
        Object.defineProperty(Array.prototype, '0', descriptor);
        result = rotateArray(source, 1);
      } finally {
        if (original) Object.defineProperty(Array.prototype, '0', original);
        else delete Array.prototype[0];
      }
      assert.equal(calls, 0);
      assert.deepEqual(result, ['c', 'a', 'b']);
      assert.strictEqual(Object.getPrototypeOf(result), Array.prototype);
      for (let index = 0; index < result.length; index += 1) {
        assert.deepEqual(Object.getOwnPropertyDescriptor(result, index), {
          value: ['c', 'a', 'b'][index], writable: true, enumerable: true, configurable: true,
        });
      }
      assert.deepEqual(source, ['a', 'b', 'c']);
    }
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
