import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAscii } from '../lib/is-ascii.mjs';

test('isAscii accepts empty text, ordinary text and literal escapes', () => {
  for (const input of ['', 'ASCII text 123!', '\\u0080']) {
    assert.equal(isAscii(input), true);
  }
});

test('isAscii accepts the full ASCII range together and embedded controls', () => {
  const ascii = Array.from({ length: 128 }, (_, unit) => String.fromCharCode(unit)).join('');
  assert.equal(isAscii(ascii), true);

  for (let unit = 0; unit <= 0x7f; unit += 1) {
    assert.equal(isAscii(`left${String.fromCharCode(unit)}right`), true);
  }
  assert.equal(isAscii('\0\t\n\r\x7f'), true);
});

test('isAscii classifies every individual UTF-16 code unit', () => {
  for (let unit = 0; unit <= 0xffff; unit += 1) {
    assert.equal(
      isAscii(String.fromCharCode(unit)),
      unit <= 0x7f,
      `UTF-16 unit 0x${unit.toString(16)}`,
    );
  }
});

const nonAsciiCases = [
  ['first non-ASCII unit', '\u0080'],
  ['last Latin-1 unit', '\u00ff'],
  ['unit with a zero low byte', '\u0100'],
  ['last UTF-16 unit', '\uffff'],
  ['accented letter', 'é'],
  ['accented text', 'café'],
  ['decomposed accented letter', 'e\u0301'],
  ['combining mark', '\u0301'],
  ['non-Latin letters', '中文'],
  ['nonbreaking space', '\u00a0'],
  ['BOM', '\ufeff'],
  ['line separator', '\u2028'],
  ['paragraph separator', '\u2029'],
  ['non-ASCII whitespace surrounding ASCII', '\u00a0A\ufeff'],
  ['fullwidth letter', 'Ａ'],
  ['Kelvin sign', '\u212a'],
  ['lowest supplementary code point', '\u{10000}'],
  ['highest supplementary code point', '\u{10ffff}'],
  ['emoji', '😀'],
  ['lowest lone high surrogate', '\ud800'],
  ['highest lone high surrogate', '\udbff'],
  ['lowest lone low surrogate', '\udc00'],
  ['highest lone low surrogate', '\udfff'],
  ['reversed surrogate pair', '\udc00\ud800'],
  ['repeated high surrogates', '\ud800\ud800'],
  ['repeated low surrogates', '\udc00\udc00'],
  ['separated surrogates', '\ud800A\udc00'],
];

for (const [name, input] of nonAsciiCases) {
  test(`isAscii returns false for ${name}, alone and within ASCII text`, () => {
    for (const text of [input, `${input}ABC`, `A${input}BC`, `ABC${input}`]) {
      assert.equal(isAscii(text), false);
    }
  });
}

test('isAscii checks non-ASCII suffixes after NUL and line endings', () => {
  for (const control of ['\0', '\n', '\r', '\r\n']) {
    assert.equal(isAscii(`ASCII${control}text`), true);
    for (const suffix of ['\u0080', '\ud800', 'é']) {
      assert.equal(isAscii(control + suffix), false);
      assert.equal(isAscii(`ASCII${control}${suffix}`), false);
    }
  }
});

test('isAscii checks the beginning, middle and end of long text', () => {
  const ascii = 'ABC\0\n'.repeat(10_000);
  assert.equal(isAscii(ascii), true);
  for (const position of [0, ascii.length / 2, ascii.length]) {
    assert.equal(isAscii(ascii.slice(0, position) + '\u0080' + ascii.slice(position)), false);
  }
});

const invalidInputs = [
  ['undefined', undefined],
  ['null', null],
  ['true', true],
  ['false', false],
  ['zero', 0],
  ['negative zero', -0],
  ['number', 123],
  ['NaN', NaN],
  ['positive infinity', Infinity],
  ['negative infinity', -Infinity],
  ['zero bigint', 0n],
  ['bigint', 123n],
  ['symbol', Symbol('ASCII')],
  ['function', () => 'ASCII'],
  ['empty array', []],
  ['string array', ['ASCII']],
  ['plain object', {}],
  ['null-prototype object', Object.create(null)],
  ['boxed empty string', new String('')],
  ['boxed ASCII string', new String('ASCII')],
  ['boxed non-ASCII string', new String('é')],
  ['boxed number', new Number(0)],
  ['boxed boolean', new Boolean(false)],
  ['object with zero length', { length: 0 }],
  ['empty buffer', Buffer.alloc(0)],
  ['ASCII buffer', Buffer.from('ASCII')],
  ['typed array', new Uint8Array([65])],
];

for (const [name, input] of invalidInputs) {
  test(`isAscii rejects ${name}`, () => {
    assert.throws(() => isAscii(input), TypeError);
  });
}

test('isAscii rejects an omitted argument', () => {
  assert.throws(() => isAscii(), TypeError);
});

for (const property of [Symbol.toPrimitive, 'toString', 'valueOf', 'length']) {
  test(`isAscii rejects objects without reading ${String(property)}`, () => {
    let reads = 0;
    const input = Object.defineProperty({}, property, {
      get() {
        reads += 1;
        throw new TypeError('property access sentinel');
      },
    });

    assert.throws(() => isAscii(input), TypeError);
    assert.equal(reads, 0);
  });
}

for (const method of [Symbol.toPrimitive, 'toString', 'valueOf']) {
  for (const throws of [false, true]) {
    test(`isAscii never calls ${String(method)} hooks that ${throws ? 'throw' : 'return ASCII'}`, () => {
      let calls = 0;
      const input = {
        [method]() {
          calls += 1;
          if (throws) throw new TypeError('coercion sentinel');
          return 'ASCII';
        },
      };

      assert.throws(() => isAscii(input), TypeError);
      assert.equal(calls, 0);
    });
  }
}

test('isAscii rejects a proxy without invoking its traps', () => {
  let calls = 0;
  const trap = () => {
    calls += 1;
    throw new TypeError('proxy trap sentinel');
  };
  const input = new Proxy({}, {
    get: trap,
    has: trap,
    getPrototypeOf: trap,
    ownKeys: trap,
    getOwnPropertyDescriptor: trap,
  });

  assert.throws(() => isAscii(input), TypeError);
  assert.equal(calls, 0);
});

test('isAscii is consistent across repeated, alternating and rejected calls', () => {
  for (let index = 0; index < 10; index += 1) {
    assert.equal(isAscii('ASCII'), true);
    assert.equal(isAscii('ASCII'), true);
    assert.equal(isAscii('é'), false);
    assert.equal(isAscii('é'), false);
    assert.equal(isAscii(''), true);
    assert.throws(() => isAscii(undefined), TypeError);
    assert.equal(isAscii('Aé'), false);
    assert.equal(isAscii('\0\n\x7f'), true);
  }
});
