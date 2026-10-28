/**
 * Convert CRLF pairs and lone CR to LF, preserving all other content.
 * Trailing line endings retain their presence and multiplicity.
 * Non-string inputs are outside this function's contract.
 * @param {string} text
 * @returns {string}
 */
export function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n');
}
