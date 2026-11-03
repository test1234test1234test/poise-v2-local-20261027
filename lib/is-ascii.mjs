export function isAscii(text) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a primitive string');
  }

  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) {
      return false;
    }
  }

  return true;
}
