import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQueryString } from '../lib/parse-query-string.mjs';

function assertResult(result, expected) {
  assert.equal(Object.getPrototypeOf(result), null);
  assert.deepEqual(new Set(Reflect.ownKeys(result)), new Set(Reflect.ownKeys(expected)));
  for (const key of Reflect.ownKeys(expected)) {
    assert.ok(Object.hasOwn(result, key));
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    assert.ok(Object.hasOwn(descriptor, 'value'));
    assert.ok(Array.isArray(descriptor.value));
    assert.deepEqual(descriptor.value, expected[key]);
  }
}

const parsingCases = [
  ['empty input', '', {}],
  ['lone question mark', '?', {}],
  ['empty pairs', '&&', {}],
  ['question mark and empty pairs', '?&&', {}],
  ['nonadjacent repeats', '?a=1&b=2&a=3', { a: ['1', '3'], b: ['2'] }],
  ['duplicate values', 'a=1&a=1&a=2&a=1', { a: ['1', '1', '2', '1'] }],
  ['empty keys, flags and first equals', '&&=x&=&flag&flag=&a=b=c&&', { '': ['x', ''], flag: ['', ''], a: ['b=c'] }],
  ['repeated empty keys', '&=&=x&=', { '': ['', 'x', ''] }],
  ['encoded delimiters', 'a%26b=c%3Dd%26e&a%3Db=v', { 'a&b': ['c=d&e'], 'a=b': ['v'] }],
  ['encoded delimiters in a bare key', 'a%26b%3Dc', { 'a&b=c': [''] }],
  ['grouping decoded keys', 'a=1&%61=2&a=3', { a: ['1', '2', '3'] }],
  ['encoded key appearing first', '%61=1&a=2', { a: ['1', '2'] }],
  ['spaces and plus keys', 'a+b=1&a%20b=2&a%2Bb=3', { 'a b': ['1', '2'], 'a+b': ['3'] }],
  ['plus replacement before decoding', '+=%2B&%20=+&%2B=%20', { ' ': ['+', ' '], '+': [' '] }],
  ['one decoding pass', 'x=+%2b%252B%25&y=%25ZZ', { x: [' +%2B%'], y: ['%ZZ'] }],
  ['decoded percents remain data', 'x=%2526%253D&%252B=%25FF', { x: ['%26%3D'], '%2B': ['%FF'] }],
  ['second question mark and hash', '??a=1&b=?#x', { '?a': ['1'], b: ['?#x'] }],
  ['bare second question mark', '??', { '?': [''] }],
  ['encoded initial question mark', '%3Fa=1', { '?a': ['1'] }],
  ['hash is data', 'a=x#y&b=z', { a: ['x#y'], b: ['z'] }],
  ['whitespace and semicolons', ' x = y &a=x;y=z', { ' x ': [' y '], a: ['x;y=z'] }],
  ['string values', 'x=001&x=true&x=null', { x: ['001', 'true', 'null'] }],
  ['numeric-looking keys', '2=two&1=one&0=zero&00=double&%30=again', { 2: ['two'], 1: ['one'], 0: ['zero', 'again'], '00': ['double'] }],
  ['literal bracket and dot names', 'arr[]=1&arr[]=2&user.name=Ada&__proto__[x]=y', { 'arr[]': ['1', '2'], 'user.name': ['Ada'], '__proto__[x]': ['y'] }],
  ['composed and decomposed keys', 'é=1&%C3%A9=2&e%CC%81=3', { é: ['1', '2'], 'e\u0301': ['3'] }],
  ['encoded Unicode key first', '%C3%A9=1&é=2', { é: ['1', '2'] }],
  ['case-sensitive keys', 'a=1&A=2', { a: ['1'], A: ['2'] }],
  ['empty key and BOM keys', '=empty&%EF%BB%BF=bom&\uFEFF=raw&x=%EF%BB%BF', { '': ['empty'], '\uFEFF': ['bom', 'raw'], x: ['\uFEFF'] }],
  ['BOM before question mark', '\uFEFF?a=1&%EF%BB%BF?a=2&?a=3', { '\uFEFF?a': ['1', '2'], '?a': ['3'] }],
  ['raw whitespace, NUL and BOM', '\t\r\n\0=\uFEFF\0\r\n\t &x=\u2028\u2029', { '\t\r\n\0': ['\uFEFF\0\r\n\t '], x: ['\u2028\u2029'] }],
];

for (const [name, input, expected] of parsingCases) {
  test(`parseQueryString: ${name}`, () => {
    assertResult(parseQueryString(input), expected);
  });
}

const unicodeCases = [
  ['accented text and lowercase hex', '%c3%a9', 'é'],
  ['CJK', '%E4%B8%AD%E6%96%87', '中文'],
  ['astral character', '%F0%9F%98%80', '😀'],
  ['NUL', '%00', '\0'],
  ['BOM', '%EF%BB%BF', '\uFEFF'],
  ['replacement character', '%EF%BF%BD', '\uFFFD'],
  ['before surrogates', '%ED%9F%BF', '\uD7FF'],
  ['after surrogates', '%EE%80%80', '\uE000'],
  ['BMP noncharacter', '%EF%BF%BF', '\uFFFF'],
  ['maximum code point', '%F4%8F%BF%BF', '\u{10FFFF}'],
];

for (const [name, encoded, raw] of unicodeCases) {
  test(`parseQueryString preserves raw and encoded ${name} in both components`, () => {
    assertResult(parseQueryString(`${encoded}=${raw}&${raw}=${encoded}`), {
      [raw]: [raw, raw],
    });
  });
}

for (const [name, raw] of [['high', '\uD800'], ['low', '\uDC00']]) {
  test(`parseQueryString preserves raw ${name} surrogates separately from U+FFFD`, () => {
    assertResult(parseQueryString(`${raw}=${raw}&%EF%BF%BD=%EF%BF%BD`), {
      [raw]: [raw],
      '\uFFFD': ['\uFFFD'],
    });
    assertResult(parseQueryString(`%EF%BF%BD=${raw}&${raw}=%EF%BF%BD`), {
      '\uFFFD': [raw],
      [raw]: ['\uFFFD'],
    });
  });
}

const malformedComponents = [
  '%', '%0', '%GG', '%0G', '%u0041',
  '%80', '%FF', '%E9',
  '%C2', '%E2%82', '%F0%9F%98',
  '%C2%20', '%E2%28%A1', '%C3é',
  '%C0%AF', '%E0%80%AF', '%F0%80%80%AF',
  '%ED%A0%80', '%ED%BF%BF', '%ED%A0%BD%ED%B8%80',
  '%F4%90%80%80',
];

for (const component of malformedComponents) {
  test(`parseQueryString rejects malformed component ${component}`, () => {
    for (const input of [
      component,
      `${component}=ok`,
      `ok=${component}`,
      `a=1&a=2&${component}`,
      `a=1&a=2&${component}=ok`,
      `a=1&a=2&ok=${component}`,
    ]) {
      assert.throws(() => parseQueryString(input), URIError, input);
    }
  });
}

const malformedQueries = [
  '=%', '=x&=%FF',
  'a=ok&a=%FF', 'a=ok&%61=%FF',
  '__proto__=%FF', 'constructor=%',
  'a=ok#%', 'a=ok#&b=%FF',
  'a=ok=bad%',
  '%C2=%A2', 'a=%C2&b=%A2', 'a=%C2+%A2',
  'a=%00%',
];

for (const input of malformedQueries) {
  test(`parseQueryString validates all components in ${input}`, () => {
    assert.throws(() => parseQueryString(input), URIError);
  });
}

test('parseQueryString keeps dangerous-looking keys as own data without mutating prototypes', () => {
  const prototypes = [Object.prototype, Array.prototype, String.prototype, Function.prototype];
  const snapshots = prototypes.map(prototype => ({
    parent: Object.getPrototypeOf(prototype),
    descriptors: Object.getOwnPropertyDescriptors(prototype),
  }));
  const input = '__proto__=x&%5F%5Fproto%5F%5F=y&constructor=c&prototype=p&hasOwnProperty=h&toString=t';
  const expected = {
    ['__proto__']: ['x', 'y'],
    constructor: ['c'],
    prototype: ['p'],
    hasOwnProperty: ['h'],
    toString: ['t'],
  };
  const result = parseQueryString(input);
  assertResult(result, expected);

  const assertPrototypesUnchanged = () => {
    prototypes.forEach((prototype, index) => {
      assert.equal(Object.getPrototypeOf(prototype), snapshots[index].parent);
      assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), snapshots[index].descriptors);
    });
  };
  assertPrototypesUnchanged();
  assert.throws(() => parseQueryString(`${input}&bad=%FF`), URIError);
  assertPrototypesUnchanged();
  assertResult(result, expected);
});

const invalidInputs = [
  ['undefined', undefined],
  ['null', null],
  ['true', true],
  ['false', false],
  ['zero', 0],
  ['number', 42],
  ['NaN', NaN],
  ['infinity', Infinity],
  ['zero bigint', 0n],
  ['bigint', 42n],
  ['symbol', Symbol('query')],
  ['empty array', []],
  ['string array', ['a=1']],
  ['plain object', {}],
  ['null-prototype object', Object.create(null)],
  ['function', () => 'a=1'],
  ['boxed empty string', new String('')],
  ['boxed string', new String('a=1')],
  ['object with zero length', { length: 0 }],
];

for (const [name, input] of invalidInputs) {
  test(`parseQueryString rejects ${name}`, () => {
    assert.throws(() => parseQueryString(input), TypeError);
  });
}

test('parseQueryString rejects an omitted argument', () => {
  assert.throws(() => parseQueryString(), TypeError);
});

for (const property of [Symbol.toPrimitive, 'toString', 'valueOf', 'length', 'startsWith', 'slice', 'split', 'replace']) {
  test(`parseQueryString rejects objects without reading ${String(property)}`, () => {
    let reads = 0;
    const input = Object.defineProperty({}, property, {
      get() {
        reads += 1;
        throw new TypeError('property access sentinel');
      },
    });
    assert.throws(() => parseQueryString(input), TypeError);
    assert.equal(reads, 0);
  });
}

for (const method of [Symbol.toPrimitive, 'toString', 'valueOf']) {
  test(`parseQueryString rejects objects without calling ${String(method)}`, () => {
    let calls = 0;
    const input = {
      [method]() {
        calls += 1;
        return 'a=1';
      },
    };
    assert.throws(() => parseQueryString(input), TypeError);
    assert.equal(calls, 0);
  });
}

test('parseQueryString returns fresh empty results across successes and failures', () => {
  const results = [];
  for (const input of ['', '?', '&&', '?&&', '', '?']) {
    const result = parseQueryString(input);
    assertResult(result, {});
    results.push(result);
    assertResult(parseQueryString('a=1'), { a: ['1'] });
    assert.throws(() => parseQueryString('a=1&b=%'), URIError);
    assert.throws(() => parseQueryString(null), TypeError);
  }
  assert.equal(new Set(results).size, results.length);
  results[0].added = ['value'];
  for (const result of results.slice(1)) assertResult(result, {});
  assertResult(parseQueryString(''), {});
});

test('parseQueryString creates independent arrays across keys and calls', () => {
  const input = 'a=same&b=same&=same';
  const expected = { a: ['same'], b: ['same'], '': ['same'] };
  const first = parseQueryString(input);
  const second = parseQueryString(input);
  assertResult(first, expected);
  assertResult(second, expected);
  assert.notEqual(first, second);
  assert.equal(new Set([...Object.values(first), ...Object.values(second)]).size, 6);

  assert.throws(() => parseQueryString(`${input}&a=%FF`), URIError);
  assert.throws(() => parseQueryString(new String(input)), TypeError);
  assertResult(first, expected);
  assertResult(second, expected);

  first.a.push('changed');
  assertResult(first, { a: ['same', 'changed'], b: ['same'], '': ['same'] });
  assertResult(second, expected);
  assertResult(parseQueryString(input), expected);
  assert.throws(() => parseQueryString(`${input}&%=bad`), URIError);
  assertResult(first, { a: ['same', 'changed'], b: ['same'], '': ['same'] });
  assertResult(second, expected);
});

test('parseQueryString consumes more than 1,000 repeated pairs and a malformed tail', () => {
  const values = Array.from({ length: 1_005 }, (_, index) => String(index));
  const input = '?' + '&'.repeat(1_005) + values.map(value => `a=${value}`).join('&');
  const result = parseQueryString(input);
  assertResult(result, { a: values });
  assert.equal(result.a.length, 1_005);
  assert.equal(result.a.at(-1), '1004');
  assert.throws(() => parseQueryString(`${input}&a=%FF`), URIError);
  assertResult(result, { a: values });
});

test('parseQueryString consumes more than 1,000 distinct keys and a malformed tail', () => {
  const entries = Array.from({ length: 1_005 }, (_, index) => [`key${index}`, [String(index)]]);
  const input = entries.map(([key, values]) => `${key}=${values[0]}`).join('&&');
  const result = parseQueryString(input);
  assertResult(result, Object.fromEntries(entries));
  assert.equal(Reflect.ownKeys(result).length, 1_005);
  assert.deepEqual(result.key1004, ['1004']);
  assert.throws(() => parseQueryString(`${input}&tail=%`), URIError);
});

test('parseQueryString consumes large keys and values through their final escape', () => {
  const component = 'é%26%3D%2B'.repeat(10_000) + 'tail';
  const decoded = 'é&=+'.repeat(10_000) + 'tail';
  assertResult(parseQueryString(`${component}=${component}`), { [decoded]: [decoded] });
  assert.throws(() => parseQueryString(`${component}%=ok`), URIError);
  assert.throws(() => parseQueryString(`ok=${component}%`), URIError);
});
