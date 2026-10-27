export class LruCache {
  #capacity;
  // Map insertion order tracks entries from least to most recent.
  #entries = new Map();

  constructor(capacity) {
    if (typeof capacity !== 'number') {
      throw new TypeError('capacity must be a number');
    }
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError('capacity must be a positive safe integer');
    }
    this.#capacity = capacity;
  }

  get(key) {
    if (!this.#entries.has(key)) return undefined;

    const value = this.#entries.get(key);
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  has(key) {
    return this.#entries.has(key);
  }

  set(key, value) {
    // Delete first so updates move to the end without growing the cache.
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.#capacity) {
      const oldestKey = this.#entries.keys().next().value;
      this.#entries.delete(oldestKey);
    }
    return this;
  }

  delete(key) {
    return this.#entries.delete(key);
  }

  clear() {
    this.#entries.clear();
  }

  get size() {
    return this.#entries.size;
  }

  entries() {
    return Array.from(this.#entries);
  }
}
