'use strict';

// Run with Electron and a writable test directory. This fixture uses no network or real accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeTheme, protocol, session } = require('electron');
const { readBookingPage, signedInOnBookingSite } = require('../src/site-page.cjs');
const { beijingClock, calendarDates } = require('../src/courts.cjs');

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

function fixture({ opening, courts, slots, inconsistentFill, closed = [], missingHour, switchDelay = 270,
  decorateBeforeRefresh = false, hiddenAvailableCell = false, pageDelay = 0, overlapping = false, otherCells = [], blankAfterClosing = false }) {
  const buttons = [...document.querySelectorAll('.date_box > div')];
  const table = document.querySelector('table');
  const head = table.createTHead();
  const body = table.createTBody();
  const closure = document.querySelector('.ivu-table-tip');
  const starts = overlapping ? [opening, opening + 4, opening + 8, 17] : [opening, opening + 5, opening + 10];
  let selected = 0;
  let page = 1;
  const hour = value => `${String(value).padStart(2, '0')}:00`;
  function drawHeader() {
    head.replaceChildren();
    if (!closure.hidden || (blankAfterClosing && selected === 0)) return;
    const header = head.insertRow();
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
        arrow.onclick = () => {
          page += direction;
          drawHeader();
          if (pageDelay) setTimeout(drawRows, pageDelay);
          else drawRows();
        };
        column.append(arrow);
      };
      if (page && current === first) addArrow('ivu-icon-ios-arrow-back', -1);
      if (page < starts.length - 1 && current === first + 4) addArrow('ivu-icon-ios-arrow-forward', 1);
    }
  }
  function drawRows() {
    body.replaceChildren();
    if (!closure.hidden || (blankAfterClosing && selected === 0)) return;
    const first = starts[page];
    for (const court of courts) {
      const row = body.insertRow();
      row.insertCell().textContent = `${court}号`;
      for (let current = first; current < Math.min(22, first + 5); current++) {
        if (current === missingHour) continue;
        const soldBetweenPages = overlapping && selected === 1 && current === starts[1] && page > 0;
        const available = !soldBetweenPages && slots.some(([date, start, ids]) => date === selected && start === current && ids.includes(court));
        const disabled = selected === 0 && current < 14;
        const block = document.createElement('div');
        const special = otherCells.find(entry => entry.day === selected && entry.hour === current && entry.court === court);
        const status = special?.status ?? (available ? 'free' : disabled ? 'free disabled' : 'reserved');
        block.className = `reserveBlock position ${status}`;
        block.textContent = '￥15.00';
        if (available && inconsistentFill) block.style.backgroundColor = inconsistentFill;
        const cell = row.insertCell();
        if (special?.hidden || (available && hiddenAvailableCell)) cell.style.opacity = '0';
        cell.append(block);
      }
    }
  }
  function draw() {
    closure.hidden = !closed.includes(selected);
    drawHeader();
    drawRows();
  }
  buttons.forEach((button, index) => {
    button.onclick = () => {
      buttons[selected].classList.remove('active');
      button.classList.add('active');
      if (decorateBeforeRefresh) {
        const stale = table.querySelector('.reserveBlock');
        stale.style.borderColor = 'blue';
        stale.classList.add('selected-time-outline');
      }
      setTimeout(() => { selected = index; page = 0; draw(); }, switchDelay);
    };
  });
  draw();
}

async function run() {
  nativeTheme.themeSource = 'light';
  const source = path.join(__dirname, '..', 'src');
  const preferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false };
  const page = new BrowserWindow({ show: false, webPreferences: preferences });
  const clock = hour => `${String(hour).padStart(2, '0')}:00`;
  async function readFixture(spec, at = Date.parse('2026-11-18T14:08:00+08:00')) {
    const fixtureHtml = `<style>.free{background-color:rgb(138,212,112)} .reserved,.reservation{background-color:rgb(253,75,55)} .disabled{background-color:rgb(225,225,225)}</style>
      <button><i></i>退出</button><div>开放时间 ${clock(spec.opening)} ~ 22:00</div>
      <div class="date_box"><div class="active"><span>11月18日</span></div><div><span>11月19日</span></div><div ${spec.disableThirdDay ? 'aria-disabled="true"' : ''}><span>11月20日</span></div></div>
      <div class="spaceTable"><table></table><p class="ivu-table-tip" hidden>当天场地暂停开放</p></div><script>(${fixture.toString()})(${JSON.stringify(spec)});</script>`;
    await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fixtureHtml)}`);
    assert.equal(await page.webContents.executeJavaScriptInIsolatedWorld(1201, [{ code: `(${signedInOnBookingSite.toString()})()` }]), true);
    const readOptions = { bookableLabels: [...calendarDates(at).keys()], nowClock: beijingClock(at) };
    return page.webContents.executeJavaScriptInIsolatedWorld(1201, [{
      code: `(${readBookingPage.toString()})(${JSON.stringify(readOptions)})`,
    }]);
  }
  for (const spec of auditedVenues) {
    const result = await readFixture(spec);
    assert.deepEqual(result.days.map(day => day.label), ['11月18日', '11月19日', '11月20日']);
    const actual = result.days.flatMap(({ slots }, day) => slots.map(({ court, start, end, price }) => `${day}/${start}/${end}/${court}/${price}`));
    const expected = spec.slots.flatMap(([day, hour, courts]) => courts.map(court => `${day}/${clock(hour)}/${clock(hour + 1)}/${court}/15`));
    assert.deepEqual(actual.sort(), expected.sort());
  }
  const morning = Date.parse('2026-11-18T07:00:00+08:00');
  const beforeRelease = await readFixture(auditedVenues[2], morning - 1);
  assert.deepEqual(beforeRelease.days.map(day => day.label), ['11月18日', '11月19日']);
  const afterRelease = await readFixture(auditedVenues[2], morning);
  assert.deepEqual(afterRelease.days.map(day => day.label), ['11月18日', '11月19日', '11月20日']);
  assert.ok(afterRelease.days[2].slots.length > 0, 'the newly released day is read even when play starts at 08:00');
  const disabledAfterRelease = await readFixture({ ...auditedVenues[2], disableThirdDay: true }, morning);
  assert.deepEqual(disabledAfterRelease.days.map(day => day.label), ['11月18日', '11月19日']);
  const conflict = await readFixture({ ...auditedVenues[2], inconsistentFill: 'rgb(225, 225, 225)' });
  assert.deepEqual(conflict, { error: 'colors' });
  const afterClosure = await readFixture({ ...auditedVenues[1], closed: [0], switchDelay: 650 });
  assert.deepEqual(afterClosure.days.map(day => day.slots.length), [0, 8, 7]);
  const night = await readFixture({ ...auditedVenues[1], blankAfterClosing: true }, Date.parse('2026-11-18T22:01:00+08:00'));
  assert.deepEqual(night.days.map(day => day.slots.length), [0, 8, 7], 'an empty table after closing must not hide the next two dates');
  const afterDecoration = await readFixture({ ...auditedVenues[1], decorateBeforeRefresh: true, switchDelay: 900 });
  assert.equal(afterDecoration.error, undefined, 'a date switch can complete after the real refresh');
  assert.deepEqual(afterDecoration.days.map(day => day.slots.length), [0, 8, 7], 'visual changes must not make stale rows count for a new date');
  const delayedPage = await readFixture({ opening: 7, courts: [1, 2], slots: [[1, 7, [1]], [1, 12, [2]]], pageDelay: 400 });
  assert.deepEqual(delayedPage.days[1].slots.map(({ start, court }) => [start, court]), [['07:00', 1], ['12:00', 2]],
    'a changed header alone cannot move an old green cell to a different time');
  const overlappingPages = await readFixture({ opening: 7, courts: [1, 2], slots: [[1, 11, [1]], [1, 12, [2]]], overlapping: true });
  assert.deepEqual(overlappingPages.days[1].slots.map(({ start, court }) => [start, court]), [['12:00', 2]],
    'a later page supersedes a green cell that was sold in an overlapping time column');
  assert.ok(overlappingPages.days[1].reserved.some(slot => slot.start === '11:00' && slot.court === 1));
  const separateStates = await readFixture({ opening: 7, courts: [1, 2, 3, 4], slots: [[1, 9, [4]]], otherCells: [
    { day: 1, hour: 9, court: 1, status: 'reservation' },
    { day: 1, hour: 9, court: 2, status: 'reserved disabled' },
    { day: 1, hour: 10, court: 1, status: 'reserved', hidden: true },
  ] });
  assert.deepEqual(separateStates.days[1].reserved.filter(slot => slot.start === '09:00').map(slot => slot.court), [3]);
  assert.deepEqual(separateStates.days[1].slots.filter(slot => slot.start === '09:00').map(slot => slot.court), [4]);
  assert.ok(!separateStates.days[1].reserved.some(slot => slot.start === '10:00' && slot.court === 1));
  const invisible = await readFixture({ ...auditedVenues[2], hiddenAvailableCell: true });
  assert.deepEqual(invisible, { error: 'colors' }, 'a green block hidden by its parent is unverified');
  const incomplete = await readFixture({ ...auditedVenues[0], missingHour: 19 });
  assert.deepEqual(incomplete, { error: 'layout' });
  page.destroy();

  const state = {
    options: { campus: 'xueyuanlu', interval: 2, targets: { xueyuanlu: {
      date: '2026-11-20', start: '18:00', end: '20:00',
    } } }, auth: 'signed-in', running: true, checking: false,
    suspended: false, nextAt: Date.parse('2026-11-18T14:10:00+08:00'), lastAt: Date.parse('2026-11-18T14:08:00+08:00'), slotCount: 9,
    rows: [
      { date: '2026-11-18', start: '17:00', end: '18:00', venue: '38', courts: [3, 5], price: 25 },
      { date: '2026-11-19', start: '08:00', end: '09:00', venue: '39', courts: [17, 20, 23], price: 15 },
      { date: '2026-11-20', start: '18:00', end: '19:00', venue: '38', courts: [4, 7], price: 25, inTarget: true },
      { date: '2026-11-20', start: '18:00', end: '19:00', venue: '39', courts: [18], price: 25, inTarget: true },
      { date: '2026-11-20', start: '19:00', end: '20:00', venue: '39', courts: [21], price: 25, inTarget: true },
    ],
    venues: ['体育馆主馆', '体育馆训练馆（副馆）'].map((label, index) => ({
      id: String(38 + index), label, dates: ['2026-11-18', '2026-11-19', '2026-11-20'], at: 1, error: '',
    })),
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
  const window = new BrowserWindow({ width: 1130, height: 820, useContentSize: true, show: false, webPreferences: { ...preferences, preload: path.join(source, 'preload.cjs') } });
  await window.loadURL('courtwatch://app/index.html');
  await window.webContents.insertCSS('* { transition: none !important; }', { cssOrigin: 'user' });
  await window.webContents.executeJavaScript("Date.now = () => Date.parse('2026-11-18T14:08:00+08:00'); window.dispatchEvent(new Event('focus'))");
  const code = `new Promise((resolve, reject) => {
    const deadline = performance.now() + 3000;
    const timer = setInterval(() => {
      const ready = document.querySelector('.court-numbers')?.getAttribute('aria-label') === '3、5号';
      if (ready || performance.now() > deadline) {
        clearInterval(timer);
        if (!ready) return reject(new Error('UI did not render mock slots'));
        resolve(document.getElementById('account-state').textContent);
      }
    }, 25);
  })`;
  assert.equal(await window.webContents.executeJavaScript(code), '已登录');
  const paint = () => window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const js = code => window.webContents.executeJavaScript(code);
  async function capture(name, selector) {
    await paint();
    const rect = await js(`(() => {
      const area = document.querySelector('${selector}').getBoundingClientRect();
      const right = Math.min(innerWidth, Math.ceil(area.right) + 24);
      return { x: 0, y: 0, width: right, height: Math.min(innerHeight, Math.ceil(area.bottom) + 24) };
    })()`);
    await fs.writeFile(path.join(target, name), (await window.webContents.capturePage(rect)).toPNG());
  }
  assert.equal(await js('document.title'), '候羽');
  assert.deepEqual(await js("[...document.querySelectorAll('.date-cell')].map(cell => cell.rowSpan)"), [1, 1, 3]);
  assert.deepEqual(await js("[...document.querySelectorAll('.date-cell small')].map(el => el.textContent)"), ['今天 · 周三', '明天 · 周四', '周五']);
  assert.deepEqual(await js("[document.querySelectorAll('.in-target').length, document.querySelectorAll('.target-caption').length]"), [3, 1]);
  assert.deepEqual(await js("[...document.querySelectorAll('#booking-links button')].map(el => el.textContent)"), ['主馆预约 ↗', '训练馆预约 ↗']);
  const readable = () => js(`(() => {
    const luminance = color => {
      const [r, g, b] = color.match(/[\\d.]+/g).slice(0, 3).map(n => {
        const v = Number(n) / 255;
        return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
      });
      return .2126 * r + .7152 * g + .0722 * b;
    };
    return ['.button.primary', '.nav.current', '.court-number', '[data-venue="38"]', '[data-venue="39"]'].every(selector => {
      const el = document.querySelector(selector);
      const style = getComputedStyle(el);
      const a = luminance(style.color), b = luminance(style.backgroundColor);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5;
    });
  })()`);
  assert.equal(await readable(), true, 'action, navigation, venue names and available court numbers maintain readable contrast');
  const logoWidth = await window.webContents.executeJavaScript("(async () => { const logo = document.querySelector('.brand img'); await logo.decode(); return logo.naturalWidth; })()");
  assert.equal(logoWidth, 512);
  assert.equal(await window.webContents.executeJavaScript(`
    document.querySelector('.inspector').getBoundingClientRect().left >= document.querySelector('.schedule').getBoundingClientRect().right
  `), true, 'Monitoring controls sit beside the results at the default width');
  assert.equal(await window.webContents.executeJavaScript("getComputedStyle(document.querySelector('input[name=campus]:disabled')).opacity"), '0',
    'a disabled native radio does not cover the selected campus label');
  await paint();
  await capture('monitor.png', '.monitor-grid');
  async function theme(value) {
    nativeTheme.themeSource = value;
    await js(`new Promise((resolve, reject) => {
      const limit = performance.now() + 3500;
      const check = () => {
        if (matchMedia('(prefers-color-scheme: ${value})').matches) return resolve();
        if (performance.now() > limit) return reject(new Error('Theme did not update'));
        setTimeout(check, 35);
      };
      check();
    })`);
    await paint();
  }
  await theme('dark');
  assert.equal(await readable(), true, 'dark mode preserves action, venue and court contrast');
  await capture('monitor-dark.png', '.monitor-grid');
  await theme('light');

  await js("document.querySelector('#rows .venue-link').focus()");
  const changed = [{ ...state.rows[0], courts: [3] }, ...state.rows.slice(1)];
  window.webContents.send('courtwatch:state', { ...state, rows: changed });
  await paint();
  assert.equal(await js("document.activeElement === document.querySelector('#rows .venue-link')"), true, 'a court update keeps the active venue link focused');
  window.webContents.send('courtwatch:state', { ...state, rows: changed.slice(1) });
  await paint();
  assert.equal(await js('document.activeElement.id'), 'schedule-title-label', 'a vanished row returns keyboard focus to the schedule');
  window.webContents.send('courtwatch:state', state);
  await paint();
  await window.webContents.executeJavaScript("document.querySelector('#open-target').click()");
  await paint();
  assert.deepEqual(await window.webContents.executeJavaScript(`[
    document.querySelector('#page-target').hidden, document.querySelector('#target-date').value,
    document.querySelector('#target-start').value, document.querySelector('#target-end').value,
    document.querySelector('#target-coverage').textContent,
  ]`), [false, '2026-11-20', '18:00', '20:00', '主馆、训练馆 · 全部场号']);
  await capture('target.png', '#page-target .form-sheet');
  await window.webContents.executeJavaScript("document.querySelector('[data-page=feishu]').click()");
  await paint();
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#page-feishu').hidden"), false);
  assert.equal(await js("document.querySelector('#push-form').hidden"), true);
  await js("document.querySelector('#replace-connection').click(); document.querySelector('#feishu-webhook').value='test-draft'; document.querySelector('#cancel-replace').click()");
  assert.equal(await js("document.querySelector('#push-form').hidden && document.querySelector('#feishu-webhook').value === ''"), true);
  const disconnected = { ...state, pushService: null, delivery: { configured: false, persistent: false, status: 'off', at: null, text: '' } };
  window.webContents.send('courtwatch:state', disconnected);
  await paint();
  assert.equal(await js("document.querySelector('#push-status').textContent"), '未连接');
  await capture('feishu.png', '.push-sheet');
  window.setContentSize(740, 600);
  await paint();
  const viewportFit = () => window.webContents.executeJavaScript("innerWidth <= 760 && document.documentElement.scrollWidth <= innerWidth && document.querySelector('.workspace').scrollWidth <= document.querySelector('.workspace').clientWidth");
  assert.equal(await viewportFit(), true, 'Feishu page fits the minimum width');
  await window.webContents.executeJavaScript("document.querySelector('[data-page=target]').click()");
  await paint();
  assert.equal(await viewportFit(), true, 'Target editor fits the minimum width');
  assert.equal(await window.webContents.executeJavaScript(`[...document.querySelectorAll('#target-form input')].every(el => {
    const rect = el.getBoundingClientRect(); return rect.width >= 82 && rect.left >= 0 && rect.right <= innerWidth;
  })`), true, 'native date and time inputs have usable widths');
  await window.webContents.executeJavaScript("document.querySelector('[data-page=monitor]').click()");
  await paint();
  assert.equal(await viewportFit(), true, 'Monitor page fits the minimum width');
  window.webContents.setZoomFactor(2);
  await paint();
  assert.equal(await js(`document.documentElement.scrollWidth <= innerWidth &&
    [...document.querySelectorAll('.navigation button, #account-action')].every(el => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.left >= 0 && box.right <= innerWidth;
    }) && document.querySelector('.workspace').scrollWidth <= document.querySelector('.workspace').clientWidth`),
    true, 'doubling text and UI size keeps Chinese navigation, account and schedule available');
  window.webContents.setZoomFactor(1);
  await paint();
  assert.equal(await window.webContents.executeJavaScript(`
    document.querySelector('.inspector').getBoundingClientRect().top >= document.querySelector('.schedule').getBoundingClientRect().bottom
  `), true, 'Monitoring controls move below the results at the minimum width');
  const crowdedRow = { ...state.rows[0], courts: Array.from({ length: 120 }, (_, i) => i + 1) };
  window.webContents.send('courtwatch:state', { ...state, rows: [crowdedRow] });
  await paint();
  assert.deepEqual(await js(`[
    document.querySelectorAll('.court-number').length, document.querySelector('.court-number:last-child').textContent,
    document.querySelector('.table-wrap').scrollWidth <= document.querySelector('.table-wrap').clientWidth,
  ]`), [120, '120', true], 'court numbers wrap at the minimum width without losing the final court');
  window.webContents.send('courtwatch:state', state);
  await paint();
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
  window.webContents.send('courtwatch:state', {
    ...state, pushService: null, delivery: { configured: false, persistent: true, status: 'off', text: '系统安全存储暂时无法读取通知配置。', at: null },
  });
  await paint();
  await window.webContents.executeJavaScript("document.querySelector('[data-page=feishu]').click()");
  assert.deepEqual(await window.webContents.executeJavaScript(`[
    !document.querySelector('#push-actions').hidden && !document.querySelector('#remove-connection').disabled,
    document.querySelector('#push-test').hidden,
  ]`), [true, true], 'a saved but inaccessible connection can be cleared from the application');
  const unrestricted = { ...state, rows: [], options: { ...state.options, targets: {} } };
  window.webContents.send('courtwatch:state', unrestricted);
  await paint();
  await js("document.querySelector('[data-page=target]').click()");
  async function crossMidnight(date) {
    await js(`(() => {
      const t = performance.now();
      Date.now = () => Date.parse('${date}T23:59:59.750+08:00') + performance.now() - t;
      window.dispatchEvent(new Event('focus'));
    })()`);
    const before = await js("document.querySelector('#target-date').min");
    await js(`new Promise((resolve, reject) => {
      const start = performance.now();
      const tick = () => {
        if (document.querySelector('#target-date').min !== '${before}') return resolve();
        if (performance.now() - start > 3500) return reject(new Error('Date minimum did not roll forward'));
        setTimeout(tick, 40);
      };
      tick();
    })`);
  }
  await crossMidnight('2026-11-18');
  assert.equal(await js("document.querySelector('#target-date').value"), '2026-11-20');
  await js("const dateInput = document.querySelector('#target-date'); dateInput.value = '2026-12-11'; dateInput.dispatchEvent(new Event('input', { bubbles: true }))");
  await crossMidnight('2026-11-19');
  assert.equal(await js("document.querySelector('#target-date').value"), '2026-12-11', 'untouched defaults advance while an explicit draft survives midnight');
  window.destroy();
  process.stdout.write('Electron UI and timetable regressions passed, including delayed and overlapping pages, expiry, and clearing unreadable settings.\n');
  app.exit(0);
}

app.whenReady().then(run).catch(error => {
  process.stderr.write(`${error.stack}\n`);
  app.exit(1);
});
