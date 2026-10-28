# `compareVersions(left, right)`

Compare two strict SemVer 2.0.0 strings. The named export returns exactly the
primitive Number `-1`, `0`, or `1` when the left version has lower, equal, or
higher precedence, respectively.

```js
import { compareVersions } from '../lib/compare-versions.mjs';

compareVersions('1.9.0', '1.10.0');              // -1
compareVersions('2.0.0-alpha', '1.999.999');     // 1
compareVersions('1.0.0-alpha', '1.0.0');         // -1
compareVersions('1.0.0+build.001', '1.0.0+xyz'); // 0
compareVersions('1.0.0-alpha+001', '1.0.0-alpha+other'); // 0
compareVersions('9007199254740992.0.0', '9007199254740993.0.0'); // -1

['1.0.0', '1.0.0-beta', '1.0.0-alpha'].sort(compareVersions);
// ['1.0.0-alpha', '1.0.0-beta', '1.0.0']
```

Numeric identifiers may be arbitrarily long, including thousands of digits and
values beyond JavaScript's finite Number range. Comparison uses digit counts and
then ASCII order for equal lengths, without converting identifiers to Numbers or
rounding them. The function is pure, deterministic, and independent of locale.

## Precedence

Major, minor, and patch compare numerically, in that order. For matching core
versions, a release ranks above its prereleases. Prerelease identifiers compare
from left to right: entirely numeric identifiers compare numerically and rank
below nonnumeric identifiers, which compare by ASCII code points. Thus `2 < 10`,
`9 < -`, and `A < a` in prerelease positions. If the shared identifier prefix is
equal, the shorter list ranks lower. Build metadata never affects precedence.

The complete official [SemVer 2.0.0 ordering example](https://semver.org/spec/v2.0.0.html#spec-item-11)
is:

```text
1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta
  < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0
```

## Accepted syntax

Both inputs must have the form `major.minor.patch`, optionally followed by
`-prerelease`, `+build`, or `-prerelease+build`. All three core components are
nonnegative ASCII decimal integers. Prerelease and build suffixes consist of
nonempty dot-separated identifiers using only ASCII letters, digits, and hyphens.

Core numbers and entirely numeric prerelease identifiers cannot have leading
zeroes, except the identifier `0` itself. Nonnumeric prerelease identifiers such
as `01a` and `01-`, and build identifiers such as `001`, are valid.

Hyphens can be identifier content, including at the end. `1.0.0--`,
`1.0.0-alpha-`, `1.0.0+-`, and `1.0.0-01-` are valid. A bare suffix introducer or
empty dot-separated identifier is invalid: `1.0.0-`, `1.0.0+`, `1.0.0-alpha.`,
and `1.0.0+build.` all fail validation.

Leading `v`, ranges, missing components, whitespace anywhere, non-ASCII
characters, repeated `+`, and other malformed suffixes are rejected. Inputs are
never trimmed or coerced, and no trailing content or line terminator is ignored.

## Errors

- **`TypeError`**: either argument is not a primitive string. This includes
  omitted arguments and boxed strings. Both argument types are checked before
  syntax, so both `compareVersions('bad', null)` and
  `compareVersions(null, 'bad')` throw `TypeError`. Conversion hooks are not called.
- **`RangeError`**: both arguments are strings, but at least one is malformed.
  Both versions, including their metadata, must pass syntax validation before a
  comparison result is returned. For example,
  `compareVersions('0.0.0', '9.0.0+bad.')` throws despite the different majors,
  and `compareVersions('1.0.0+ok', '1.0.0+bad.')` throws despite metadata having
  no effect on precedence. Validation stops at the first error; it does not
  collect multiple errors.

Run the regression tests with `node --test test/compare-versions.test.mjs`, or
run all repository checks with `npm test` from the repository root.
