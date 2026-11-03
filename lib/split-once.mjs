/** Split at the first literal, case-sensitive match in UTF-16 code units. */
export function splitOnce(text, separator) {
  if (typeof text !== 'string' || typeof separator !== 'string') {
    throw new TypeError('text and separator must be primitive strings');
  }
  if (separator.length === 0) {
    throw new RangeError('separator must not be empty');
  }

  const index = text.indexOf(separator);
  if (index === -1) {
    return [text, null];
  }
  return [text.slice(0, index), text.slice(index + separator.length)];
}
