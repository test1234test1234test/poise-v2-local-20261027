/** Parse escaped dot paths into independent arrays of literal segment strings. */
export function parseDotPath(text) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a primitive string');
  }

  const segments = [];
  let segment = '';

  function finishSegment() {
    if (segment === '') {
      throw new SyntaxError('Dot path segments must not be empty');
    }
    if (segment === '__proto__' || segment === 'prototype' || segment === 'constructor') {
      throw new SyntaxError('Forbidden dot path segment');
    }
    segments.push(segment);
    segment = '';
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '.') {
      finishSegment();
    } else if (character === '\\') {
      const escaped = text[++index];
      if (escaped !== '.' && escaped !== '\\') {
        throw new SyntaxError('Invalid dot path escape');
      }
      // Consume the escape once; decoded dots and backslashes remain content.
      segment += escaped;
    } else {
      segment += character;
    }
  }
  finishSegment();
  return segments;
}
