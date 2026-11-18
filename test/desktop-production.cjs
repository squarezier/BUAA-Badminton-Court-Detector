'use strict';

// Exercise the real desktop entry point with isolated test services and a temporary profile.
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, powerMonitor, safeStorage, session } = require('electron');
const { beijingDay, calendarDates } = require('../src/courts.cjs');

const profile = path.resolve(process.argv.at(-1));
const legacyToken = 'SCTtest-houyu-local-token-01';
const legacyCiphertext = Buffer.from('legacy-test-connection');
const feishuCiphertext = Buffer.from('feishu-test-connection');
const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/11111111-2222-4333-8444-555555555555';
const secret = 'synthetic-feishu-signing-key';
const campusOrigin = 'https://cgyy.buaa.edu.cn';
const wallClock = Date.now;
let testClockOffset = Date.parse(`${beijingDay(wallClock())}T13:10:00+08:00`) - wallClock();
Date.now = () => wallClock() + testClockOffset;
const label = [...calendarDates(Date.now()).keys()][1];
let rejectSignature = false;
let pushRequests = 0;
let visibleCourts = [1];
let expired = false;
let loginFailure = '';
let changeVenueWhileReading = false;
let pushed = [];
let loads = 0;
let started = false;
let cases = 0;

process.env.COURTWATCH_DEV_PROFILE = profile;
fs.mkdirSync(profile, { recursive: true });
const settings = path.join(profile, 'settings.json');
fs.writeFileSync(settings, JSON.stringify({
  version: 1, options: { campus: 'shahe', interval: 2 }, encryptedToken: legacyCiphertext.toString('base64'),
}), { mode: 0o600 });
safeStorage.isAsyncEncryptionAvailable = async () => true;
safeStorage.decryptStringAsync = async value => {
  assert.deepEqual(value, legacyCiphertext);
  return { result: legacyToken };
};
safeStorage.encryptStringAsync = async value => {
  assert.deepEqual(JSON.parse(value), { provider: 'feishu', webhook, secret });
  return feishuCiphertext;
};

global.fetch = async (url, request) => {
  pushRequests++;
  assert.equal(url, webhook);
  assert.equal(request.method, 'POST');
  const { msg_type, timestamp, sign, card: { header, body } } = JSON.parse(request.body);
  const title = header.title.content;
  assert.equal(msg_type, 'interactive');
  assert.match(timestamp, /^\d{10}$/);
  assert.match(sign, /^[A-Za-z0-9+/]{43}=$/);
  assert.doesNotMatch(request.body, /synthetic-feishu-signing-key/);
  if (rejectSignature) {
    assert.match(title, /测试提醒/);
    return Response.json({ code: 19021 }, { status: 400 });
  }
  pushed.push({ title, content: body.elements.map(element => element.content ?? '').join('\n') });
  return Response.json({ code: 0 });
};

function venuePage() {
  const rows = [1, 2, 3, 4].map(id => {
    const state = visibleCourts.includes(id) ? 'free' : id === 2 ? 'reservation' : 'reserved';
    return `<tr><td>${id}号</td><td><div class="reserveBlock ${state}">￥15.00</div></td></tr>`;
  });
  const grid = `<tr><td>场地</td><td>07:00-08:00</td></tr>${rows.join('')}`;
  const update = changeVenueWhileReading ? `<script>setTimeout(() => {
    history.replaceState(null, '', '/venue/venue-reservation/39');
    document.querySelector('table').innerHTML = ${JSON.stringify(grid)};
  }, 250);</script>` : '';
  return `<style>.free{background:rgb(138,212,112)}.reservation,.reserved{background:rgb(253,75,55)}</style>
    <button>退出</button><div>开放时间 07:00 ~ 08:00</div>
    <div class="date_box"><div class="active"><span>${label}</span></div></div>
    <div class="spaceTable"><table>${changeVenueWhileReading ? '' : grid}</table></div>${update}`;
}

const html = body => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const mocked = app.whenReady().then(async () => {
  const campus = session.fromPartition('buaa-session');
  campus.protocol.handle('https', request => {
    const url = new URL(request.url);
    assert.equal(url.origin, campusOrigin);
    if (url.pathname === '/venue/login') {
      if (loginFailure === 'network') return Response.error();
      if (loginFailure === 'server') return new Response('Service Unavailable', { status: 503 });
      return expired ? html('<p>统一身份认证</p>') : Response.redirect(`${campusOrigin}/venue/home`);
    }
    if (url.pathname === '/venue/home') return html('<button>退出</button>');
    if (url.pathname.startsWith('/venue/venue-reservation/')) {
      loads++;
      return expired ? Response.redirect(`${campusOrigin}/venue/login`) : html(venuePage());
    }
    return new Response('', { status: 404 });
  });
  await campus.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:1' });
});

// Windows on Arm launches the x64 Chromium scanner under emulation for each of the 30 sleep/wake rounds.
const deadline = setTimeout(() => fail(new Error('Desktop end-to-end test timed out')), 180000);
function fail(error) { process.stderr.write(`${error.stack}\n`); app.exit(1); }

async function run(win) {
  await mocked;
  const js = code => win.webContents.executeJavaScript(code);
  const state = () => js('window.courtWatch.state()');
  async function click(selector) {
    const target = `document.querySelector(${JSON.stringify(selector)})`;
    await waitFor(() => js(`Boolean(${target} && !${target}.matches(':disabled'))`), `enabled control ${selector}`);
    return js(`${target}.click()`);
  }
  async function waitFor(passes, description) {
    const until = wallClock() + 15000;
    while (wallClock() < until) {
      const current = await state();
      if (await passes(current)) return current;
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    throw new Error(`Timed out: ${description}`);
  }
  const wake = () => { powerMonitor.emit('suspend'); powerMonitor.emit('resume'); };

  assert.equal((await state()).auth, 'signed-out');
  assert.equal(await js('document.querySelector("#monitor-action").disabled'), true);
  for (const failure of ['network', 'server']) {
    loginFailure = failure;
    await click('#account-action');
    await waitFor(async view => view.auth === 'signed-out' && await js(`
      !document.querySelector('#account-action').disabled && document.querySelector('#toast').textContent.includes('官网暂时无法打开')
    `), `login can be retried after a ${failure} error`);
  }
  loginFailure = '';
  cases++;
  await click('#account-action');
  await waitFor(view => view.auth === 'signed-in', 'sign-in');
  cases++;

  await click('[data-page=feishu]');
  const feedback = () => js("document.querySelector('#push-feedback').textContent");
  const submitConnection = address => js(`
    document.querySelector('#feishu-webhook').value = ${JSON.stringify(address)};
    document.querySelector('#feishu-secret').value = ${JSON.stringify(secret)};
    document.querySelector('#push-form').requestSubmit();
  `);
  const storedCiphertext = () => JSON.parse(fs.readFileSync(settings, 'utf8')).encryptedToken;
  assert.equal((await state()).pushService, 'serverchan', 'an existing WeChat channel is loaded on upgrade');
  await submitConnection(webhook.replace('open.feishu.cn', 'example.invalid'));
  await waitFor(async () => (await feedback()).includes('请填写飞书'), 'webhook validation');
  assert.equal(pushRequests, 0);
  assert.equal(storedCiphertext(), legacyCiphertext.toString('base64'));
  rejectSignature = true;
  await submitConnection(webhook);
  const retained = await waitFor(async () => (await feedback()).includes('签名校验失败'), 'rejected Feishu connection');
  assert.equal(retained.pushService, 'serverchan');
  assert.equal(storedCiphertext(), legacyCiphertext.toString('base64'));
  assert.equal(pushRequests, 1);
  cases++;

  testClockOffset += 16000;
  rejectSignature = false;
  await submitConnection(webhook);
  const connected = await waitFor(view => view.delivery.status === 'accepted', 'Feishu connection and test');
  assert.equal(connected.delivery.configured, true);
  assert.equal(connected.delivery.persistent, true);
  assert.equal(connected.pushService, 'feishu');
  assert.equal(storedCiphertext(), feishuCiphertext.toString('base64'));
  assert.doesNotMatch(fs.readFileSync(settings, 'utf8'), /feishu\.cn|synthetic-feishu-signing-key/);
  assert.doesNotMatch(JSON.stringify(connected), /feishu\.cn|synthetic-feishu-signing-key/);
  await waitFor(async () => await js("document.querySelector('#feishu-webhook').value === ''"), 'credential fields cleared');
  assert.match(pushed[0].title, /测试提醒/);
  assert.equal(pushed.length, 1);
  cases++;

  await click('[data-page=monitor]');
  await click('#monitor-action');
  await waitFor(view => view.running && !view.checking && view.slotCount === 1, 'first green baseline');
  assert.equal(pushed.length, 1);
  cases++;

  await js(`const field = document.querySelector('#interval'); field.value = '37'; field.dispatchEvent(new Event('input')); document.querySelector('#interval-form').requestSubmit()`);
  const adjusted = await waitFor(view => view.options.interval === 37 && view.nextAt !== null, 'custom interval while watching');
  assert.ok(adjusted.nextAt > Date.now() + 36 * 60000);
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).options.interval, 37);
  cases++;

  win.close();
  assert.equal(win.isVisible(), false);
  visibleCourts = [1, 2, 4];
  wake();
  await waitFor(view => view.slotCount === 3 && !view.checking && pushed.length === 2, 'only reopened slots are sent while hidden');
  assert.equal(pushed[1].title, '候羽｜沙河校区疑似退订 1 场次');
  assert.match(pushed[1].content, /已预约.*绿色可约/);
  assert.match(pushed[1].content, /07:00–08:00 · 综合馆[\s\S]*场号 \*\*4 号\*\*.*¥15\/场/);
  assert.match(pushed[1].content, /venue-reservation\/57/);
  assert.doesNotMatch(pushed[1].content, /1 号|2 号/);
  app.emit('activate');
  assert.equal(win.isVisible(), true);
  cases++;

  for (let round = 0; round < 30; round++) {
    const before = loads;
    wake();
    await waitFor(view => loads > before && !view.checking && view.nextAt !== null, `unchanged scan ${round + 1}`);
    assert.equal(pushed.length, 2);
    await waitFor(() => BrowserWindow.getAllWindows().length === 1, 'the scanner window is closed after every round');
  }
  cases++;

  changeVenueWhileReading = true;
  const beforeRedirect = loads;
  wake();
  const mismatched = await waitFor(view => loads > beforeRedirect && !view.checking && view.nextAt !== null, 'scan with changing venue URL');
  assert.equal(mismatched.slotCount, 0, 'a different venue URL invalidates an otherwise readable timetable');
  assert.match(mismatched.venues[0].error, /跳转异常/);
  assert.equal(pushed.length, 2);
  changeVenueWhileReading = false;
  cases++;

  win.hide();
  const rendererGone = once(win.webContents, 'render-process-gone', { signal: AbortSignal.timeout(15000) });
  win.webContents.forcefullyCrashRenderer();
  await rendererGone;
  const reloaded = once(win.webContents, 'did-finish-load', { signal: AbortSignal.timeout(15000) });
  const beforeRecovery = loads;
  wake();
  app.emit('activate');
  await reloaded;
  await waitFor(view => loads > beforeRecovery && view.running && !view.checking && view.slotCount === 3, 'reopen a crashed interface while monitoring continues');
  assert.equal(win.isVisible(), true);
  assert.equal(pushed.length, 2);
  cases++;

  await click('#open-booking');
  const bookingPage = await waitFor(() => BrowserWindow.getAllWindows().find(page =>
    page !== win && page.webContents.getURL() === `${campusOrigin}/venue/venue-reservation/57`
  ), 'official booking window');
  assert.equal((await state()).auth, 'signed-in');
  expired = true;
  wake();
  const last = await waitFor(view => view.auth === 'expired', 'sign-in expires');
  assert.equal(last.running, false);
  assert.equal(last.slotCount, 0);
  assert.equal(last.nextAt, null);
  assert.equal(pushed.length, 2);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await state()).auth, 'expired', 'an already open booking page cannot revive an expired login');
  await click('#account-action');
  await waitFor(view => view.auth === 'opening' && BrowserWindow.getAllWindows().some(page =>
    page !== win && page.webContents.getURL() === `${campusOrigin}/venue/login`
  ), 'relogin opens the official login page');
  expired = false;
  const loginPage = BrowserWindow.getAllWindows().find(page => page !== win && page.webContents.getURL().endsWith('/venue/login'));
  loginPage.webContents.reload();
  await waitFor(view => view.auth === 'signed-in', 'relogin after session expiry');
  cases++;

  await click('input[name="campus"][value="xueyuanlu"]');
  await waitFor(view => view.options.campus === 'xueyuanlu', 'switch to Xueyuanlu while paused');
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).options.campus, 'xueyuanlu');
  await click('#monitor-action');
  const xueyuanlu = await waitFor(view => view.running && !view.checking && view.slotCount === 6, 'both Xueyuanlu venues scanned');
  assert.deepEqual(xueyuanlu.rows.map(row => row.venue), ['38', '39']);
  assert.equal(pushed.length, 2);
  await click('#open-target');
  assert.equal(await js("document.querySelector('#page-target').hidden"), false);
  const targetDay = [...calendarDates(Date.now()).values()][1];
  await js(`
    document.querySelector('#target-date').value = ${JSON.stringify(targetDay)};
    document.querySelector('#target-start').value = '08:00';
    document.querySelector('#target-end').value = '07:00';
    document.querySelector('#target-form').requestSubmit();
  `);
  assert.match(await js("document.querySelector('#target-error').innerText"), /晚于开始/);
  assert.deepEqual((await state()).options.targets, {});
  await js(`document.querySelector('#target-start').value = '07:00';
    document.querySelector('#target-end').value = '08:00'`);
  const draftScan = loads;
  wake();
  await waitFor(view => loads > draftScan && !view.checking && view.nextAt !== null, 'unsubmitted target survives a background scan');
  assert.equal(await js("document.querySelector('#target-start').value"), '07:00');
  await js("document.querySelector('#target-form').requestSubmit()");
  const targeted = await waitFor(view => view.options.targets?.xueyuanlu?.start === '07:00', 'target saved through the form');
  assert.deepEqual(targeted.options.targets.xueyuanlu, { date: targetDay, start: '07:00', end: '08:00' });
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).options.targets, targeted.options.targets);
  assert.equal(storedCiphertext(), feishuCiphertext.toString('base64'));
  assert.equal(pushed.length, 2);
  cases++;

  visibleCourts = [1, 2, 3, 4];
  wake();
  await waitFor(view => view.slotCount === 8 && !view.checking && pushed.length === 3, 'both venues reopen and all matching courts reach Feishu');
  assert.match(pushed[2].title, /目标场次重新可约.*学院路校区 2 场次/);
  assert.match(pushed[2].content, /07:00–08:00.*体育馆训练馆[\s\S]*场号 \*\*3 号\*\*/);
  assert.match(pushed[2].content, /07:00–08:00.*体育馆主馆[\s\S]*场号 \*\*3 号\*\*/);
  assert.doesNotMatch(pushed[2].content, /综合馆|venue-reservation\/57/);
  for (const [campus, target] of [
    ['shahe', targeted.options.targets.xueyuanlu],
    ['xueyuanlu', { ...targeted.options.targets.xueyuanlu, date: '2000-01-01' }],
    ['xueyuanlu', { ...targeted.options.targets.xueyuanlu, end: '06:59' }],
  ]) {
    await assert.rejects(js(`window.courtWatch.saveTarget(${JSON.stringify(campus)}, ${JSON.stringify(target)})`));
  }
  assert.deepEqual((await state()).options.targets, targeted.options.targets);
  cases++;
  await click('[data-page=monitor]');
  await click('#monitor-action');
  await waitFor(view => !view.running && view.nextAt === null, 'manual pause cancels scheduling');
  cases++;

  await click('input[name="campus"][value="shahe"]');
  await waitFor(view => view.options.campus === 'shahe', 'Shahe retains all alerts');
  assert.equal(await js("document.querySelector('#shortcut-range').textContent"), '全部退订');
  await click('input[name="campus"][value="xueyuanlu"]');
  await waitFor(view => view.options.campus === 'xueyuanlu', 'target restored for the other campus');
  await click('#open-target');
  assert.equal(await js("document.querySelector('#target-start').value"), '07:00');
  await click('#clear-target');
  await waitFor(view => !Object.hasOwn(view.options.targets, 'xueyuanlu'), 'clearing the target restores all reopenings without sending');
  assert.equal(await js("document.querySelector('#saved-range').textContent"), '全部退订');
  assert.equal(pushed.length, 3);
  await click('[data-page=monitor]');
  cases++;

  await click('#account-action');
  const signedOut = await waitFor(view => view.auth === 'signed-out', 'explicit sign-out');
  assert.equal(signedOut.delivery.configured, true);
  cases++;

  await click('[data-page=feishu]');
  await click('#remove-connection');
  await waitFor(view => !view.delivery.configured && view.pushService === null, 'disconnect notification provider');
  assert.equal(storedCiphertext(), null);
  assert.equal(pushed.length, 3);
  cases++;

  clearTimeout(deadline);
  for (const window of BrowserWindow.getAllWindows()) if (window !== win) window.destroy();
  process.stdout.write(`Production desktop ${process.arch}: ${cases} end-to-end scenarios passed, including 30 consecutive scanner-window cleanup checks.\n`);
  app.quit();
}

app.on('browser-window-created', (_event, window) => {
  window.webContents.on('did-finish-load', () => {
    if (started || window.webContents.getURL() !== 'courtwatch://app/index.html') return;
    started = true;
    run(window).catch(fail);
  });
});

require('../src/main.cjs');
