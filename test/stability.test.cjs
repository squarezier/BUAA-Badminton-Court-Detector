'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { CourtMonitor, UserError } = require('../src/monitor.cjs');
const { sendPush } = require('../src/push.cjs');
const { decodePushConnection } = require('../src/push-connection.cjs');
const { Preferences } = require('../src/preferences.cjs');
const { beijingDay, slotKey, validOptions } = require('../src/courts.cjs');

const baselineTime = Date.parse('2026-11-18T13:10:00+08:00');
const slot = (court, venue = '57', start = '17:00') => ({ venue, date: '2026-11-18', start, end: '18:00', court, price: 25 });
const stamped = (...slots) => ({ dates: ['2026-11-18'], slots });
const accepted = { kind: 'accepted', text: 'accepted' };
const deferred = () => Promise.withResolvers();

function setup(t, overrides = {}) {
  const monitor = new CourtMonitor({
    options: { campus: 'shahe', interval: 2 }, onChange() {}, now: () => baselineTime,
    async checkVenue() { return stamped(); }, async dispatch() { return accepted; }, ...overrides,
  });
  t.after(() => monitor.stop());
  monitor.setAuth('signed-in');
  monitor.setDelivery(true, true);
  monitor.start();
  return monitor;
}

test('a rapid pause and restart waits for the aborted poll to settle', async t => {
  const first = deferred();
  let calls = 0;
  let firstSignal;
  const monitor = setup(t, { async checkVenue(_venue, signal) {
    if (++calls === 1) { firstSignal = signal; await first.promise; }
    return stamped(slot(calls));
  } });
  const oldPoll = monitor.check();
  monitor.stop();
  assert.equal(firstSignal.aborted, true);
  monitor.start();
  try {
    await monitor.check();
    assert.equal(calls, 1);
  } finally { first.resolve(); await oldPoll; }
  await monitor.check();
  assert.equal(calls, 2);
  assert.deepEqual(monitor.state().rows[0].courts, [2]);
});

test('suspend and resume do not resend a push already handed to the provider', async t => {
  const underway = deferred();
  const response = deferred();
  let sends = 0;
  let avail = stamped(slot(1));
  const monitor = setup(t, {
    async checkVenue() { return avail; },
    async dispatch() { if (++sends === 1) { underway.resolve(); await response.promise; } return accepted; },
  });
  await monitor.check();
  avail = stamped(slot(1), slot(2));
  const interrupted = monitor.check();
  await underway.promise;
  monitor.setSuspended(true);
  monitor.setSuspended(false);
  response.resolve();
  await interrupted;
  await monitor.check();
  assert.equal(sends, 1);
  assert.equal(monitor.state().slotCount, 2);
});

test('one bad venue leaves the healthy venue on its configured cadence', async t => {
  let broken = false;
  const messages = [];
  const monitor = setup(t, {
    options: { campus: 'xueyuanlu', interval: 2 },
    async checkVenue(id) {
      if (broken && id === '38') throw new Error('offline');
      return stamped(slot(broken ? 19 : 18, id));
    },
    async dispatch(message) { messages.push(message); return accepted; },
  });
  await monitor.check();
  broken = true;
  await monitor.check();
  const last = monitor.state();
  assert.equal(last.nextAt, baselineTime + 120000);
  assert.deepEqual(last.rows.map(row => row.venue), ['39']);
  assert.match(messages[0].content, /19号/);
  assert.doesNotMatch(messages[0].content, /venue-reservation\/38/);
});

test('reconnecting does not display a previous session’s availability', async t => {
  const monitor = setup(t, { async checkVenue() { return stamped(slot(1)); } });
  await monitor.check();
  monitor.setAuth('expired');
  monitor.setAuth('signed-in');
  assert.equal(monitor.state().lastAt, null);
  assert.equal(monitor.state().slotCount, 0);
});

test('a thrown push adapter error leaves polling active and avoids blind retransmission', async t => {
  let booking = stamped(slot(1));
  let attempts = 0;
  const monitor = setup(t, {
    async checkVenue() { return booking; },
    async dispatch() { ++attempts; throw new Error('interrupted after request started'); },
  });
  await monitor.check();
  booking = stamped(slot(1), slot(2));
  await monitor.check();
  assert.equal(monitor.state().delivery.status, 'unknown');
  assert.ok(monitor.state().nextAt > baselineTime);
  await monitor.check();
  assert.equal(attempts, 1);
});

test('rate-limited notifications wait and discard slots that are sold in the meantime', async t => {
  let now = baselineTime;
  let booking = stamped(slot(1));
  const messages = [];
  const monitor = setup(t, {
    now: () => now,
    async checkVenue() { return booking; },
    async dispatch(message) {
      messages.push(message);
      return messages.length === 1 ? { kind: 'retry', retryAfterMs: 300000, text: 'rate-limited' } : accepted;
    },
  });
  await monitor.check();
  booking = stamped(slot(1), slot(2), slot(3));
  await monitor.check();
  now += 120000;
  booking = stamped(slot(1), slot(3), slot(4));
  await monitor.check();
  assert.equal(messages.length, 1);
  now += 180000;
  await monitor.check();
  assert.equal(messages.length, 2);
  assert.match(messages[1].content, /3、4号/);
  assert.doesNotMatch(messages[1].content, /2号/);
});

test('PushPlus transient, rejected and malformed responses are distinguished', async () => {
  const connection = decodePushConnection('synthetic-test-token');
  const message = { title: 'test', content: '<p>test</p>' };
  const statuses = [[500, 'retry'], [903, 'blocked'], [900, 'blocked'], [null, 'unknown'], ['', 'unknown'], ['200', 'accepted']];
  for (const [code, expected] of statuses) {
    const result = await sendPush(connection, message, undefined, async () => Response.json({ code }));
    assert.equal(result.kind, expected, `body code ${JSON.stringify(code)}`);
  }
  const slow = await sendPush(connection, message, undefined, async () => new Response('', { status: 429, headers: { 'retry-after': '300' } }));
  assert.equal(slow.kind, 'retry');
  assert.equal(slow.retryAfterMs, 300000);
  const gateway = await sendPush(connection, message, undefined, async () => new Response('', { status: 502 }));
  assert.equal(gateway.kind, 'unknown');
  const oversized = await sendPush(connection, message, undefined, async () => new Response(' '.repeat(65537)));
  assert.equal(oversized.kind, 'unknown');
});

test('a temporarily failed keychain refresh keeps a decrypted token usable in memory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'houyu-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'settings.json');
  const token = 'synthetic-test-token';
  await writeFile(file, JSON.stringify({ version: 1, encryptedToken: 'AAAAAAAB' }));
  const store = new Preferences(file, {
    async isAsyncEncryptionAvailable() { return true; },
    async decryptStringAsync() { return { result: token, shouldReEncrypt: true }; },
    async encryptStringAsync() { throw new Error('temporary vault error'); },
  });
  await store.load();
  assert.deepEqual(store.connection, { provider: 'pushplus', token });
  assert.doesNotMatch(await readFile(file, 'utf8'), /synthetic-test-token/);
});

test('a failed settings save can be retried without corrupting the previous file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'houyu-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'settings.json');
  const store = new Preferences(file, {});
  await store.saveOptions({ campus: 'shahe', interval: 5 });
  const goodPersist = store.persist.bind(store);
  store.persist = async () => { throw new Error('disk temporarily full'); };
  await assert.rejects(store.saveOptions({ campus: 'xueyuanlu', interval: 10 }));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).options.interval, 5);
  store.persist = goodPersist;
  await store.saveOptions({ campus: 'xueyuanlu', interval: 2 });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).options, { campus: 'xueyuanlu', interval: 2 });
});

test('custom intervals accept whole minutes within the supported range', () => {
  for (const interval of [1, 7, 22, 1440]) assert.equal(validOptions({ campus: 'shahe', interval }), true);
  for (const interval of [0, 1.5, 1441, '5', NaN, Infinity]) assert.equal(validOptions({ campus: 'shahe', interval }), false);
});

test('changing the interval while idle recomputes the next check from the last completed poll', async t => {
  let now = baselineTime;
  const monitor = setup(t, { now: () => now });
  await monitor.check();
  now += 30000;
  monitor.setOptions({ campus: 'shahe', interval: 7 });
  assert.equal(monitor.state().nextAt, baselineTime + 420000);
  monitor.setOptions({ campus: 'shahe', interval: 1 });
  assert.equal(monitor.state().nextAt, baselineTime + 60000);
  assert.throws(() => monitor.setOptions({ campus: 'xueyuanlu', interval: 1 }), UserError);
});

test('changing the interval during a read applies after the in-flight check', async t => {
  let now = baselineTime;
  const read = deferred();
  const monitor = setup(t, { now: () => now, async checkVenue() { return read.promise; } });
  const reading = monitor.check();
  monitor.setOptions({ campus: 'shahe', interval: 7 });
  assert.equal(monitor.state().nextAt, null);
  assert.equal(monitor.state().checking, true);
  now += 20000;
  read.resolve(stamped(slot(1)));
  await reading;
  assert.equal(monitor.state().nextAt, now + 420000);
});

test('a long user-set interval is not silently shortened by the outage backoff cap', async t => {
  const monitor = setup(t, { options: { campus: 'shahe', interval: 1440 }, async checkVenue() { throw new Error('network down'); } });
  await monitor.check();
  assert.equal(monitor.state().nextAt, baselineTime + 86400000);
});

test('started slots disappear from a snapshot without any network call', async t => {
  let now = baselineTime;
  const monitor = setup(t, { now: () => now, async checkVenue() { return stamped(slot(1)); } });
  await monitor.check();
  assert.equal(monitor.state().slotCount, 1);
  now = Date.parse('2026-11-18T17:00:00+08:00');
  assert.equal(monitor.state().slotCount, 0);
});

test('10000 scheduled cycles tolerate rolling dates, availability changes and network failures', async t => {
  let now = baselineTime;
  let previous;
  let booking;
  let down = false;
  let sent = 0;
  let expectedSent = 0;
  let seed = 1326817;
  const monitor = setup(t, {
    now: () => now,
    async checkVenue() { if (down) throw new Error('scheduled outage'); return booking; },
    async dispatch() { sent++; return accepted; },
  });
  for (let round = 0; round < 10000; round++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    down = round % 13 < 3;
    const date = beijingDay(now + 86400000);
    const slots = [1, 2, 3, 4, 5, 6, 7, 8].filter(court => (seed >>> (court + 12)) & 1).map(court => ({ ...slot(court), date }));
    booking = { slots, dates: [date] };
    if (!down) {
      if (previous && slots.some(court => !previous.has(slotKey(court)))) expectedSent++;
      previous = new Set(slots.map(slotKey));
    }
    await monitor.check();
    const state = monitor.state();
    assert.equal(state.slotCount, down ? 0 : slots.length);
    assert.equal(sent, expectedSent);
    assert.ok(state.nextAt >= now + 120000);
    assert.ok(state.nextAt <= now + 900000);
    assert.equal(monitor.task, null);
    assert.equal(monitor.pending.size, 0);
    now = state.nextAt;
  }
});
