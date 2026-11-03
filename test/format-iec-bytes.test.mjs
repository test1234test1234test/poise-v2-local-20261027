import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatIecBytes } from '../lib/format-iec-bytes.mjs';

function assertFormats(bytes, expected) {
  assert.equal(formatIecBytes(bytes), expected, `${bytes}n`);
  if (bytes <= BigInt(Number.MAX_SAFE_INTEGER)) {
    assert.equal(formatIecBytes(Number(bytes)), expected, `${bytes} as Number`);
  }
}

test('formats integer bytes, negative zero and the documented examples', () => {
  for (const [bytes, expected] of [
    [0n, '0 B'],
    [1n, '1 B'],
    [1023n, '1023 B'],
    [1024n, '1.0 KiB'],
    [1025n, '1.0 KiB'],
    [1126n, '1.1 KiB'],
    [1536n, '1.5 KiB'],
    [1048575n, '1.0 MiB'],
  ]) {
    assertFormats(bytes, expected);
  }
  assert.equal(formatIecBytes(-0), '0 B');
});

test('rounds original bytes exactly without floating-point or double rounding', () => {
  for (const [bytes, expected] of [
    [1075n, '1.0 KiB'],
    [1076n, '1.1 KiB'],
    [1279n, '1.2 KiB'],
    [1280n, '1.3 KiB'],
    [1281n, '1.3 KiB'],
    [1996n, '1.9 KiB'],
    [1997n, '2.0 KiB'],
    [2047n, '2.0 KiB'],
    [1101004n, '1.0 MiB'],
    [1101005n, '1.1 MiB'],
    [2308094809027379n, '2.0 PiB'],
    [2308094809027380n, '2.1 PiB'],
  ]) {
    assertFormats(bytes, expected);
  }
});

const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
for (const [index, unit] of units.entries()) {
  const divisor = 1024n ** BigInt(index + 1);

  test(`formats the exact ${unit} boundary and adjacent bytes`, () => {
    assertFormats(divisor - 1n, index === 0 ? '1023 B' : `1.0 ${unit}`);
    assertFormats(divisor, `1.0 ${unit}`);
    assertFormats(divisor + 1n, `1.0 ${unit}`);
  });

  test(`rounds all ten ${unit} decimal transitions half up`, () => {
    const magnitudes = ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9', '2.0'];
    for (let tenth = 11; tenth <= 20; tenth += 1) {
      // Independently derive the first integer byte count at each transition:
      // ceil((tenth - 0.5) * divisor / 10). The 1.25 tie is exact in every unit.
      const threshold = ((2n * BigInt(tenth) - 1n) * divisor + 19n) / 20n;
      assertFormats(threshold - 1n, `${magnitudes[tenth - 11]} ${unit}`);
      assertFormats(threshold, `${magnitudes[tenth - 10]} ${unit}`);
      assertFormats(threshold + 1n, `${magnitudes[tenth - 10]} ${unit}`);
    }
  });
}

for (const [unit, firstRounded, expected] of [
  ['KiB', 1048525n, '1.0 MiB'],
  ['MiB', 1073689396n, '1.0 GiB'],
  ['GiB', 1099457940685n, '1.0 TiB'],
  ['TiB', 1125844931261236n, '1.0 PiB'],
  ['PiB', 1152865209611504845n, '1.0 EiB'],
  ['EiB', 1180533974642180961076n, '1024.0 EiB'],
]) {
  test(`handles the earliest rounded 1024.0 ${unit} and adjacent bytes`, () => {
    assertFormats(firstRounded - 1n, `1023.9 ${unit}`);
    assertFormats(firstRounded, expected);
    assertFormats(firstRounded + 1n, expected);
  });
}

test('accepts the safe Number limit and larger BigInts', () => {
  assertFormats(9007199254740991n, '8.0 PiB');
  assertFormats(9007199254740992n, '8.0 PiB');
  assert.throws(() => formatIecBytes(9007199254740992), RangeError);
});

test('caps units at EiB without capping the decimal magnitude', () => {
  assertFormats(1024n ** 7n, '1024.0 EiB');
  assertFormats(10000n * (1024n ** 6n), '10000.0 EiB');
});

test('preserves huge decimal magnitudes, adjacent-byte rounding and fractional carry', () => {
  const eib = 1024n ** 6n;
  const huge = 10n ** 400n;
  for (const [bytes, expected] of [
    [huge * eib, `${huge}.0 EiB`],
    [huge * eib + eib / 4n - 1n, `${huge}.2 EiB`],
    [huge * eib + eib / 4n, `${huge}.3 EiB`],
    [huge * eib + eib / 4n + 1n, `${huge}.3 EiB`],
    [huge * eib + eib - 1n, `${huge + 1n}.0 EiB`],
  ]) {
    assertFormats(bytes, expected);
  }
});

test('rejects invalid numeric values with RangeError', () => {
  for (const value of [
    -1, -1024, -Number.MAX_SAFE_INTEGER, -1n, -(10n ** 400n),
    -0.5, 0.5, 1.5, Number.MIN_VALUE,
    NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE,
  ]) {
    assert.throws(() => formatIecBytes(value), RangeError, String(value));
  }
});

test('rejects other primitive types, objects and omitted arguments with TypeError', () => {
  for (const value of [
    undefined, null, '', '0', '1024', true, false, Symbol('1024'),
    [], [1024], {}, Object.create(null), () => 1024,
    new Number(0), new Number(1024), Object(0n), Object(1024n),
  ]) {
    assert.throws(() => formatIecBytes(value), TypeError);
  }
  assert.throws(() => formatIecBytes(), TypeError);
});

for (const hook of [Symbol.toPrimitive, 'valueOf', 'toString']) {
  test(`rejects objects without reading or calling ${String(hook)}`, () => {
    let accesses = 0;
    const fail = () => {
      accesses += 1;
      throw new Error('Conversion hook must not run');
    };
    const getter = Object.defineProperty({}, hook, { get: fail });
    const method = { [hook]: fail };
    assert.throws(() => formatIecBytes(getter), TypeError);
    assert.throws(() => formatIecBytes(method), TypeError);
    assert.equal(accesses, 0);
  });
}

test('rejects live and revoked proxies without inspecting their properties', () => {
  let accesses = 0;
  const fail = () => {
    accesses += 1;
    throw new Error('Proxy must not be inspected');
  };
  const handler = { get: fail, getPrototypeOf: fail, has: fail, ownKeys: fail, getOwnPropertyDescriptor: fail };
  for (const target of [{}, () => 1024]) {
    assert.throws(() => formatIecBytes(new Proxy(target, handler)), TypeError);
    const revoked = Proxy.revocable(target, handler);
    revoked.revoke();
    assert.throws(() => formatIecBytes(revoked.proxy), TypeError);
  }
  assert.equal(accesses, 0);
});
