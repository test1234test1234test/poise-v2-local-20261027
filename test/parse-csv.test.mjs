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
];

for (const [name, input, expected] of validCases) {
  test(name, () => assert.deepEqual(parseCsv(input), expected));
}

test('alternate delimiter works in bare and quoted rows', () => {
  assert.deepEqual(parseCsv('a;b\n"c;d";e,f;', { delimiter: ';' }), [
    ['a', 'b'], ['c;d', 'e,f', ''],
  ]);
});

for (const delimiter of [' ', '\t', '\0', '|', 'é', '\u2028', '\uD800']) {
  test(`accepts one-code-unit delimiter ${JSON.stringify(delimiter)}`, () => {
    assert.deepEqual(parseCsv(`"a"${delimiter}b${delimiter}"c${delimiter}d"${delimiter}`, { delimiter }), [
      ['a', 'b', `c${delimiter}d`, ''],
    ]);
  });
}

test('removes one initial BOM before recognizing a BOM delimiter', () => {
  const options = { delimiter: '\uFEFF' };
  assert.deepEqual(parseCsv('\uFEFF', options), []);
  assert.deepEqual(parseCsv('\uFEFF\uFEFF', options), [['', '']]);
  assert.deepEqual(parseCsv('\uFEFFa\uFEFFb', options), [['a', 'b']]);
  assert.deepEqual(parseCsv('"\uFEFF"\uFEFFc\n\uFEFFd', options), [['\uFEFF', 'c'], ['', 'd']]);
});

function assertCsvError(input, line, column, options) {
  assert.throws(() => parseCsv(input, options), (error) => {
    assert.ok(error instanceof SyntaxError);
    assert.ok(Number.isInteger(error.line));
    assert.ok(Number.isInteger(error.column));
    assert.equal(error.line, line);
    assert.equal(error.column, column);
    return true;
  });
}

const invalidCases = [
  ['quote in bare field', 'a"b', 1, 2],
  ['space before opening quote', ' "a"', 1, 2],
  ['tab before opening quote', '\t"a"', 1, 2],
  ['space after closing quote', '"a" ', 1, 4],
  ['tab after closing quote', '"a"\t', 1, 4],
  ['letter after closing quote', '"a"x', 1, 4],
  ['bare CR in bare field', 'a\rb', 1, 2],
  ['bare CR at field start', '\r', 1, 1],
  ['bare CR after closing quote', '"a"\r', 1, 4],
  ['CR content after escaped quote leaves field open', '"a""\r', 1, 6],
  ['quoted bare CR advances the column', '"a\rb"x', 1, 6],
  ['quoted CRLF advances one line', '"a\r\nb"x', 2, 3],
  ['quoted LF advances one line', '"a\nb"x', 2, 3],
  ['mixed row endings', 'a\r\nb\nc"', 3, 2],
  ['BOM counts in original coordinates', '\uFEFF"a"x', 1, 5],
  ['second BOM prevents opening quote', '\uFEFF\uFEFF"a"', 1, 3],
  ['EOF after opening quote', '"', 1, 2],
  ['EOF after escaped quote', '"""', 1, 4],
  ['EOF after quoted bare CR', '"a\r', 1, 4],
  ['EOF after quoted LF', '"a\n', 2, 1],
  ['EOF after quoted CRLF', '"a\r\n', 2, 1],
  ['BOM-inclusive EOF', '\uFEFF"', 1, 3],
  ['BOM column offset resets after CRLF', '\uFEFF"a\r\nb', 2, 2],
  ['astral text advances two columns', '😀"', 1, 3],
  ['astral text in a quoted field', '"😀"x', 1, 5],
  ['astral text at EOF', '"😀', 1, 4],
  ['Unicode line separator advances only the column', 'a\u2028b"', 1, 4],
  ['failure after complete rows', 'ok\r\n"a\r\nb"x', 3, 3],
  ['first offending character wins', 'a"\r', 1, 2],
];

for (const [name, input, line, column] of invalidCases) {
  test(name, () => assertCsvError(input, line, column));
}

test('an alternate delimiter does not permit junk after a closing quote', () => {
  assertCsvError('"a",b', 1, 4, { delimiter: ';' });
});

test('rejects nonstring input without coercion', () => {
  for (const input of [undefined, null, true, 1, 1n, Symbol('text'), [], {}, new String('a,b'), () => 'a,b']) {
    assert.throws(() => parseCsv(input), TypeError);
  }
  let coerced = false;
  assert.throws(() => parseCsv({ [Symbol.toPrimitive]() { coerced = true; return 'a,b'; } }), TypeError);
  assert.equal(coerced, false);
});

test('rejects invalid option containers even on empty input', () => {
  for (const options of [null, [], '', ',', 0, false, 1n, Symbol('options'), () => {}]) {
    assert.throws(() => parseCsv('', options), TypeError);
  }
});

test('rejects every unknown own key, including symbols and non-enumerable keys', () => {
  for (const options of [
    { delimeter: ',' },
    { delimiter: ',', trim: false },
    { [Symbol('delimiter')]: ',' },
    Object.defineProperty({}, 'delimeter', { value: ',' }),
  ]) {
    assert.throws(() => parseCsv('', options), TypeError);
  }
});

test('defaults only an absent delimiter and accepts explicit undefined options', () => {
  assert.deepEqual(parseCsv('a,b', undefined), [['a', 'b']]);
  assert.deepEqual(parseCsv('a,b', {}), [['a', 'b']]);
  assert.throws(() => parseCsv('', { delimiter: undefined }), TypeError);
});

test('rejects nonstring delimiters without coercion', () => {
  for (const delimiter of [undefined, null, 1, false, 1n, Symbol('delimiter'), [], {}, new String(';'), () => ';']) {
    assert.throws(() => parseCsv('', { delimiter }), TypeError);
  }
  let coerced = false;
  const delimiter = { toString() { coerced = true; return ';'; } };
  assert.throws(() => parseCsv('', { delimiter }), TypeError);
  assert.equal(coerced, false);
});

test('rejects wrong-length and forbidden delimiters, including on BOM-only input', () => {
  for (const delimiter of ['', 'ab', '😀', 'e\u0301', '"', '\r', '\n', '\r\n']) {
    for (const input of ['', '\uFEFF', 'a,b']) {
      assert.throws(() => parseCsv(input, { delimiter }), RangeError);
    }
  }
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

test('calls and returned arrays remain independent across success and failure', () => {
  const earlier = parseCsv('first,second\nthird,fourth');
  assertCsvError('ok\r\n"a\r\nb"x', 3, 3);
  assert.deepEqual(parseCsv('a;"b;c"', { delimiter: ';' }), [['a', 'b;c']]);
  const later = parseCsv('a,b');
  assert.deepEqual(later, [['a', 'b']]);
  assertCsvError('a"', 1, 2);
  assertCsvError('\uFEFF"', 1, 3);
  assertCsvError('"', 1, 2);
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
