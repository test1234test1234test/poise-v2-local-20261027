/** Merge closed numeric intervals into fresh ordinary arrays without input writes. */
export function mergeIntervals(intervals) {
  if (!Array.isArray(intervals)) {
    throw new TypeError('intervals must be an Array');
  }

  const length = intervals.length;
  const sorted = [];
  // Capture and validate before sorting, without input iterators or species.
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(intervals, index)) {
      throw new TypeError('intervals must not contain holes');
    }
    const pair = intervals[index];
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new TypeError('each interval must be a two-element Array');
    }
    if (!Object.hasOwn(pair, 0)) {
      throw new TypeError('interval pairs must not contain holes');
    }
    const start = pair[0];
    if (!Object.hasOwn(pair, 1)) {
      throw new TypeError('interval pairs must not contain holes');
    }
    const end = pair[1];
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      throw new TypeError('interval endpoints must be finite numbers with start <= end');
    }
    sorted.push([start === 0 ? 0 : start, end === 0 ? 0 : end]);
  }
  sorted.sort((left, right) => left[0] - right[0] || left[1] - right[1]);

  const result = [];
  for (const pair of sorted) {
    const previous = result[result.length - 1];
    if (previous === undefined || pair[0] > previous[1]) {
      result.push(pair);
    } else if (pair[1] > previous[1]) {
      // Shared endpoints merge; contained intervals must not shrink the end.
      previous[1] = pair[1];
    }
  }
  return result;
}
