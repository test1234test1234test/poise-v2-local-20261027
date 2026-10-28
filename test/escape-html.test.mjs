import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../lib/escape-html.mjs';

const escapingCases = [
  ['ampersand', '&', '&amp;'],
  ['less-than', '<', '&lt;'],
  ['greater-than', '>', '&gt;'],
  ['double quote', '"', '&quot;'],
  ['apostrophe', "'", '&#39;'],
  ['all five characters', `&<>"'`, '&amp;&lt;&gt;&quot;&#39;'],
  ['adjacent repetitions', `&&<<>>""''`, '&amp;&amp;&lt;&lt;&gt;&gt;&quot;&quot;&#39;&#39;'],
  ['replacement order', '<&', '&lt;&amp;'],
  ['mixed text', `Tom & <Ada> said "it's fine".`, 'Tom &amp; &lt;Ada&gt; said &quot;it&#39;s fine&quot;.'],
];

for (const [name, input, expected] of escapingCases) {
  test(`escapeHtml: ${name}`, () => {
    assert.equal(escapeHtml(input), expected);
  });
}

test('escapeHtml re-escapes named, numeric, hexadecimal, unknown and incomplete entities', () => {
  assert.equal(
    escapeHtml('&amp; &lt; &gt; &quot; &apos; &#39; &#x27; &bogus; &unfinished'),
    '&amp;amp; &amp;lt; &amp;gt; &amp;quot; &amp;apos; &amp;#39; &amp;#x27; &amp;bogus; &amp;unfinished',
  );
});

test('escapeHtml deliberately escapes again on a second call', () => {
  assert.equal(escapeHtml(escapeHtml('&')), '&amp;amp;');
});

const preservedCases = [
  ['empty text', ''],
  ['plain text', 'ordinary text 123'],
  ['whitespace only', ' \t\n\r\n\r '],
  ['mixed line endings and surrounding whitespace', ' \tA\nB\r\nC\rD \t\n'],
  ['Unicode and decomposed text', 'café 中文 😀 e\u0301'],
  ['Unicode separators, BOM and NUL', '\uFEFF\u2028\u2029\0'],
  ['lone surrogates', '\uD800x\uDC00'],
  ['curly quotes and fullwidth lookalikes', '“”‘’＆＜＞＂＇'],
  ['other punctuation', '/\\`='],
];

for (const [name, input] of preservedCases) {
  test(`escapeHtml preserves ${name} with and without replacements`, () => {
    assert.equal(escapeHtml(input), input);
    assert.equal(
      escapeHtml(`<${input}&"'>${input}`),
      `&lt;${input}&amp;&quot;&#39;&gt;${input}`,
    );
  });
}

test('escapeHtml preserves code units immediately beside escaped characters', () => {
  assert.equal(escapeHtml('\uFEFFA\r\nB\rC\0<&'), '\uFEFFA\r\nB\rC\0&lt;&amp;');
  assert.equal(escapeHtml('\uD800&\uDC00'), '\uD800&amp;\uDC00');
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
  ['symbol', Symbol('text')],
  ['empty array', []],
  ['string array', ['text']],
  ['plain object', {}],
  ['function', () => 'text'],
  ['boxed string', new String('text')],
  ['boxed empty string', new String('')],
  ['object with zero length', { length: 0 }],
];

for (const [name, input] of invalidInputs) {
  test(`escapeHtml rejects ${name}`, () => {
    assert.throws(() => escapeHtml(input), TypeError);
  });
}

test('escapeHtml rejects an omitted argument', () => {
  assert.throws(() => escapeHtml(), TypeError);
});

for (const property of [Symbol.toPrimitive, 'toString', 'valueOf', 'replace', 'length']) {
  test(`escapeHtml rejects objects without reading ${String(property)}`, () => {
    let reads = 0;
    const input = Object.defineProperty({}, property, {
      get() {
        reads += 1;
        throw new TypeError('property access sentinel');
      },
    });

    assert.throws(() => escapeHtml(input), TypeError);
    assert.equal(reads, 0);
  });
}

for (const method of [Symbol.toPrimitive, 'toString', 'replace']) {
  test(`escapeHtml rejects objects without calling ${String(method)}`, () => {
    let calls = 0;
    const input = {
      [method]() {
        calls += 1;
        return 'text';
      },
    };

    assert.throws(() => escapeHtml(input), TypeError);
    assert.equal(calls, 0);
  });
}

test('escapeHtml is deterministic across repeated, alternating and rejected calls', () => {
  for (let index = 0; index < 10; index += 1) {
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('plain text'), 'plain text');
    assert.equal(escapeHtml('<&'), '&lt;&amp;');
    assert.equal(escapeHtml(''), '');
    assert.throws(() => escapeHtml(null), TypeError);
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  }
});

test('escapeHtml processes a large mixed string through its complete tail', () => {
  const input = `é😀\t<&>"'\r\n`.repeat(10_000) + '\uD800&tail<\uDC00\0\n';
  const expected = 'é😀\t&lt;&amp;&gt;&quot;&#39;\r\n'.repeat(10_000)
    + '\uD800&amp;tail&lt;\uDC00\0\n';

  assert.equal(escapeHtml(input), expected);
});
