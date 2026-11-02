import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDotPath } from '../lib/parse-dot-path.mjs';

function encode(parts) {
  return parts.map(part => part.replaceAll('\\', '\\\\').replaceAll('.', '\\.')).join('.');
}

const validCases = [
  ['one segment', 'a', ['a']],
  ['separated segments', 'a.b', ['a', 'b']],
  ['repeated segments', 'a.a.a', ['a', 'a', 'a']],
  ['escaped period', String.raw`a\.b.c`, ['a.b', 'c']],
  ['escaped backslash before separator', String.raw`a\\.b`, ['a\\', 'b']],
  ['escaped backslash and period', String.raw`a\\\.b`, ['a\\.b']],
  ['two escaped backslashes before separator', String.raw`a\\\\.b`, ['a\\\\', 'b']],
  ['only an escaped period', String.raw`\.`, ['.']],
  ['only an escaped backslash', String.raw`\\`, ['\\']],
  ['two escaped periods', String.raw`\.\.`, ['..']],
  ['escaped final period', String.raw`a\.`, ['a.']],
  ['escaped period before separator', String.raw`a\..b`, ['a.', 'b']],
  ['escaped period after separator', String.raw`a.\.b`, ['a', '.b']],
  ['decode once', String.raw`\\u0061.a\\u002eb`, ['\\u0061', 'a\\u002eb']],
  ['whitespace-only segments', ' . ', [' ', ' ']],
  ['whitespace-only input', ' \t\r\n\u00a0', [' \t\r\n\u00a0']],
  ['preserved whitespace', '\t a \r.\nb\r\n.\u00a0', ['\t a \r', '\nb\r\n', '\u00a0']],
  ['newlines beside separators', 'a.\n.a\n.b', ['a', '\n', 'a\n', 'b']],
  ['numbers and brackets remain strings', '01.1e3.a[0]', ['01', '1e3', 'a[0]']],
  ['brackets do not shield separators', 'a[b.c]', ['a[b', 'c]']],
  ['other path notations remain literal', '[constructor].%5F%5Fproto%5F%5F.~1./', ['[constructor]', '%5F%5Fproto%5F%5F', '~1', '/']],
  ['slash and embedded NUL', 'a/b.a\0b', ['a/b', 'a\0b']],
  ['initial BOM and NUL', '\uFEFFa.\0b', ['\uFEFFa', '\0b']],
  ['Unicode and normalization forms', 'é.e\u0301.🧪.𐐷', ['é', 'e\u0301', '🧪', '𐐷']],
  ['fullwidth punctuation', 'a．b.＼c', ['a．b', '＼c']],
  ['Unicode beside escapes and separators', String.raw`🧪\.é.𐐷\\中`, ['🧪.é', '𐐷\\中']],
  ['NUL and Unicode line separators beside escapes', '\0\\.\u2028.\u2029\\\\', ['\0.\u2028', '\u2029\\']],
  ['lone surrogates', '\uD800.\uDC00', ['\uD800', '\uDC00']],
  ['lone surrogates beside escapes', '\uD800\\.x.\uDC00\\\\', ['\uD800.x', '\uDC00\\']],
  ['allowed inherited property names', 'toString.hasOwnProperty.valueOf', ['toString', 'hasOwnProperty', 'valueOf']],
  ['forbidden names joined by escaped period', String.raw`constructor\.prototype`, ['constructor.prototype']],
];

for (const [name, input, expected] of validCases) {
  test(`parseDotPath: ${name}`, () => {
    const result = parseDotPath(input);
    assert.ok(Array.isArray(result));
    assert.ok(result.every(part => typeof part === 'string'));
    assert.deepEqual(result, expected);
    assert.equal(encode(result), input);
  });
}

for (let count = 0; count <= 8; count += 1) {
  test(`parseDotPath handles a run of ${count} backslashes at boundaries`, () => {
    const prefix = 'a' + '\\'.repeat(count);
    const decoded = 'a' + '\\'.repeat(Math.floor(count / 2));
    if (count % 2 === 0) {
      assert.deepEqual(parseDotPath(prefix + '.b'), [decoded, 'b']);
      assert.deepEqual(parseDotPath(prefix), [decoded]);
      assert.throws(() => parseDotPath(prefix + '.'), SyntaxError);
      assert.throws(() => parseDotPath(prefix + '..b'), SyntaxError);
    } else {
      assert.deepEqual(parseDotPath(prefix + '.b'), [decoded + '.b']);
      assert.throws(() => parseDotPath(prefix), SyntaxError);
      assert.deepEqual(parseDotPath(prefix + '.'), [decoded + '.']);
      assert.deepEqual(parseDotPath(prefix + '..b'), [decoded + '.', 'b']);
    }
  });
}

test('parseDotPath rejects empty input, empty segments and unfinished escapes', () => {
  for (const input of ['', '.', '..', '.a', 'a.', 'a..b', 'a.b..c', '\\', 'a.\\', String.raw`a\\.`, String.raw`a\\..b`]) {
    assert.throws(() => parseDotPath(input), SyntaxError, JSON.stringify(input));
  }
});

test('parseDotPath rejects unsupported escapes at the start, middle and end', () => {
  for (const escaped of ['n', 't', '0', '9', 'x2e', 'u002e', 'u{61}', ' ', '\t', '\r', '\n', '\r\n', '\0', '/', '[', ']', 'é', '🧪', '．', '＼', '\uD800']) {
    for (const input of ['\\' + escaped, 'a\\' + escaped + 'b', 'safe.key.\\' + escaped]) {
      assert.throws(() => parseDotPath(input), SyntaxError, JSON.stringify(input));
    }
  }
});

for (const name of ['__proto__', 'prototype', 'constructor']) {
  test(`parseDotPath rejects the complete segment ${name} in every position`, () => {
    for (const input of [name, `${name}.safe`, `safe.${name}.key`, `safe.${name}`, String.raw`safe\.key.${name}`, String.raw`${name}.safe\\key`]) {
      assert.throws(() => parseDotPath(input), SyntaxError, input);
    }
  });

  test(`parseDotPath permits containing and case variants of ${name}`, () => {
    for (const part of [`x${name}`, `${name}Suffix`, name.toUpperCase(), ` ${name}`, `${name} `, `${name}\n`, `\uFEFF${name}`, `${name}\0`]) {
      assert.deepEqual(parseDotPath(part), [part]);
    }
    assert.deepEqual(parseDotPath(name + String.raw`\.`), [name + '.']);
    assert.deepEqual(parseDotPath(name + String.raw`\\`), [name + '\\']);
  });
}

test('parseDotPath accepts Constructor but rejects an already decoded forbidden name', () => {
  assert.deepEqual(parseDotPath('Constructor'), ['Constructor']);
  assert.throws(() => parseDotPath('\u005f\u005fproto__'), SyntaxError);
});

test('parseDotPath rejects nonstrings, including omitted and boxed input', () => {
  assert.throws(() => parseDotPath(), TypeError);
  for (const input of [undefined, null, 0, 1, NaN, Infinity, true, false, 1n, Symbol('a.b'), [], ['a.b'], {}, new String('a.b'), () => 'a.b']) {
    assert.throws(() => parseDotPath(input), TypeError);
  }
});

test('parseDotPath rejects objects without reading properties or invoking conversion hooks', () => {
  let accesses = 0;
  const sentinel = new TypeError('input access sentinel');
  const trap = () => {
    accesses += 1;
    throw sentinel;
  };
  for (const property of [Symbol.toPrimitive, Symbol.iterator, 'toString', 'valueOf', 'length', '0']) {
    for (const input of [Object.defineProperty({}, property, { get: trap }), { [property]: trap }]) {
      assert.throws(() => parseDotPath(input), TypeError);
      assert.equal(accesses, 0);
    }
  }
  assert.throws(() => parseDotPath(new Proxy(new String('a.b'), { get: trap })), TypeError);
  assert.equal(accesses, 0);
});

test('parseDotPath returns fresh arrays and retains no state after failures or mutation', () => {
  const input = String.raw`a\.b.c\\d`;
  const expected = ['a.b', 'c\\d'];
  const first = parseDotPath(input);
  const second = parseDotPath(input);
  assert.notStrictEqual(first, second);
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
  first[0] = 'changed';
  first.push('extra');

  for (const invalid of ['safe..key', 'safe.constructor', 'safe.key\\', String.raw`safe.key\n`, null]) {
    assert.throws(() => parseDotPath(invalid), invalid === null ? TypeError : SyntaxError);
    assert.deepEqual(second, expected);
    const next = parseDotPath(input);
    assert.notStrictEqual(next, first);
    assert.notStrictEqual(next, second);
    assert.deepEqual(next, expected);
  }
  assert.deepEqual(first, ['changed', 'c\\d', 'extra']);
});

test('parseDotPath round trips generated segment combinations without normalization', () => {
  const parts = ['a', '.', '\\', '.\\', '\\.', ' ', '\t\r\n', '\0', '\uFEFF', 'é', 'e\u0301', '🧪', '\uD800', '\uDC00', '01', 'a[b]', '__proto__.x', 'constructor\\', 'toString'];
  for (const first of parts) {
    for (const second of parts) {
      const expected = [first, second, first + second];
      const input = encode(expected);
      const result = parseDotPath(input);
      assert.deepEqual(result, expected);
      assert.equal(encode(result), input);
    }
  }
});

test('parseDotPath processes long segments, many segments and invalid tails', () => {
  const segment = 'x'.repeat(16_384);
  const parts = Array.from({ length: 2_048 }, (_, index) => `key${index}`);
  assert.deepEqual(parseDotPath(segment), [segment]);
  assert.deepEqual(parseDotPath(parts.join('.')), parts);
  for (const prefix of [segment, parts.join('.')]) {
    assert.deepEqual(parseDotPath(prefix + String.raw`\.tail`), prefix === segment
      ? [segment + '.tail']
      : [...parts.slice(0, -1), parts.at(-1) + '.tail']);
    for (const suffix of ['\\', String.raw`\n`, '.', '..tail', '.constructor']) {
      assert.throws(() => parseDotPath(prefix + suffix), SyntaxError);
    }
  }
});
