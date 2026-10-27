# Deterministic dependency ordering

Import the named helper directly; no graph package is required:

```js
import { topologicalSort } from '../lib/topological-sort.mjs';

topologicalSort(['build', 'fetch', 'docs'], [['fetch', 'build']]);
// ['fetch', 'build', 'docs']
```

`topologicalSort(nodes, edges)` accepts an Array of unique primitive string IDs
and an Array of two-element tuples `[dependency, dependent]`. The dependency
must appear before its dependent in the result. IDs may be empty strings or
names such as `constructor` and `__proto__`. Duplicate edges count once.

The result is a new Array containing every declared node exactly once, including
disconnected components and isolated nodes. Both empty arrays produce a new
empty result. With no edges, the result is a copy of `nodes` in declaration order.

When several nodes are available, the earliest in the original `nodes` array is
selected **at each step**. In the example, `fetch` and `docs` are initially
available. Selecting `fetch` releases `build`, whose earlier declaration gives
it priority over the waiting `docs`. Edge-array order does not affect the result.

The function never modifies `nodes`, `edges`, or the nested tuples. Frozen inputs
are supported. Each result and cycle witness is independently allocated; editing
one cannot affect the inputs or a later call. All traversal state is local to a
call, including calls that throw.

## Validation and errors

All graph data is validated before sorting or diagnosing cycles:

| Error | Condition |
| --- | --- |
| `TypeError` | Either top-level argument is not an Array; any node ID is not a primitive string; an edge is not an Array of length two; or either endpoint is not a primitive string. |
| `RangeError` | Node IDs repeat (including empty strings), or an endpoint names an undeclared node. |
| `Error` with `name === 'CycleError'` | The fully validated graph contains a directed cycle. |

Arguments are required and are not coerced. Sparse slots read as `undefined`
and are invalid wherever a node, edge tuple, or endpoint is required. An empty
node array does not bypass edge validation. Likewise, a self-loop followed by
an invalid edge produces the appropriate validation error rather than a
`CycleError`. When there are multiple independent validation problems, which
validation error is reported first is not part of the contract.

## Cycle evidence

```js
try {
  topologicalSort(
    ['tail', 'a', 'b'],
    [['a', 'b'], ['b', 'a'], ['b', 'tail']],
  );
} catch (error) {
  if (error.name !== 'CycleError') throw error;
  console.log(error.message); // 'Dependency cycle detected'
  console.log(error.cycle);   // ['a', 'b', 'a']
}
```

`error.cycle` is a fresh Array describing an actual directed closed walk: its
first ID repeats at the end, and every adjacent ordered pair is a supplied
edge. A self-loop yields `[id, id]`. A blocked downstream node such as `tail`
does not become part of the witness simply because sorting could not reach it.

Cycle discovery visits remaining candidate roots and their outgoing neighbors
in declaration order using iterative depth-first traversal. Identical graphs
produce identical evidence even when edges are reordered or repeated. The API
does not promise a shortest cycle or a globally canonical rotation. Check the
error's name and cycle property, not exact message wording; the message identifies
that a cycle was detected. No separately exported error class is required.

Sorting uses a min-heap of ready declaration indices. Both sorting and cycle
discovery are iterative, including graphs at least 20,000 nodes deep. With `V`
nodes, `M` supplied edges and `E` unique edges, space is `O(V + E)`, successful
sorting takes `O(M + V log(V + 1))`, and cycle diagnosis additionally sorts
outgoing neighbors in `O(E log(V + 1))` time.
