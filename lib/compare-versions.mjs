const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const numericIdentifier = /^[0-9]+$/;

function parseVersion(version) {
  const match = versionPattern.exec(version);
  // JavaScript's $ can match before a final newline; require the whole string.
  if (match === null || match[0] !== version) {
    throw new RangeError('Invalid semantic version');
  }

  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  if (prerelease.some(identifier => /^0[0-9]+$/.test(identifier))) {
    throw new RangeError('Numeric prerelease identifiers must not have leading zeroes');
  }

  return { core: match.slice(1, 4), prerelease };
}

function compareNumeric(left, right) {
  // Canonical decimal strings compare exactly by length, then by ASCII order.
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Compare strict SemVer 2.0.0 strings, returning exactly -1, 0, or 1. */
export function compareVersions(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    throw new TypeError('left and right must be primitive strings');
  }

  // Validate both complete inputs, including metadata, before any comparison.
  const a = parseVersion(left);
  const b = parseVersion(right);

  for (let index = 0; index < 3; index += 1) {
    const result = compareNumeric(a.core[index], b.core[index]);
    if (result !== 0) return result;
  }

  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }

  const commonLength = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < commonLength; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === rightIdentifier) continue;

    const leftNumeric = numericIdentifier.test(leftIdentifier);
    const rightNumeric = numericIdentifier.test(rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (leftNumeric) return compareNumeric(leftIdentifier, rightIdentifier);
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }

  if (a.prerelease.length === b.prerelease.length) return 0;
  return a.prerelease.length < b.prerelease.length ? -1 : 1;
}
