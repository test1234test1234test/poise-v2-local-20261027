import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createAsyncChannel } from '../lib/async-channel.mjs';

const listeners = signal => getEventListeners(signal, 'abort');
const checkpoint = () => new Promise(resolve => setImmediate(resolve));
const eof = { value: undefined, done: true };

// Observe rejections before triggering cancellation/close, without assimilating
// either rejection reasons or payloads inside receive results.
function observe(promise) {
  assert.ok(promise instanceof Promise);
  const state = { status: 'pending' };
  state.done = promise.then(
    value => { state.status = 'fulfilled'; state.value = value; },
    reason => { state.status = 'rejected'; state.reason = reason; },
  );
  return state;
}

async function fulfilled(state, value) {
  await state.done;
  assert.equal(state.status, 'fulfilled');
  assert.deepEqual(state.value, value);
}

async function rejected(state, reason) {
  await state.done;
  assert.equal(state.status, 'rejected');
  assert.ok(Object.is(state.reason, reason));
}

async function rejectedClosed(state) {
  await state.done;
  assert.equal(state.status, 'rejected');
  assert.ok(state.reason instanceof Error);
  assert.equal(state.reason.code, 'CHANNEL_CLOSED');
}

function received(result, value) {
  assert.equal(result.done, false);
  assert.ok(Object.is(result.value, value));
}

// Timeouts only diagnose hangs. All progress is driven by public operations.
describe('createAsyncChannel', { timeout: 15_000 }, () => {
  it('requires a positive safe-integer capacity without coercion or eager allocation', async () => {
    const coercible = { valueOf() { assert.fail('capacity coercion'); } };
    for (const capacity of [undefined, null, false, true, '1', 1n, Symbol(), {}, [],
      new Number(1), () => 1, coercible, 0, -0, -1, 0.5, NaN, Infinity, -Infinity,
      Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => createAsyncChannel(capacity), TypeError);
    }
    for (const capacity of [1, 3, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
      const channel = createAsyncChannel(capacity);
      assert.equal(channel.size, 0);
      assert.equal(channel.closed, false);
      const send = channel.send(undefined);
      assert.equal(channel.size, 1);
      assert.equal(await send, undefined);
      received(await channel.receive(), undefined);
      assert.equal(channel.size, 0);
      assert.equal(channel.close(), true);
      assert.deepEqual(await channel.receive(), eof);
    }
  });

  it('exposes getter-only state and isolates independent channels', async () => {
    const one = createAsyncChannel(1), two = createAsyncChannel(2);
    for (const name of ['size', 'closed']) {
      const descriptor = Object.getOwnPropertyDescriptor(one, name);
      assert.equal(typeof descriptor.get, 'function');
      assert.equal(descriptor.set, undefined);
      assert.throws(() => { one[name] = 99; }, TypeError);
    }
    assert.equal(Symbol.asyncIterator in one, false);
    assert.equal(one.size, 0);
    assert.equal(one.closed, false);
    await one.send('one');
    await two.send('two');
    one.close();
    assert.equal(two.closed, false);
    received(await two.receive(), 'two');
    assert.equal(one.size, 1);
    received(await one.receive(), 'one');
    await two.send('reused');
    received(await two.receive(), 'reused');
    two.close();
  });

  for (const capacity of [1, 3]) {
    it(`backpressures sends and refills synchronously in FIFO order at capacity ${capacity}`, async () => {
      const channel = createAsyncChannel(capacity);
      for (let i = 0; i < capacity; i++) await channel.send(i);
      const b = observe(channel.send('B')), c = observe(channel.send('C'));
      assert.equal(channel.size, capacity);
      await checkpoint();
      assert.equal(b.status, 'pending');
      assert.equal(c.status, 'pending');
      const first = channel.receive();
      assert.equal(channel.size, capacity);
      const d = observe(channel.send('D'));
      received(await first, 0);
      await fulfilled(b, undefined);
      assert.equal(c.status, 'pending');
      for (const value of [...Array.from({ length: capacity - 1 }, (_, i) => i + 1), 'B', 'C', 'D']) {
        received(await channel.receive(), value);
      }
      await fulfilled(c, undefined);
      await fulfilled(d, undefined);
      assert.equal(channel.size, 0);
      channel.close();
    });

    it(`supports independent concurrent producers and consumers at capacity ${capacity}`, async () => {
      const channel = createAsyncChannel(capacity);
      const sent = [], results = [];
      async function produce(producer) {
        for (let index = 0; index < 30; index++) {
          const value = { producer, index };
          sent.push(value);
          assert.equal(await channel.send(value), undefined);
          assert.ok(channel.size <= capacity);
        }
      }
      async function consume() {
        while (true) {
          // Compare receive invocation order, not downstream processing order
          // or the relative ordering of producer and consumer continuations.
          const slot = results.length;
          results.push(undefined);
          const result = await channel.receive();
          results[slot] = result;
          if (result.done) return;
          await Promise.resolve();
        }
      }
      const producers = [0, 1, 2].map(produce);
      const consumers = [consume(), consume(), consume(), consume()];
      await Promise.all(producers);
      channel.close();
      await Promise.all(consumers);
      const values = results.filter(result => !result.done).map(result => result.value);
      assert.equal(values.length, 90);
      values.forEach((value, index) => assert.equal(value, sent[index]));
      assert.equal(channel.size, 0);
      assert.deepEqual(await channel.receive(), eof);
    });
  }

  for (const delivery of ['buffered', 'blocked', 'direct']) {
    it(`preserves every payload and repeated occurrences during ${delivery} delivery`, async () => {
      const shared = { changed: false }, cyclic = {};
      cyclic.self = cyclic;
      let thenReads = 0;
      const thenable = { get then() { thenReads++; throw new Error('payload inspected'); } };
      const payloads = [undefined, null, false, true, '', 0, -0, NaN, Infinity, 1n,
        Symbol('payload'), () => {}, shared, shared, cyclic, Object.freeze({ frozen: true }),
        new Promise(() => {}), thenable];
      const channel = createAsyncChannel(1);
      for (const value of payloads) {
        if (delivery === 'blocked') await channel.send('predecessor');
        const pending = delivery === 'direct' ? channel.receive() : undefined;
        const sent = channel.send(value);
        shared.changed = true;
        if (delivery === 'blocked') received(await channel.receive(), 'predecessor');
        assert.equal(await sent, undefined);
        const result = await (pending ?? channel.receive());
        received(result, value);
        if (value === shared) assert.equal(result.value.changed, true);
      }
      assert.equal(thenReads, 0);
      channel.close();
      assert.deepEqual(await channel.receive(), eof);
    });
  }

  for (const phase of ['empty', 'full', 'receiver-waiting', 'closed-empty', 'closed-buffered']) {
    it(`rejects invalid arguments as Promises without mutation while ${phase}`, async () => {
      const channel = createAsyncChannel(1);
      const controller = new AbortController(), external = () => {};
      controller.signal.addEventListener('abort', external);
      const signal = controller.signal;
      if (phase === 'full' || phase === 'closed-buffered') await channel.send('accepted');
      const older = phase === 'full' ? observe(channel.send('older', { signal })) :
        phase === 'receiver-waiting' ? observe(channel.receive({ signal })) : undefined;
      if (phase.startsWith('closed')) channel.close();
      const before = [channel.size, channel.closed], subscriptions = listeners(signal);
      const revoked = Proxy.revocable(signal, {});
      revoked.revoke();
      const invalid = [null, [], true, 0, 'options', 1n, Symbol(), () => {},
        ...[null, false, 1, 'signal', {}, [], () => {},
          { aborted: false, addEventListener() {}, removeEventListener() {} },
          AbortSignal.prototype, Object.create(AbortSignal.prototype), Object.create(signal),
          new Proxy(signal, {}), revoked.proxy].map(signal => ({ signal }))];
      for (const options of invalid) {
        for (const call of [() => channel.send('invalid', options), () => channel.receive(options)]) {
          let promise;
          assert.doesNotThrow(() => { promise = call(); });
          const state = observe(promise);
          assert.deepEqual([channel.size, channel.closed], before);
          assert.deepEqual(listeners(signal), subscriptions);
          await state.done;
          assert.equal(state.status, 'rejected');
          assert.ok(state.reason instanceof TypeError);
          if (older) assert.equal(older.status, 'pending');
        }
      }
      const failure = { getter: true };
      for (const method of ['send', 'receive']) {
        let reads = 0;
        const options = { get signal() { reads++; throw failure; } };
        await rejected(observe(method === 'send' ? channel.send('invalid', options) : channel.receive(options)), failure);
        assert.equal(reads, 1);
        assert.deepEqual([channel.size, channel.closed], before);
      }
      if (phase === 'receiver-waiting') {
        await channel.send('live');
        await fulfilled(older, { value: 'live', done: false });
      }
      if (phase === 'full' || phase === 'closed-buffered') received(await channel.receive(), 'accepted');
      if (phase === 'full') {
        await fulfilled(older, undefined);
        received(await channel.receive(), 'older');
      }
      channel.close();
      assert.deepEqual(await channel.receive(), eof);
      assert.deepEqual(listeners(signal), [external]);
    });
  }

  it('accepts optional, inherited and null-prototype options and ignores unrelated keys', async () => {
    const channel = createAsyncChannel(1), controller = new AbortController();
    class Options { constructor() { this.signal = controller.signal; } }
    let reads = 0;
    const options = [undefined, {}, { signal: undefined }, new Options(),
      Object.assign(Object.create(null), { signal: controller.signal }),
      Object.create({ get signal() { reads++; return controller.signal; } }),
      { signal: controller.signal, extra: 1, [Symbol()]: 2 },
      { get unrelated() { assert.fail('unrelated option read'); } },
      { signal: AbortSignal.any([controller.signal]) }];
    for (const option of options) {
      assert.equal(await channel.send('value', option), undefined);
      received(await channel.receive(option), 'value');
    }
    assert.equal(reads, 2);
    assert.deepEqual(listeners(controller.signal), []);
    const composed = AbortSignal.any([controller.signal]);
    const pending = observe(channel.receive({ signal: composed }));
    controller.abort('composed');
    await rejected(pending, 'composed');
    assert.deepEqual(listeners(composed), []);
    channel.close();
  });

  for (const closed of [false, true]) {
    for (const buffered of [false, true]) {
      it(`honors pre-abort before closure (closed=${closed}, buffered=${buffered})`, async () => {
        const channel = createAsyncChannel(1);
        if (buffered) await channel.send('accepted');
        if (closed) channel.close();
        for (const reason of [undefined, null, false, 0, -0, NaN, '', Symbol(), { abort: true }]) {
          const controller = new AbortController(), external = () => {};
          controller.signal.addEventListener('abort', external);
          controller.abort(reason);
          for (const promise of [channel.send('rejected', { signal: controller.signal }),
            channel.receive({ signal: controller.signal })]) {
            await rejected(observe(promise), controller.signal.reason);
          }
          assert.equal(channel.size, buffered ? 1 : 0);
          assert.deepEqual(listeners(controller.signal), [external]);
        }
        const signal = new AbortController().signal;
        if (closed) await rejectedClosed(observe(channel.send('closed', { signal })));
        if (buffered) received(await channel.receive({ signal }), 'accepted');
        if (!closed) {
          await channel.send('live', { signal });
          received(await channel.receive({ signal }), 'live');
          channel.close();
        }
        assert.deepEqual(await channel.receive({ signal }), eof);
        assert.deepEqual(listeners(signal), []);
      });
    }
  }

  it('preserves exact queued abort reasons across both directions and keeps caller listeners', async () => {
    for (const reason of [undefined, null, false, 0, -0, NaN, '', Symbol(), { abort: true }]) {
      const full = createAsyncChannel(1), empty = createAsyncChannel(1);
      const controller = new AbortController(), external = () => {};
      controller.signal.addEventListener('abort', external);
      const options = { signal: controller.signal };
      await full.send('accepted', options);
      assert.deepEqual(listeners(controller.signal), [external]);
      const send = observe(full.send('canceled', options));
      const receive = observe(empty.receive(options));
      controller.abort(reason);
      await rejected(send, controller.signal.reason);
      await rejected(receive, controller.signal.reason);
      assert.deepEqual(listeners(controller.signal), [external]);
      received(await full.receive(), 'accepted');
      await empty.send('available');
      received(await empty.receive(), 'available');
      full.close();
      empty.close();
      assert.deepEqual(await full.receive(), eof);
    }
  });

  for (const direction of ['send', 'receive']) {
    it(`reads a ${direction} signal getter once and preserves reentrant FIFO order`, async () => {
      const channel = createAsyncChannel(1);
      if (direction === 'send') await channel.send('seed');
      let nested, reads = 0;
      const signal = new AbortController().signal;
      const options = Object.create({ get signal() {
        reads++;
        nested = direction === 'send' ? channel.send('nested') : channel.receive();
        return signal;
      } });
      const outer = direction === 'send' ? channel.send('outer', options) : channel.receive(options);
      assert.equal(reads, 1);
      if (direction === 'send') {
        for (const value of ['seed', 'nested', 'outer']) received(await channel.receive(), value);
        assert.equal(await nested, undefined);
        assert.equal(await outer, undefined);
      } else {
        await channel.send('nested');
        await channel.send('outer');
        received(await nested, 'nested');
        received(await outer, 'outer');
      }
      assert.equal(reads, 1);
      assert.deepEqual(listeners(signal), []);
      channel.close();
    });

    for (const throwing of [false, true]) {
      it(`rechecks close after a ${direction} getter (throwing=${throwing})`, async () => {
        const channel = createAsyncChannel(1), failure = { getter: true };
        const options = { get signal() {
          channel.close();
          if (throwing) throw failure;
          return new AbortController().signal;
        } };
        const state = observe(direction === 'send' ? channel.send('outer', options) : channel.receive(options));
        assert.equal(channel.closed, true);
        assert.equal(channel.size, 0);
        if (throwing) await rejected(state, failure);
        else if (direction === 'send') await rejectedClosed(state);
        else await fulfilled(state, eof);
      });
    }
  }

  it('keeps getter side effects but never admits a failed outer operation', async () => {
    const channel = createAsyncChannel(1), failure = { getter: true };
    let nested;
    const send = observe(channel.send('invalid', { get signal() {
      nested = channel.send('nested');
      throw failure;
    } }));
    assert.equal(channel.size, 1);
    await rejected(send, failure);
    assert.equal(await nested, undefined);
    const receive = observe(channel.receive({ get signal() {
      nested = channel.receive();
      throw failure;
    } }));
    assert.equal(channel.size, 0);
    await rejected(receive, failure);
    received(await nested, 'nested');
    channel.close();
    assert.deepEqual(await channel.receive(), eof);
  });

  for (const direction of ['send', 'receive']) {
    for (const capacity of [1, 3]) {
      for (const cancelled of [[0, 3, 6], [0, 1, 2, 3, 4, 5, 6]]) {
        it(`preserves ${direction} FIFO after canceling ${cancelled} at capacity ${capacity}`, async () => {
          const channel = createAsyncChannel(capacity);
          const seed = Array.from({ length: capacity }, (_, i) => `seed${i}`);
          if (direction === 'send') for (const value of seed) await channel.send(value);
          const controllers = Array.from({ length: 7 }, () => new AbortController());
          const states = controllers.map((controller, i) => observe(direction === 'send' ?
            channel.send(i, { signal: controller.signal }) : channel.receive({ signal: controller.signal })));
          for (const i of cancelled) controllers[i].abort({ i });
          const survivors = states.map((_, i) => i).filter(i => !cancelled.includes(i));
          let newcomer;
          if (direction === 'send') {
            assert.equal(channel.size, capacity);
            const first = channel.receive();
            newcomer = observe(channel.send('new'));
            received(await first, seed[0]);
            for (const value of [...seed.slice(1), ...survivors, 'new']) {
              received(await channel.receive(), value);
            }
            await fulfilled(newcomer, undefined);
          } else {
            const first = channel.send('first');
            newcomer = observe(channel.receive());
            await first;
            const values = ['first', ...survivors.map(i => `next${i}`)];
            for (const value of values.slice(1)) await channel.send(value);
            for (const [index, i] of survivors.entries()) {
              await fulfilled(states[i], { value: values[index], done: false });
            }
            await fulfilled(newcomer, { value: values.at(-1), done: false });
          }
          for (let i = 0; i < states.length; i++) {
            if (cancelled.includes(i)) await rejected(states[i], controllers[i].signal.reason);
            else if (direction === 'send') await fulfilled(states[i], undefined);
            assert.deepEqual(listeners(controllers[i].signal), []);
          }
          assert.equal(channel.size, 0);
          channel.close();
          assert.deepEqual(await channel.receive(), eof);
        });
      }
    }
  }

  for (const action of ['abort', 'close']) {
    for (const first of ['receive', action]) {
      it(`commits refill synchronously: ${first} before ${first === 'receive' ? action : 'receive'}`, async () => {
        const channel = createAsyncChannel(1), controller = new AbortController();
        await channel.send('A');
        const b = observe(channel.send('B', { signal: controller.signal }));
        const act = () => action === 'close' ? channel.close() : controller.abort('aborted');
        let a;
        if (first === 'receive') {
          a = channel.receive();
          assert.equal(channel.size, 1);
          assert.deepEqual(listeners(controller.signal), []);
          act();
        } else {
          act();
          assert.equal(channel.size, 1);
          a = channel.receive();
          assert.equal(channel.size, 0);
        }
        received(await a, 'A');
        if (first === 'receive') {
          await fulfilled(b, undefined);
          received(await channel.receive(), 'B');
        } else if (action === 'abort') await rejected(b, 'aborted');
        else await rejectedClosed(b);
        channel.close();
        assert.deepEqual(await channel.receive(), eof);
        assert.deepEqual(listeners(controller.signal), []);
      });
    }
  }

  for (const delivery of ['buffered', 'direct']) {
    for (const first of ['delivery', 'abort']) {
      it(`${delivery} ownership survives later abort/close, with ${first} first`, async () => {
        const channel = createAsyncChannel(1), sender = new AbortController(), receiver = new AbortController();
        let send, receive;
        if (delivery === 'buffered') {
          send = observe(channel.send('value', { signal: sender.signal }));
          assert.deepEqual(listeners(sender.signal), []);
          sender.abort('too late');
          if (first === 'abort') receiver.abort('canceled');
          receive = observe(channel.receive({ signal: receiver.signal }));
        } else {
          receive = observe(channel.receive({ signal: receiver.signal }));
          if (first === 'abort') receiver.abort('canceled');
          send = observe(channel.send('value', { signal: sender.signal }));
          sender.abort('too late');
        }
        assert.deepEqual(listeners(receiver.signal), []);
        receiver.abort('canceled');
        channel.close();
        await fulfilled(send, undefined);
        if (first === 'abort') {
          await rejected(receive, 'canceled');
          received(await channel.receive(), 'value');
        } else await fulfilled(receive, { value: 'value', done: false });
        assert.deepEqual(await channel.receive(), eof);
      });
    }
  }

  for (const direction of ['send', 'receive']) {
    for (const action of ['handoff', 'close']) {
      it(`checks current ${direction} abort state in an earlier listener's ${action}`, async () => {
        const channel = createAsyncChannel(1), controller = new AbortController();
        if (direction === 'send') await channel.send('A');
        let triggered;
        const external = () => {
          triggered = action === 'close' ? channel.close() :
            direction === 'send' ? channel.receive() : channel.send('X');
        };
        controller.signal.addEventListener('abort', external);
        const canceled = observe(direction === 'send' ? channel.send('B', { signal: controller.signal }) :
          channel.receive({ signal: controller.signal }));
        const live = observe(direction === 'send' ? channel.send('C') : channel.receive());
        const reason = { earlier: true };
        controller.abort(reason);
        await rejected(canceled, reason);
        assert.deepEqual(listeners(controller.signal), [external]);
        if (action === 'close') {
          assert.equal(triggered, true);
          if (direction === 'send') {
            await rejectedClosed(live);
            received(await channel.receive(), 'A');
          } else await fulfilled(live, eof);
        } else if (direction === 'send') {
          received(await triggered, 'A');
          await fulfilled(live, undefined);
          received(await channel.receive(), 'C');
        } else {
          assert.equal(await triggered, undefined);
          await fulfilled(live, { value: 'X', done: false });
        }
        channel.close();
        assert.deepEqual(await channel.receive(), eof);
      });
    }

    it(`cannot suppress queued ${direction} cancellation with stopImmediatePropagation`, async () => {
      const channel = createAsyncChannel(1), controller = new AbortController();
      if (direction === 'send') await channel.send('accepted');
      const external = event => event.stopImmediatePropagation();
      controller.signal.addEventListener('abort', external);
      const state = observe(direction === 'send' ? channel.send('canceled', { signal: controller.signal }) :
        channel.receive({ signal: controller.signal }));
      controller.abort('stopped');
      await rejected(state, 'stopped');
      assert.deepEqual(listeners(controller.signal), [external]);
      if (direction === 'send') received(await channel.receive(), 'accepted');
      await channel.send('live');
      received(await channel.receive(), 'live');
      channel.close();
    });

    for (const ending of ['abort immediately', 'abort after rearm', 'handoff immediately',
      'handoff after rearm', 'close immediately', 'close after rearm']) {
      it(`ignores synthetic ${direction} aborts and handles ${ending} on a shared signal`, async () => {
        const channel = createAsyncChannel(1), controller = new AbortController();
        if (direction === 'send') await channel.send('seed');
        const external = event => event.stopImmediatePropagation();
        controller.signal.addEventListener('abort', external);
        const states = ['B', 'C'].map(value => observe(direction === 'send' ?
          channel.send(value, { signal: controller.signal }) : channel.receive({ signal: controller.signal })));
        const last = observe(direction === 'send' ? channel.send('last') : channel.receive());
        controller.signal.dispatchEvent(new Event('abort'));
        assert.equal(controller.signal.aborted, false);
        if (ending.endsWith('after rearm')) {
          await checkpoint();
          states.forEach(state => assert.equal(state.status, 'pending'));
          assert.equal(listeners(controller.signal).length, 3);
          controller.signal.dispatchEvent(new Event('abort'));
          await checkpoint();
          assert.equal(listeners(controller.signal).length, 3);
        }
        if (ending.startsWith('abort')) {
          controller.abort('real abort');
          for (const state of states) await rejected(state, 'real abort');
          if (direction === 'send') {
            received(await channel.receive(), 'seed');
            received(await channel.receive(), 'last');
            await fulfilled(last, undefined);
          } else {
            await channel.send('last');
            await fulfilled(last, { value: 'last', done: false });
          }
        } else if (ending.startsWith('handoff')) {
          // No await before these transitions: exercise the re-arm gap too.
          if (direction === 'send') {
            const reads = ['seed', 'B', 'C', 'last'].map(() => channel.receive());
            for (const [index, value] of ['seed', 'B', 'C', 'last'].entries()) received(await reads[index], value);
            for (const state of [...states, last]) await fulfilled(state, undefined);
          } else {
            const sends = ['B', 'C', 'last'].map(value => channel.send(value));
            await Promise.all(sends);
            for (const [index, state] of [...states, last].entries()) {
              await fulfilled(state, { value: ['B', 'C', 'last'][index], done: false });
            }
          }
        } else {
          channel.close();
          if (direction === 'send') {
            for (const state of [...states, last]) await rejectedClosed(state);
            received(await channel.receive(), 'seed');
          } else for (const state of [...states, last]) await fulfilled(state, eof);
        }
        channel.close();
        await checkpoint();
        assert.deepEqual(listeners(controller.signal), [external]);
        assert.deepEqual(await channel.receive(), eof);
      });
    }
  }

  for (const direction of ['send', 'receive']) {
    for (const ending of ['complete', 'close']) {
      it(`${ending} removes only its owned ${direction} listener across channels`, async () => {
        const one = createAsyncChannel(1), two = createAsyncChannel(1);
        const controller = new AbortController(), external = () => {};
        controller.signal.addEventListener('abort', external);
        if (direction === 'send') {
          await one.send('seed1');
          await two.send('seed2');
        }
        const a = observe(direction === 'send' ? one.send('A', { signal: controller.signal }) :
          one.receive({ signal: controller.signal }));
        const b = observe(direction === 'send' ? two.send('B', { signal: controller.signal }) :
          two.receive({ signal: controller.signal }));
        const original = listeners(controller.signal);
        assert.equal(original.length, 3);
        if (ending === 'close') one.close();
        else if (direction === 'send') received(await one.receive(), 'seed1');
        else await one.send('A');
        assert.deepEqual(listeners(controller.signal), [external, original[2]]);
        controller.abort('remaining');
        await rejected(b, 'remaining');
        if (ending === 'complete') {
          await fulfilled(a, direction === 'send' ? undefined : { value: 'A', done: false });
        } else if (direction === 'send') await rejectedClosed(a);
        else await fulfilled(a, eof);
        assert.deepEqual(listeners(controller.signal), [external]);
        if (direction === 'send') {
          received(await one.receive(), ending === 'close' ? 'seed1' : 'A');
          received(await two.receive(), 'seed2');
        }
        one.close();
        two.close();
      });
    }
  }

  it('closes synchronously, rejects every blocked and future send, and drains only accepted values', async () => {
    const channel = createAsyncChannel(2), controller = new AbortController();
    await channel.send(undefined);
    await channel.send('accepted');
    const blocked = ['B', 'C', 'D'].map(value => observe(channel.send(value, { signal: controller.signal })));
    assert.equal(channel.close(), true);
    assert.equal(channel.closed, true);
    assert.equal(channel.size, 2);
    assert.deepEqual(listeners(controller.signal), []);
    assert.equal(channel.close(), false);
    controller.abort('too late');
    for (const state of blocked) await rejectedClosed(state);
    await rejectedClosed(observe(channel.send('future')));
    received(await channel.receive(), undefined);
    assert.equal(channel.size, 1);
    assert.equal(channel.close(), false);
    received(await channel.receive(), 'accepted');
    assert.equal(channel.size, 0);
    assert.equal(channel.close(), false);
    assert.deepEqual(await channel.receive(), eof);
    assert.deepEqual(await channel.receive(), eof);
  });

  it('closing empty releases every receiver and later abort cannot replace EOF', async () => {
    const channel = createAsyncChannel(3), controller = new AbortController(), external = () => {};
    controller.signal.addEventListener('abort', external);
    const waiting = Array.from({ length: 5 }, () => observe(channel.receive({ signal: controller.signal })));
    assert.equal(channel.close(), true);
    assert.equal(channel.closed, true);
    assert.equal(channel.size, 0);
    assert.deepEqual(listeners(controller.signal), [external]);
    controller.abort('too late');
    assert.equal(channel.close(), false);
    for (const state of waiting) await fulfilled(state, eof);
    assert.deepEqual(await channel.receive(), eof);
  });

  for (const capacity of [1, 3]) {
    for (const seed of [17, 83, 2026]) {
      it(`matches an occurrence-based model for mixed operations (capacity=${capacity}, seed=${seed})`, async () => {
        const channel = createAsyncChannel(capacity);
        const buffer = [], sends = [], receives = [], operations = [];
        const accepted = [], delivered = [];
        let closed = false, random = seed;
        const next = limit => {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          return random % limit;
        };
        const fulfill = (op, value) => { op.expected = { status: 'fulfilled', value }; };
        const reject = (op, reason) => { op.expected = { status: 'rejected', reason }; };
        const accept = op => {
          accepted.push(op.value);
          fulfill(op, undefined);
        };
        const deliver = (op, value) => {
          delivered.push(value);
          fulfill(op, { value, done: false });
        };
        function send() {
          const controller = new AbortController();
          // Unique occurrence IDs make loss/duplication visible even when
          // application payloads repeat. Compare sequences, never Sets.
          const value = { occurrence: operations.length, payload: operations.length % 3 };
          const op = { controller, value, expected: { status: 'pending' } };
          if (closed) reject(op, 'closed');
          else if (receives.length) {
            accept(op);
            deliver(receives.shift(), value);
          } else if (buffer.length < capacity) {
            accept(op);
            buffer.push(value);
          } else sends.push(op);
          op.actual = observe(channel.send(value, { signal: controller.signal }));
          operations.push(op);
        }
        function receive() {
          const controller = new AbortController();
          const op = { controller, expected: { status: 'pending' } };
          if (buffer.length) {
            deliver(op, buffer.shift());
            if (sends.length) {
              const sender = sends.shift();
              accept(sender);
              buffer.push(sender.value);
            }
          } else if (closed) fulfill(op, eof);
          else receives.push(op);
          op.actual = observe(channel.receive({ signal: controller.signal }));
          operations.push(op);
        }
        function close() {
          const first = !closed;
          closed = true;
          while (sends.length) reject(sends.shift(), 'closed');
          while (receives.length) fulfill(receives.shift(), eof);
          assert.equal(channel.close(), first);
        }
        async function check() {
          // Immediate state is checked separately from Promise reactions.
          assert.equal(channel.size, buffer.length);
          assert.equal(channel.closed, closed);
          assert.ok(channel.size >= 0 && channel.size <= capacity);
          assert.deepEqual(accepted, [...delivered, ...buffer]);
          await checkpoint();
          for (const { actual, expected, controller } of operations) {
            assert.equal(actual.status, expected.status);
            if (expected.status === 'fulfilled') assert.deepEqual(actual.value, expected.value);
            if (expected.status === 'rejected') {
              if (expected.reason === 'closed') {
                assert.ok(actual.reason instanceof Error);
                assert.equal(actual.reason.code, 'CHANNEL_CLOSED');
              } else assert.equal(actual.reason, expected.reason);
            }
            assert.equal(listeners(controller.signal).length, expected.status === 'pending' ? 1 : 0);
          }
        }
        for (let step = 0; step < 180; step++) {
          const choice = next(10);
          if (step === 160) close();
          else if (choice < 4) send();
          else if (choice < 8) receive();
          else if (operations.length) {
            const op = operations[next(operations.length)];
            const reason = { step };
            if (op.expected.status === 'pending') {
              for (const queue of [sends, receives]) {
                const index = queue.indexOf(op);
                if (index !== -1) queue.splice(index, 1);
              }
              reject(op, reason);
            }
            op.controller.abort(reason);
          }
          await check();
        }
        close();
        while (buffer.length) receive();
        receive();
        await check();
        assert.deepEqual(accepted, delivered);
        assert.ok(operations.every(op => op.actual.status !== 'pending'));
      });
    }
  }

  it('cleans up repeated cancellations behind full/empty channels and reuses drained storage', async () => {
    const full = createAsyncChannel(Number.MAX_SAFE_INTEGER), empty = createAsyncChannel(1);
    // A separate capacity-one channel keeps one accepted value alive through
    // cancellation churn; finite churn complements source review of retention.
    const blocked = createAsyncChannel(1);
    await blocked.send('held');
    for (let i = 0; i < 1000; i++) {
      const controller = new AbortController(), reason = { i };
      const send = observe(blocked.send({ i }, { signal: controller.signal }));
      const receive = observe(empty.receive({ signal: controller.signal }));
      controller.abort(reason);
      await rejected(send, reason);
      await rejected(receive, reason);
      assert.deepEqual(listeners(controller.signal), []);
      assert.equal(blocked.size, 1);
      assert.equal(empty.size, 0);
      await full.send(i);
      received(await full.receive(), i);
      assert.equal(full.size, 0);
    }
    received(await blocked.receive(), 'held');
    for (const channel of [full, empty, blocked]) {
      await channel.send('reused');
      received(await channel.receive(), 'reused');
      channel.close();
      assert.deepEqual(await channel.receive(), eof);
    }
  });
});
