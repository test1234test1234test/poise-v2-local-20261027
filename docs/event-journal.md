# Event journal

`lib/event-journal.mjs` exports `createEventJournal` and `restoreEventJournal`.
This is a synchronous, in-memory Node library. It retains all accepted events
and request receipts; it performs no file/network I/O or background work.

```js
import { createEventJournal, restoreEventJournal } from './lib/event-journal.mjs';

const reduce = (state, event) => state + event.payload;
const journal = createEventJournal({ initialState: 0, reduce });
const events = [{ id: 'e1', type: 'add', payload: 2 }];
const request = { expectedSequence: 0, requestId: 'r1' };

journal.sequence; // 0
journal.append(events, request);
// { requestId: 'r1', fromSequence: 1, toSequence: 1, eventIds: ['e1'] }
journal.read();
// { records: [{ sequence: 1, event: { id: 'e1', type: 'add', payload: 2 } }],
//   next: null }
journal.snapshot(); // { sequence: 1, state: 2 }

const document = journal.export();
const restored = restoreEventJournal(JSON.parse(JSON.stringify(document)), reduce);
restored.append(events, request); // The original receipt, without reducing again.
restored.append([{ id: 'e2', type: 'add', payload: 3 }], {
  expectedSequence: 1, requestId: 'r2',
});
restored.snapshot(); // { sequence: 2, state: 5 }
```

## JSON values and ownership

Accepted values are `null`, primitive booleans and strings, finite primitive
numbers, dense ordinary arrays, and objects whose prototype is this realm's
`Object.prototype` or `null`. Finite fractions and integers outside the safe
integer range are valid **state/payload numbers**. The safe integer restriction
applies separately to sequence and cursor parameters.

Objects must have only own enumerable string **data** properties. Symbol keys,
accessors (even getters returning valid JSON), hidden properties, functions,
`undefined`, BigInt, nonfinite numbers, cycles, custom prototypes, boxed values
and ordinary built-ins such as Date, Map, Set, Promise and typed arrays are
rejected. Validation inspects descriptors without calling getters, `toJSON`,
coercion hooks or constructors. It never freezes or modifies supplied data.

Arrays must have exactly their intrinsic nonenumerable `length` and the own
enumerable data indices `0..length-1`. The `length` property is the sole
exception to the nonenumerability ban. Holes, inherited indices, accessor or
hidden indices, symbols, metadata such as `array.note`, array subclasses and
custom array prototypes are rejected. The prototype must be this realm's
`Array.prototype`. Frozen arrays/objects and readonly enumerable data properties
are valid; writability and configurability are not admission requirements.
These rules also apply to event containers and every export array.

Proxies, including revoked proxies, are rejected before reflection, without
executing traps. Native built-ins recognized by `node:util.types` are rejected
even after prototype replacement (for example, a Date with a null prototype).
Plain-object validation uses these brand, prototype and descriptor checks;
deliberately disguised host objects or other instances whose origins those
checks cannot identify are outside the supported input boundary.

Every accepted value is normalized before a reducer sees it:

- Objects become ordinary `Object.prototype` objects. Arrays become ordinary
  arrays. Data properties become enumerable, writable and configurable.
- Each occurrence of a shared acyclic reference becomes a separate copy.
  Sharing topology and input prototypes/descriptors are not JSON identity.
- Negative zero becomes positive zero, including inside states and payloads.
- Object members are inserted in lexicographic UTF-16 key order. JavaScript's
  integer-index keys still enumerate first, in ascending numeric order. Array
  order is preserved. Thus reducers see consistent member enumeration even
  when equivalent input objects originally used different insertion orders.

Normalization applies to initial state, accepted events, every reducer result,
replay and returned data. No caller/reducer reference points into internal
state, event history or request evidence. Each public return is a new mutable
deep copy, including receipts and their `eventIds` arrays. The journal API
object itself is frozen; its `sequence` getter cannot be assigned or replaced.

Structural equality ignores object key order, allowed input prototypes,
descriptors and sharing topology. It preserves array order/length, member
presence, primitive types and values (after zero normalization). An array is
different from an object with numeric keys, and a missing field differs from a
field containing `null`. Keys such as `__proto__`, `constructor`, `prototype`,
`hasOwnProperty` and `toString` remain literal data without prototype mutation.

## Construction, events and options

`createEventJournal({ initialState, reduce })` requires both fields and no extras.
`initialState` may be any valid JSON value, including a scalar. `reduce` must be
a function; construction does not invoke it. Invalid construction throws
`TypeError`.

Each event has exactly `{ id, type, payload }`. `payload` is any valid JSON
value. `id`, `type` and `requestId` must be nonempty primitive strings unchanged
by ECMAScript `String.prototype.trim()`, with no C0/C1 control code units
(`U+0000..U+001F` and `U+007F..U+009F`) anywhere. Interior whitespace outside
those control ranges is allowed. These restrictions do not apply to payload
strings or object keys, which may be empty or contain whitespace/controls.
IDs are case-sensitive; event IDs and request IDs are separate namespaces.

Construction, append and read options must also be plain or null-prototype
objects containing only the listed own enumerable data fields, with no symbols,
hidden properties, accessors or extras. Custom prototypes/inherited option
fields are rejected; ordinary inherited `Object.prototype` members are ignored.
Options are inspected without invoking getters. Construction deliberately
allows the function-valued `reduce` field rather than treating options as JSON.
Null-prototype event objects and export envelopes are accepted as well.

## Atomic append and retry

`append(events, { expectedSequence, requestId })` requires a dense ordinary array
of **1 through 100** valid events and both option fields. `expectedSequence`
must be a nonnegative safe integer primitive number. Sequences begin at zero
and increase once per accepted event, including when the reducer leaves state
unchanged. The returned receipt contains exactly:

```js
{ requestId: 'r1', fromSequence: 1, toSequence: 2, eventIds: ['e1', 'e2'] }
```

`fromSequence` is the first accepted event's sequence, not the previous cursor;
`toSequence` is the last. `eventIds` follows input order.

Append proceeds in this order:

1. Reject any nested append on this journal with `REENTRANT_APPEND`.
2. Validate and detach the entire batch and capture options before any reducer
   call. An invalid last event prevents reduction of every earlier event.
3. If `requestId` was accepted before, compare the original expected sequence
   and ordered event structure. An exact retry returns a new copy of the
   original receipt without reducing, adding history or recording another
   batch, even after later requests advanced the journal. Different valid input
   throws `REQUEST_CONFLICT`.
4. For a new request, require `expectedSequence === journal.sequence`, or throw
   `SEQUENCE_CONFLICT` with own `expected` (supplied) and `actual` (current) fields.
5. Reject repeated event IDs within the batch or anywhere in accepted history
   with `DUPLICATE_EVENT` and an own `eventId` field naming the duplicate. Check
   `events.length > Number.MAX_SAFE_INTEGER - sequence` for sequence overflow.
6. Reduce candidates in input order, then commit the complete batch, its final
   state, IDs and receipt together.

For each event, `reduce(state, event)` receives independent mutable copies of
the previous candidate state and the captured original event. Its returned
state is validated and copied immediately, before the next call. It may return
its argument, `event.payload`, or any other valid JSON value, including `null`,
`false`, `0` and `''`. Changing its event argument cannot change stored events or
receipt IDs. Later mutations of retained arguments/results cannot change the
journal or a subsequent candidate.

Any thrown reducer value propagates **unchanged**, including primitive values
and frozen Error objects. Invalid results, including `undefined` or a Promise,
throw `TypeError`. No accepted prefix, state, event-ID reservation or request
receipt survives a failed batch. Reuse the failed request ID and proposed event
IDs in a subsequent valid attempt. This rollback covers journal data; it cannot
undo external effects performed by a reducer or direct mutations the reducer
makes through its own captured caller references.

The write guard rejects **all** same-journal nested appends, including valid
retries and malformed calls. A reducer may catch that rejection and allow its
outer append to finish. Otherwise it propagates and rolls back the outer batch.
The guard remains active until the outer append exits, and is released after
success or any failure. During reduction, `sequence`, `read`, `snapshot` and
`export` see only the last committed version. Writes to a different journal
are allowed.

## Reads and snapshots

`read({ after = 0, limit = 100 } = {})` returns exactly
`{ records: [{ sequence, event }], next }`. `after` is an exclusive nonnegative
safe integer cursor; `limit` is an integer from 1 through 100. Omitted or
`undefined` read fields use their defaults. Records are in increasing sequence
order. `next` is the last returned sequence **only when more records remain**;
otherwise it is `null`, even for an exactly full terminal page. An empty journal
or a cursor at/past the end returns `{ records: [], next: null }`.

`snapshot()` returns exactly `{ sequence, state }`, copied from the last
committed version. Neither reads nor snapshots invoke the reducer, modify
history, or compact it.

## Export schema and validated replay

`export()` returns an independent JSON document with this exact version-1 schema:

```json
{
  "formatVersion": 1,
  "initialState": 0,
  "batches": [
    {
      "requestId": "r1",
      "expectedSequence": 0,
      "events": [{ "id": "e1", "type": "add", "payload": 2 }]
    }
  ],
  "snapshot": { "sequence": 1, "state": 2 }
}
```

The root has exactly `formatVersion`, `initialState`, `batches` and `snapshot`.
Each batch has exactly `requestId`, `expectedSequence` and `events`; each event
has exactly `id`, `type` and `payload`; the snapshot has exactly `sequence` and
`state`. All are required. `initialState` is the original normalized starting
state. `batches` contains exactly the accepted new requests in order, with their
original expected sequences and events; retries are not extra rows. An empty
journal has `batches: []` and a sequence-zero snapshot matching its initial state.
State/payload objects have arbitrary valid data members, not envelope schemas.

`restoreEventJournal(document, reduce)` first validates and detaches the **whole**
document, including all JSON values and every envelope, before reducing. It
then preflights request-row uniqueness, event-ID uniqueness, contiguous expected
sequences, overflow and final sequence. A repeated request row is rejected even
when identical to a previous row: it cannot be silently interpreted as a retry.
These input-only failures make zero reducer calls, including a malformed final
batch following valid earlier batches.

Restore constructs a new journal from the supplied initial state and replays
each batch through `append`. It compares the replayed final snapshot with the
supplied snapshot by JSON structural equality. A structurally valid but wrong
final **state** is detected after replay; reducer calls can therefore occur
before that rejection. Restore never overwrites the replayed state from the
snapshot. Reducer failures propagate as during append. The source document and
its descriptors remain unchanged even if reducers mutate arguments or throw.
After successful restore, original retry receipts work without another reducer
call and new appends can use the restored sequence.

Replay requires the same deterministic reduction semantics over normalized JSON
values. Canonical member order handles equivalent input insertion orders;
randomness, time, external mutable state or other external dependencies can
still produce a final-state mismatch. Exports are not signed or authenticated:
replay checks internal consistency, not who produced the history. Storage grows
with accepted history; there is no persistence adapter or compaction policy.

## Error classification

| Failure | Error |
| --- | --- |
| Invalid JSON, descriptors, schema, identifier or argument type | `TypeError` |
| Numeric append/read parameters outside their specified integer range | `RangeError` |
| Empty or over-100-event batch; sequence overflow | `RangeError` |
| Unsupported export version or mismatched final snapshot | `TypeError` |
| Reused request with different valid input; repeated export request row | `Error` with own `code: 'REQUEST_CONFLICT'` |
| Stale/ahead expected sequence | `Error` with own `code: 'SEQUENCE_CONFLICT'`, `expected`, `actual` |
| Duplicate event ID | `Error` with own `code: 'DUPLICATE_EVENT'`, `eventId` |
| Same-journal nested append | `Error` with own `code: 'REENTRANT_APPEND'` |
| Thrown reducer value | The original value, unchanged |

Nonfinite JSON state/payload numbers are `TypeError`, including invalid reducer
results. `append`/`read` numeric parameters such as `expectedSequence: NaN` are
`RangeError`. Restore first validates the entire document as JSON, so nonfinite
numbers anywhere in that document are `TypeError`; finite but out-of-range
sequence fields are `RangeError`. There is no coercion.

Except for the reentrancy guard, complete append input validation precedes
request comparison. A malformed attempt using an accepted request ID gets its
argument error rather than `REQUEST_CONFLICT`. No priority is promised among
independent malformed fields. Conflict checks and reducer failures leave all
committed data and retry evidence unchanged.

Run the journal tests with `node --test test/event-journal.test.mjs` and the
complete repository suite with `npm test` (the CI `node --test` check on Node 22).
Tests cover public numeric boundaries; the overflow subtraction is inspected
directly because reaching `MAX_SAFE_INTEGER` accepted events is not a practical
public-API fixture. No sequence setter or trusted high-sequence snapshot bypass
is provided to manufacture that test.
