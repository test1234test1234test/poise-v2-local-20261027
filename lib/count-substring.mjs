/** Count literal, case-sensitive, non-overlapping matches in UTF-16 code units. */
export function countSubstring(text, needle) {
  if (typeof text !== 'string' || typeof needle !== 'string') {
    throw new TypeError('text and needle must be primitive strings');
  }
  if (needle.length === 0) {
    throw new RangeError('needle must not be empty');
  }

  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}
