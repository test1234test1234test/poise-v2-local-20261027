import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../lib/compare-versions.mjs';

function assertOrder(left, right, expected) {
  assert.equal(compareVersions(left, right), expected);
  assert.equal(compareVersions(right, left), expected === 0 ? 0 : -expected);
}

function assertInvalidVersion(version, other = '1.2.3') {
  const message = JSON.stringify(version);
  assert.throws(() => compareVersions(version, other), RangeError, message);
  assert.throws(() => compareVersions(other, version), RangeError, message);
}

const precedenceCases = [
  ['0.0.0', '0.0.0', 0],
  ['1.2.3', '1.2.3', 0],
  ['1.999.999', '2.0.0-alpha', -1],
  ['1.2.999', '1.3.0-alpha', -1],
  ['1.2.3', '1.2.4-alpha', -1],
  ['1.0.0-alpha', '1.0.0', -1],
  ['1.0.0-2', '1.0.0-10', -1],
  ['1.0.0-9', '1.0.0--', -1],
  ['1.0.0-01a', '1.0.0-1', 1],
  ['1.0.0-A', '1.0.0-a', -1],
  ['1.0.0-a-', '1.0.0-a0', -1],
  ['1.0.0-1e3', '1.0.0-2e1', -1],
  ['1.0.0-alpha', '1.0.0-alpha.0', -1],
  ['1.0.0-alpha.z', '1.0.0-alpha.1.extra', 1],
  ['1.0.0-alpha-beta', '1.0.0-alpha.beta', 1],
  ['1.0.0+build-alpha.01', '1.0.0', 0],
  ['1.0.0+-', '1.0.0+00', 0],
  ['1.0.0-alpha+001', '1.0.0-alpha+xyz.000', 0],
];

for (const [left, right, expected] of precedenceCases) {
  test(`compares ${left} and ${right} in both directions`, () => {
    assertOrder(left, right, expected);
  });
}

test('follows the complete official prerelease sequence for every pair', () => {
  const versions = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ];

  for (let left = 0; left < versions.length; left += 1) {
    for (let right = 0; right < versions.length; right += 1) {
      assert.equal(compareVersions(versions[left], versions[right]), Math.sign(left - right));
    }
  }
});

const numericPositions = [
  ['major', digits => `${digits}.0.0`],
  ['minor', digits => `1.${digits}.0`],
  ['patch', digits => `1.2.${digits}`],
  ['prerelease', digits => `1.2.3-alpha.${digits}`],
];

for (const [position, version] of numericPositions) {
  test(`compares ${position} integers exactly at any digit length`, () => {
    const prefix = '7'.repeat(5_000);
    const orderedPairs = [
      ['0', '1'],
      ['9', '10'],
      ['9007199254740992', '9007199254740993'],
      [`${prefix}2`, `${prefix}3`],
      ['9'.repeat(5_000), `1${'0'.repeat(5_000)}`],
    ];

    for (const [lower, higher] of orderedPairs) {
      assertOrder(version(lower), version(higher), -1);
      assert.equal(compareVersions(version(lower), version(lower)), 0);
      assertOrder(`${version(higher)}+001`, `${version(higher)}+different`, 0);
    }
  });
}

test('accepts hyphen content and leading zeroes in nonnumeric or build identifiers', () => {
  for (const version of [
    '0.0.0',
    '1.0.0--',
    '1.0.0--alpha',
    '1.0.0-alpha-',
    '1.0.0+-',
    '1.0.0-01-',
    '1.0.0-01a',
    '1.2.3-0',
    '1.2.3-0.0.0',
    '1.2.3-00a',
    '1.2.3+00',
    '1.2.3-alpha+001',
    '1.2.3-x.7.z.92',
    '1.2.3-x-y-z.--',
    '1.2.3-alpha-beta+build-alpha.01',
    '1.2.3+21AF26D3----117B344092BD',
  ]) {
    assert.equal(compareVersions(version, version), 0, version);
  }
});

const invalidSyntax = [
  ['core shape and ranges', [
    '', 'v1.2.3', '=1.2.3', '^1.2.3', '~1.2.3', '>=1.2.3', '*',
    '1', '1.2', '1.2.3.4', '1.2.3.', '1.2.x', '1.2.3 - 2.0.0',
  ]],
  ['empty and malformed suffixes', [
    '1.2.3-', '1.2.3+', '1.2.3-.alpha', '1.2.3-alpha.', '1.2.3-alpha..1',
    '1.2.3-+build', '1.2.3+.build', '1.2.3+build.', '1.2.3+build..1',
    '1.2.3+build+other', '1.2.3-alpha+build+other',
  ]],
  ['leading zeroes in numeric prerelease identifiers', [
    '1.2.3-01', '1.2.3-alpha.00', '1.2.3-alpha.01.beta', '1.2.3-00+build',
  ]],
];

for (const [family, versions] of invalidSyntax) {
  test(`rejects ${family} in either argument with RangeError`, () => {
    for (const version of versions) assertInvalidVersion(version);
  });
}

test('requires canonical decimal integers in every core position', () => {
  for (let position = 0; position < 3; position += 1) {
    for (const invalid of ['', '00', '01', '-1', '+1', '1e3', '0x10', '0b10', '0o10', 'NaN', 'Infinity']) {
      const components = ['1', '2', '3'];
      components[position] = invalid;
      assertInvalidVersion(components.join('.'));
    }
  }
});

test('rejects whitespace and line terminators throughout both whole inputs', () => {
  for (const whitespace of [' ', '\t', '\n', '\r', '\r\n', '\v', '\f', '\u0085', '\u00a0', '\uFEFF', '\u2028', '\u2029']) {
    for (const version of [
      `${whitespace}1.2.3`,
      `1.2.3${whitespace}`,
      `1${whitespace}.2.3`,
      `1.2${whitespace}0.3`,
      `1.2.3${whitespace}0`,
      `1.2.3-al${whitespace}pha`,
      `1.2.3-alpha${whitespace}`,
      `1.2.3+bu${whitespace}ild`,
      `1.2.3+build${whitespace}`,
      `1.2.3-alpha+build${whitespace}`,
    ]) {
      assertInvalidVersion(version);
    }
  }
});

test('rejects forbidden characters and non-ASCII letters or digits', () => {
  for (const character of ['_', '/', '\0', '\u00e9', '\u0661', '\uff11']) {
    for (const version of [
      `${character}.2.3`,
      `1.${character}.3`,
      `1.2.${character}`,
      `1.2.3-alpha${character}`,
      `1.2.3+build${character}`,
    ]) {
      assertInvalidVersion(version);
    }
  }
});

test('validates both versions before every precedence or equality shortcut', () => {
  for (const [left, right] of [
    ['0.0.0', '9.0.0-alpha.'],
    ['0.0.0', '9.0.0+build..id'],
    ['1.0.0', '1.0.0-alpha+'],
    ['1.0.0-a', '1.0.0-z+bad.'],
    ['1.0.0+ok', '1.0.0+bad.'],
    ['1.0.0-', '1.0.0-'],
    ['0.0.0', `${'9'.repeat(5_000)}.0.0-alpha.`],
  ]) {
    assertInvalidVersion(right, left);
  }
});

test('rejects non-string arguments before syntax validation, without coercion', () => {
  const coercible = {
    [Symbol.toPrimitive]() { assert.fail('must not call Symbol.toPrimitive'); },
    toString() { assert.fail('must not call toString'); },
    valueOf() { assert.fail('must not call valueOf'); },
  };
  for (const value of [undefined, null, 1, NaN, Infinity, 1n, true, false, Symbol('version'), [], ['1.2.3'], {}, new String('1.2.3'), () => '1.2.3', coercible]) {
    for (const other of ['1.2.3', 'not-a-version']) {
      assert.throws(() => compareVersions(value, other), TypeError);
      assert.throws(() => compareVersions(other, value), TypeError);
    }
  }
  assert.throws(() => compareVersions(), TypeError);
  assert.throws(() => compareVersions('1.2.3'), TypeError);
  assert.throws(() => compareVersions('not-a-version'), TypeError);
});

test('is repeatable and preserves ordering when valid metadata is added', () => {
  const versions = [
    '0.0.0', '1.0.0-0', '1.0.0-10', '1.0.0--', '1.0.0-A',
    '1.0.0-alpha', '1.0.0-alpha.0', '1.0.0-alpha.beta', '1.0.0',
    '1.0.1-0', '2.0.0', '9007199254740993.0.0',
  ];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (let left = 0; left < versions.length; left += 1) {
      for (let right = 0; right < versions.length; right += 1) {
        const expected = Math.sign(left - right);
        assert.equal(compareVersions(versions[left], versions[right]), expected);
        assert.equal(compareVersions(`${versions[left]}+left.000`, versions[right]), expected);
        assert.equal(compareVersions(versions[left], `${versions[right]}+right.001`), expected);
        assert.equal(compareVersions(`${versions[left]}+left.000`, `${versions[right]}+right.001`), expected);
      }
    }
  }
});

test('retains no parser state across interleaved successes and failures', () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertOrder('1.0.0-alpha.1', '1.0.0-alpha.2', -1);
    assertInvalidVersion('1.0.0+bad.');
    assert.equal(compareVersions('1.0.0+001', '1.0.0+abc'), 0);
    assert.throws(() => compareVersions(null, 'bad'), TypeError);
    assertInvalidVersion('1.0.0-alpha.00');
    assertOrder('1.0.0-alpha.1', '1.0.0-alpha.2', -1);
  }
});
