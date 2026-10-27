import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topologicalSort } from '../lib/topological-sort.mjs';

function assertOrder(nodes, edges, result) {
  assert.ok(Array.isArray(result));
  assert.notStrictEqual(result, nodes);
  assert.equal(result.length, nodes.length);
  assert.equal(new Set(result).size, nodes.length);
  const positions = new Map(result.map((id, index) => [id, index]));
  for (const id of nodes) assert.ok(positions.has(id));
  for (const [dependency, dependent] of edges) {
    assert.ok(positions.get(dependency) < positions.get(dependent));
  }
}

function cycleFrom(nodes, edges) {
  let error;
  try {
    topologicalSort(nodes, edges);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error, 'a cyclic graph must throw an Error');
  assert.equal(error.name, 'CycleError');
  assert.match(error.message, /cycle/i);
  const { cycle } = error;
  assert.ok(Array.isArray(cycle));
  assert.ok(cycle.length >= 2);
  assert.notStrictEqual(cycle, nodes);
  assert.notStrictEqual(cycle, edges);
  for (const edge of edges) assert.notStrictEqual(cycle, edge);
  assert.equal(cycle[0], cycle.at(-1));
  const declared = new Set(nodes);
  const supplied = new Map(nodes.map(id => [id, new Set()]));
  for (const [from, to] of edges) supplied.get(from).add(to);
  for (let i = 0; i < cycle.length; i++) {
    assert.ok(declared.has(cycle[i]));
    if (i > 0) assert.ok(supplied.get(cycle[i - 1]).has(cycle[i]));
  }
  return cycle;
}

const orderCases = [
  ['empty graph', [], [], []],
  ['declaration order without edges', ['b', 'a', ''], [], ['b', 'a', '']],
  ['dependency direction', ['build', 'fetch'], [['fetch', 'build']], ['fetch', 'build']],
  ['newly available node overtakes a waiting node', ['b', 'a', 'c'], [['a', 'b']], ['a', 'b', 'c']],
  ['new siblings use node order, not edge order', ['d', 'b', 'a', 'c'], [['a', 'b'], ['a', 'd']], ['a', 'd', 'b', 'c']],
  ['disconnected components and isolate', ['d', 'b', 'a', 'c', 'i'], [['a', 'b'], ['c', 'd']], ['a', 'b', 'c', 'd', 'i']],
  ['duplicate edges count once', ['b', 'a', 'c'], [['a', 'b'], ['a', 'b']], ['a', 'b', 'c']],
  ['shared descendant is not a cycle', ['a', 'b', 'c'], [['a', 'b'], ['a', 'c'], ['c', 'b']], ['a', 'c', 'b']],
  ['prototype-like and empty IDs', ['constructor', '__proto__', 'toString', ''], [['', 'toString'], ['toString', '__proto__'], ['__proto__', 'constructor']], ['', 'toString', '__proto__', 'constructor']],
  ['edge keys cannot collide on delimiters', ['b,c', 'c', 'a,b', 'a'], [['a,b', 'c'], ['a', 'b,c']], ['a,b', 'c', 'a', 'b,c']],
];

for (const [name, nodes, edges, expected] of orderCases) {
  test(name, () => {
    const results = [edges, edges.toReversed(), edges].map(inputEdges => {
      const result = topologicalSort(nodes, inputEdges);
      assertOrder(nodes, edges, result);
      assert.deepEqual(result, expected);
      return result;
    });
    assert.notStrictEqual(results[0], results[1]);
    results[0].push('changed result');
    assert.deepEqual(results[2], expected);
  });
}

const invalidCases = [
  ['omitted arguments', [], TypeError],
  ['missing edges', [[]], TypeError],
  ['null nodes', [null, []], TypeError],
  ['string nodes', ['abc', []], TypeError],
  ['iterable nodes', [new Set(['a']), []], TypeError],
  ['array-like nodes', [{ 0: 'a', length: 1 }, []], TypeError],
  ['null edges', [[], null], TypeError],
  ['string edges', [[], ''], TypeError],
  ['iterable edges', [[], new Set()], TypeError],
  ['array-like edges', [[], { length: 0 }], TypeError],
  ['numeric ID', [[0], []], TypeError],
  ['null ID', [[null], []], TypeError],
  ['undefined ID', [[undefined], []], TypeError],
  ['symbol ID', [[Symbol('a')], []], TypeError],
  ['boxed string ID', [[new String('a')], []], TypeError],
  ['sparse nodes', [Array(1), []], TypeError],
  ['null edge', [['a'], [null]], TypeError],
  ['string edge', [['a'], ['aa']], TypeError],
  ['array-like edge', [['a'], [{ 0: 'a', 1: 'a', length: 2 }]], TypeError],
  ['empty tuple', [['a'], [[]]], TypeError],
  ['short tuple', [['a'], [['a']]], TypeError],
  ['long tuple', [['a'], [['a', 'a', 'a']]], TypeError],
  ['sparse edges', [['a'], Array(1)], TypeError],
  ['sparse tuple', [['a'], [Array(2)]], TypeError],
  ['missing dependency slot', [['a'], [[, 'a']]], TypeError],
  ['missing dependent slot', [['a'], [['a', ,]]], TypeError],
  ['nonstring dependency', [['a'], [[42, 'a']]], TypeError],
  ['nonstring dependent', [['a'], [['a', null]]], TypeError],
  ['boxed dependency', [['a'], [[new String('a'), 'a']]], TypeError],
  ['boxed dependent', [['a'], [['a', new String('a')]]], TypeError],
  ['duplicate ID', [['a', 'a'], []], RangeError],
  ['duplicate empty ID', [['', ''], []], RangeError],
  ['duplicate prototype-like ID', [['__proto__', '__proto__'], []], RangeError],
  ['undeclared dependency', [['a'], [['missing', 'a']]], RangeError],
  ['undeclared dependent', [['a'], [['a', 'missing']]], RangeError],
  ['empty graph still validates edges', [[], [['x', 'y']]], RangeError],
  ['empty graph rejects malformed edges', [[], [[]]], TypeError],
  ['self-loop cannot mask undeclared endpoint', [['a'], [['a', 'a'], ['a', 'missing']]], RangeError],
  ['self-loop cannot mask malformed tuple', [['a'], [['a', 'a'], ['a']]], TypeError],
];

for (const [name, args, ErrorType] of invalidCases) {
  test(`rejects ${name}`, () => {
    assert.throws(() => topologicalSort(...args), ErrorType);
    const nodes = ['a', '', '__proto__'];
    const edges = [['__proto__', 'a'], ['a', '']];
    const result = topologicalSort(nodes, edges);
    assertOrder(nodes, edges, result);
    assert.deepEqual(result, ['__proto__', 'a', '']);
  });
}

for (const id of ['self', '', '__proto__']) {
  test(`self-loop evidence for ${JSON.stringify(id)}`, () => {
    assert.deepEqual(cycleFrom([id], [[id, id], [id, id]]), [id, id]);
  });
}

test('cycle evidence excludes downstream tails and completed components', () => {
  const nodes = ['tail', 'done', 'a', 'b', 'upstream'];
  const edges = [['a', 'b'], ['b', 'a'], ['b', 'tail'], ['upstream', 'a']];
  const cycle = cycleFrom(nodes, edges);
  assert.ok(cycle.every(id => id === 'a' || id === 'b'));
  const result = topologicalSort(nodes, [['upstream', 'a'], ['a', 'b'], ['b', 'tail']]);
  assertOrder(nodes, [['upstream', 'a'], ['a', 'b'], ['b', 'tail']], result);
  assert.deepEqual(result, ['done', 'upstream', 'a', 'b', 'tail']);
});

test('cycle traversal follows declaration order across edge permutations', () => {
  const nodes = ['z', 'b', 'a'];
  const edges = [['z', 'a'], ['a', 'z'], ['z', 'b'], ['b', 'z']];
  const first = cycleFrom(nodes, edges);
  assert.deepEqual(first, ['z', 'b', 'z']);
  for (const permutation of [edges.toReversed(), [edges[1], edges[3], edges[0], edges[2]], edges]) {
    const cycle = cycleFrom(nodes, permutation);
    assert.deepEqual(cycle, first);
    assert.notStrictEqual(cycle, first);
  }
  first[0] = 'modified witness';
  assert.deepEqual(cycleFrom(nodes, edges), ['z', 'b', 'z']);
});

test('separate cyclic components use declaration order for candidate roots', () => {
  const nodes = ['z', 'y', 'a', 'b'];
  const edges = [['a', 'b'], ['b', 'a'], ['y', 'z'], ['z', 'y']];
  assert.deepEqual(cycleFrom(nodes, edges), ['z', 'y', 'z']);
  assert.deepEqual(cycleFrom(nodes, edges.toReversed()), ['z', 'y', 'z']);
});

test('sorting and cycle extraction preserve frozen inputs and nested tuples', () => {
  for (const cyclic of [false, true]) {
    const nodes = Object.freeze(['c', 'b', 'a']);
    const edges = [['a', 'b'], ['b', 'c'], ['a', 'b']];
    if (cyclic) edges.push(['c', 'a']);
    edges.forEach(Object.freeze);
    Object.freeze(edges);
    const beforeNodes = [...nodes];
    const beforeEdges = edges.map(edge => [...edge]);
    if (cyclic) cycleFrom(nodes, edges);
    else assertOrder(nodes, edges, topologicalSort(nodes, edges));
    assert.deepEqual(nodes, beforeNodes);
    assert.deepEqual(edges, beforeEdges);
  }
});

// Enumerate orders independently of the implementation's ready queue or DFS.
function permutations(items) {
  if (items.length === 0) return [[]];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, i) => i !== index)).map(rest => [item, ...rest]));
}

test('all 4096 loop-free four-node graphs agree with an exhaustive order oracle', () => {
  const nodes = ['z', 'constructor', '', 'a'];
  const possibleEdges = nodes.flatMap(from => nodes.filter(to => to !== from).map(to => [from, to]));
  const orders = permutations(nodes).map(order => ({
    order,
    positions: new Map(order.map((id, index) => [id, index])),
  }));
  for (let mask = 0; mask < 2 ** possibleEdges.length; mask++) {
    const edges = possibleEdges.filter((_, i) => mask & (1 << i)).toReversed();
    const expected = orders.find(({ positions }) =>
      edges.every(([from, to]) => positions.get(from) < positions.get(to)));
    if (expected) {
      const result = topologicalSort(nodes, edges);
      assertOrder(nodes, edges, result);
      assert.deepEqual(result, expected.order, `graph ${mask}`);
    } else {
      const first = cycleFrom(nodes, edges);
      assert.deepEqual(cycleFrom(nodes, edges.toReversed()), first, `graph ${mask}`);
    }
  }
});

test('a reversed declaration chain of 20,000 nodes is depth-safe', () => {
  const expected = Array.from({ length: 20_000 }, (_, i) => `node-${i}`);
  const nodes = expected.toReversed();
  const edges = expected.slice(1).map((id, i) => [expected[i], id]);
  const result = topologicalSort(nodes, edges);
  assertOrder(nodes, edges, result);
  assert.deepEqual(result, expected);
});

test('a directed cycle of 20,000 nodes produces depth-safe, valid evidence', () => {
  const nodes = Array.from({ length: 20_000 }, (_, i) => `node-${i}`);
  const edges = nodes.map((id, i) => [id, nodes[(i + 1) % nodes.length]]);
  const first = cycleFrom(nodes, edges);
  assert.equal(first.length, nodes.length + 1);
  const second = cycleFrom(nodes, edges.toReversed());
  assert.deepEqual(second, first);
  assert.notStrictEqual(second, first);
  assert.deepEqual(topologicalSort(['node-0'], []), ['node-0']);
});

test('large ready sets retain priority as newly released nodes overtake them', () => {
  const nodes = Array.from({ length: 20_000 }, (_, i) => `node-${i}`);
  const edges = nodes.filter((_, i) => i % 2 === 1).map((id, i) => [id, nodes[2 * i]]).toReversed();
  const expected = [];
  for (let i = 0; i < nodes.length; i += 2) expected.push(nodes[i + 1], nodes[i]);
  const result = topologicalSort(nodes, edges);
  assertOrder(nodes, edges, result);
  assert.deepEqual(result, expected);
});
