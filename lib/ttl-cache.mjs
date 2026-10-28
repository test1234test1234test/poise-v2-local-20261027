export function createTtlCache({ capacity, ttlMs, clock = Date.now }) {
  if (typeof capacity !== 'number') {
    throw new TypeError('capacity must be a number');
  }
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError('capacity must be a positive safe integer');
  }
  if (typeof ttlMs !== 'number') {
    throw new TypeError('ttlMs must be a number');
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError('ttlMs must be finite and positive');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('clock must be a function');
  }

  // Map insertion order tracks entries from least to most recently used.
  const records = new Map();
  let lastTime;

  function readTime() {
    const now = clock();
    if (typeof now !== 'number') {
      throw new TypeError('clock must return a number');
    }
    if (!Number.isFinite(now)) {
      throw new RangeError('clock must return a finite number');
    }
    if (lastTime !== undefined && now < lastTime) {
      throw new RangeError('clock must not move backward');
    }
    return now;
  }

  function purgeExpired(now) {
    // Recency and expiry order can differ, so inspect every entry.
    for (const [key, record] of records) {
      if (now >= record.expiry) records.delete(key);
    }
    lastTime = now;
  }

  const cache = {
    set(key, value) {
      const now = readTime();
      const expiry = now + ttlMs;
      // Overflow must not commit a purge, eviction, or clock-history update.
      if (!Number.isFinite(expiry)) {
        throw new RangeError('expiry must be finite');
      }
      purgeExpired(now);
      records.delete(key);
      records.set(key, { value, expiry });
      if (records.size > capacity) {
        records.delete(records.keys().next().value);
      }
      return cache;
    },

    get(key) {
      purgeExpired(readTime());
      if (!records.has(key)) return undefined;

      const record = records.get(key);
      records.delete(key);
      records.set(key, record);
      return record.value;
    },

    has(key) {
      purgeExpired(readTime());
      return records.has(key);
    },

    delete(key) {
      purgeExpired(readTime());
      return records.delete(key);
    },

    clear() {
      records.clear();
    },

    entries() {
      purgeExpired(readTime());
      return Array.from(records, ([key, record]) => [key, record.value]);
    },

    get size() {
      purgeExpired(readTime());
      return records.size;
    },
  };

  return cache;
}
