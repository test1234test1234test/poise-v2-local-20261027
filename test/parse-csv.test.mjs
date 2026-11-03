import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../lib/parse-csv.mjs';

const validCases = [
  ['ordinary multirow data', 'name,city\nAda,London\nLin,Taipei', [['name', 'city'], ['Ada', 'London'], ['Lin', 'Taipei']]],
  ['empty input', '', []],
  ['BOM-only input', '\uFEFF', []],
  ['only one BOM is removed', '\uFEFF\uFEFF', [['\uFEFF']]],
  ['single bare field', 'value', [['value']]],
  ['only a delimiter', ',', [['', '']]],
  ['consecutive and final delimiters', 'a,,b,', [['a', '', 'b', '']]],
  ['all empty fields', ',,', [['', '', '']]],
  ['final LF', 'a,b\n', [['a', 'b']]],
  ['final CRLF', 'a,b\r\n', [['a', 'b']]],
  ['an empty LF row', '\n', [['']]],
  ['an empty CRLF row', '\r\n', [['']]],
  ['consecutive empty rows', '\n\r\n', [[''], ['']]],
  ['leading and interior empty rows', '\na\n\nb', [[''], ['a'], [''], ['b']]],
  ['trailing delimiter and empty row', 'a,\r\n\r\n', [['a', ''], ['']]],
  ['ragged widths and mixed endings', 'a,b\r\nc\n\r\n', [['a', 'b'], ['c'], ['']]],
  ['quoted empty field', '""', [['']]],
  ['quoted and bare empties', '"",,\n', [['', '', '']]],
  ['quoted field before final delimiter', '"a",', [['a', '']]],
  ['quoted field before final CRLF', '"a"\r\n', [['a']]],
  ['four quotes encode one quote', '""""', [['"']]],
  ['escaped quotes and embedded delimiter', '"a,b","say ""hi"""', [['a,b', 'say "hi"']]],
  ['quoted LF', '"a\nb",c\nd,e', [['a\nb', 'c'], ['d', 'e']]],
  ['quoted CR, CRLF and LF', '"a\rb\r\nc\nd"', [['a\rb\r\nc\nd']]],
  ['quoted CRLF followed by outer CRLF', '"\r\n"\r\n', [['\r\n']]],
  ['quoted repeated CR', '"a\r\rb",c', [['a\r\rb', 'c']]],
  ['nonleading BOMs', '\uFEFFa,\uFEFFb\n\uFEFFc,d\uFEFF', [['a', '\uFEFFb'], ['\uFEFFc', 'd\uFEFF']]],
  ['BOM within quotes', '"\uFEFFa",b', [['\uFEFFa', 'b']]],
  ['spaces, tabs, formulas and numeric text', ' a \t,=1+1,001,TRUE', [[' a \t', '=1+1', '001', 'TRUE']]],
  ['quoted whitespace', '" a \t ",\t', [[' a \t ', '\t']]],
  ['exact Unicode preservation', 'café,東京,😀,e\u0301', [['café', '東京', '😀', 'e\u0301']]],
  ['other Unicode separators are data', 'a\u2028b\u2029c\u0085d,\0', [['a\u2028b\u2029c\u0085d', '\0']]],
  ['BOM, astral text, escaped quote and mixed endings', '\uFEFFok\r\n"😀""x\nz"\r\n', [['ok'], ['😀"x\nz']]],
  ['BOM, astral text, escaped quote and quoted bare CR', '\uFEFF\r\n"😀""x\ry"\r\n', [[''], ['😀"x\ry']]],
];

for (const [name, input, expected] of validCases) {
  test(name, () => assert.deepEqual(parseCsv(input), expected));
}

test('alternate delimiter works in bare and quoted rows', () => {
  assert.deepEqual(parseCsv('a;b\n"c;d";e,f;', { delimiter: ';' }), [
    ['a', 'b'], ['c;d', 'e,f', ''],
  ]);
  assert.deepEqual(parseCsv('\uFEFFa;"😀\r\nb""c";\n', { delimiter: ';' }), [
    ['a', '😀\r\nb"c', ''],
  ]);
});

for (const delimiter of [' ', '\t', '\0', '|', 'é', '\u2028', '\uD800']) {
  test(`accepts one-code-unit delimiter ${JSON.stringify(delimiter)}`, () => {
    assert.deepEqual(parseCsv(`"a"${delimiter}b${delimiter}"c${delimiter}d"${delimiter}`, { delimiter }), [
      ['a', 'b', `c${delimiter}d`, ''],
    ]);
    assert.deepEqual(parseCsv(`${delimiter}"a"`, { delimiter }), [['', 'a']]);
  });
}

test('removes one initial BOM before recognizing a BOM delimiter', () => {
  const options = { delimiter: '\uFEFF' };
  assert.deepEqual(parseCsv('\uFEFF', options), []);
  assert.deepEqual(parseCsv('\uFEFF\uFEFF', options), [['', '']]);
  assert.deepEqual(parseCsv('\uFEFFa\uFEFFb', options), [['a', 'b']]);
  assert.deepEqual(parseCsv('"\uFEFF"\uFEFFc\n\uFEFFd', options), [['\uFEFF', 'c'], ['', 'd']]);
});

function assertCsvError(input, line, column, offset, reason, options) {
  assert.throws(() => parseCsv(input, options), (error) => {
    assert.ok(error instanceof SyntaxError);
    assert.ok(Number.isInteger(error.line));
    assert.ok(Number.isInteger(error.column));
    assert.ok(Number.isInteger(error.offset));
    assert.equal(error.line, line);
    assert.equal(error.column, column);
    assert.equal(error.offset, offset);
    assert.ok(error.offset >= 0 && error.offset <= input.length);
    assert.equal(error.message, `${reason} at line ${line}, column ${column}`);
    return true;
  });
}

const invalidCases = [
  ['quote in bare field', 'a"b', 1, 2, 1, 'quote inside an unquoted field'],
  ['space before opening quote', ' "a"', 1, 2, 1, 'quote inside an unquoted field'],
  ['tab before opening quote', '\t"a"', 1, 2, 1, 'quote inside an unquoted field'],
  ['space after closing quote', '"a" ', 1, 4, 3, 'unexpected character after a closing quote'],
  ['tab after closing quote', '"a"\t', 1, 4, 3, 'unexpected character after a closing quote'],
  ['letter after closing quote', '"a"x', 1, 4, 3, 'unexpected character after a closing quote'],
  ['bare CR in bare field', 'a\rb', 1, 2, 1, 'bare CR outside a quoted field'],
  ['bare CR at field start', '\r', 1, 1, 0, 'bare CR outside a quoted field'],
  ['bare CR after closing quote', '"a"\r', 1, 4, 3, 'bare CR outside a quoted field'],
  ['CR content after escaped quote leaves field open', '"a""\r', 1, 6, 5, 'unterminated quoted field'],
  ['quoted bare CR advances the column', '"a\rb"x', 1, 6, 5, 'unexpected character after a closing quote'],
  ['quoted CRLF advances one line', '"a\r\nb"x', 2, 3, 6, 'unexpected character after a closing quote'],
  ['quoted LF advances one line', '"a\nb"x', 2, 3, 5, 'unexpected character after a closing quote'],
  ['mixed row endings', 'a\r\nb\nc"', 3, 2, 6, 'quote inside an unquoted field'],
  ['BOM counts in original coordinates', '\uFEFF"a"x', 1, 5, 4, 'unexpected character after a closing quote'],
  ['second BOM prevents opening quote', '\uFEFF\uFEFF"a"', 1, 3, 2, 'quote inside an unquoted field'],
  ['EOF after opening quote', '"', 1, 2, 1, 'unterminated quoted field'],
  ['EOF after escaped quote', '"""', 1, 4, 3, 'unterminated quoted field'],
  ['EOF after quoted bare CR', '"a\r', 1, 4, 3, 'unterminated quoted field'],
  ['EOF after quoted LF', '"a\n', 2, 1, 3, 'unterminated quoted field'],
  ['EOF after quoted CRLF', '"a\r\n', 2, 1, 4, 'unterminated quoted field'],
  ['BOM-inclusive EOF', '\uFEFF"', 1, 3, 2, 'unterminated quoted field'],
  ['BOM column offset resets after CRLF', '\uFEFF"a\r\nb', 2, 2, 6, 'unterminated quoted field'],
  ['astral text advances two columns', '😀"', 1, 3, 2, 'quote inside an unquoted field'],
  ['astral text in a quoted field', '"😀"x', 1, 5, 4, 'unexpected character after a closing quote'],
  ['astral text at EOF', '"😀', 1, 4, 3, 'unterminated quoted field'],
  ['Unicode line separator advances only the column', 'a\u2028b"', 1, 4, 3, 'quote inside an unquoted field'],
  ['failure after complete rows', 'ok\r\n"a\r\nb"x', 3, 3, 10, 'unexpected character after a closing quote'],
  ['first offending character wins', 'a"\r', 1, 2, 1, 'quote inside an unquoted field'],
  ['bare CR after BOM', '\uFEFF\r', 1, 2, 1, 'bare CR outside a quoted field'],
  ['quote in bare field after BOM', '\uFEFFa"b', 1, 3, 2, 'quote inside an unquoted field'],
  ['offending astral character starts at its high surrogate', '"a"😀', 1, 4, 3, 'unexpected character after a closing quote'],
  ['escaped quotes count both source code units', '"a""b"x', 1, 7, 6, 'unexpected character after a closing quote'],
  ['unpaired surrogate counts one code unit', '\uD800"', 1, 2, 1, 'quote inside an unquoted field'],
  ['quoted CR before CRLF', '"x\r\r\ny"z', 2, 3, 7, 'unexpected character after a closing quote'],
  ['combined BOM, astral text, escape and mixed endings', '\uFEFFok\r\n"😀""x\nz"x', 3, 3, 14, 'unexpected character after a closing quote'],
  ['EOF after BOM, astral text, escape and mixed endings', '\uFEFFok\r\n"😀""x\nz', 3, 2, 13, 'unterminated quoted field'],
  ['combined BOM, astral text, escape and bare CR', '\uFEFF\r\n"😀""x\ry"z', 2, 10, 12, 'unexpected character after a closing quote'],
  ['EOF after BOM, astral text, escape and bare CR', '\uFEFF\r\n"😀""x\ry', 2, 9, 11, 'unterminated quoted field'],
  ['combined coordinates with semicolon delimiter', '\uFEFFa;"😀\r\nb""c"x', 2, 6, 13, 'unexpected character after a closing quote', { delimiter: ';' }],
  ['combined EOF with semicolon delimiter', '\uFEFFa;"😀\r\nb""c', 2, 5, 12, 'unterminated quoted field', { delimiter: ';' }],
  ['BOM delimiter keeps original offsets', '\uFEFFa\uFEFF"b"x', 1, 7, 6, 'unexpected character after a closing quote', { delimiter: '\uFEFF' }],
];

for (const [name, input, line, column, offset, reason, options] of invalidCases) {
  test(name, () => assertCsvError(input, line, column, offset, reason, options));
}

test('an alternate delimiter does not permit junk after a closing quote', () => {
  assertCsvError('"a",b', 1, 4, 3, 'unexpected character after a closing quote', { delimiter: ';' });
});

test('surrogate delimiters split pairs without changing original offsets', () => {
  const high = { delimiter: '\uD83D' };
  const low = { delimiter: '\uDE00' };
  assert.deepEqual(parseCsv('"a"😀', high), [['a', '\uDE00']]);
  assertCsvError('"a"😀"', 1, 6, 5, 'quote inside an unquoted field', high);
  assert.deepEqual(parseCsv('😀""', low), [['\uD83D', '']]);
  assertCsvError('😀"', 1, 4, 3, 'unterminated quoted field', low);
});

function assertValidationError(input, options, ErrorClass, message) {
  assert.throws(() => parseCsv(input, options), (error) => {
    assert.ok(error instanceof ErrorClass);
    assert.equal(error.message, message);
    assert.equal(Object.hasOwn(error, 'offset'), false);
    return true;
  });
}

test('rejects nonstring input without coercion', () => {
  for (const input of [undefined, null, true, 1, 1n, Symbol('text'), [], {}, new String('a,b'), () => 'a,b']) {
    assertValidationError(input, undefined, TypeError, 'text must be a string');
  }
  let coerced = false;
  const input = { [Symbol.toPrimitive]() { coerced = true; return 'a,b'; } };
  assertValidationError(input, undefined, TypeError, 'text must be a string');
  assert.equal(coerced, false);
});

test('rejects invalid option containers even on empty input', () => {
  for (const options of [null, [], '', ',', 0, false, 1n, Symbol('options'), () => {}]) {
    assertValidationError('', options, TypeError, 'options must be a non-array object');
  }
});

test('rejects every unknown own key, including symbols and non-enumerable keys', () => {
  for (const options of [
    { delimeter: ',' },
    { delimiter: ',', trim: false },
    { [Symbol('delimiter')]: ',' },
    Object.defineProperty({}, 'delimeter', { value: ',' }),
  ]) {
    assertValidationError('', options, TypeError, 'unknown CSV option');
  }
});

test('defaults only an absent delimiter and accepts explicit undefined options', () => {
  assert.deepEqual(parseCsv('a,b', undefined), [['a', 'b']]);
  assert.deepEqual(parseCsv('a,b', {}), [['a', 'b']]);
  assertValidationError('', { delimiter: undefined }, TypeError, 'delimiter must be a string');
});

test('rejects nonstring delimiters without coercion', () => {
  for (const delimiter of [undefined, null, 1, false, 1n, Symbol('delimiter'), [], {}, new String(';'), () => ';']) {
    assertValidationError('', { delimiter }, TypeError, 'delimiter must be a string');
  }
  let coerced = false;
  const delimiter = { toString() { coerced = true; return ';'; } };
  assertValidationError('', { delimiter }, TypeError, 'delimiter must be a string');
  assert.equal(coerced, false);
});

test('rejects wrong-length and forbidden delimiters, including on BOM-only input', () => {
  for (const delimiter of ['', 'ab', '😀', 'e\u0301', '"', '\r', '\n', '\r\n']) {
    for (const input of ['', '\uFEFF', 'a,b', '"']) {
      assertValidationError(input, { delimiter }, RangeError,
        'delimiter must be one UTF-16 code unit other than quote, CR or LF');
    }
  }
});

test('option validation takes precedence over malformed CSV', () => {
  assertValidationError('"', null, TypeError, 'options must be a non-array object');
  assertValidationError('"', { trim: true }, TypeError, 'unknown CSV option');
  assertValidationError('"', { delimiter: undefined }, TypeError, 'delimiter must be a string');
});

test('ignores inherited options consistently and does not require a plain object', () => {
  const prototype = Object.defineProperties({}, {
    delimiter: { get() { assert.fail('inherited delimiter must not be read'); } },
    delimeter: { value: ';' },
    [Symbol('unknown')]: { value: true },
  });
  assert.deepEqual(parseCsv('a,b', Object.create(prototype)), [['a', 'b']]);
  const own = Object.create(prototype, { delimiter: { value: ';' } });
  assert.deepEqual(parseCsv('a;b', own), [['a', 'b']]);
  class Options { delimiter = ';'; }
  for (const options of [Object.assign(Object.create(null), { delimiter: ';' }), new Options()]) {
    assert.deepEqual(parseCsv('a;b', options), [['a', 'b']]);
  }
});

test('reads an own delimiter once without mutating options', () => {
  let reads = 0;
  const options = Object.freeze({ get delimiter() { reads++; return ';'; } });
  assert.deepEqual(parseCsv('a;b\nc;d', options), [['a', 'b'], ['c', 'd']]);
  assert.equal(reads, 1);
});

test('caller SyntaxErrors from getters and Proxy traps propagate without coordinates', () => {
  const sentinel = Object.freeze(new SyntaxError('caller failure'));
  const fail = () => { throw sentinel; };
  for (const options of [
    Object.defineProperty({}, 'delimiter', { get: fail }),
    new Proxy({}, { ownKeys: fail }),
    new Proxy({ delimiter: ';' }, { getOwnPropertyDescriptor: fail }),
  ]) {
    assert.throws(() => parseCsv('"', options), (error) => {
      assert.equal(error, sentinel);
      for (const key of ['line', 'column', 'offset']) {
        assert.equal(Object.hasOwn(error, key), false);
      }
      return true;
    });
  }
});

test('reentrant parsing in a delimiter getter keeps coordinates independent', () => {
  const options = {
    get delimiter() {
      assertCsvError('\uFEFF"😀', 1, 5, 4, 'unterminated quoted field');
      return ';';
    },
  };
  assertCsvError('a;"x"x', 1, 6, 5, 'unexpected character after a closing quote', options);
});

test('calls and returned arrays remain independent across success and failure', () => {
  const earlier = parseCsv('first,second\nthird,fourth');
  assertCsvError('ok\r\n"a\r\nb"x', 3, 3, 10, 'unexpected character after a closing quote');
  assert.deepEqual(parseCsv('a;"b;c"', { delimiter: ';' }), [['a', 'b;c']]);
  const later = parseCsv('a,b');
  assert.deepEqual(later, [['a', 'b']]);
  assertCsvError('a"', 1, 2, 1, 'quote inside an unquoted field');
  assertCsvError('\uFEFF"', 1, 3, 2, 'unterminated quoted field');
  assertCsvError('"', 1, 2, 1, 'unterminated quoted field');
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(earlier, [['first', 'second'], ['third', 'fourth']]);
  assert.notEqual(earlier[0], earlier[1]);
  assert.notEqual(earlier, later);
  earlier[0][0] = 'changed';
  assert.deepEqual(later, [['a', 'b']]);
  assert.deepEqual(parseCsv('first,second'), [['first', 'second']]);
});

test('preserves complete long bare and quoted fields with subsequent fields and rows', () => {
  const bare = 'é東京😀'.repeat(20_000); // 100,000 UTF-16 code units.
  const quoted = `${bare},"middle"\r\n${bare}`;
  const input = `${bare},tail\n"${quoted.replaceAll('"', '""')}",end\r\nlast,row`;
  assert.deepEqual(parseCsv(input), [[bare, 'tail'], [quoted, 'end'], ['last', 'row']]);
});
