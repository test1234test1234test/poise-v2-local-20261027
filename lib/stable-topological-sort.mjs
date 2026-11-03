// Prioritize original positions at every selection, including newly ready ones.
function pushReady(heap, vertex) {
  let index = heap.length;
  heap.push(vertex);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent] <= vertex) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = vertex;
}

function popReady(heap) {
  const first = heap[0];
  const last = heap.pop();
  if (heap.length === 0) return first;
  let index = 0;
  while (2 * index + 1 < heap.length) {
    let child = 2 * index + 1;
    if (child + 1 < heap.length && heap[child + 1] < heap[child]) child++;
    if (last <= heap[child]) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return first;
}

/**
 * Return a fresh topological order of arbitrary SameValueZero vertex identities.
 * Edges are [before, after]; ties favor the earliest original vertex position.
 */
export function stableTopologicalSort(vertices, edges) {
  if (!Array.isArray(vertices) || !Array.isArray(edges)) {
    throw new TypeError('vertices and edges must be Arrays');
  }

  const indices = new Map();
  const values = [];
  const length = vertices.length;
  for (let i = 0; i < length; i++) {
    if (!Object.hasOwn(vertices, i)) {
      throw new TypeError('vertices must not contain holes');
    }
    const vertex = vertices[i];
    if (indices.has(vertex)) throw new TypeError('Vertices must be unique');
    indices.set(vertex, i);
    // Map keys normalize -0 to +0; retain the original values for the result.
    values.push(vertex);
  }

  const outgoing = Array.from({ length }, () => new Set());
  const indegree = new Array(length).fill(0);
  // Validate all edges before ordering, even for empty graphs or self-cycles.
  for (let i = 0; i < edges.length; i++) {
    if (!Object.hasOwn(edges, i)) {
      throw new TypeError('edges must not contain holes');
    }
    const edge = edges[i];
    if (!Array.isArray(edge) || edge.length !== 2 ||
        !Object.hasOwn(edge, 0) || !Object.hasOwn(edge, 1)) {
      throw new TypeError('Edges must be dense two-element Arrays');
    }
    const before = edge[0];
    const after = edge[1];
    if (!indices.has(before) || !indices.has(after)) {
      throw new RangeError('Edge endpoints must be declared vertices');
    }
    const from = indices.get(before);
    const to = indices.get(after);
    if (!outgoing[from].has(to)) {
      outgoing[from].add(to);
      indegree[to]++;
    }
  }

  const ready = [];
  for (let i = 0; i < length; i++) {
    if (indegree[i] === 0) pushReady(ready, i);
  }
  const result = [];
  while (ready.length > 0) {
    const current = popReady(ready);
    result.push(values[current]);
    for (const next of outgoing[current]) {
      indegree[next]--;
      if (indegree[next] === 0) pushReady(ready, next);
    }
  }

  if (result.length !== length) {
    const error = new Error('Dependency cycle detected');
    error.code = 'CYCLE';
    throw error;
  }
  return result;
}
