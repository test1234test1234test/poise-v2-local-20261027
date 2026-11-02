function isObject(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function advance(source) {
  const result = Reflect.apply(source.next, source.iterator, []);
  if (!isObject(result)) throw new TypeError('Iterator results must be objects');
  if (result.done) {
    source.done = true;
    source.value = undefined;
  } else {
    // Results may be reused, even by different iterators. Buffer only the value.
    source.value = result.value;
  }
}

function siftDown(heap, index, before) {
  const source = heap[index];
  while (2 * index + 1 < heap.length) {
    let child = 2 * index + 1;
    if (child + 1 < heap.length && before(heap[child + 1], heap[child])) child++;
    if (!before(heap[child], source)) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = source;
}

function* merge(sources, compare) {
  // Ownership is independent of heap membership, including during failed repairs.
  const opened = new Map();
  const heap = [];
  let failed = false;
  const before = (left, right) => {
    const order = compare(left.value, right.value);
    if (typeof order !== 'number' || !Number.isFinite(order)) {
      throw new TypeError('compare must return a finite primitive number');
    }
    return order < 0 || (order === 0 && left.index < right.index);
  };

  try {
    const length = sources.length;
    for (let index = 0; index < length; index++) {
      const iterable = sources[index];
      const method = iterable?.[Symbol.iterator];
      if (typeof method !== 'function') {
        throw new TypeError('Each source must be a synchronous iterable');
      }
      const iterator = Reflect.apply(method, iterable, []);
      if (!isObject(iterator)) throw new TypeError('Iterators must be objects');
      if (opened.has(iterator)) {
        throw new TypeError('Sources must provide distinct iterators');
      }
      const source = { iterator, index, done: false, value: undefined, next: undefined };
      opened.set(iterator, source);
      // Capture next once, but acquire ownership before its getter can throw.
      source.next = iterator.next;
      if (typeof source.next !== 'function') {
        throw new TypeError('Iterator next must be a function');
      }
      advance(source);
      if (!source.done) heap.push(source);
    }

    for (let index = Math.floor(heap.length / 2) - 1; index >= 0; index--) {
      siftDown(heap, index, before);
    }
    while (heap.length > 0) {
      const winner = heap[0];
      yield winner.value;
      // Deliver the buffered value before attempting the source's next step.
      advance(winner);
      if (winner.done) {
        const last = heap.pop();
        if (heap.length > 0) heap[0] = last;
      }
      if (heap.length > 0) siftDown(heap, 0, before);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    let cleanupFailed = false;
    let firstError;
    for (const source of opened.values()) {
      if (source.done) continue;
      source.done = true;
      source.value = undefined;
      try {
        const close = source.iterator.return;
        if (close === undefined || close === null) continue;
        if (typeof close !== 'function') {
          throw new TypeError('Iterator return must be a function');
        }
        const result = Reflect.apply(close, source.iterator, []);
        if (!isObject(result)) throw new TypeError('Iterator return must return an object');
      } catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true;
          firstError = error;
        }
      }
    }
    // Booleans distinguish no failure from legitimate throws of undefined/null.
    if (!failed && cleanupFailed) throw firstError;
  }
}

/** Lazily merge independently iterated, sorted sources; ties use source index. */
export function mergeSorted(sources, compare) {
  if (!Array.isArray(sources)) throw new TypeError('sources must be an Array');
  if (typeof compare !== 'function') throw new TypeError('compare must be a function');
  return merge(sources, compare);
}
