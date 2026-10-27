/** Parse the strict CSV dialect documented in docs/parse-csv.md. */
export function parseCsv(text, options = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string');
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be a non-array object');
  }
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'delimiter') {
      throw new TypeError('unknown CSV option');
    }
  }
  const delimiter = Object.hasOwn(options, 'delimiter') ? options.delimiter : ',';
  if (typeof delimiter !== 'string') {
    throw new TypeError('delimiter must be a string');
  }
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\r' || delimiter === '\n') {
    throw new RangeError('delimiter must be one UTF-16 code unit other than quote, CR or LF');
  }

  const rows = [];
  let row = [];
  let field = '';
  let state = 'start'; // start, bare, quoted, or closed
  // Skip one BOM without losing its column in the original input.
  let index = text[0] === '\uFEFF' ? 1 : 0;
  let line = 1;
  let column = index + 1;

  function fail(message) {
    const error = new SyntaxError(`${message} at line ${line}, column ${column}`);
    error.line = line;
    error.column = column;
    throw error;
  }

  while (index < text.length) {
    const character = text[index];
    const isCrLf = character === '\r' && text[index + 1] === '\n';

    if (state === 'quoted') {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          column += 2;
        } else {
          state = 'closed';
          index++;
          column++;
        }
      } else if (character === '\n' || isCrLf) {
        field += isCrLf ? '\r\n' : '\n';
        index += isCrLf ? 2 : 1;
        line++;
        column = 1;
      } else {
        // Bare CR, delimiters, and all other code units are literal content.
        field += character;
        index++;
        column++;
      }
      continue;
    }

    if (character === delimiter) {
      row.push(field);
      field = '';
      state = 'start';
      index++;
      column++;
      continue;
    }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && !isCrLf) {
        fail('bare CR outside a quoted field');
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      state = 'start';
      index += isCrLf ? 2 : 1;
      line++;
      column = 1;
      continue;
    }
    if (state === 'closed') {
      fail('unexpected character after a closing quote');
    }
    if (character === '"') {
      if (state !== 'start') {
        fail('quote inside an unquoted field');
      }
      state = 'quoted';
    } else {
      field += character;
      state = 'bare';
    }
    index++;
    column++;
  }

  if (state === 'quoted') {
    fail('unterminated quoted field');
  }
  // A delimiter leaves a pending empty field; a row ending does not.
  if (state !== 'start' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
