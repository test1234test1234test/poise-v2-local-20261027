import { mapConcurrent as mapWithOptions } from './lib/map-concurrent.mjs';

export const baseline = () => 'sandbox';

/** Map an Array in input order with an explicit bound on outstanding work. */
export async function mapConcurrent(items, limit, mapper, { signal } = {}) {
  if (typeof limit !== 'number') throw new TypeError('limit must be a number');
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('limit must be a positive safe integer');
  }
  return mapWithOptions(items, mapper, { concurrency: limit, signal });
}
