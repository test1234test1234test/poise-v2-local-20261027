import { types } from 'node:util';

// Match stableStringify's plain-record boundary, including disguised brands.
const builtinChecks = [
  types.isAnyArrayBuffer, types.isArrayBufferView, types.isArgumentsObject,
  types.isBoxedPrimitive, types.isDate, types.isExternal, types.isGeneratorObject,
  types.isMap, types.isMapIterator, types.isModuleNamespaceObject,
  types.isNativeError, types.isPromise, types.isRegExp, types.isSet,
  types.isSetIterator, types.isWeakMap, types.isWeakSet,
  types.isKeyObject, types.isCryptoKey,
];

function dataValue(object, key, enumerable = false) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value') ||
      (enumerable && !descriptor.enumerable)) {
    throw new TypeError('Expected an own data property with the required enumerability');
  }
  return descriptor.value;
}

function prepareEdit(edit, length) {
  // Proxy detection precedes all reflection, including for revoked proxies.
  if (edit === null || typeof edit !== 'object' || types.isProxy(edit) || Array.isArray(edit)) {
    throw new TypeError('Each edit must be a plain or null-prototype object');
  }
  const prototype = Object.getPrototypeOf(edit);
  if ((prototype !== Object.prototype && prototype !== null) ||
      builtinChecks.some(check => check(edit))) {
    throw new TypeError('Each edit must be a plain or null-prototype object');
  }
  if (Reflect.ownKeys(edit).length !== 3) {
    throw new TypeError('Each edit must have exactly start, end and text');
  }
  const start = dataValue(edit, 'start', true);
  const end = dataValue(edit, 'end', true);
  const text = dataValue(edit, 'text', true);
  if (typeof start !== 'number' || typeof end !== 'number' || typeof text !== 'string') {
    throw new TypeError('Edit coordinates must be numbers and replacement text a primitive string');
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || start > end || end > length) {
    throw new RangeError('Edit coordinates must be safe integers within the original text');
  }
  return { start, end, text };
}

/** Apply a fully validated batch at original UTF-16 offsets without input writes. */
export function applyTextEdits(text, edits) {
  if (typeof text !== 'string') throw new TypeError('text must be a primitive string');
  if (types.isProxy(edits) || !Array.isArray(edits)) {
    throw new TypeError('edits must be an Array');
  }
  const length = dataValue(edits, 'length');
  if (Reflect.ownKeys(edits).length !== length + 1) {
    throw new TypeError('edits must be dense with no extra own properties');
  }
  const sorted = [];
  for (let index = 0; index < length; index++) {
    sorted.push(prepareEdit(dataValue(edits, index), text.length));
  }
  // Native stable sorting preserves input order among equal starts.
  sorted.sort((left, right) => left.start - right.start);

  // Validate whole equal-start groups before rendering anything. Insertions at
  // a replacement's start remain valid even when supplied after that replacement.
  let previousEnd = 0;
  for (let index = 0; index < sorted.length;) {
    const start = sorted[index].start;
    if (start < previousEnd) {
      throw new RangeError('Edits overlap or an insertion lies inside a replacement');
    }
    let end = start;
    do {
      const edit = sorted[index++];
      if (edit.start < edit.end) {
        if (end !== start) throw new RangeError('Nonempty edits with the same start overlap');
        end = edit.end;
      }
    } while (index < sorted.length && sorted[index].start === start);
    previousEnd = end;
  }

  const chunks = [];
  let cursor = 0;
  for (let index = 0; index < sorted.length;) {
    const start = sorted[index].start;
    chunks.push(text.slice(cursor, start));
    let replacement = null;
    do {
      const edit = sorted[index++];
      if (edit.start === edit.end) chunks.push(edit.text);
      else replacement = edit;
    } while (index < sorted.length && sorted[index].start === start);
    if (replacement) chunks.push(replacement.text);
    cursor = replacement ? replacement.end : start;
  }
  chunks.push(text.slice(cursor));
  return chunks.join('');
}
