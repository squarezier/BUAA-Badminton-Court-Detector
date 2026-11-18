'use strict';

// Run with Electron and a writable test directory. This fixture uses no network or real accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const { readBookingPage, signedInOnBookingSite } = require('../src/site-page.cjs');

const target = path.resolve(process.argv.at(-1));
mkdirSync(target, { recursive: true });
app.setPath('userData', target);
app.enableSandbox();
app.on('window-all-closed', () => {});
protocol.registerSchemesAsPrivileged([{ scheme: 'courtwatch', privileges: { standard: true, secure: true } }]);

const auditedVenues = [
  { opening: 7, courts: Array.from({ length: 12 }, (_, index) => index + 1), slots: [[1, 7, [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12]]] },
  { opening: 7, courts: [17, 18, 19, 20, 21, 22, 23, 24], slots: [[1, 7, [17, 18, 19, 20, 21, 22, 23, 24]], [2, 7, [18, 19, 20, 21, 22, 23, 24]]] },
  { opening: 8, courts: [1, 2, 3, 4, 5, 6, 7, 8], slots: [[2, 12, [5, 7, 8]], [2, 13, [7]], [2, 14, [4, 5, 7, 8]], [2, 15, [8]]] },
];

function fixture({ opening, courts, slots, inconsistentFill, closed = [], missingHour, switchDelay = 270 }) {
  const buttons = [...document.querySelectorAll('.date_box > div')];
  const table = document.querySelector('table');
  const closure = document.querySelector('.ivu-table-tip');
  const starts = [opening, opening + 5, opening + 10];
  let selected = 0;
  let page = 1;
  const hour = value => `${String(value).padStart(2, '0')}:00`;
  function draw() {
    table.replaceChildren();
    closure.hidden = !closed.includes(selected);
    if (!closure.hidden) return;
    const header = table.insertRow();
    header.insertCell().textContent = '场地';
    const first = starts[page];
    for (let current = first; current < Math.min(22, first + 5); current++) {
      if (current === missingHour) continue;
      const column = header.insertCell();
      column.textContent = `${hour(current)}-${hour(current + 1)}`;
      const addArrow = (className, direction) => {
        const arrow = document.createElement('i');
        arrow.className = className;
        arrow.textContent = '→';
        arrow.onclick = () => { page += direction; draw(); };
        column.append(arrow);
      };
      if (page && current === first) addArrow('ivu-icon-ios-arrow-back', -1);
      if (page < 2 && current === first + 4) addArrow('ivu-icon-ios-arrow-forward', 1);
    }
    for (const court of courts) {
      const row = table.insertRow();
      row.insertCell().textContent = `${court}号`;
      for (let current = first; current < Math.min(22, first + 5); current++) {
        if (current === missingHour) continue;
        const available = slots.some(([date, start, ids]) => date === selected && start === current && ids.includes(court));
        const disabled = selected === 0 && current < 14;
        const block = document.createElement('div');
        block.className = `reserveBlock position ${available ? 'free' : disabled ? 'free disabled' : 'reserved'}`;
        block.textContent = '￥15.00';
        if (available && inconsistentFill) block.style.backgroundColor = inconsistentFill;
        row.insertCell().append(block);
      }
    }
  }
  buttons.forEach((button, index) => {
    button.onclick = () => {
      buttons[selected].classList.remove('active');
      button.classList.add('active');
      setTimeout(() => { selected = index; page = 0; draw(); }, switchDelay);
    };
  });
  draw();
}

async function run() {
  const source = path.join(__dirname, '..', 'src');
  const preferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false };
  const page = new BrowserWindow({ show: false, webPreferences: preferences });
  const clock = hour => `${String(hour).padStart(2, '0')}:00`;
  async function readFixture(spec) {
    const fixtureHtml = `<style>.free{background-color:rgb(138,212,112)} .reserved{background-color:rgb(253,75,55)} .disabled{background-color:rgb(225,225,225)}</style>
      <button><i></i>退出</button><div>开放时间 ${clock(spec.opening)} ~ 22:00</div>
      <div class="date_box"><div class="active"><span>11月18日</span></div><div><span>11月19日</span></div><div><span>11月20日</span></div></div>
      <div class="spaceTable"><table></table><p class="ivu-table-tip" hidden>当天场地暂停开放</p></div><script>(${fixture.toString()})(${JSON.stringify(spec)});</script>`;
    await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fixtureHtml)}`);
    assert.equal(await page.webContents.executeJavaScriptInIsolatedWorld(1201, [{ code: `(${signedInOnBookingSite.toString()})()` }]), true);
    return page.webContents.executeJavaScriptInIsolatedWorld(1201, [{
      code: `(${readBookingPage.toString()})({ todayLabel: '11月18日', nowClock: '14:08' })`,
    }]);
  }
  for (const spec of auditedVenues) {
    const result = await readFixture(spec);
    assert.deepEqual(result.days.map(day => day.label), ['11月18日', '11月19日', '11月20日']);
    const actual = result.days.flatMap(({ slots }, day) => slots.map(({ court, start, end, price }) => `${day}/${start}/${end}/${court}/${price}`));
    const expected = spec.slots.flatMap(([day, hour, courts]) => courts.map(court => `${day}/${clock(hour)}/${clock(hour + 1)}/${court}/15`));
    assert.deepEqual(actual.sort(), expected.sort());
  }
  const conflict = await readFixture({ ...auditedVenues[2], inconsistentFill: 'rgb(225, 225, 225)' });
  assert.deepEqual(conflict, { error: 'colors' });
  const afterClosure = await readFixture({ ...auditedVenues[1], closed: [0], switchDelay: 650 });
  assert.deepEqual(afterClosure.days.map(day => day.slots.length), [0, 8, 7]);
  const incomplete = await readFixture({ ...auditedVenues[0], missingHour: 19 });
  assert.deepEqual(incomplete, { error: 'layout' });
  page.destroy();

  const state = {
    options: { campus: 'shahe', interval: 2 }, auth: 'signed-in', running: true, checking: false,
    suspended: false, nextAt: Date.parse('2026-11-18T14:10:00+08:00'), lastAt: Date.parse('2026-11-18T14:08:00+08:00'), slotCount: 9,
    rows: [
      { date: '2026-11-18', start: '17:00', end: '18:00', venue: '57', courts: [3, 5], price: 25 },
      { date: '2026-11-20', start: '12:00', end: '13:00', venue: '57', courts: [5, 7, 8], price: 15 },
      { date: '2026-11-20', start: '14:00', end: '15:00', venue: '57', courts: [4, 5, 7, 8], price: 15 },
    ],
    venues: [{ id: '57', label: '综合馆', dates: ['2026-11-18', '2026-11-19', '2026-11-20'], at: 1, error: '' }],
    delivery: { configured: true, persistent: true, status: 'ready', text: '', at: null }, pushService: 'feishu',
  };
  ipcMain.handle('courtwatch:state', () => ({ ok: true, value: state }));
  ipcMain.handle('courtwatch:start', event => {
    event.sender.send('courtwatch:state', { ...state, running: true });
    return { ok: true };
  });
  const assets = { '/index.html': 'text/html', '/styles.css': 'text/css', '/renderer.js': 'text/javascript', '/icon.png': 'image/png' };
  session.defaultSession.protocol.handle('courtwatch', async request => {
    const item = new URL(request.url).pathname;
    if (!Object.hasOwn(assets, item)) return new Response('Not found', { status: 404 });
    return new Response(await fs.readFile(path.join(source, 'ui', item.slice(1))), { headers: { 'content-type': `${assets[item]}; charset=utf-8` } });
  });
  const window = new BrowserWindow({ width: 1130, height: 820, show: false, webPreferences: { ...preferences, preload: path.join(source, 'preload.cjs') } });
  await window.loadURL('courtwatch://app/index.html');
  await window.webContents.insertCSS('* { transition: none !important; }', { cssOrigin: 'user' });
  await window.webContents.executeJavaScript("Date.now = () => Date.parse('2026-11-18T14:08:00+08:00'); window.dispatchEvent(new Event('focus'))");
  const code = `new Promise((resolve, reject) => {
    const deadline = performance.now() + 3000;
    const timer = setInterval(() => {
      const ready = document.getElementById('rows').innerText.includes('3、5号');
      if (ready || performance.now() > deadline) {
        clearInterval(timer);
        if (!ready) return reject(new Error('UI did not render mock slots'));
        resolve(document.getElementById('account-state').textContent);
      }
    }, 25);
  })`;
  assert.equal(await window.webContents.executeJavaScript(code), '已登录');
  const paint = () => window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await window.webContents.executeJavaScript("document.title"), '候羽');
  const logoWidth = await window.webContents.executeJavaScript("(async () => { const logo = document.querySelector('.brand img'); await logo.decode(); return logo.naturalWidth; })()");
  assert.equal(logoWidth, 512);
  const sideBySide = () => window.webContents.executeJavaScript(`
    document.querySelector('.settings').getBoundingClientRect().left >
      document.querySelector('.schedule').getBoundingClientRect().left
  `);
  assert.equal(await sideBySide(), true, 'Monitoring settings sit beside the results at the default width');
  await paint();
  await fs.writeFile(path.join(target, 'monitor.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("document.querySelector('[data-page=feishu]').click()");
  await paint();
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#page-feishu').hidden"), false);
  await fs.writeFile(path.join(target, 'feishu.png'), (await window.webContents.capturePage()).toPNG());
  window.setSize(760, 630);
  await paint();
  const viewportFit = () => window.webContents.executeJavaScript('innerWidth === 760 && document.documentElement.scrollWidth <= innerWidth');
  assert.equal(await viewportFit(), true, 'Feishu page fits the minimum width');
  await window.webContents.executeJavaScript("document.querySelector('[data-page=monitor]').click()");
  await paint();
  assert.equal(await viewportFit(), true, 'Monitor page fits the minimum width');
  assert.equal(await sideBySide(), false, 'Monitoring settings move below the results at the minimum width');
  const expiredSlotRemoved = await window.webContents.executeJavaScript(`new Promise(resolve => {
    const baseline = performance.now();
    Date.now = () => Date.parse('2026-11-18T16:59:59.800+08:00') + performance.now() - baseline;
    window.dispatchEvent(new Event('focus'));
    const until = performance.now() + 1800;
    const timer = setInterval(() => {
      const count = document.querySelector('#count').textContent;
      if (count === '7' || performance.now() > until) { clearInterval(timer); resolve(count === '7'); }
    }, 25);
  })`);
  assert.equal(expiredSlotRemoved, true, 'a started slot disappears from the table between scans');
  window.destroy();
  process.stdout.write('Electron UI, three venue replays, stale closures, missing time columns, wrong colors, and expiry display passed.\n');
  app.exit(0);
}

app.whenReady().then(run).catch(error => {
  process.stderr.write(`${error.stack}\n`);
  app.exit(1);
});
