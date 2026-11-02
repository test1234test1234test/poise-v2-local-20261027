/** A bounded FIFO that stores payloads by reference, including undefined. */
export function createRingBuffer(capacity) {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new TypeError('capacity must be a positive safe integer');
  }

  // Keep only live nodes: no capacity-sized allocation or historical index.
  let head = null;
  let tail = null;
  let size = 0;

  return {
    get size() {
      return size;
    },

    push(value) {
      const node = { value, next: null };
      if (tail === null) head = node;
      else tail.next = node;
      tail = node;

      if (size === capacity) {
        const droppedValue = head.value;
        head = head.next;
        return { evicted: true, value: droppedValue };
      }
      size += 1;
      return { evicted: false };
    },

    shift() {
      if (head === null) return { found: false };

      const value = head.value;
      head = head.next;
      size -= 1;
      if (head === null) tail = null;
      return { found: true, value };
    },

    clear() {
      head = null;
      tail = null;
      size = 0;
    },

    toArray() {
      // Allocate only the snapshot's size; Array rejects unrepresentable lengths.
      const result = new Array(size);
      let index = 0;
      for (let node = head; node !== null; node = node.next) {
        result[index++] = node.value;
      }
      return result;
    },
  };
}
