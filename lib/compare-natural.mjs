function isAsciiDigit(point) {
  return point >= 0x30 && point <= 0x39;
}

/** Compare strings by code point and complete ASCII digit runs, returning -1, 0, or 1. */
export function compareNatural(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    throw new TypeError('a and b must be primitive strings');
  }

  let aIndex = 0;
  let bIndex = 0;
  while (aIndex < a.length && bIndex < b.length) {
    const aPoint = a.codePointAt(aIndex);
    const bPoint = b.codePointAt(bIndex);

    // Find complete runs before advancing past even an equal initial digit.
    if (isAsciiDigit(aPoint) && isAsciiDigit(bPoint)) {
      let aEnd = aIndex + 1;
      let bEnd = bIndex + 1;
      while (isAsciiDigit(a.charCodeAt(aEnd))) aEnd += 1;
      while (isAsciiDigit(b.charCodeAt(bEnd))) bEnd += 1;

      let aSignificant = aIndex;
      let bSignificant = bIndex;
      while (aSignificant < aEnd && a.charCodeAt(aSignificant) === 0x30) aSignificant += 1;
      while (bSignificant < bEnd && b.charCodeAt(bSignificant) === 0x30) bSignificant += 1;

      // Magnitude is significant length, then ASCII order; all-zero runs have length 0.
      const aDigits = aEnd - aSignificant;
      const bDigits = bEnd - bSignificant;
      if (aDigits !== bDigits) return aDigits < bDigits ? -1 : 1;
      while (aSignificant < aEnd) {
        const aDigit = a.charCodeAt(aSignificant);
        const bDigit = b.charCodeAt(bSignificant);
        if (aDigit !== bDigit) return aDigit < bDigit ? -1 : 1;
        aSignificant += 1;
        bSignificant += 1;
      }

      // Break equal-value ties immediately, before considering either suffix.
      const aLength = aEnd - aIndex;
      const bLength = bEnd - bIndex;
      if (aLength !== bLength) return aLength < bLength ? -1 : 1;
      aIndex = aEnd;
      bIndex = bEnd;
    } else {
      if (aPoint !== bPoint) return aPoint < bPoint ? -1 : 1;
      // Valid pairs advance together; lone surrogates retain their numeric values.
      const width = aPoint > 0xFFFF ? 2 : 1;
      aIndex += width;
      bIndex += width;
    }
  }

  if (aIndex === a.length && bIndex === b.length) return 0;
  return aIndex === a.length ? -1 : 1;
}
