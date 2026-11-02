import { types } from 'node:util';

// These brands remain unsupported even when their prototypes are replaced.
const builtinChecks = [
  types.isAnyArrayBuffer, types.isArrayBufferView, types.isArgumentsObject,
  types.isBoxedPrimitive, types.isDate, types.isExternal, types.isGeneratorObject,
  types.isMap, types.isMapIterator, types.isModuleNamespaceObject,
  types.isNativeError, types.isPromise, types.isRegExp, types.isSet,
  types.isSetIterator, types.isWeakMap, types.isWeakSet,
  types.isKeyObject, types.isCryptoKey,
];

/** Serialize the restricted JSON data contract in docs/stable-stringify.md. */
export function stableStringify(value) {
  const chunks = [];
  const ancestors = new Set();
  const stack = [];
  let current = value;

  // Explicit traversal frames avoid a JavaScript call-stack depth limit.
  while (true) {
    if (current === null || typeof current === 'boolean' || typeof current === 'string' ||
        (typeof current === 'number' && Number.isFinite(current))) {
      // Native JSON supplies only primitive spelling/escaping, never traversal.
      chunks.push(JSON.stringify(current));
    } else {
      // Check proxies before Array.isArray or any reflection (also when revoked).
      if (typeof current !== 'object' || types.isProxy(current)) {
        throw new TypeError('Unsupported JSON value');
      }
      if (ancestors.has(current)) throw new TypeError('Cyclic JSON value');

      const array = Array.isArray(current);
      let keys = null;
      let length;
      if (array) {
        length = Object.getOwnPropertyDescriptor(current, 'length').value;
        for (const key of Object.keys(current)) {
          if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
            throw new TypeError('Arrays cannot have enumerable string metadata');
          }
        }
      } else {
        const prototype = Object.getPrototypeOf(current);
        if ((prototype !== Object.prototype && prototype !== null) ||
            builtinChecks.some(check => check(current))) {
          throw new TypeError('Expected a plain or null-prototype object');
        }
        // Sort raw keys, then emit members directly: JSON.stringify on a sorted
        // clone would reorder integer-index keys numerically and consult hooks.
        keys = Object.keys(current).sort();
        length = keys.length;
      }
      chunks.push(array ? '[' : '{');
      ancestors.add(current);
      stack.push({ value: current, keys, length, index: 0 });
    }

    // Close completed containers, or descend into the next own data property.
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.index === frame.length) {
        chunks.push(frame.keys === null ? ']' : '}');
        ancestors.delete(frame.value);
        stack.pop();
        continue;
      }
      const index = frame.index++;
      const key = frame.keys === null ? String(index) : frame.keys[index];
      const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Expected an own data property; holes and accessors are unsupported');
      }
      if (index > 0) chunks.push(',');
      if (frame.keys !== null) chunks.push(JSON.stringify(key), ':');
      current = descriptor.value;
      break;
    }
    if (stack.length === 0) return chunks.join('');
  }
}
