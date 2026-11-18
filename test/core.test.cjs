'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { validatedSnapshot, calendarDates } = require('../src/courts.cjs');
const { sendPush, notice } = require('../src/push.cjs');
const { feishuConnection, decodePushConnection } = require('../src/push-connection.cjs');
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
  const connection = decodePushConnection('mock-token-not-real');
  const adapter = async (url, request) => {
    assert.equal(url, 'https://www.pushplus.plus/send');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(JSON.parse(request.body).channel, 'wechat');
    return new Response(JSON.stringify({ code: 200 }));
  };
  assert.equal((await sendPush(connection, { title: 'test', content: 'test' }, undefined, adapter)).kind, 'accepted');
  const rejected = async () => new Response(JSON.stringify({ code: 905 }));
  assert.equal((await sendPush(connection, { title: 'test', content: 'test' }, undefined, rejected)).kind, 'blocked');
});

test('ServerChan sends markdown over HTTPS and handles throttling without blind retries', async () => {
  const key = 'SCTmock-test-token-12345';
  const connection = decodePushConnection(key);
  const message = notice('shahe', [slot(3), slot(5)], now);
  const adapter = async (url, request) => {
    assert.equal(url, `https://sctapi.ftqq.com/${key}.send`);
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(request.body.get('title'), '候羽｜沙河校区新增 2 场次');
    assert.match(request.body.get('desp'), /3、5号/);
    assert.match(request.body.get('desp'), /\(https:\/\/cgyy\.buaa\.edu\.cn\/venue\/venue-reservation\/57\)/);
    return Response.json({ code: 0 });
  };
  assert.equal((await sendPush(connection, message, undefined, adapter)).kind, 'accepted');
  const limited = async () => new Response('', { status: 429 });
  const delayed = await sendPush(connection, message, undefined, limited);
  assert.equal(delayed.kind, 'retry');
  assert.equal(delayed.retryAfterMs, 86400000);
  const rejected = async () => Response.json({ code: 40001 });
  assert.equal((await sendPush(connection, message, undefined, rejected)).kind, 'blocked');
});

const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/11111111-2222-4333-8444-555555555555';

test('Feishu accepts only the official HTTPS webhook path', () => {
  assert.deepEqual(feishuConnection({ webhook: ` ${webhook}\n` }), { provider: 'feishu', webhook, secret: '' });
  for (const invalid of [
    webhook.replace('https:', 'http:'),
    webhook.replace('open.feishu.cn', 'open.feishu.cn.example.invalid'),
    webhook.replace('open.feishu.cn', 'open.feishu.cn@example.invalid'),
    webhook.replace('open.feishu.cn', 'open.feishu.cn:443'),
    webhook.replace('/v2/', '/v1/'),
    webhook + '?test=1',
    webhook + '#test',
    webhook + '/../elsewhere',
  ]) assert.equal(feishuConnection({ webhook: invalid }), null);
  assert.equal(feishuConnection({ webhook, secret: 'first\nsecond' }), null);
});

test('Feishu sends a signed group post with the official booking link', async t => {
  t.mock.method(Date, 'now', () => 1599360473000);
  const connection = feishuConnection({ webhook, secret: 'demo' });
  const message = notice('shahe', [slot(3), slot(5)], now);
  const adapter = async (url, request) => {
    assert.equal(url, webhook);
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    const payload = JSON.parse(request.body);
    assert.equal(payload.timestamp, '1599360473');
    assert.equal(payload.sign, 'l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=');
    assert.doesNotMatch(request.body, /demo/);
    assert.equal(payload.msg_type, 'post');
    const { title, content } = payload.content.post.zh_cn;
    assert.equal(title, '候羽｜沙河校区新增 2 场次');
    assert.ok(content.flat().some(node => node.tag === 'text' && node.text.includes('3、5号')));
    assert.deepEqual(content.flat().filter(node => node.tag === 'a'), [
      { tag: 'a', text: '综合馆预约页', href: 'https://cgyy.buaa.edu.cn/venue/venue-reservation/57' },
    ]);
    return Response.json({ code: 0 });
  };
  assert.equal((await sendPush(connection, message, undefined, adapter)).kind, 'accepted');
});

test('Feishu distinguishes rejections, throttling and uncertain delivery', async () => {
  const connection = feishuConnection({ webhook });
  const message = notice('shahe', [slot(5)], now);
  const send = response => sendPush(connection, message, undefined, async (_url, request) => {
    const payload = JSON.parse(request.body);
    assert.ok(!Object.hasOwn(payload, 'timestamp') && !Object.hasOwn(payload, 'sign'));
    return response;
  });
  assert.equal((await send(Response.json({ StatusCode: 0, StatusMessage: 'success' }))).kind, 'accepted');
  assert.equal((await send(Response.json({ code: 19021 }, { status: 400 }))).kind, 'blocked');
  assert.equal((await send(Response.json({ code: 19024 }))).kind, 'blocked');
  assert.equal((await send(Response.json({ code: 11232 }))).retryAfterMs, 60000);
  assert.equal((await send(new Response('', { status: 429, headers: { 'retry-after': '90' } }))).retryAfterMs, 90000);
  assert.equal((await send(new Response('<html>', { status: 502 }))).kind, 'unknown');
  assert.equal((await send(Response.json({ code: 0 }, { status: 400 }))).kind, 'blocked');
});

test('a Feishu connection is sealed and survives reload', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'courtwatch-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'settings.json');
  const connection = feishuConnection({ webhook, secret: 'synthetic-signing-key' });
  const ciphertext = Buffer.from('sealed-by-test-vault');
  let plaintext;
  const vault = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) { plaintext = value; return ciphertext; },
    async decryptStringAsync(value) { assert.deepEqual(value, ciphertext); return { result: plaintext }; },
  };
  const store = new Preferences(file, vault);
  assert.equal(await store.saveConnection(connection), true);
  const saved = await readFile(file, 'utf8');
  assert.doesNotMatch(saved, /feishu\.cn|synthetic-signing-key/);
  const reopened = new Preferences(file, vault);
  await reopened.load();
  assert.deepEqual(reopened.connection, connection);
  vault.isAsyncEncryptionAvailable = async () => false;
  await assert.rejects(reopened.saveConnection(feishuConnection({ webhook })));
  assert.equal(await readFile(file, 'utf8'), saved);
  assert.deepEqual(reopened.connection, connection);
});

test('an unavailable OS vault leaves a new connection in memory only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'courtwatch-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'settings.json');
  const store = new Preferences(file, { async isAsyncEncryptionAvailable() { return false; } });
  await store.load();
  const connection = feishuConnection({ webhook, secret: 'mock-test-signing-key' });
  assert.equal(await store.saveConnection(connection), false);
  assert.deepEqual(store.connection, connection);
  assert.doesNotMatch(await readFile(file, 'utf8'), /feishu\.cn|mock-test/);
  const reopened = new Preferences(file, { async isAsyncEncryptionAvailable() { return false; } });
  await reopened.load();
  assert.equal(reopened.connection, null);
});
