/**
 * Count lines separated by LF or CRLF, preserving blank lines.
 * Empty text has no lines; a final terminator adds no extra empty line.
 * Lone CR and Unicode line separators are ordinary content.
 * @param {string} text
 * @returns {number}
 */
export function countLines(text) {
  let lines = 0;
  for (let index = 0; index < text.length; index += 1) {
    // Every supported terminator contains exactly one LF.
    if (text[index] === '\n') lines += 1;
  }
  if (text.length > 0 && !text.endsWith('\n')) lines += 1;
  return lines;
}
