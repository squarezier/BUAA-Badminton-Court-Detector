'use strict';

// Exercise the real desktop entry point with isolated test services and a temporary profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, powerMonitor, safeStorage, session } = require('electron');
const { calendarDates } = require('../src/courts.cjs');

const profile = path.resolve(process.argv.at(-1));
const syntheticToken = 'test-houyu-local-token-01';
const campusOrigin = 'https://cgyy.buaa.edu.cn';
const label = [...calendarDates(Date.now()).keys()][1];
let visibleCourts = [1];
let expired = false;
let pushed = [];
let loads = 0;
let started = false;
let cases = 0;

process.env.COURTWATCH_DEV_PROFILE = profile;
fs.mkdirSync(profile, { recursive: true });
const settings = path.join(profile, 'settings.json');
fs.writeFileSync(settings, JSON.stringify({ version: 1, options: { campus: 'shahe', interval: 2 }, encryptedToken: null }), { mode: 0o600 });
safeStorage.isAsyncEncryptionAvailable = async () => false;

global.fetch = async (url, request) => {
  assert.equal(url, 'https://www.pushplus.plus/send');
  assert.equal(request.method, 'POST');
  const { token, title, content, channel } = JSON.parse(request.body);
  assert.equal(token, syntheticToken);
  assert.equal(channel, 'wechat');
  pushed.push({ title, content });
  return Response.json({ code: 200 });
};

function venuePage() {
  const rows = [1, 2, 3, 4].map(id => `<tr><td>${id}号</td><td><div class="reserveBlock ${visibleCourts.includes(id) ? 'free' : 'reserved'}">￥15.00</div></td></tr>`);
  return `<style>.free{background:rgb(138,212,112)}.reserved{background:rgb(253,75,55)}</style>
    <button>退出</button><div>开放时间 07:00 ~ 08:00</div>
    <div class="date_box"><div class="active"><span>${label}</span></div></div>
    <div class="spaceTable"><table><tr><td>场地</td><td>07:00-08:00</td></tr>${rows.join('')}</table></div>`;
}

const html = body => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const mocked = app.whenReady().then(async () => {
  const campus = session.fromPartition('buaa-session');
  campus.protocol.handle('https', request => {
    const url = new URL(request.url);
    assert.equal(url.origin, campusOrigin);
    if (url.pathname === '/venue/login') return expired ? html('<p>统一身份认证</p>') : Response.redirect(`${campusOrigin}/venue/home`);
    if (url.pathname === '/venue/home') return html('<button>退出</button>');
    if (url.pathname.startsWith('/venue/venue-reservation/')) {
      loads++;
      return expired ? Response.redirect(`${campusOrigin}/venue/login`) : html(venuePage());
    }
    return new Response('', { status: 404 });
  });
  await campus.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:1' });
});

const deadline = setTimeout(() => fail(new Error('Desktop end-to-end test timed out')), 40000);
function fail(error) { process.stderr.write(`${error.stack}\n`); app.exit(1); }

async function run(win) {
  await mocked;
  const js = code => win.webContents.executeJavaScript(code);
  const state = () => js('window.courtWatch.state()');
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  async function waitFor(passes, description) {
    for (let tries = 0; tries < 150; tries++) {
      const current = await state();
      if (passes(current)) return current;
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    throw new Error(`Timed out: ${description}`);
  }
  const wake = () => { powerMonitor.emit('suspend'); powerMonitor.emit('resume'); };

  assert.equal((await state()).auth, 'signed-out');
  assert.equal(await js('document.querySelector("#monitor-action").disabled'), true);
  await click('#account-action');
  await waitFor(view => view.auth === 'signed-in', 'sign-in');
  cases++;

  await click('[data-page=wechat]');
  await js(`document.querySelector('#push-token').value = ${JSON.stringify(syntheticToken)}; document.querySelector('#token-form').requestSubmit()`);
  await waitFor(view => view.delivery.configured, 'token storage');
  assert.doesNotMatch(fs.readFileSync(settings, 'utf8'), new RegExp(syntheticToken));
  await click('#push-test');
  await waitFor(view => view.delivery.status === 'accepted', 'test push');
  assert.match(pushed[0].title, /测试提醒/);
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
  visibleCourts = [1, 4];
  wake();
  await waitFor(view => view.slotCount === 2 && !view.checking && pushed.length === 2, 'new green slot while hidden');
  assert.match(pushed[1].content, /4号/);
  assert.doesNotMatch(pushed[1].content, /1号/);
  app.emit('activate');
  assert.equal(win.isVisible(), true);
  cases++;

  for (let round = 0; round < 30; round++) {
    const before = loads;
    wake();
    await waitFor(view => loads > before && !view.checking && view.nextAt !== null, `unchanged scan ${round + 1}`);
    assert.equal(pushed.length, 2);
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'the scanner window is closed after every round');
  }
  cases++;

  expired = true;
  wake();
  const last = await waitFor(view => view.auth === 'expired', 'sign-in expires');
  assert.equal(last.running, false);
  assert.equal(last.slotCount, 0);
  assert.equal(last.nextAt, null);
  assert.equal(pushed.length, 2);
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
