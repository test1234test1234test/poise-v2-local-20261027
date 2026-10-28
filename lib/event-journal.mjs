import { types } from 'node:util';

// Brand checks also reject these built-ins after their prototypes are replaced.
const builtinChecks = [
  types.isAnyArrayBuffer, types.isArrayBufferView, types.isArgumentsObject,
  types.isBoxedPrimitive, types.isDate, types.isExternal, types.isGeneratorObject,
  types.isMap, types.isMapIterator, types.isModuleNamespaceObject,
  types.isNativeError, types.isPromise, types.isRegExp, types.isSet,
  types.isSetIterator, types.isWeakMap, types.isWeakSet,
  types.isKeyObject, types.isCryptoKey,
];

function put(object, key, value) {
  Object.defineProperty(object, key, {
    value, enumerable: true, configurable: true, writable: true,
  });
}

function dataEntries(value, array = false) {
  // Reject proxies before any reflection can execute their traps.
  if (value === null || typeof value !== 'object' || types.isProxy(value)) {
    throw new TypeError('Expected an ordinary JSON container');
  }
  const prototype = Object.getPrototypeOf(value);
  if (array ? !Array.isArray(value) || prototype !== Array.prototype
    : Array.isArray(value) || (prototype !== Object.prototype && prototype !== null) ||
      builtinChecks.some(check => check(value))) {
    throw new TypeError('Expected an ordinary array or plain object');
  }
  const keys = Reflect.ownKeys(value);
  const length = array ? Object.getOwnPropertyDescriptor(value, 'length').value : 0;
  if (array && keys.length !== length + 1) {
    throw new TypeError('Arrays must be dense and have no metadata');
  }
  const entries = [];
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Only enumerable string data properties are allowed');
    }
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) {
      throw new TypeError('Arrays cannot have extra properties');
    }
    entries.push([key, descriptor.value]);
  }
  // Canonical member order makes even enumeration-sensitive reducers replayable.
  if (!array) entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return entries;
}

// Track ancestors, not all visited objects: shared acyclic references become
// separate mutable copies, just as they do across a JSON text round trip.
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
      put(task.parent, task.key, current === 0 ? 0 : current);
      continue;
    }
    if (typeof current !== 'object' || types.isProxy(current)) {
      throw new TypeError('Invalid JSON value');
    }
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

function fields(value, allowed, required = allowed) {
  const entries = new Map(dataEntries(value));
  if ([...entries.keys()].some(key => !allowed.includes(key)) ||
      required.some(key => !entries.has(key))) {
    throw new TypeError(`Expected fields: ${allowed.join(', ')}`);
  }
  return entries;
}

function identifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
      /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new TypeError('Identifiers must be nonempty, trimmed strings without controls');
  }
  return value;
}

function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} through ${max}`);
  }
  return value === 0 ? 0 : value;
}

function validateBatch(batch) {
  identifier(batch.requestId);
  integer(batch.expectedSequence, 'expectedSequence');
  if (!Array.isArray(batch.events)) throw new TypeError('events must be an array');
  if (batch.events.length < 1 || batch.events.length > 100) {
    throw new RangeError('A batch must contain 1 through 100 events');
  }
  for (const event of batch.events) {
    fields(event, ['id', 'type', 'payload']);
    identifier(event.id);
    identifier(event.type);
  }
}

// Only called with validated, normalized JSON values.
function equalJson(left, right) {
  const pending = [[left, right]];
  while (pending.length) {
    const [a, b] = pending.pop();
    if (a === b) continue;
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

function conflict(code, message, details = {}) {
  return Object.assign(new Error(message), { code }, details);
}

function checkAdmission(batch, sequence, eventIds) {
  if (batch.expectedSequence !== sequence) {
    throw conflict('SEQUENCE_CONFLICT', 'expectedSequence does not match the journal', {
      expected: batch.expectedSequence, actual: sequence,
    });
  }
  const pendingIds = new Set();
  for (const event of batch.events) {
    if (eventIds.has(event.id) || pendingIds.has(event.id)) {
      throw conflict('DUPLICATE_EVENT', 'Event id has already been used', { eventId: event.id });
    }
    pendingIds.add(event.id);
  }
  // Subtract before adding: never calculate an imprecise candidate sequence.
  if (batch.events.length > Number.MAX_SAFE_INTEGER - sequence) {
    throw new RangeError('Journal sequence would overflow');
  }
}

/** Create a synchronous, atomic journal of normalized JSON events. */
export function createEventJournal(options) {
  const config = fields(options, ['initialState', 'reduce']);
  const reduce = config.get('reduce');
  if (typeof reduce !== 'function') throw new TypeError('reduce must be a function');
  const initialState = cloneJson(config.get('initialState'));
  let state = cloneJson(initialState);
  let sequence = 0;
  let writing = false;
  const records = [];
  const batches = [];
  const eventIds = new Set();
  const requests = new Map();

  return Object.freeze({
    get sequence() { return sequence; },

    append(events, options) {
      // This rejection sits outside the finally block so a nested caller cannot
      // release the outer write guard, even if the reducer catches the error.
      if (writing) throw conflict('REENTRANT_APPEND', 'Cannot append during reduction');
      writing = true;
      try {
        const input = fields(options, ['expectedSequence', 'requestId']);
        const batch = {
          expectedSequence: integer(input.get('expectedSequence'), 'expectedSequence'),
          requestId: identifier(input.get('requestId')),
          events: cloneJson(events),
        };
        validateBatch(batch);
        const previous = requests.get(batch.requestId);
        if (previous) {
          if (!equalJson(batch, previous.batch)) {
            throw conflict('REQUEST_CONFLICT', 'requestId was accepted with different input');
          }
          return cloneJson(previous.receipt);
        }
        checkAdmission(batch, sequence, eventIds);

        let candidate = state;
        for (const event of batch.events) {
          candidate = cloneJson(reduce(cloneJson(candidate), cloneJson(event)));
        }
        const receipt = {
          requestId: batch.requestId,
          fromSequence: sequence + 1,
          toSequence: sequence + batch.events.length,
          eventIds: batch.events.map(event => event.id),
        };
        const result = cloneJson(receipt);
        // All validation and user callbacks have finished; publish the batch.
        for (const event of batch.events) {
          records.push({ sequence: ++sequence, event });
          eventIds.add(event.id);
        }
        state = candidate;
        batches.push(batch);
        requests.set(batch.requestId, { batch, receipt });
        return result;
      } finally {
        writing = false;
      }
    },

    read(options = {}) {
      const input = fields(options, ['after', 'limit'], []);
      const after = integer(input.get('after') === undefined ? 0 : input.get('after'), 'after');
      const limit = integer(input.get('limit') === undefined ? 100 : input.get('limit'), 'limit', 1, 100);
      // Clamp before addition so a cursor at MAX_SAFE_INTEGER stays exact.
      const start = Math.min(after, sequence);
      const end = start + Math.min(limit, sequence - start);
      return cloneJson({ records: records.slice(start, end), next: end < sequence ? end : null });
    },

    snapshot() {
      return cloneJson({ sequence, state });
    },

    export() {
      return cloneJson({ formatVersion: 1, initialState, batches, snapshot: { sequence, state } });
    },
  });
}

/** Validate the entire document, then reconstruct authority by replaying it. */
export function restoreEventJournal(document, reduce) {
  if (typeof reduce !== 'function') throw new TypeError('reduce must be a function');
  const source = cloneJson(document);
  fields(source, ['formatVersion', 'initialState', 'batches', 'snapshot']);
  if (source.formatVersion !== 1) throw new TypeError('Unsupported journal formatVersion');
  if (!Array.isArray(source.batches)) throw new TypeError('batches must be an array');
  fields(source.snapshot, ['sequence', 'state']);
  integer(source.snapshot.sequence, 'snapshot.sequence');
  for (const batch of source.batches) {
    fields(batch, ['requestId', 'expectedSequence', 'events']);
    validateBatch(batch);
  }

  // Input-only integrity checks cover all rows before any reducer runs. An
  // identical repeated request row is corruption, not an append retry.
  const requests = new Set();
  const eventIds = new Set();
  let sequence = 0;
  for (const batch of source.batches) {
    if (requests.has(batch.requestId)) {
      throw conflict('REQUEST_CONFLICT', 'Export contains a repeated requestId');
    }
    checkAdmission(batch, sequence, eventIds);
    requests.add(batch.requestId);
    for (const event of batch.events) eventIds.add(event.id);
    sequence += batch.events.length;
  }
  if (source.snapshot.sequence !== sequence) {
    throw new TypeError('Snapshot sequence does not match the accepted history');
  }

  const journal = createEventJournal({ initialState: source.initialState, reduce });
  for (const batch of source.batches) {
    journal.append(batch.events, {
      requestId: batch.requestId, expectedSequence: batch.expectedSequence,
    });
  }
  if (!equalJson(journal.snapshot(), source.snapshot)) {
    throw new TypeError('Snapshot state does not match replayed history');
  }
  return journal;
}
