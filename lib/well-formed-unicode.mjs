export function isWellFormedUnicode(text) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a primitive string');
  }

  return text.isWellFormed();
}
