// Define data properties explicitly: even __proto__ is just a JSON member.
function put(object, key, value) {
  Object.defineProperty(object, key, {
    value, enumerable: true, configurable: true, writable: true,
  });
}

function dataEntries(object, array = false) {
  if (object === null || typeof object !== 'object') {
    throw new TypeError('Expected a JSON object');
  }
  if (!array) {
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Expected a plain or null-prototype object');
    }
  }
  const keys = Reflect.ownKeys(object);
  const length = array ? Object.getOwnPropertyDescriptor(object, 'length').value : 0;
  if (array && keys.length !== length + 1) {
    throw new TypeError('Arrays must be dense and have no extra properties');
  }
  const entries = [];
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Only own string data properties are allowed');
    }
    if (array) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
        throw new TypeError('Arrays cannot have extra properties');
      }
    } else if (!descriptor.enumerable) {
      throw new TypeError('Object properties must be enumerable');
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

// Validate and clone together, using only descriptors. Track ancestors, not all
// seen objects: repeated references are valid and get separate output copies.
function cloneJson(value) {
  const holder = {};
  const ancestors = new Set();
  const pending = [{ parent: holder, key: 'value', value }];
  while (pending.length) {
    const task = pending.pop();
    if (task.exit) {
      ancestors.delete(task.exit);
      continue;
    }
    const current = task.value;
    if (current === null || typeof current === 'boolean' || typeof current === 'string' ||
        (typeof current === 'number' && Number.isFinite(current))) {
      put(task.parent, task.key, current);
      continue;
    }
    if (typeof current !== 'object') throw new TypeError('Invalid JSON value');
    if (ancestors.has(current)) throw new TypeError('Cyclic JSON value');
    const array = Array.isArray(current);
    const entries = dataEntries(current, array);
    const copy = array ? [] : {};
    put(task.parent, task.key, copy);
    ancestors.add(current);
    pending.push({ exit: current });
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, child] = entries[i];
      pending.push({ parent: copy, key, value: child });
    }
  }
  return holder.value;
}

function parsePointer(path) {
  if (typeof path !== 'string') throw new TypeError('Pointers must be strings');
  if (path === '') return [];
  if (!path.startsWith('/')) throw new SyntaxError('A nonroot pointer must start with /');
  return path.slice(1).split('/').map(token => {
    if (/~(?:[^01]|$)/.test(token)) throw new SyntaxError('Invalid pointer escape');
    return token.replace(/~[01]/g, escape => escape === '~0' ? '~' : '/');
  });
}

function prepareOperations(operations) {
  if (!Array.isArray(operations)) throw new TypeError('Operations must be an Array');
  return dataEntries(operations, true).map(([, operation], operationIndex) => {
    try {
      const fields = new Map(dataEntries(operation));
      const op = fields.get('op');
      let keys;
      switch (op) {
        case 'add': case 'replace': case 'test': keys = ['op', 'path', 'value']; break;
        case 'copy': case 'move': keys = ['op', 'path', 'from']; break;
        case 'remove': keys = ['op', 'path']; break;
        default: throw new TypeError('Unsupported patch operation');
      }
      if (fields.size !== keys.length || keys.some(key => !fields.has(key))) {
        throw new TypeError('Operation must contain exactly its permitted keys');
      }
      const prepared = { op, path: parsePointer(fields.get('path')) };
      if (fields.has('from')) prepared.from = parsePointer(fields.get('from'));
      if (fields.has('value')) prepared.value = cloneJson(fields.get('value'));
      return prepared;
    } catch (error) {
      error.operationIndex = operationIndex;
      throw error;
    }
  });
}

function arrayIndex(token) {
  if (!/^(0|[1-9][0-9]*)$/.test(token) || !Number.isSafeInteger(Number(token))) {
    throw new RangeError('Array index must be a canonical safe nonnegative integer');
  }
  return Number(token);
}

function testFailure() {
  const error = new Error('Patch test target is missing or unequal');
  error.name = 'PatchTestError';
  return error;
}

function member(container, token, testing = false) {
  if (container === null || typeof container !== 'object') {
    throw new RangeError('Cannot traverse a scalar');
  }
  const key = Array.isArray(container) ? arrayIndex(token) : token;
  if (!Object.hasOwn(container, key)) {
    throw testing ? testFailure() : new RangeError('Target does not exist');
  }
  return container[key];
}

function lookup(document, tokens, testing = false) {
  let value = document;
  for (let i = 0; i < tokens.length; i++) {
    value = member(value, tokens[i], testing && i === tokens.length - 1);
  }
  return value;
}

function edit(document, tokens, op, value) {
  if (tokens.length === 0) {
    if (op === 'remove') throw new RangeError('Cannot remove the root');
    return value;
  }
  const parent = lookup(document, tokens.slice(0, -1));
  if (parent === null || typeof parent !== 'object') {
    throw new RangeError('Cannot edit a scalar parent');
  }
  const token = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    const index = token === '-' && op === 'add' ? parent.length : arrayIndex(token);
    if (index > parent.length || (op !== 'add' && index === parent.length)) {
      throw new RangeError('Array index is out of bounds');
    }
    if (op === 'add') parent.splice(index, 0, value);
    else if (op === 'remove') parent.splice(index, 1);
    else parent[index] = value;
  } else {
    if (op !== 'add' && !Object.hasOwn(parent, token)) {
      throw new RangeError('Target does not exist');
    }
    if (op === 'remove') delete parent[token];
    else put(parent, token, value);
  }
  return document;
}

function equalJson(left, right) {
  const pending = [[left, right]];
  while (pending.length) {
    const [a, b] = pending.pop();
    if (a === b) continue; // JSON numeric equality includes -0 === 0.
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' ||
        Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false;
      pending.push([a[key], b[key]]);
    }
  }
  return true;
}

/** Apply all operations transactionally, returning an independent JSON value. */
export function applyPatch(document, operations) {
  let working = cloneJson(document);
  // Every payload is validated/copied before the first operation executes.
  const prepared = prepareOperations(operations);
  for (let operationIndex = 0; operationIndex < prepared.length; operationIndex++) {
    const { op, path, from, value } = prepared[operationIndex];
    try {
      switch (op) {
        case 'add': case 'remove': case 'replace':
          working = edit(working, path, op, value);
          break;
        case 'test':
          if (!equalJson(lookup(working, path, true), value)) throw testFailure();
          break;
        case 'copy':
          working = edit(working, path, 'add', cloneJson(lookup(working, from)));
          break;
        case 'move': {
          const source = lookup(working, from);
          const prefix = from.every((token, i) => token === path[i]);
          if (prefix && from.length === path.length) break;
          if (prefix && from.length < path.length) {
            throw new RangeError('Cannot move a parent into its descendant');
          }
          working = edit(working, from, 'remove');
          working = edit(working, path, 'add', source);
          break;
        }
      }
    } catch (error) {
      error.operationIndex = operationIndex;
      throw error;
    }
  }
  return working;
}
