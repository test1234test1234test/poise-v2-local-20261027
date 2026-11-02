import { isWellFormedUnicode } from './well-formed-unicode.mjs';

/** Minimum unit insertion, deletion and substitution cost over Unicode code points. */
export function levenshteinDistance(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    throw new TypeError('left and right must be primitive strings');
  }
  if (!isWellFormedUnicode(left) || !isWellFormedUnicode(right)) {
    throw new TypeError('left and right must be well-formed Unicode strings');
  }
  if (left === right) return 0;

  // UTF-16 length selects a buffer within twice the smaller code-point length.
  // Only this side is materialized; the other string is streamed below.
  const shorterText = left.length <= right.length ? left : right;
  const longerText = left.length <= right.length ? right : left;
  const points = [...shorterText];
  const row = Array.from({ length: points.length + 1 }, (_, index) => index);

  for (const point of longerText) {
    let diagonal = row[0];
    row[0] += 1;
    for (let column = 1; column <= points.length; column += 1) {
      const above = row[column];
      row[column] = Math.min(
        above + 1,
        row[column - 1] + 1,
        diagonal + (points[column - 1] === point ? 0 : 1),
      );
      // Preserve the previous row's value before moving to the next column.
      diagonal = above;
    }
  }

  return row[points.length];
}
