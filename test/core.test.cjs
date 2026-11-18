'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { validatedSnapshot, calendarDates } = require('../src/courts.cjs');
const { sendPush } = require('../src/push.cjs');
const { CourtMonitor, UserError } = require('../src/monitor.cjs');
const { Preferences } = require('../src/preferences.cjs');

const now = Date.parse('2026-11-18T13:10:00+08:00');
const slot = (court, venue = '57') => ({ venue, date: '2026-11-18', start: '17:00', end: '18:00', court, price: 25 });
const sample = (...slots) => ({ dates: ['2026-11-18'], slots });

test('normalizes Beijing dates across a year boundary and validates visible court data', () => {
  const date = Date.parse('2026-12-31T23:50:00+08:00');
  assert.equal(calendarDates(date).get('1月1日'), '2027-01-01');
  const row = { court: 3, start: '17:00', end: '18:00', price: 25 };
  assert.equal(validatedSnapshot('57', [{ label: '11月18日', slots: [row, row] }], now).slots.length, 1);
  assert.throws(() => validatedSnapshot('57', [{ label: '11月18日', slots: [{ ...row, court: '3' }] }], now));
});

test('a first sample establishes a baseline and only new slots are sent', async t => {
  let response = sample(slot(1));
  const pushes = [];
  const monitor = new CourtMonitor({
    options: { campus: 'shahe', interval: 2 }, now: () => now, onChange() {},
    async checkVenue() { return response; },
    async dispatch(message) { pushes.push(message); return { kind: 'accepted', text: 'accepted' }; },
  });
  t.after(() => monitor.stop());
  monitor.setAuth('signed-in');
  monitor.setDelivery(true, true);
  monitor.start();
  await monitor.check();
  assert.equal(pushes.length, 0);
  response = sample(slot(1), slot(3), slot(5));
  await monitor.check();
  await monitor.check();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, '候羽｜沙河校区新增 2 场次');
  assert.match(pushes[0].content, /3、5号/);
  assert.doesNotMatch(pushes[0].content, /1号/);
});

test('unverified venue data is hidden, with no false alerts on recovery', async t => {
  let failed = false;
  let pushed = 0;
  const monitor = new CourtMonitor({
    options: { campus: 'shahe', interval: 2 }, now: () => now, onChange() {},
    async checkVenue() { if (failed) throw new UserError('页面暂时不可用。'); return sample(slot(1)); },
    async dispatch() { pushed++; return { kind: 'accepted', text: 'accepted' }; },
  });
  t.after(() => monitor.stop());
  monitor.setAuth('signed-in');
  monitor.setDelivery(true, true);
  monitor.start();
  await monitor.check();
  failed = true;
  await monitor.check();
  assert.equal(monitor.state().slotCount, 0);
  assert.equal(monitor.state().venues[0].at, now);
  assert.match(monitor.state().venues[0].error, /页面暂时不可用/);
  assert.equal(monitor.state().nextAt, now + 240000);
  failed = false;
  await monitor.check();
  assert.equal(monitor.state().slotCount, 1);
  assert.equal(pushed, 0);
});

test('an expired session stops polling and never sends a notification', async () => {
  const monitor = new CourtMonitor({
    options: { campus: 'xueyuanlu', interval: 2 }, now: () => now, onChange() {},
    async checkVenue() { throw new UserError('expired', 'auth'); },
    async dispatch() { assert.fail('no push should be sent'); },
  });
  monitor.setAuth('signed-in');
  monitor.start();
  await monitor.check();
  assert.equal(monitor.state().running, false);
  assert.equal(monitor.state().auth, 'expired');
  assert.equal(monitor.state().nextAt, null);
});

test('PushPlus uses an HTTPS POST and treats acceptance as separate from delivery', async () => {
  const adapter = async (url, request) => {
    assert.equal(url, 'https://www.pushplus.plus/send');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(JSON.parse(request.body).channel, 'wechat');
    return new Response(JSON.stringify({ code: 200 }));
  };
  assert.equal((await sendPush('mock-token-not-real', { title: 'test', content: 'test' }, undefined, adapter)).kind, 'accepted');
  const rejected = async () => new Response(JSON.stringify({ code: 905 }));
  assert.equal((await sendPush('mock-token-not-real', { title: 'test', content: 'test' }, undefined, rejected)).kind, 'blocked');
});

test('an unavailable OS vault leaves the PushPlus token in memory only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'courtwatch-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'settings.json');
  const store = new Preferences(file, { async isAsyncEncryptionAvailable() { return false; } });
  await store.load();
  const secret = 'mock-test-token-12345';
  assert.equal(await store.saveToken(secret), false);
  assert.equal(store.token, secret);
  assert.doesNotMatch(await readFile(file, 'utf8'), /mock-test/);
  const reopened = new Preferences(file, { async isAsyncEncryptionAvailable() { return false; } });
  await reopened.load();
  assert.equal(reopened.token, null);
});
