# createTtlCache

```js
import { createTtlCache } from './lib/ttl-cache.mjs'; // From the repository root.

let now = 0;
const cache = createTtlCache({ capacity: 2, ttlMs: 10, clock: () => now });
cache.set('a', 1);
now = 5;
cache.set('b', 2);
now = 6;
cache.get('a'); // 1; order is now b, a, but a still expires at 10.
now = 10;
cache.set('c', 3); // Purges expired a, keeping live b.
cache.entries(); // [['b', 2], ['c', 3]], least to most recently used.
cache.set('d', 4); // Evicts b, the least recently used live entry.
cache.entries(); // [['c', 3], ['d', 4]]
```

This synchronous, in-memory cache is separate from the existing
[`LruCache`](lru-cache.md) class. It uses no timers or background work.
Capacity limits the entry count, not bytes; storage grows only with entries.
Each cache owns its contents, recency order, and clock history.

## Configuration

`createTtlCache({ capacity, ttlMs, clock })` requires:

- `capacity`: a positive safe integer primitive number. Non-numbers throw
  `TypeError`; zero, negatives, fractions, unsafe integers, `NaN`, and infinities
  throw `RangeError`. `Number.MAX_SAFE_INTEGER` is accepted without allocating
  to capacity.
- `ttlMs`: a finite positive primitive number of milliseconds. Non-numbers
  throw `TypeError`; zero, negatives, `NaN`, and infinities throw `RangeError`.
  Positive fractions, including `Number.MIN_VALUE`, are accepted.
- `clock`: an optional function returning the current time in milliseconds.
  Omitting it or passing `undefined` selects `Date.now`; other non-functions
  throw `TypeError`.

There is no numeric coercion: strings, boxed numbers, BigInts, and objects are
not numbers. Configuration is validated before returning a cache. Construction
does not call the clock.

## Operations and expiry

Every operation except `clear()` calls the clock exactly once, even for misses
and an empty cache. After validating that reading, it removes **all** entries
whose expiry is less than or equal to that time, then performs the action below.
An expired entry may be anywhere in the recency order. Expired entries remain
stored until an operation purges them or `clear()` removes them.

| Member | Behavior and return value after expiry cleanup |
| --- | --- |
| `set(key, value)` | Inserts or replaces a value, sets its expiry to `sampledNow + ttlMs`, makes it most recent, and returns the cache. If capacity is exceeded, evicts the least recently used live entry. Replacing a live key does not evict another key. |
| `get(key)` | Returns the live value and makes its key most recent without extending expiry. Returns `undefined` on a miss. |
| `has(key)` | Returns whether the key is live, without changing recency or expiry. Distinguishes a stored `undefined` value from absence. |
| `delete(key)` | Removes the key and returns whether a live entry was removed. |
| `clear()` | Removes all entries and returns `undefined`. Calls the clock zero times, including when empty, and retains configuration and clock history. |
| `size` | Read-only getter returning the live entry count without changing recency. |
| `entries()` | Returns a fresh ordinary array of fresh ordinary `[key, value]` arrays, ordered least to most recently used, without changing recency. |

Call order determines recency, including when clock readings are equal. Keys
use `Map` equality: object identity, one key for all `NaN` values, and the same
key for `+0` and `-0`. Numeric and string keys are distinct. Any key or value,
including `undefined`, is supported.

Snapshots are shallow. Editing, reordering, or splicing returned arrays cannot
change cache contents or recency. Later replacement, expiry, eviction, deletion,
and clearing cannot change earlier snapshot pairs. Key and value references
are preserved, so object property changes remain shared intentionally.

Expiry uses ordinary JavaScript Number addition and rounding. A positive TTL
can round to an expiry equal to the insertion time: for example,
`1_800_000_000_000 + 0.0001 === 1_800_000_000_000`. Such an insertion succeeds,
but the next timed operation, even at the same time, sees it as expired. A
finite computed sum is accepted even at extreme magnitudes, such as
`1 + Number.MAX_VALUE === Number.MAX_VALUE`.

## Clock and failure policies

The first successful timed operation establishes the clock baseline. Subsequent
readings may be equal or increase; finite negative readings and zero are valid.
History survives misses, deletion of the final entry, full expiry, and `clear()`.
For example, after accepting time `10`, clearing the cache does not permit a
reading of `5`. These rules also apply to the default `Date.now`, whose wall
clock can move backward, including when reading `size` or calling `entries()`.

- A non-number clock result throws `TypeError` without coercion.
- `NaN`, either infinity, or a reading below the last accepted time throws
  `RangeError`.
- If the clock throws, its exact thrown value is propagated.
- If `set` computes a non-finite expiry, it throws `RangeError`.

These failures leave cache contents, expiries, recency, and the last accepted
time unchanged. In particular, **the chosen overflow policy validates the new
expiry before any purge or clock-history update**, an exception to the usual
purge-before-action rule. This also applies to replacement, insertion at
capacity, and the first-ever `set`. A later reading below a failed call's time
is accepted if it is not below the last successful reading. Caller-owned clock
counters or other side effects of invoking the clock are not rolled back.
Each attempted timed operation calls the clock once, even when rejected;
`clear()` remains usable when the clock is broken.

Run the direct-import regression tests with `node --test test/ttl-cache.test.mjs`
and the complete repository suite with `npm test` (equivalent to `node --test`).
