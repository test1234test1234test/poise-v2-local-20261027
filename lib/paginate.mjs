/** Select a one-based page, preserving own sparse slots in a fresh ordinary Array. */
export function paginate(items, page, pageSize) {
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an Array');
  }
  if (typeof page !== 'number' || typeof pageSize !== 'number') {
    throw new TypeError('page and pageSize must be numbers');
  }
  if (!Number.isSafeInteger(page) || page <= 0
    || !Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new RangeError('page and pageSize must be positive safe integers');
  }

  const totalItems = items.length;
  const totalPages = Math.ceil(totalItems / pageSize);
  // Only multiply for existing pages, whose offsets are within the source length.
  const start = page <= totalPages ? (page - 1) * pageSize : totalItems;
  const selected = new Array(Math.min(pageSize, totalItems - start));
  for (let offset = 0; offset < selected.length; offset += 1) {
    const index = start + offset;
    if (Object.hasOwn(items, index)) {
      // Define own slots without invoking inherited destination setters/getters.
      Object.defineProperty(selected, offset, {
        value: items[index],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }

  return {
    items: selected,
    page,
    pageSize,
    totalItems,
    totalPages,
    hasPrevious: totalPages > 0 && page > 1,
    hasNext: page < totalPages,
  };
}
