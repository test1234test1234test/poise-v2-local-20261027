import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIni } from '../lib/parse-ini.mjs';

function assertIniError(input, lineNumber = 1) {
  assert.throws(() => parseIni(input), error => {
    assert.ok(error instanceof SyntaxError);
    assert.ok(Object.hasOwn(error, 'lineNumber'));
    assert.ok(Number.isInteger(error.lineNumber) && error.lineNumber > 0);
    assert.equal(error.lineNumber, lineNumber);
    return true;
  }, JSON.stringify(input));
}

function assertEntries(object, entries) {
  assert.equal(Object.getPrototypeOf(object), null);
  assert.deepEqual(Reflect.ownKeys(object), entries.map(([key]) => key));
  for (const [key, value] of entries) {
    assert.ok(Object.hasOwn(object, key));
    assert.equal(object[key], value);
    assert.equal(typeof object[key], 'string');
  }
}

test('requires a primitive string without invoking conversion hooks', () => {
  const conversionTrap = {
    [Symbol.toPrimitive]() { assert.fail('must not coerce input'); },
    toString() { assert.fail('must not call toString'); },
    valueOf() { assert.fail('must not call valueOf'); },
  };
  for (const input of [
    undefined, null, true, false, 0, 1, NaN, Infinity, 1n, Symbol('ini'),
    [], ['k=v'], {}, new String('k=v'), () => 'k=v', conversionTrap,
  ]) {
    assert.throws(() => parseIni(input), TypeError);
  }
  assert.throws(() => parseIni(), TypeError);
});

for (const input of ['', '\uFEFF', ' \t\r\n\t\r\n', '\n\r\n\r', ';comment\n \t#comment\r']) {
  test(`fresh null-prototype empty maps for ${JSON.stringify(input)}`, () => {
    const result = parseIni(input);
    assert.equal(Object.getPrototypeOf(result), null);
    assert.deepEqual(Reflect.ownKeys(result), ['root', 'sections']);
    assertEntries(result.root, []);
    assertEntries(result.sections, []);
    assert.notEqual(result.root, result.sections);
    const next = parseIni(input);
    assert.notEqual(result, next);
    assert.notEqual(result.root, next.root);
    assert.notEqual(result.sections, next.sections);
  });
}

const rootCases = [
  ['surrounding ASCII whitespace', ' \ta\t=\tv\t ', [['a', 'v']]],
  ['first equals and string types', 'a=b=c\nempty=\nnumber=001\nflag=false', [
    ['a', 'b=c'], ['empty', ''], ['number', '001'], ['flag', 'false'],
  ]],
  ['comments precede assignments', ' \t#key=value\n;other=value\nok=yes', [['ok', 'yes']]],
  ['comment text is ignored', '# [broken " \\q\u0000\nok=yes', [['ok', 'yes']]],
  ['comment markers in values', 'a=#literal\nb= ;literal\nc=a;#b', [
    ['a', '#literal'], ['b', ';literal'], ['c', 'a;#b'],
  ]],
  ['NBSP is not trimmed', 'k=\u00A0v\u00A0', [['k', '\u00A0v\u00A0']]],
  ['NBSP prevents a comment', '\u00A0#key=value', [['\u00A0#key', 'value']]],
  ['literal key spaces', 'first last=value', [['first last', 'value']]],
  ['literal names and case', 'a.b=1\n"k"=2\n\'k\'=3\nA=4\na=5\na\\b=6', [
    ['a.b', '1'], ['"k"', '2'], ["'k'", '3'], ['A', '4'], ['a', '5'], ['a\\b', '6'],
  ]],
  ['Unicode names and values', '東京=😀e\u0301\n\uD800=\uDC00', [['東京', '😀e\u0301'], ['\uD800', '\uDC00']]],
];

for (const [name, input, entries] of rootCases) {
  test(name, () => assertEntries(parseIni(input).root, entries));
}

const valueCases = [
  ['empty', '', ''],
  ['whitespace-only bare', ' \t ', ''],
  ['bare brackets', '[x]', '[x]'],
  ['middle double quote', 'ab"cd', 'ab"cd'],
  ['middle single quote', "ab'cd", "ab'cd"],
  ['terminal double quote', 'value"', 'value"'],
  ['terminal single quote', "value'", "value'"],
  ['terminal bare backslash', 'value\\', 'value\\'],
  ['bare unknown escape', '\\q', '\\q'],
  ['bare Windows path', 'C:\\new\\test', 'C:\\new\\test'],
  ['NBSP prevents quotes', '\u00A0"v"', '\u00A0"v"'],
  ['BOM prevents quotes', '\uFEFF"v"', '\uFEFF"v"'],
  ['Unicode separators', 'a\u2028b\u2029c', 'a\u2028b\u2029c'],
  ['bare interpolation syntax', '${NAME}', '${NAME}'],
];

for (const [name, source, expected] of valueCases) {
  test(`preserves ${name}`, () => assert.equal(parseIni(`k=${source}`).root.k, expected));
}

test('ignores exactly one BOM only at source offset zero', () => {
  assertEntries(parseIni('\uFEFFa=b').root, [['a', 'b']]);
  assertEntries(parseIni('\uFEFF\uFEFFa=b').root, [['\uFEFFa', 'b']]);
  assertEntries(parseIni(' \uFEFFa=b').root, [['\uFEFFa', 'b']]);
  assertEntries(parseIni('a=\uFEFF').root, [['a', '\uFEFF']]);
  assertEntries(parseIni('a=1\n\uFEFFb=2').root, [['a', '1'], ['\uFEFFb', '2']]);
  assertEntries(parseIni('[\uFEFFs]\na=b').sections['\uFEFFs'], [['a', 'b']]);
  assertEntries(parseIni('\uFEFF[s]\na=b').sections.s, [['a', 'b']]);
  assertEntries(parseIni('\uFEFF#comment\na=b').root, [['a', 'b']]);
  for (const tail of ['\uFEFF[s]', ' \uFEFF#comment', '\uFEFF;comment']) {
    assertIniError(`a=b\n${tail}`, 2);
  }
});

test('reopens trimmed section names without resetting scopes on blank/comment lines', () => {
  const result = parseIni('x=1\n[root]\nx=2\n[ x ]\na=1\n[y]\nb=2\n[\tx\t]\n\t\n;comment\n#comment\nc=3\n[empty]');
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(Object.getPrototypeOf(result.sections), null);
  assert.deepEqual(Reflect.ownKeys(result), ['root', 'sections']);
  assertEntries(result.root, [['x', '1']]);
  assert.deepEqual(Object.keys(result.sections), ['root', 'x', 'y', 'empty']);
  assertEntries(result.sections.root, [['x', '2']]);
  assertEntries(result.sections.x, [['a', '1'], ['c', '3']]);
  assertEntries(result.sections.y, [['b', '2']]);
  assertEntries(result.sections.empty, []);
});

test('section names are literal, case-sensitive strings and may contain equals', () => {
  const names = ['a=b', 'a.b', '"s"', "'s'", 'a\\b', 'section with spaces', 'A', 'a', '\u00A0', 'a\u2028b'];
  const result = parseIni(names.map(name => ` \t[ ${name} ] \t\nk=\u00A0`).join('\n'));
  assert.deepEqual(Object.keys(result.sections), names);
  for (const name of names) assertEntries(result.sections[name], [['k', '\u00A0']]);
  assertEntries(parseIni('\u00A0=v').root, [['\u00A0', 'v']]);
});

test('preserves source order for numeric and nonnumeric names at every dictionary level', () => {
  const names = ['z', '10', '2', '0', '01', '-0', '4294967294', '4294967295', 'a'];
  const assignments = names.map(name => `${name}=${name}`).join('\n');
  const sections = names.map(name => `[${name}]\n${assignments}`).join('\n');
  const result = parseIni(`${assignments}\n${sections}\n[10]\nlater=value`);
  assert.deepEqual(Object.keys(result.root), names);
  assert.deepEqual(Object.keys(result.sections), names);
  for (const name of names) {
    const expectedKeys = name === '10' ? [...names, 'later'] : names;
    assert.deepEqual(Object.keys(result.sections[name]), expectedKeys);
    assert.deepEqual(Reflect.ownKeys(result.sections[name]), expectedKeys);
  }
  const oracle = parseIni('10=a\n2=b\n[10]\n10=a\n2=b\n[2]\nk=v\n[10]\nlater=v');
  assert.deepEqual(Object.keys(oracle.root), ['10', '2']);
  assert.deepEqual(Object.keys(oracle.sections), ['10', '2']);
  assert.deepEqual(Object.keys(oracle.sections['10']), ['10', '2', 'later']);
});

test('dangerous-looking names are ordinary own properties at every level', () => {
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  const names = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'root', 'sections'];
  const root = names.map(name => `${name}=root:${name}`).join('\n');
  const sections = names.map(section => `[${section}]\n` + names.map(key => `${key}=${section}:${key}`).join('\n')).join('\n');
  const result = parseIni(`${root}\n${sections}`);
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(Object.getPrototypeOf(result.sections), null);
  assert.deepEqual(Reflect.ownKeys(result), ['root', 'sections']);
  assertEntries(result.root, names.map(name => [name, `root:${name}`]));
  assert.deepEqual(Object.keys(result.sections), names);
  for (const section of names) {
    assert.ok(Object.hasOwn(result.sections, section));
    assertEntries(result.sections[section], names.map(key => [key, `${section}:${key}`]));
    assertIniError(`${section}=\n${section}=`, 2);
    assertIniError(`[${section}]\n${section}=1\n[other]\nk=v\n[${section}]\n${section}=2`, 6);
  }
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
});

for (const quote of ['"', "'"]) {
  const otherQuote = quote === '"' ? "'" : '"';
  const quotedCases = [
    ['empty', '', ''],
    ['spaces inside quotes', ' a b ', ' a b '],
    ['comment markers', 'x # y ; z', 'x # y ; z'],
    ['literal other quote', `a${otherQuote}b`, `a${otherQuote}b`],
    ['escaped matching quote', `a\\${quote}b`, `a${quote}b`],
    ['escaped backslash', 'a\\\\b', 'a\\b'],
    ['escaped newline', 'a\\nb', 'a\nb'],
    ['escaped carriage return', 'a\\rb', 'a\rb'],
    ['escaped tab', 'a\\tb', 'a\tb'],
    ['backslash plus n decoded once', '\\\\n', '\\n'],
    ['backslash plus q decoded once', '\\\\q', '\\q'],
    ['backslash plus u0041 decoded once', '\\\\u0041', '\\u0041'],
    ['quoted Windows path', 'C:\\\\new\\\\test', 'C:\\new\\test'],
    ['interpolation syntax', '${NAME}', '${NAME}'],
    ['Unicode separators and BOM', 'x\u2028y\u2029\uFEFF', 'x\u2028y\u2029\uFEFF'],
  ];
  for (const [name, source, expected] of quotedCases) {
    test(`${quote}-quoted ${name}`, () => {
      assert.equal(parseIni(`k= \t${quote}${source}${quote}\t `).root.k, expected);
    });
  }

  test(`${quote}-quoted escape parity before a matching quote`, () => {
    for (let count = 0; count <= 7; count++) {
      const input = `k=${quote}a${'\\'.repeat(count)}${quote}`;
      if (count % 2 === 0) {
        assert.equal(parseIni(input).root.k, `a${'\\'.repeat(count / 2)}`);
        assertIniError(input + quote);
      } else {
        assertIniError(input);
        assert.equal(parseIni(input + quote).root.k, `a${'\\'.repeat((count - 1) / 2)}${quote}`);
      }
    }
  });

  test(`${quote}-quoted values reject unknown/incomplete escapes and missing closers`, () => {
    for (const escape of ['q', '0', 'x41', 'u0041', otherQuote, '/', 'N']) {
      assertIniError(`k=${quote}\\${escape}${quote}`);
      assertIniError(`ok=yes\n[s]\nk=${quote}\\${escape}${quote}`, 3);
    }
    for (const source of [quote, `${quote}a`, `${quote}a${otherQuote}`, `${quote}a\\`]) {
      assertIniError(`k=${source}`);
    }
  });

  test(`${quote}-quoted values reject all non-ASCII-whitespace after the first closing quote`, () => {
    for (const tail of ['x', ' #comment', ';comment', `b${quote}`, `${quote}b${quote}`, '\u00A0', '\u2028', '\u2029', '\uFEFF', '\\']) {
      assertIniError(`k=${quote}a${quote}${tail}`);
    }
  });

  test(`${quote}-quoted values cannot continue across any physical line ending`, () => {
    for (const ending of ['\n', '\r\n', '\r']) {
      for (const backslash of ['', '\\']) {
        assertIniError(`k=${quote}a${backslash}${ending}b${quote}`);
        assertIniError(`;comment${ending}k=${quote}a${backslash}${ending}b${quote}`, 2);
      }
    }
  });
}

const invalidSyntax = [
  ['missing equals', 'broken'],
  ['empty key', '=value'],
  ['blank key', ' \t =value'],
  ['empty header', '[]'],
  ['blank header', '[ \t ]'],
  ['unterminated header', '[s'],
  ['nested brackets', '[[s]]'],
  ['multiple headers', '[a][b]'],
  ['header trailing garbage', '[s]extra'],
  ['header inline comment', '[s] #comment'],
  ['header semicolon comment', '[s];comment'],
  ['header cannot be an assignment', '[s]=value'],
  ['bracket inside key', 'a[b]=value'],
  ['closing bracket inside key', 'a]b=value'],
  ['NBSP is not a blank line', '\u00A0'],
  ['NBSP-prefixed text is not a comment', '\u00A0#comment'],
  ['vertical tab is not a blank line', '\v'],
  ['form feed is not a blank line', '\f'],
  ['Unicode separator after header', '[s]\u2028'],
  ['Unicode paragraph separator after header', '[s]\u2029'],
  ['BOM after header', '[s]\uFEFF'],
];

for (const [name, input] of invalidSyntax) {
  test(`rejects ${name} with its physical line number`, () => {
    assertIniError(input);
    assertIniError(`;comment\r\n[valid]\r${input}`, 3);
  });
}

test('rejects raw C0/C1 controls in names and values, including boundary characters', () => {
  const controls = [
    ...Array.from({ length: 32 }, (_, index) => index),
    ...Array.from({ length: 33 }, (_, index) => index + 127),
  ];
  for (const code of controls) {
    if (code === 10 || code === 13) continue; // Physical endings are tested separately.
    const control = String.fromCharCode(code);
    for (const input of [
      `a${control}b=v`, `[a${control}b]`, `k=a${control}b`,
      `k="a${control}b"`, `k='a${control}b'`,
      `k="${control}"`, `k='${control}'`,
    ]) {
      assertIniError(input);
      assertIniError(`ok=yes\r\n${input}`, 2);
    }
    if (code === 9) continue; // Surrounding HT is grammar whitespace, not field data.
    for (const input of [
      `${control}a=v`, `a${control}=v`, `[${control}a]`, `[a${control}]`,
      `k=${control}v`, `k=v${control}`, `k=${control}`,
    ]) assertIniError(input);
  }
});

test('non-control Unicode and ASCII spaces remain literal field content', () => {
  for (const character of [' ', '!', '~', '\u00A0', '\u2003', '\u2028', '\u2029', '\uFEFF']) {
    const name = `a${character}b`;
    const result = parseIni(`${name}=${name}\n[${name}]\nk="${name}"`);
    assertEntries(result.root, [[name, name]]);
    assertEntries(result.sections[name], [['k', name]]);
  }
});

const duplicates = [
  ['same values', 'k=v\nk=v', 2],
  ['different values', 'k=v\nk=other', 2],
  ['empty then nonempty', 'k=\nk=v', 2],
  ['both empty', 'k=\nk=', 2],
  ['trimmed root identity', 'a=1\n \ta\t =2', 2],
  ['section duplicate', '[s]\nk=1\nk=2', 3],
  ['reopened section duplicate', '[ x ]\na=1\n[x]\na=2', 4],
  ['trimmed reopened identity', '[ x ]\na=1\n[\tx\t]\n \ta\t =2', 4],
  ['duplicate after valid content', 'root=yes\n[s]\na=1\n[other]\na=2\n[s]\na=1', 7],
];

for (const [name, input, lineNumber] of duplicates) {
  test(`rejects ${name} on the repeated assignment line`, () => assertIniError(input, lineNumber));
}

test('identical keys in root and distinct sections do not collide or alias', () => {
  const result = parseIni('x=1\n[root]\nx=2\n[other]\nx=3');
  const scopes = [result.root, result.sections.root, result.sections.other];
  assert.equal(new Set(scopes).size, 3);
  scopes.forEach((scope, index) => assertEntries(scope, [['x', String(index + 1)]]));
});

test('counts CRLF once and LF/CR separately without skipping physical blank/comment lines', () => {
  const result = parseIni('\uFEFF;comment\r\na=1\r[b]\nx=2\n\r\ny=3\r');
  assertEntries(result.root, [['a', '1']]);
  assertEntries(result.sections.b, [['x', '2'], ['y', '3']]);
  assertIniError('\uFEFF;comment\r\n\r[ s ]\nk=ok\rk=again', 5);
  assertIniError('a=1\n\rbroken', 3);
  assertIniError('k="a\\nb"\r\nbroken', 2);
  assertIniError('k=a\u2028b\u2029c\nbroken', 2);
});

test('reports the first invalid physical line when several errors exist', () => {
  assertIniError('broken\nk=\u0000', 1);
  assertIniError('a=1\na=2\nk="\\q"', 2);
  assertIniError(';comment\r\n[s]extra\nk=\u0000', 2);
});

test('successful results and parser state are independent across failures in different scopes', () => {
  const source = 'k=root\n[s]\nk=section\n[t]\nk=other';
  const first = parseIni(source);
  assertIniError('k=1\nk=2', 2);
  const second = parseIni(source);
  assertIniError('[s]\nk=1\n[t]\nk=2\n[s]\nk=3', 6);
  assertIniError('k="\\q"');
  assert.notEqual(first, second);
  assert.notEqual(first.root, second.root);
  assert.notEqual(first.sections, second.sections);
  for (const name of ['s', 't']) assert.notEqual(first.sections[name], second.sections[name]);
  first.root.k = 'changed';
  first.sections.s.k = 'changed';
  delete first.sections.t;
  assertEntries(second.root, [['k', 'root']]);
  assertEntries(second.sections.s, [['k', 'section']]);
  assertEntries(second.sections.t, [['k', 'other']]);
  assert.deepEqual(second, parseIni(source));
  assertIniError('broken');
  assertEntries(parseIni('k=again').root, [['k', 'again']]);
  assertEntries(parseIni('').sections, []);
});

test('ordered dictionaries support caller changes and normal property descriptors', () => {
  const root = parseIni('10=a\n2=b').root;
  root['0'] = 'c';
  root['10'] = 'updated';
  assertEntries(root, [['10', 'updated'], ['2', 'b'], ['0', 'c']]);
  delete root['10'];
  root['10'] = 'reinserted';
  assert.deepEqual(Object.keys(root), ['2', '0', '10']);
  const symbol = Symbol('caller');
  Object.defineProperty(root, symbol, { value: 'symbol' });
  Object.defineProperty(root, 'hidden', { value: 'hidden' });
  assert.deepEqual(Reflect.ownKeys(root), ['2', '0', '10', symbol, 'hidden']);
  assert.equal(Reflect.deleteProperty(root, 'hidden'), false);
  Object.freeze(root);
  assert.equal(Object.isFrozen(root), true);
  assert.equal(Object.getPrototypeOf(root), null);
  assert.deepEqual(Object.keys(root), ['2', '0', '10']);
  assert.equal(Reflect.defineProperty(root, 'new', { value: 'no' }), false);
  assert.equal(Reflect.deleteProperty(root, '2'), false);
  assert.deepEqual(Reflect.ownKeys(root), ['2', '0', '10', symbol, 'hidden']);
});

test('consumes long values completely and rejects long invalid quoted tails', () => {
  const value = 'é東京😀'.repeat(20_000);
  const result = parseIni(`bare=${value}\ndouble="${value}\\n${value}"\nsingle='${value}'\nlast=end`);
  assertEntries(result.root, [
    ['bare', value], ['double', `${value}\n${value}`], ['single', value], ['last', 'end'],
  ]);
  assertIniError(`k="${value}"${' '.repeat(100_000)}x`);
  assertIniError(`ok=yes\nk='${value}${'\\\\'.repeat(20_000)}`, 2);
});
