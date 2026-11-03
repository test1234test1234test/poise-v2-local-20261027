import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stableTopologicalSort } from '../lib/stable-topological-sort.mjs';

function assertOrder(vertices, edges, expected) {
  const result = stableTopologicalSort(vertices, edges);
  assert.ok(Array.isArray(result));
  assert.notStrictEqual(result, vertices);
  assert.notStrictEqual(result, edges);
  assert.equal(result.length, vertices.length);
  assert.equal(new Set(result).size, vertices.length);
  const positions = new Map(result.map((vertex, index) => [vertex, index]));
  for (let i = 0; i < result.length; i++) {
    assert.ok(Object.hasOwn(result, i));
    // Strict identity also distinguishes equal-looking objects and signed zero.
    assert.strictEqual(result[i], expected[i], `position ${i}`);
  }
  for (const vertex of vertices) {
    assert.ok(positions.has(vertex));
    assert.strictEqual(result[positions.get(vertex)], vertex);
  }
  for (const [before, after] of edges) {
    assert.ok(positions.get(before) < positions.get(after));
  }
  return result;
}

function assertCycle(vertices, edges) {
  assert.throws(() => stableTopologicalSort(vertices, edges), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, 'CYCLE');
    return true;
  });
}

const orderCases = [
  ['empty graph', [], [], []],
  ['original order without edges', ['z', 'a'], [], ['z', 'a']],
  ['before precedes after', ['build', 'fetch'], [['fetch', 'build']], ['fetch', 'build']],
  ['newly eligible earlier vertex overtakes waiting vertex', ['b', 'a', 'c'], [['a', 'b']], ['a', 'b', 'c']],
  ['eligible siblings follow vertex order', ['d', 'b', 'a', 'c'], [['a', 'b'], ['a', 'd']], ['a', 'd', 'b', 'c']],
  ['disconnected components and isolate', ['d', 'b', 'a', 'c', 'i'], [['a', 'b'], ['c', 'd']], ['a', 'b', 'c', 'd', 'i']],
  ['shared descendant waits for every predecessor', ['a', 'b', 'c'], [['a', 'b'], ['a', 'c'], ['c', 'b']], ['a', 'c', 'b']],
  ['edge identities cannot collide on delimiters', ['b,c', 'c', 'a,b', 'a'], [['a,b', 'c'], ['a', 'b,c']], ['a,b', 'c', 'a', 'b,c']],
];

for (const [name, vertices, edges, expected] of orderCases) {
  test(name, () => {
    const variants = [edges, edges.toReversed(), edges.flatMap(edge => [[...edge], [...edge]])];
    const results = variants.map(inputEdges => assertOrder(vertices, inputEdges, expected));
    assert.notStrictEqual(results[0], results[1]);
    assert.notStrictEqual(results[1], results[2]);
    results[0][0] = 'changed result';
    assertOrder(vertices, edges, expected);
    assert.deepEqual(results[1], expected);
  });
}

test('special primitive identities remain distinct without coercion', () => {
  const vertices = [0, 0n, '0', false, null, undefined, NaN, Symbol('x'), Symbol('x'),
    '', '__proto__', 'constructor', 'toString', Infinity, -Infinity, true];
  const expected = vertices.toReversed();
  const edges = expected.slice(1).map((vertex, index) => [expected[index], vertex]);
  assertOrder(vertices, edges, expected);
  assertOrder(vertices, edges.toReversed(), expected);
  assertOrder([undefined], [], [undefined]);
  assertOrder([undefined, 'a'], [[undefined, 'a']], [undefined, 'a']);
});

function throwingCoercion() {
  return {
    toString() { throw new Error('must not stringify'); },
    valueOf() { throw new Error('must not convert'); },
    [Symbol.toPrimitive]() { throw new Error('must not coerce'); },
  };
}

test('object, array and function vertices remain opaque original references', () => {
  const first = {};
  const second = {};
  const array = ['nested'];
  const callable = () => { throw new Error('must not invoke'); };
  const vertices = [first, second, array, callable, Object.create(null), throwingCoercion()];
  const expected = vertices.toReversed();
  const edges = expected.slice(1).map((vertex, index) => [expected[index], vertex]);
  assertOrder(vertices, edges, expected);
  assertOrder(vertices, edges.toReversed(), expected);
  for (const missing of [{}, throwingCoercion()]) {
    assert.throws(() => stableTopologicalSort(vertices, [[first, missing]]), RangeError);
    assert.throws(() => stableTopologicalSort(vertices, [[missing, first]]), RangeError);
  }
});

test('SameValueZero endpoints and duplicate edges preserve original negative zero', () => {
  const first = {};
  const second = {};
  const vertices = [NaN, -0, first, second];
  const edges = [[first, NaN], [first, NaN], [NaN, +0], [NaN, -0],
    [+0, second], [-0, second], [first, second]];
  const expected = [first, NaN, -0, second];
  assertOrder(vertices, edges, expected);
  assertOrder(vertices, edges.toReversed(), expected);
  assertOrder([-0, 'x'], [['x', +0]], ['x', -0]);
  assertOrder([-0], [], [-0]);
});

const reference = {};
const symbol = Symbol('same');
const callable = () => {};
const array = [];
for (const [name, vertices] of [
  ['strings', ['a', 'a']], ['undefined', [undefined, undefined]],
  ['NaN', [NaN, NaN]], ['signed zero', [-0, +0]],
  ['object', [reference, reference]], ['symbol', [symbol, symbol]],
  ['function', [callable, callable]], ['array', [array, array]],
]) {
  test(`rejects duplicate ${name} vertices with TypeError`, () => {
    assert.throws(() => stableTopologicalSort(vertices, []), TypeError);
  });
}

test('requires actual Arrays for both containers and every tuple', () => {
  const nonArrays = [undefined, null, 0, '01', new Set([0, 1]), new Uint8Array([0, 1]),
    { 0: 0, 1: 1, length: 2 }];
  for (const value of nonArrays) {
    assert.throws(() => stableTopologicalSort(value, []), TypeError);
    assert.throws(() => stableTopologicalSort([], value), TypeError);
    assert.throws(() => stableTopologicalSort([0, 1], [value]), TypeError);
  }
  assert.throws(() => stableTopologicalSort(), TypeError);
});

// Inherited slots must not conceal holes; do not change the global prototype.
function inheritedHole(values, index) {
  const result = [...values];
  delete result[index];
  const prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, index, { value: values[index] });
  Object.setPrototypeOf(result, prototype);
  return result;
}

for (const [name, vertices, edges] of [
  ['vertex hole', Array(1), []],
  ['edge hole', [undefined, 'a'], Array(1)],
  ['empty tuple', [undefined, 'a'], [[]]],
  ['short tuple', [undefined, 'a'], [['a']]],
  ['long tuple', [undefined, 'a'], [['a', undefined, 'a']]],
  ['both endpoint holes', [undefined, 'a'], [Array(2)]],
  ['before hole', [undefined, 'a'], [[, 'a']]],
  ['after hole', [undefined, 'a'], [['a', ,]]],
  ['inherited vertex', inheritedHole([undefined], 0), []],
  ['inherited edge', [undefined, 'a'], inheritedHole([[undefined, 'a']], 0)],
  ['inherited before endpoint', [undefined, 'a'], [inheritedHole([undefined, 'a'], 0)]],
  ['inherited after endpoint', [undefined, 'a'], [inheritedHole(['a', undefined], 1)]],
]) {
  test(`rejects ${name} with TypeError`, () => {
    assert.throws(() => stableTopologicalSort(vertices, edges), TypeError);
  });
}

test('validates edges before empty results or any cycle diagnosis', () => {
  assert.throws(() => stableTopologicalSort([], [['missing', 'also-missing']]), RangeError);
  assert.throws(() => stableTopologicalSort([], [[]]), TypeError);
  const vertices = ['a', 'b', 'c', undefined];
  for (const prefix of [[], [['a', 'a']], [['a', 'b'], ['b', 'c']],
    [['a', 'b'], ['b', 'c'], ['c', 'a']]]) {
    assert.throws(() => stableTopologicalSort(vertices, [...prefix, ['a', 'missing']]), RangeError);
    assert.throws(() => stableTopologicalSort(vertices, [...prefix, ['missing', 'a']]), RangeError);
    assert.throws(() => stableTopologicalSort(vertices, [...prefix, ['a']]), TypeError);
    assert.throws(() => stableTopologicalSort(vertices, [...prefix, [, 'a']]), TypeError);
    assert.throws(() => stableTopologicalSort(vertices, [...prefix, ,]), TypeError);
  }
});

for (const [name, vertices, edges] of [
  ['self-edge', ['a'], [['a', 'a']]],
  ['undefined self-edge', [undefined], [[undefined, undefined]]],
  ['NaN self-edge', [NaN], [[NaN, NaN]]],
  ['signed-zero self-edge', [-0], [[+0, -0]]],
  ['two-vertex cycle', ['a', 'b'], [['a', 'b'], ['b', 'a']]],
  ['longer cycle', ['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]],
  ['cycle with completed component and downstream tail', ['done', 'other', 'a', 'b', 'tail'],
    [['done', 'other'], ['a', 'b'], ['b', 'a'], ['b', 'tail']]],
]) {
  test(`throws an Error with code CYCLE for ${name}`, () => {
    assertCycle(vertices, edges);
    assertCycle(vertices, edges.toReversed());
  });
}

test('frozen inputs and mutable vertex objects survive success and every failure category', () => {
  const first = { label: 'first' };
  const second = { label: 'second' };
  for (const outcome of ['success', 'duplicate', 'shape', 'endpoint', 'cycle']) {
    const vertices = Object.freeze(outcome === 'duplicate' ? [first, first] : [second, first]);
    const edges = [[first, second]];
    if (outcome === 'shape') edges.push([second]);
    if (outcome === 'endpoint') edges.push([second, 'missing']);
    if (outcome === 'cycle') edges.push([second, first]);
    edges.forEach(Object.freeze);
    Object.freeze(edges);
    const beforeVertices = [...vertices];
    const beforeTuples = [...edges];
    const beforeEndpoints = edges.map(edge => [...edge]);
    if (outcome === 'success') assertOrder(vertices, edges, [first, second]);
    else if (outcome === 'cycle') assertCycle(vertices, edges);
    else assert.throws(() => stableTopologicalSort(vertices, edges), outcome === 'endpoint' ? RangeError : TypeError);
    assert.deepEqual(vertices, beforeVertices);
    assert.deepEqual(edges, beforeEndpoints);
    vertices.forEach((vertex, i) => assert.strictEqual(vertex, beforeVertices[i]));
    edges.forEach((edge, i) => {
      assert.strictEqual(edge, beforeTuples[i]);
      edge.forEach((endpoint, j) => assert.strictEqual(endpoint, beforeEndpoints[i][j]));
    });
    assert.deepEqual(first, { label: 'first' });
    assert.deepEqual(second, { label: 'second' });
    assert.equal(Object.isFrozen(first), false);
    assert.equal(Object.isFrozen(second), false);
  }
});

test('repeated calls have fresh results and no state retained across failures', () => {
  const vertices = [{}, undefined, NaN, -0];
  const first = assertOrder(vertices, [], vertices);
  assert.throws(() => stableTopologicalSort([NaN, NaN], []), TypeError);
  assertCycle([NaN], [[NaN, NaN]]);
  const second = assertOrder(vertices, [], vertices);
  assert.notStrictEqual(first, second);
  first[0] = 'changed result';
  assert.strictEqual(second[0], vertices[0]);
  assertOrder(vertices, [], vertices);
  assert.notStrictEqual(assertOrder([], [], []), assertOrder([], [], []));
});

// Enumerate candidate index orders independently of Kahn's algorithm and heap.
function permutations(items) {
  if (items.length === 0) return [[]];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, i) => i !== index)).map(rest => [item, ...rest]));
}

test('all 4096 loop-free four-vertex graphs match a mixed-identity permutation oracle', () => {
  const vertices = [{}, {}, NaN, -0];
  const indices = [0, 1, 2, 3];
  const possibleEdges = indices.flatMap(from => indices.filter(to => to !== from).map(to => [from, to]));
  const orders = permutations(indices);
  for (let mask = 0; mask < 2 ** possibleEdges.length; mask++) {
    const indexEdges = possibleEdges.filter((_, i) => mask & (1 << i));
    // Permutations are in lexicographic original-index order: the first valid
    // permutation is the required result, without simulating a ready queue.
    const expected = orders.find(order => indexEdges.every(([from, to]) => order.indexOf(from) < order.indexOf(to)));
    const edges = indexEdges.map(([from, to]) => [vertices[from], vertices[to]]);
    for (const inputEdges of [edges, edges.toReversed()]) {
      if (expected) assertOrder(vertices, inputEdges, expected.map(index => vertices[index]));
      else assertCycle(vertices, inputEdges);
    }
  }
});
