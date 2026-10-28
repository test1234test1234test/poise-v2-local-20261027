const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function trimWhitespace(text) {
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === ' ' || text[start] === '\t')) start++;
  while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  return text.slice(start, end);
}

// Ordinary objects reorder array-index names. Keep source order without adding
// bookkeeping properties, and track subsequent caller additions/deletions too.
function orderedObject() {
  const keys = new Set();
  return new Proxy(Object.create(null), {
    ownKeys() { return [...keys]; },
    defineProperty(target, key, descriptor) {
      const defined = Reflect.defineProperty(target, key, descriptor);
      if (defined) keys.add(key);
      return defined;
    },
    deleteProperty(target, key) {
      const deleted = Reflect.deleteProperty(target, key);
      if (deleted) keys.delete(key);
      return deleted;
    },
  });
}

function fail(message, lineNumber) {
  const error = new SyntaxError(`${message} at line ${lineNumber}`);
  error.lineNumber = lineNumber;
  throw error;
}

function validateName(name, lineNumber) {
  if (!name || CONTROL.test(name) || name.includes('[') || name.includes(']')) {
    fail('invalid name', lineNumber);
  }
}

function parseValue(value, lineNumber) {
  // Check source characters before decoding: documented escapes may produce
  // controls, but a raw tab inside quotes or other field content is invalid.
  if (CONTROL.test(value)) fail('raw control in value', lineNumber);
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return value;

  let decoded = '';
  for (let index = 1; index < value.length; index++) {
    const character = value[index];
    if (character === quote) {
      if (index !== value.length - 1) fail('trailing quoted content', lineNumber);
      return decoded;
    }
    if (character !== '\\') {
      decoded += character;
      continue;
    }

    const escaped = value[++index];
    if (escaped === quote || escaped === '\\') decoded += escaped;
    else if (escaped === 'n') decoded += '\n';
    else if (escaped === 'r') decoded += '\r';
    else if (escaped === 't') decoded += '\t';
    else fail('unknown or incomplete escape', lineNumber);
  }
  fail('unterminated quoted value', lineNumber);
}

/** Parse the INI dialect documented in docs/parse-ini.md. */
export function parseIni(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');

  const result = Object.create(null);
  result.root = orderedObject();
  result.sections = orderedObject();
  let scope = result.root;
  // Remove exactly one initial BOM. Only CRLF, LF and CR divide physical lines.
  const lines = (text[0] === '\uFEFF' ? text.slice(1) : text).split(/\r\n|\r|\n/);

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = trimWhitespace(lines[index]);
    if (!line || line[0] === ';' || line[0] === '#') continue;

    // Headers take precedence over assignments: '=' is legal in section names.
    if (line[0] === '[') {
      if (!line.endsWith(']')) fail('malformed section header', lineNumber);
      const name = trimWhitespace(line.slice(1, -1));
      validateName(name, lineNumber);
      if (!Object.hasOwn(result.sections, name)) {
        result.sections[name] = orderedObject();
      }
      scope = result.sections[name];
      continue;
    }

    const equals = line.indexOf('=');
    if (equals === -1) fail('missing equals sign', lineNumber);
    const key = trimWhitespace(line.slice(0, equals));
    validateName(key, lineNumber);
    if (Object.hasOwn(scope, key)) fail('duplicate key', lineNumber);
    scope[key] = parseValue(trimWhitespace(line.slice(equals + 1)), lineNumber);
  }
  return result;
}
