# LruCache

```js
import { LruCache } from './lib/lru-cache.mjs'; // From the repository root.

const cache = new LruCache(2);
cache.set('a', 1).set('b', 2);
cache.get('a'); // 1; protects a by making it most recent.
cache.set('c', 3); // Evicts b.
cache.entries(); // [['a', 1], ['c', 3]], least-recent first.
```

`new LruCache(capacity)` accepts a positive safe integer number. Capacity limits
the number of entries, not their byte size, and storage grows with stored entries.
Non-number capacities (including omitted arguments, strings, BigInts and boxed
numbers) throw `TypeError`. Numbers that are not positive safe integers throw
`RangeError`. No coercion or default capacity is provided.

Keys use JavaScript `Map` equality: objects compare by identity, `NaN` equals
`NaN`, and `+0` and `-0` identify the same key. All values, including `undefined`,
can be stored. Each instance owns its contents and recency order.

| Member | Behavior and return value |
| --- | --- |
| `get(key)` | Returns the value and makes an existing key most recent. Returns `undefined` for a missing key without changing order. |
| `has(key)` | Returns whether the key exists, without changing order. Distinguishes stored `undefined` from absence. |
| `set(key, value)` | Inserts or updates the value, makes the key most recent, and returns this cache for chaining. Evicts the least recent key if capacity is exceeded. An update does not increase size or evict another entry. |
| `delete(key)` | Removes the key and returns whether it existed; preserves the relative order of remaining keys. |
| `clear()` | Removes all entries, retains capacity, and returns `undefined`. Safe on an empty cache. |
| `size` | Read-only getter returning the entry count, without changing order. |
| `entries()` | Returns an independent Array of `[key, value]` pairs in least-recent-first order, without changing order. |

Snapshots are **shallow**: every `entries()` call creates a fresh outer Array and
fresh pair Arrays. Replacing pairs, assigning pair elements, sorting, or splicing
a snapshot cannot change cache contents or recency. Later cache operations do not
change an earlier snapshot's associations or order. Object keys and values retain
their original references, so changing an object's properties through a snapshot
also changes that shared object; objects are not cloned.

The cache is synchronous and in-memory, with no dependencies, timers, shared
global state, or persistence.
