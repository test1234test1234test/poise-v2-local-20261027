const entities = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a primitive string');
  }

  return text.replace(/[&<>"']/g, character => entities[character]);
}
