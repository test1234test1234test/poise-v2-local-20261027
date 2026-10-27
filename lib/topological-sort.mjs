// A min-heap of declaration indices applies priority at every selection,
// including when a newly available node precedes an already waiting node.
function pushReady(heap, node) {
  let index = heap.length;
  heap.push(node);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent] <= node) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = node;
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

function findCycle(nodes, outgoing, indegree) {
  // Only needed after sorting fails. Copy before sorting so edge insertion
  // order cannot influence the witness, and caller-owned arrays stay intact.
  const neighbors = outgoing.map(targets => [...targets].sort((a, b) => a - b));
  const state = new Uint8Array(nodes.length); // 0: unseen, 1: active, 2: finished
  const activePosition = new Array(nodes.length).fill(-1);
  const stack = [];

  for (let root = 0; root < nodes.length; root++) {
    if (indegree[root] === 0 || state[root] !== 0) continue;
    state[root] = 1;
    activePosition[root] = 0;
    stack.push({ node: root, nextEdge: 0 });

    // Explicit DFS frames keep both long cycles and long blocked tails safe.
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.nextEdge === neighbors[frame.node].length) {
        state[frame.node] = 2;
        activePosition[frame.node] = -1;
        stack.pop();
        continue;
      }
      const next = neighbors[frame.node][frame.nextEdge++];
      if (indegree[next] === 0 || state[next] === 2) continue;
      if (state[next] === 1) {
        const cycle = stack.slice(activePosition[next]).map(entry => nodes[entry.node]);
        cycle.push(nodes[next]);
        return cycle;
      }
      state[next] = 1;
      activePosition[next] = stack.length;
      stack.push({ node: next, nextEdge: 0 });
    }
  }
  // Kahn's algorithm can leave nodes blocked only when a cycle exists.
  throw new Error('Internal error: blocked graph has no cycle');
}

/**
 * Return a fresh dependency order, prioritizing the earliest declared ready ID.
 * Edges are [dependency, dependent]; cyclic graphs throw with cycle evidence.
 */
export function topologicalSort(nodes, edges) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw new TypeError('nodes and edges must be Arrays');
  }

  const indices = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const id = nodes[i];
    if (typeof id !== 'string') throw new TypeError('Node IDs must be strings');
    if (indices.has(id)) throw new RangeError('Node IDs must be unique');
    indices.set(id, i);
  }

  const outgoing = Array.from({ length: nodes.length }, () => new Set());
  const indegree = new Array(nodes.length).fill(0);
  // Validate every edge before any ordering or cycle diagnosis. Indexed reads
  // also reject sparse arrays instead of silently skipping missing entries.
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (!Array.isArray(edge) || edge.length !== 2) {
      throw new TypeError('Edges must be two-element Arrays');
    }
    const from = edge[0];
    const to = edge[1];
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new TypeError('Edge endpoints must be strings');
    }
    if (!indices.has(from) || !indices.has(to)) {
      throw new RangeError('Edge endpoints must be declared nodes');
    }
    const dependency = indices.get(from);
    const dependent = indices.get(to);
    if (!outgoing[dependency].has(dependent)) {
      outgoing[dependency].add(dependent);
      indegree[dependent]++;
    }
  }

  const ready = [];
  for (let i = 0; i < nodes.length; i++) {
    if (indegree[i] === 0) pushReady(ready, i);
  }
  const result = [];
  while (ready.length > 0) {
    const current = popReady(ready);
    result.push(nodes[current]);
    for (const dependent of outgoing[current]) {
      indegree[dependent]--;
      if (indegree[dependent] === 0) pushReady(ready, dependent);
    }
  }

  if (result.length !== nodes.length) {
    const error = new Error('Dependency cycle detected');
    error.name = 'CycleError';
    error.cycle = findCycle(nodes, outgoing, indegree);
    throw error;
  }
  return result;
}
