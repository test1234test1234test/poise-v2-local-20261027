import { isWellFormedUnicode } from './well-formed-unicode.mjs';

/** Split well-formed text greedily at code-point boundaries within a UTF-8 byte limit. */
export function chunkUtf8(text, maxBytes) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a primitive string');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }
  // Validate the whole string first so malformed UTF-16 takes precedence over capacity.
  if (!isWellFormedUnicode(text)) {
    throw new TypeError('text must be well-formed Unicode');
  }

  const result = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    const point = text.codePointAt(index);
    const width = point <= 0x7F ? 1 : point <= 0x7FF ? 2 : point <= 0xFFFF ? 3 : 4;
    if (width > maxBytes) {
      throw new RangeError('a code point exceeds maxBytes');
    }
    if (bytes + width > maxBytes) {
      result.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += width;
    index += point > 0xFFFF ? 2 : 1;
  }
  if (start < text.length) result.push(text.slice(start));
  return result;
}
