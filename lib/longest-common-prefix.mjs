/** Return the longest shared code-point prefix without modifying the input. */
export function longestCommonPrefix(strings) {
  if (!Array.isArray(strings)) {
    throw new TypeError('strings must be an Array');
  }

  // Validate and capture every indexed value before any empty-prefix shortcut.
  // Do not consult input iterators or constructors when taking this snapshot.
  const length = strings.length;
  const values = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(strings, index)) {
      throw new TypeError('strings must not contain holes');
    }
    const value = strings[index];
    if (typeof value !== 'string') {
      throw new TypeError('strings must contain only primitive strings');
    }
    values.push(value);
  }
  if (length === 0) return '';

  const first = values[0];
  let end = first.length;
  for (let index = 1; index < length && end > 0; index += 1) {
    const value = values[index];
    let offset = 0;
    while (offset < end && offset < value.length) {
      const point = first.codePointAt(offset);
      if (point !== value.codePointAt(offset)) break;
      // Keep UTF-16 slice offsets on code-point boundaries in every input.
      offset += point > 0xFFFF ? 2 : 1;
    }
    end = offset;
  }
  return first.slice(0, end);
}
