function decodeComponent(component) {
  return decodeURIComponent(component.replace(/\+/g, ' '));
}

/** Parse raw query text into a null-prototype object of ordered value arrays. */
export function parseQueryString(text) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a primitive string');
  }

  const result = Object.create(null);
  const query = text.startsWith('?') ? text.slice(1) : text;
  for (const pair of query.split('&')) {
    if (pair === '') continue;

    // Split before decoding so escaped delimiters remain component data.
    const equals = pair.indexOf('=');
    const key = decodeComponent(equals === -1 ? pair : pair.slice(0, equals));
    const value = decodeComponent(equals === -1 ? '' : pair.slice(equals + 1));

    if (Object.hasOwn(result, key)) {
      result[key].push(value);
    } else {
      result[key] = [value];
    }
  }
  return result;
}
