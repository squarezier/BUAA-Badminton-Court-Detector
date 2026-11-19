'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { CourtMonitor, UserError, CampusRateLimit } = require('../src/monitor.cjs');
const { sendPush } = require('../src/push.cjs');
const { decodePushConnection, feishuConnection } = require('../src/push-connection.cjs');
const { Preferences } = require('../src/preferences.cjs');
const { beijingDay, nextBookingRelease, slotKey, validOptions, intervalSeconds } = require('../src/courts.cjs');

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

test('target markers follow the notification rule across both venues while all free courts remain visible', async t => {
  const monitor = setup(t, {
    options: { campus: 'xueyuanlu', interval: 2 },
    async checkVenue(id) { return stamped(slot(1, id), { ...slot(2, id), start: '18:00', end: '19:00' }); },
  });
  await monitor.check();
  monitor.setOptions({ ...monitor.options, targets: { xueyuanlu: { date: '2026-11-18', start: '17:30', end: '19:00' } } });
  let rows = monitor.state().rows;
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.filter(row => row.inTarget).map(row => [row.venue, row.start]), [['38', '18:00'], ['39', '18:00']]);
  monitor.setOptions({ ...monitor.options, targets: {} });
  assert.ok(monitor.state().rows.every(row => !row.inTarget));
});

const refundDeadline = Date.parse('2026-11-18T14:00:00+08:00');

for (const offset of [-1, 0, 1]) {
  test(`Shahe paid reopening uses the last sold observation at refund deadline offset ${offset}ms`, async t => {
    let now = refundDeadline - 200;
    let phase = 'booked';
    const courts = [slot(1), slot(2), { ...slot(3), price: 0 }, { ...slot(4), date: '2026-11-19' }];
    const messages = [];
    const monitor = setup(t, {
      now: () => now,
      async checkVenue() {
        if (phase === 'outage') throw new Error('simulated offline');
        if (phase === 'booked') {
          now = refundDeadline + 1000; // The successful read finishes after the deadline in every case.
          return { slots: [], reserved: courts, dates: ['2026-11-18', '2026-11-19'], started: refundDeadline + offset };
        }
        return { slots: courts, dates: ['2026-11-18', '2026-11-19'] };
      },
      async dispatch(message) { messages.push(message); return accepted; },
    });
    await monitor.check();
    phase = 'outage';
    await monitor.check();
    phase = 'green';
    await monitor.check();
    await monitor.check();
    assert.equal(monitor.state().slotCount, 4);
    assert.equal(messages.length, 1);
    assert.match(messages[0].title, offset <= 0 ? /4 场次/ : /2 场次/);
    if (offset <= 0) assert.match(messages[0].markdown, /1、2号/);
    else assert.doesNotMatch(messages[0].markdown, /1、2号/);
    assert.match(messages[0].markdown, /3号/);
    assert.match(messages[0].markdown, /4号/);
  });
}

test('Xueyuanlu samples each venue separately and only applies a published refund deadline', async t => {
  let now = refundDeadline - 100;
  let booked = true;
  const messages = [];
  const monitor = setup(t, {
    now: () => now,
    options: { campus: 'xueyuanlu', interval: 2 },
    async checkVenue(id) {
      if (!booked) return stamped(slot(1, id));
      const sold = { ...stamped(), reserved: [slot(1, id)] };
      if (id === '38') {
        now = refundDeadline + 100;
        sold.started = refundDeadline + 20;
      }
      return sold;
    },
    async dispatch(message) { messages.push(message); return accepted; },
  });
  await monitor.check();
  booked = false;
  await monitor.check();
  assert.equal(monitor.state().slotCount, 2);
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /主馆/);
  assert.doesNotMatch(messages[0].content, /训练馆/);
});

test('a confirmed retry survives the refund deadline and drops a court exactly when its session starts', async t => {
  let now = refundDeadline;
  let booked = true;
  const messages = [];
  const courts = [slot(1), { ...slot(2), start: '18:00', end: '19:00' }];
  const monitor = setup(t, {
    now: () => now,
    async checkVenue() { return booked ? { ...stamped(), reserved: courts } : stamped(...courts); },
    async dispatch(message) {
      messages.push(message);
      return messages.length === 1 ? { kind: 'retry', retryAfterMs: 60000, text: 'retry' } : accepted;
    },
  });
  await monitor.check();
  booked = false;
  now++;
  await monitor.check();
  now = Date.parse('2026-11-18T17:00:00+08:00');
  await monitor.check();
  await monitor.check();
  assert.deepEqual(messages.map(message => message.title), ['候羽｜沙河校区疑似退订 2 场次', '候羽｜沙河校区疑似退订 1 场次']);
  assert.match(messages[1].markdown, /2号/);
  assert.doesNotMatch(messages[1].markdown, /1号/);
});

test('partial dates keep their own sold observation across the refund deadline while withdrawn dates reset', async t => {
  const today = '2026-11-18';
  const tomorrow = '2026-11-19';
  const later = '2026-11-20';
  const courts = [slot(1), { ...slot(2), date: tomorrow }, { ...slot(3), date: later }];
  let now = refundDeadline;
  let sample = { dates: [today, tomorrow, later], reserved: courts, slots: [] };
  const messages = [];
  const monitor = setup(t, {
    now: () => now,
    async checkVenue() { return sample; },
    async dispatch(message) { messages.push(message); return accepted; },
  });
  await monitor.check();
  now += 60000;
  sample = { dates: [tomorrow], unreadDates: [today], slots: [courts[1]] };
  await monitor.check();
  await monitor.check();
  assert.equal(monitor.state().slotCount, 1);
  assert.deepEqual(monitor.state().venues[0].unreadDates, [today]);
  assert.equal(messages.length, 1);
  assert.match(messages[0].markdown, /2号/);
  sample = { dates: [today, tomorrow, later], slots: courts };
  await monitor.check();
  await monitor.check();
  assert.equal(monitor.state().slotCount, 3);
  assert.equal(messages.length, 2);
  assert.match(messages[1].markdown, /1号/);
  assert.doesNotMatch(messages[1].markdown, /2号|3号/);
});

test('a pending retry waits for fresh green evidence on its specific date', async t => {
  const date = '2026-11-18';
  const tomorrow = '2026-11-19';
  const courts = [slot(4), slot(5)];
  let now = baselineTime;
  let sample = { dates: [date, tomorrow], reserved: courts, slots: [] };
  const messages = [];
  const monitor = setup(t, {
    now: () => now,
    async checkVenue() { return sample; },
    async dispatch(message) {
      messages.push(message);
      return messages.length === 1 ? { kind: 'retry', text: 'limited', retryAfterMs: 60000 } : accepted;
    },
  });
  await monitor.check();
  sample = { dates: [date, tomorrow], slots: courts };
  await monitor.check();
  now += 60000;
  sample = { dates: [tomorrow], unreadDates: [date], slots: [] };
  await monitor.check();
  await monitor.check();
  assert.equal(messages.length, 1);
  assert.equal(monitor.state().slotCount, 0);
  sample = { dates: [date, tomorrow], slots: [courts[0]], reserved: [courts[1]] };
  await monitor.check();
  await monitor.check();
  assert.equal(messages.length, 2);
  assert.match(messages[1].markdown, /4号/);
  assert.doesNotMatch(messages[1].markdown, /5号/);
  assert.equal(monitor.pending.size, 0);
});

test('suspending before the push transport starts preserves the reopening for one fresh attempt', async t => {
  const connection = feishuConnection({ webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-test-hook' });
  const waitingForVault = deferred();
  const unlock = deferred();
  let sample = { ...stamped(), reserved: [slot(2)] };
  let attempts = 0;
  let requests = 0;
  const monitor = setup(t, {
    async checkVenue() { return sample; },
    async dispatch(message, signal) {
      if (++attempts === 1) { waitingForVault.resolve(); await unlock.promise; }
      return sendPush(connection, message, signal, async () => { requests++; return Response.json({ code: 0 }); });
    },
  });
  await monitor.check();
  sample = stamped(slot(2));
  const poll = monitor.check();
  await waitingForVault.promise;
  monitor.setSuspended(true);
  unlock.resolve();
  await poll;
  assert.equal(requests, 0);
  monitor.setSuspended(false);
  await monitor.check();
  await monitor.check();
  assert.equal(requests, 1);
  assert.equal(attempts, 2);
});

test('a complete Feishu result remains authoritative when suspension overlaps reading its response', async () => {
  const connection = feishuConnection({ webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-test-hook' });
  for (const [code, kind] of [[11232, 'retry'], [0, 'accepted']]) {
    const controller = new AbortController();
    const result = await sendPush(connection, { feishuCard: {} }, controller.signal, async () => {
      controller.abort();
      return Response.json({ code });
    });
    assert.equal(result.kind, kind);
  }
});

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
  let avail = { ...stamped(slot(1)), reserved: [slot(2)] };
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

test('a rate limit confirmed during sleep preserves the retry and rechecks what is still free', async t => {
  let now = baselineTime;
  let avail = { ...stamped(slot(1)), reserved: [slot(2), slot(3)] };
  const underway = deferred();
  const limited = deferred();
  const sent = [];
  const monitor = setup(t, {
    now: () => now,
    async checkVenue() { return avail; },
    async dispatch(message) {
      sent.push(message);
      if (sent.length !== 1) return accepted;
      underway.resolve();
      return limited.promise;
    },
  });
  await monitor.check();
  avail = stamped(slot(1), slot(2), slot(3));
  const interrupted = monitor.check();
  await underway.promise;
  monitor.setSuspended(true);
  limited.resolve({ kind: 'retry', retryAfterMs: 60000, text: 'rate-limited' });
  await interrupted;
  monitor.setSuspended(false);
  avail = stamped(slot(1), slot(3));
  await monitor.check();
  assert.equal(sent.length, 1);
  assert.equal(monitor.state().delivery.status, 'retry');
  now += 60000;
  await monitor.check();
  assert.equal(sent.length, 2);
  assert.match(sent[1].content, /3号/);
  assert.doesNotMatch(sent[1].content, /2号/);
});

test('a late retry from a paused campus is discarded on switching campuses', async t => {
  const underway = deferred();
  const limited = deferred();
  const sent = [];
  let courts = [1];
  const monitor = setup(t, {
    async checkVenue(id) {
      const reserved = [2, 3].filter(court => !courts.includes(court)).map(court => slot(court, id));
      return { ...stamped(...courts.map(court => slot(court, id))), reserved };
    },
    async dispatch(message) {
      sent.push(message);
      if (sent.length !== 1) return accepted;
      underway.resolve();
      return limited.promise;
    },
  });
  await monitor.check();
  courts = [1, 2];
  const interrupted = monitor.check();
  await underway.promise;
  monitor.stop();
  monitor.setOptions({ campus: 'xueyuanlu', interval: 2 });
  monitor.start();
  limited.resolve({ kind: 'retry', retryAfterMs: 300000, text: 'old destination limit' });
  await interrupted;
  await monitor.check();
  assert.equal(monitor.state().delivery.status, 'ready');
  assert.equal(sent.length, 1);
  courts = [1, 2, 3];
  await monitor.check();
  assert.equal(sent.length, 2);
  assert.match(sent[1].title, /学院路校区疑似退订 2 场次/);
  assert.doesNotMatch(sent[1].content, /venue-reservation\/57/);
});

test('one bad venue leaves the healthy venue on its configured cadence', async t => {
  let broken = false;
  const messages = [];
  const monitor = setup(t, {
    options: { campus: 'xueyuanlu', interval: 2 },
    async checkVenue(id) {
      if (broken && id === '38') throw new Error('offline');
      return broken ? stamped(slot(19, id)) : { ...stamped(slot(18, id)), reserved: [slot(19, id)] };
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
  let booking = { ...stamped(slot(1)), reserved: [slot(2)] };
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
  let booking = { ...stamped(slot(1)), reserved: [slot(2), slot(3), slot(4)] };
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
  booking = { ...stamped(slot(1), slot(2), slot(3)), reserved: [slot(4)] };
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

test('a rate-limited reopening is retried without including an unobserved green slot', async t => {
  let now = baselineTime;
  let booking = { ...stamped(slot(1)), reserved: [slot(4)] };
  const messages = [];
  const monitor = setup(t, {
    now: () => now,
    async checkVenue() { return booking; },
    async dispatch(message) {
      messages.push(message);
      return messages.length === 1 ? { kind: 'retry', retryAfterMs: 60000, text: 'rate-limited' } : accepted;
    },
  });
  await monitor.check();
  booking = stamped(slot(1), slot(2), slot(4));
  await monitor.check();
  now += 30000;
  await monitor.check();
  assert.deepEqual(messages.map(message => message.title), ['候羽｜沙河校区疑似退订 1 场次']);
  now += 30000;
  await monitor.check();
  assert.deepEqual(messages.map(message => message.title), [
    '候羽｜沙河校区疑似退订 1 场次', '候羽｜沙河校区疑似退订 1 场次',
  ]);
  assert.match(messages[1].markdown, /4号/);
  assert.doesNotMatch(messages[1].markdown, /2号/);
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

test('notification transport retries pre-connection failures and treats a lost response as uncertain', async () => {
  const connection = feishuConnection({ webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-test-hook' });
  const message = { feishuCard: { body: {} } };
  function sendWithFailure(code, syscall) {
    return sendPush(connection, message, undefined, async () => {
      throw new TypeError('fetch failed', { cause: { code, syscall } });
    });
  }
  for (const [code, syscall] of [['EAI_AGAIN', 'getaddrinfo'], ['ECONNREFUSED', 'connect']]) {
    const result = await sendWithFailure(code, syscall);
    assert.equal(result.kind, 'retry');
    assert.ok(result.retryAfterMs >= 60000);
  }
  assert.equal((await sendWithFailure('ECONNRESET', 'read')).kind, 'unknown');
  assert.equal((await sendWithFailure('ECONNREFUSED', 'read')).kind, 'unknown');
});

test('a temporarily failed key rotation retains the readable ciphertext without caching the token', async t => {
  const root = await mkdtemp(join(tmpdir(), 'houyu-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'settings.json');
  const token = 'synthetic-test-token';
  await writeFile(file, JSON.stringify({ version: 1, encryptedToken: Buffer.from('v11test-vault').toString('base64') }));
  const store = new Preferences(file, {
    async isAsyncEncryptionAvailable() { return true; },
    async decryptStringAsync() { return { result: token, shouldReEncrypt: true }; },
    async encryptStringAsync() { throw new Error('temporary vault error'); },
  });
  await store.load();
  assert.equal(store.sessionConnection, null);
  assert.deepEqual(await store.readConnection(), { provider: 'pushplus', token });
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

test('one second through 24 hours round-trip as exact whole seconds in the minute-based settings', () => {
  for (let seconds = 1; seconds <= 86400; seconds++) assert.equal(intervalSeconds(seconds / 60), seconds);
  for (const interval of [1 / 60, 7, 1.5, 22, 1440]) assert.equal(validOptions({ campus: 'shahe', interval }), true);
  for (const interval of [0, 0.5 / 60, 1.1 / 60, 86401 / 60, '5', NaN, Infinity]) {
    assert.equal(validOptions({ campus: 'shahe', interval }), false);
  }
});

test('one-second polling is serial, waits after a slow scan, and backs off on outages', async t => {
  let now = baselineTime;
  const pending = deferred();
  let attempts = 0;
  let offline = false;
  const monitor = setup(t, { options: { campus: 'shahe', interval: 1 / 60 }, now: () => now,
    async checkVenue() {
      attempts++;
      if (offline) throw new Error('offline');
      return pending.promise;
    } });
  const underway = monitor.check();
  now += 9000;
  await monitor.check();
  assert.equal(attempts, 1);
  assert.equal(monitor.state().nextAt, null);
  pending.resolve(stamped());
  await underway;
  assert.equal(monitor.state().nextAt, now + 1000);
  offline = true;
  for (const delay of [60000, 120000, 240000]) {
    now = monitor.state().nextAt;
    await monitor.check();
    assert.equal(monitor.state().nextAt, now + delay);
  }
  offline = false;
  now = monitor.state().nextAt;
  await monitor.check();
  assert.equal(monitor.state().nextAt, now + 1000);
});

test('campus HTTP 429 pauses both halls, including across 07:00, resume, and interval edits', async t => {
  const release = Date.parse('2026-11-19T07:00:00+08:00');
  let now = release - 500;
  const until = now + 180000;
  const calls = [];
  const monitor = setup(t, { options: { campus: 'xueyuanlu', interval: 1 / 60 }, now: () => now,
    async checkVenue(id) {
      calls.push(id);
      if (calls.length === 1) throw new CampusRateLimit('180', now);
      return stamped();
    } });
  await monitor.check();
  assert.deepEqual(calls, ['38']);
  assert.equal(monitor.state().nextAt, until);
  now = release;
  monitor.setSuspended(true);
  monitor.setSuspended(false);
  monitor.setOptions({ ...monitor.options, interval: 2 / 60 });
  await monitor.check();
  assert.equal(monitor.state().nextAt, until);
  assert.deepEqual(calls, ['38']);
  now = until;
  await monitor.check();
  assert.deepEqual(calls, ['38', '38', '39']);
  assert.equal(monitor.state().nextAt, until + 2000);
  for (const value of ['', '0', 'invalid']) assert.equal(new CampusRateLimit(value, release).retryAfterMs, 60000);
  assert.equal(new CampusRateLimit(new Date(release + 300000).toUTCString(), release).retryAfterMs, 300000);
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

test('the morning refresh records newly published slots and alerts only for a verified reopening', async t => {
  const release = Date.parse('2026-11-18T07:00:00+08:00');
  let now = release - 120000;
  const newSlot = { ...slot(4), date: '2026-11-20' };
  let booking = { ...stamped(slot(1)), reserved: [slot(2)] };
  const messages = [];
  const monitor = setup(t, {
    options: { campus: 'shahe', interval: 30 },
    now: () => now,
    async checkVenue() { return booking; },
    async dispatch(message) { messages.push(message); return accepted; },
  });
  await monitor.check();
  assert.equal(monitor.state().nextAt, release);
  now = release;
  booking = { dates: ['2026-11-18', '2026-11-20'], slots: [slot(1), slot(2), newSlot] };
  await monitor.check();
  assert.equal(monitor.state().slotCount, 3);
  assert.equal(monitor.state().nextAt, release + 28 * 60000);
  assert.deepEqual(messages.map(message => message.title), ['候羽｜沙河校区疑似退订 1 场次']);
  assert.match(messages[0].content, /2号/);
  assert.doesNotMatch(messages[0].content, /4号|11月20日/);
  await monitor.check();
  assert.equal(messages.length, 1);
});

test('interval edits during the 07:00 supplemental scan use the preceding regular sample', async t => {
  const release = Date.parse('2026-11-18T07:00:00+08:00');
  let now = release - 2 * 60000;
  const read = deferred();
  const monitor = setup(t, { now: () => now, options: { campus: 'shahe', interval: 30 },
    async checkVenue() { return now < release ? stamped() : read.promise; } });
  await monitor.check();
  now = release;
  const reading = monitor.check();
  monitor.setOptions({ campus: 'shahe', interval: 10 });
  now += 12000;
  read.resolve(stamped());
  await reading;
  assert.equal(monitor.state().nextAt, release + 8 * 60000);
});

test('a late supplemental timer covers the regular check when its deadline has already passed', async t => {
  const release = Date.parse('2026-11-18T07:00:00+08:00');
  let now = release - 60000;
  const monitor = setup(t, { now: () => now });
  await monitor.check();
  now = release + 120000;
  await monitor.check();
  assert.equal(monitor.state().nextAt, now + 120000);
});

test('a scan straddling the morning release runs one fresh check immediately afterward', async t => {
  const release = Date.parse('2026-11-18T07:00:00+08:00');
  let now = release - 1000;
  const read = deferred();
  const monitor = setup(t, { now: () => now, async checkVenue() { return read.promise; } });
  const reading = monitor.check();
  now = release + 1500;
  read.resolve(stamped());
  await reading;
  assert.equal(monitor.state().nextAt, now);
  await monitor.check();
  assert.equal(monitor.state().nextAt, now + 120000);
});

test('a long user-set interval is not silently shortened by the outage backoff cap', async t => {
  const monitor = setup(t, { options: { campus: 'shahe', interval: 1440 }, async checkVenue() { throw new Error('network down'); } });
  await monitor.check();
  assert.equal(monitor.pollDelay(), 86400000);
  assert.equal(monitor.state().nextAt, nextBookingRelease(baselineTime));
});

test('editing the interval before 07:00 preserves the original regular-check anchor', async t => {
  const release = Date.parse('2026-11-18T07:00:00+08:00');
  let now = release - 600000;
  const monitor = setup(t, { now: () => now, options: { campus: 'shahe', interval: 30 } });
  await monitor.check();
  assert.equal(monitor.state().nextAt, release);
  now += 60000;
  monitor.setOptions({ campus: 'shahe', interval: 5 });
  assert.equal(monitor.state().nextAt, release - 300000);
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
    const courts = [1, 2, 3, 4, 5, 6, 7, 8].map(court => ({ ...slot(court), date }));
    const isAvailable = ({ court }) => Boolean((seed >>> (court + 12)) & 1);
    const slots = courts.filter(isAvailable);
    const reserved = courts.filter(court => !isAvailable(court) && Boolean((seed >>> (court.court + 3)) & 1));
    booking = { slots, reserved, dates: [date] };
    if (!down) {
      if (previous && slots.some(court => previous.has(slotKey(court)))) expectedSent++;
      previous = new Set(reserved.map(slotKey));
    }
    await monitor.check();
    const state = monitor.state();
    assert.equal(state.slotCount, down ? 0 : slots.length);
    assert.equal(sent, expectedSent);
    assert.ok(state.nextAt > now);
    if (now !== nextBookingRelease(now - 1)) {
      assert.ok(state.nextAt >= Math.min(now + 120000, nextBookingRelease(now)));
    }
    assert.ok(state.nextAt <= now + 900000);
    assert.equal(monitor.task, null);
    assert.equal(monitor.pending.size, 0);
    now = state.nextAt;
  }
});
