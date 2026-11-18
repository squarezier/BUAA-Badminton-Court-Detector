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

test('the third calendar day opens at 07:00 Beijing time even across a year boundary', () => {
  const release = Date.parse('2026-12-31T07:00:00+08:00');
  assert.deepEqual([...calendarDates(release - 1).values()], ['2026-12-31', '2027-01-01']);
  assert.deepEqual([...calendarDates(release).values()], ['2026-12-31', '2027-01-01', '2027-01-02']);
  const newDay = { label: '1月2日', slots: [{ court: 4, start: '08:00', end: '09:00', price: 15 }] };
  assert.throws(() => validatedSnapshot('57', [newDay], release - 1));
  assert.equal(validatedSnapshot('57', [newDay], release).slots[0].date, '2027-01-02');
});

test('validated snapshots keep confirmed reservations separate from green slots', () => {
  const reserved = { court: 4, start: '17:00', end: '18:00' };
  const available = { ...reserved, court: 5, price: 25 };
  const snapshot = validatedSnapshot('57', [{ label: '11月18日', slots: [available], reserved: [reserved, reserved] }], now);
  assert.deepEqual(snapshot.slots, [slot(5)]);
  assert.deepEqual(snapshot.reserved, [{ ...reserved, venue: '57', date: '2026-11-18' }]);
  assert.throws(() => validatedSnapshot('57', [{ label: '11月18日', slots: [available], reserved: [available] }], now));
  assert.throws(() => validatedSnapshot('57', [{ label: '11月18日', slots: [], reserved: [{ ...reserved, start: '25:00' }] }], now));
});

test('duplicate available cells must agree on the price', () => {
  const available = { court: 3, start: '17:00', end: '18:00', price: 25 };
  const read = slots => validatedSnapshot('57', [{ label: '11月18日', slots }], now);
  assert.equal(read([available, available]).slots.length, 1);
  assert.throws(() => read([available, { ...available, price: 15 }]), /价格/);
});

test('initial availability and a newly published green slot do not send a notice', async t => {
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
  assert.equal(pushes.length, 0);
  assert.equal(monitor.state().slotCount, 3);
});

test('a confirmed reservation reopening gets a distinct alert for the exact venue and slot', async t => {
  const reserved = slot(3, '38');
  const openingNextDay = { ...reserved, date: '2026-11-19' };
  const response = new Map([
    ['38', { ...sample(slot(1, '38')), reserved: [reserved] }],
    ['39', sample()],
  ]);
  const pushes = [];
  const monitor = new CourtMonitor({
    options: { campus: 'xueyuanlu', interval: 2 }, now: () => now, onChange() {},
    async checkVenue(id) { return response.get(id); },
    async dispatch(message) { pushes.push(message); return { kind: 'accepted', text: 'accepted' }; },
  });
  t.after(() => monitor.stop());
  monitor.setAuth('signed-in');
  monitor.setDelivery(true, true);
  monitor.start();
  await monitor.check();
  assert.equal(pushes.length, 0);

  response.set('38', sample(slot(1, '38'), reserved, openingNextDay));
  response.set('39', sample(slot(3, '39')));
  await monitor.check();
  await monitor.check();
  assert.deepEqual(pushes.map(message => message.title), ['候羽｜学院路校区疑似退订 1 场次']);
  const card = pushes[0].feishuCard.body.elements.map(element => element.content).join('\n');
  assert.match(card, /已预约.*绿色可约/);
  assert.match(card, /11月18日[\s\S]*17:00–18:00 · 体育馆主馆[\s\S]*场号 \*\*3 号\*\*[\s\S]*¥25\/场/);
  assert.match(card, /venue-reservation\/38/);
  assert.doesNotMatch(card, /11月19日|训练馆|venue-reservation\/39|1 号/);

  response.set('38', { ...sample(slot(1, '38'), openingNextDay), reserved: [reserved] });
  await monitor.check();
  response.set('38', sample(slot(1, '38'), reserved, openingNextDay));
  await monitor.check();
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].title, pushes[0].title, 'a second verified reservation and release is a new event');
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
    assert.equal(request.body.get('title'), '候羽｜沙河校区疑似退订 2 场次');
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

test('Feishu sends a signed availability card with the official booking link', async t => {
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
    assert.equal(payload.msg_type, 'interactive');
    const { schema, header, body: { elements } } = payload.card;
    assert.equal(schema, '2.0');
    assert.equal(header.title.content, '候羽｜沙河校区疑似退订 2 场次');
    assert.match(elements[0].content, /已预约变为绿色可约/);
    assert.match(elements[1].content, /\*\*11月18日 周三\*\*/);
    assert.match(elements[1].content, /\*\*17:00–18:00 · 综合馆\*\*/);
    assert.match(elements[1].content, /场号 \*\*3、5 号\*\*.*¥25\/场/u);
    assert.match(elements.at(-1).content, /\[综合馆 ↗\]\(https:\/\/cgyy\.buaa\.edu\.cn\/venue\/venue-reservation\/57\)/u);
    return Response.json({ code: 0 });
  };
  assert.equal((await sendPush(connection, message, undefined, adapter)).kind, 'accepted');
});

test('Feishu lists each date separately and caps large notices within the request limit', async () => {
  const first = { ...slot(3, '38'), date: '2026-11-19' };
  const second = { ...slot(5, '39'), date: '2026-11-20', price: 0 };
  const elements = notice('xueyuanlu', [second, first], now).feishuCard.body.elements;
  assert.match(elements[1].content, /11月19日 周四[\s\S]*体育馆主馆[\s\S]*3 号/u);
  assert.match(elements[2].content, /11月20日 周五[\s\S]*体育馆训练馆[\s\S]*5 号[\s\S]*免费/u);
  const crowded = Array.from({ length: 30 }, (_, index) =>
    Array.from({ length: 120 }, (_, court) => ({
      ...slot(court + 1, '38'), date: index < 15 ? first.date : second.date, price: index + 1,
    }))).flat();
  const adapter = async (_url, request) => {
    assert.ok(Buffer.byteLength(request.body) <= 20000);
    assert.match(request.body, /另有 [1-9]\d* 组场次/u);
    return Response.json({ code: 0 });
  };
  assert.equal((await sendPush(feishuConnection({ webhook }), notice('xueyuanlu', crowded, now), undefined, adapter)).kind, 'accepted');
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
  const ciphertext = Buffer.from('v11sealed-by-test-vault');
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

test('Linux persists connections only with the OS Secret Service or Secret portal provider', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'houyu-linux-vault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const tag of ['v10', '???', 'v11', 'v12']) {
    const file = join(directory, tag === '???' ? 'unknown' : tag);
    const bytes = Buffer.from(tag + 'test-ciphertext');
    const vault = { async isAsyncEncryptionAvailable() { return true; }, async encryptStringAsync() { return bytes; } };
    const prefs = new Preferences(file, vault, 'linux');
    const secure = tag === 'v11' || tag === 'v12';
    assert.equal(await prefs.saveConnection(feishuConnection({ webhook })), secure);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).encryptedToken, secure ? bytes.toString('base64') : null);
  }
});
