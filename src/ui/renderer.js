'use strict';

const app = window.courtWatch;
const get = id => document.getElementById(id);
const text = (id, value) => { if (get(id).textContent !== value) get(id).textContent = value; };
const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' });
const isoDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const campusNames = { shahe: '沙河校区', xueyuanlu: '学院路校区' };
let current;
let busy = false;
let toastTimer;
let renderedRows = '';
let expiryTimer;
let intervalDirty = false;
let pushError = '';
let editorVersion;

function showToast(message) {
  const toast = get('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4800);
}

async function act(action) {
  if (busy) return;
  busy = true;
  if (current) render();
  try { await action(); }
  catch (error) { showToast(error.message?.replace(/^Error: /, '') || '操作未完成，请重试。'); }
  finally {
    busy = false;
    if (current) render();
  }
}

function runPushAction(action) {
  return act(async () => {
    pushError = '';
    try { await action(); }
    catch (error) { pushError = error.message?.replace(/^Error: /, '') || '操作未完成，请重试。'; }
  });
}

function showPage(page) {
  for (const nav of document.querySelectorAll('[data-page]')) {
    const selected = nav.dataset.page === page;
    nav.classList.toggle('current', selected);
    if (selected) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
    get(`page-${nav.dataset.page}`).hidden = !selected;
  }
  const title = get(`page-${page}`).querySelector('h1');
  title.tabIndex = -1;
  title.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function shortDay(value) {
  const [, month, day] = value.split('-');
  return `${Number(month)}月${Number(day)}日 ${weekday.format(new Date(`${value}T12:00:00+08:00`))}`;
}

function renderTarget(options, venues, now) {
  const target = options.targets?.[options.campus];
  const version = JSON.stringify([options.campus, target === undefined ? 'all' : target]);
  const endsAt = target ? Date.parse(`${target.date}T${target.end}:00+08:00`) : 0;
  const expired = Boolean(target && endsAt <= now);
  const campus = campusNames[options.campus];
  let range = '全部退订';
  let place = '此校区的所有时段和场号';
  let note = '可以提前设定未来的日期。保存后，只有符合目标的场次重新可约时才会提醒。';
  if (target) {
    const venue = venues.find(item => item.id === target.venue)?.label ?? '全部场馆';
    const year = target.date.slice(0, 4);
    const yearLabel = year === isoDay.format(now).slice(0, 4) ? '' : `${year}年`;
    range = `${yearLabel}${shortDay(target.date)}${expired ? ' · 已结束' : ''}`;
    place = `${target.start}–${target.end}\n${venue} · ${target.court === null ? '不限场号' : `${target.court} 号场`}`;
    note = expired ? '此目标已到期，提醒已静默。可以选择新的日期或移除目标。' : '目标仅用于退订推送，场地监控仍显示全校区的绿色空场。';
  } else if (target === null) {
    range = '目标需要重新设置';
    place = '此校区的推送已静默';
    note = '已保存的目标无法读取。可以重新保存，或移除目标以接收全部退订。';
  }
  text('target-campus', `${campus} · 退订时通知`);
  text('saved-range', range);
  text('shortcut-range', range);
  text('saved-place', place);
  text('shortcut-place', place);
  text('saved-note', note);
  text('target-link-label', target === undefined ? '设置目标' : '编辑目标');
  get('clear-target').hidden = target === undefined;
  get('target-date').min = isoDay.format(now);
  if (editorVersion !== version) {
    editorVersion = version;
    get('target-date').value = target?.date ?? isoDay.format(now + 86400000);
    get('target-start').value = target?.start ?? '18:00';
    get('target-end').value = target?.end ?? '20:00';
    get('target-venue').replaceChildren(new Option('全部场馆', ''), ...venues.map(venue => new Option(venue.label, venue.id)));
    get('target-venue').value = target?.venue ?? '';
    get('target-court').value = target?.court ?? '';
    get('target-error').hidden = true;
  }
  for (const control of get('target-form').elements) control.disabled = busy;
  get('clear-target').disabled = busy;
  return endsAt > now ? endsAt : Infinity;
}

function submitTarget(event) {
  event.preventDefault();
  if (!current) return;
  const date = get('target-date').value;
  const start = get('target-start').value;
  const end = get('target-end').value;
  const court = get('target-court');
  const error = get('target-error');
  const showError = message => { error.textContent = message; error.hidden = false; };
  if (start >= end) { showError('结束时间需要晚于开始时间。'); get('target-end').focus(); return; }
  if (Date.parse(`${date}T${end}:00+08:00`) <= Date.now()) { showError('请选择尚未结束的北京时间段。'); return; }
  const campus = current.options.campus;
  const target = { date, start, end, venue: get('target-venue').value || null, court: court.value === '' ? null : court.valueAsNumber };
  void act(async () => {
    try {
      await app.saveTarget(campus, target);
      error.hidden = true;
      showToast('目标已保存，符合条件的退订会推送到已连接的渠道。');
    } catch (err) { showError(err.message || '目标保存失败，请重试。'); }
  });
}

function appendCell(row, value) {
  const cell = row.insertCell();
  cell.textContent = value;
  return cell;
}

function renderTable(rows, venues) {
  const fingerprint = JSON.stringify(rows);
  if (fingerprint === renderedRows) return;
  renderedRows = fingerprint;
  const body = get('rows');
  body.replaceChildren();
  for (const slot of rows) {
    const row = body.insertRow();
    appendCell(row, shortDay(slot.date));
    appendCell(row, `${slot.start}–${slot.end}`);
    const venue = venues.find(item => item.id === slot.venue);
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'quiet venue-link';
    link.textContent = venue?.label ?? '预约页';
    link.title = '在北航官网查看这个场馆';
    link.addEventListener('click', () => act(() => app.openVenue(slot.venue)));
    row.insertCell().append(link);
    const courts = document.createElement('span');
    courts.className = 'court-numbers';
    courts.textContent = `${slot.courts.join('、')}号`;
    row.insertCell().append(courts);
    appendCell(row, slot.price ? `¥${number.format(slot.price)}` : '免费');
  }
}

function render() {
  const { auth, options, venues, running, checking, suspended, lastAt, nextAt, rows: sampledRows, delivery } = current;
  clearTimeout(expiryTimer);
  const now = Date.now();
  let nextExpiry = renderTarget(options, venues, now);
  const rows = sampledRows.filter(row => {
    const starts = Date.parse(`${row.date}T${row.start}:00+08:00`);
    if (starts <= now) return false;
    nextExpiry = Math.min(nextExpiry, starts);
    return true;
  });
  if (Number.isFinite(nextExpiry)) expiryTimer = setTimeout(render, Math.min(2147483647, nextExpiry - now + 10));
  const slotCount = rows.reduce((total, row) => total + row.courts.length, 0);
  const signedIn = auth === 'signed-in';
  const errors = venues.filter(venue => venue.error);
  const verifiedVenues = signedIn ? venues.filter(venue => venue.at && !venue.error) : [];
  const anyResult = verifiedVenues.length > 0;
  const accountLabels = { opening: '等待官网登录', expired: '登录已失效', 'signed-in': '已登录', 'signed-out': '尚未登录' };
  text('account-state', accountLabels[auth]);
  get('account-dot').dataset.tone = signedIn ? 'good' : auth === 'expired' ? 'warn' : 'neutral';
  text('account-action', signedIn ? '退出登录' : auth === 'expired' ? '重新登录' : '登录北航');
  get('account-action').disabled = busy || auth === 'opening';

  let status = signedIn ? '已暂停' : '等待登录';
  let tone = 'neutral';
  if (auth === 'expired') { status = '登录已失效'; tone = 'warn'; }
  if (running) {
    status = '监控运行中';
    tone = 'good';
    if (checking) status = '正在查询';
    if (suspended) { status = '设备休眠'; tone = 'neutral'; }
    else if (errors.length && !checking) { status = '下轮重试'; tone = 'warn'; }
  }
  text('monitor-state-label', status);
  get('monitor-state').dataset.tone = tone;
  text('selected-campus', campusNames[options.campus]);
  text('selected-venues', `${venues.map(venue => venue.label).join('、')} · 每 ${options.interval} 分钟检查`);
  text('count', anyResult ? number.format(slotCount) : '—');
  text('checked', lastAt ? time.format(lastAt) : '—');
  text('next', nextAt ? time.format(nextAt) : checking ? '查询中' : '—');
  text('monitor-action-label', running ? '暂停监控' : '开始监控');
  get('monitor-action').dataset.running = String(running);
  get('monitor-action').disabled = busy || !signedIn;
  get('campus-field').disabled = busy || running;
  for (const input of document.querySelectorAll('input[name="campus"]')) input.checked = input.value === options.campus;
  if (!intervalDirty) get('interval').value = String(options.interval);
  get('interval').disabled = busy;
  get('save-interval').disabled = busy;
  text('schedule-title-label', !running && anyResult ? '上次核验空场' : '当前空场');

  const dates = [...new Set(verifiedVenues.flatMap(venue => venue.dates))].sort();
  const showDate = value => `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
  const range = dates.length > 1 ? `${showDate(dates[0])}–${showDate(dates.at(-1))}` : dates[0] ? showDate(dates[0]) : '';
  text('scope', range ? `${range} · ${rows.length} 个有空场的时段` : '仅统计官网的绿色可约格');
  const freshestError = errors[0];
  get('read-error').hidden = !freshestError;
  if (freshestError) {
    const lastSuccess = freshestError.at ? `　上次成功于 ${time.format(freshestError.at)}。` : '';
    text('read-error', `${freshestError.label} · ${freshestError.error}${lastSuccess}`);
  }
  get('empty').hidden = rows.length > 0;
  get('table-wrap').hidden = rows.length === 0;
  renderTable(rows, venues);
  if (!rows.length) {
    let title = '登录后可查看余量';
    let note = '启动监控后，官网标绿且尚未开始的空场会显示在这里。';
    if (signedIn) {
      title = '等待首次查询';
      note = '点击开始监控，读取当前开放的日期和场地。';
    }
    if (checking) { title = '正在读取官网场地'; note = '查询完成后，空场会显示在这里。'; }
    else if (freshestError) { title = '余量查询暂时不完整'; note = running ? '应用将自动重试。' : '登录并启动监控后，可重新查询。'; }
    else if (anyResult) { title = '暂无可显示的空场'; note = running ? '出现新的空场时，应用会更新这里。' : '启动监控后继续查询。'; }
    text('empty-title', title);
    text('empty-note', note);
  }

  const legacyService = { pushplus: 'PushPlus', serverchan: 'Server酱' }[current.pushService];
  const pushNeedsAttention = delivery.status === 'blocked' || (delivery.persistent && !delivery.configured);
  const pushStatus = legacyService ? '待切换' : pushNeedsAttention ? '需检查配置' : delivery.configured ? '已连接' : '未连接';
  get('push-service').hidden = !legacyService;
  text('push-service', legacyService ? `当前使用 ${legacyService}。飞书测试通过后切换。` : '');
  text('push-status', pushStatus);
  get('push-status').dataset.tone = pushNeedsAttention ? 'warn' : delivery.configured && !legacyService ? 'good' : 'neutral';
  get('storage-note').hidden = !delivery.configured || delivery.persistent;
  get('push-connect').disabled = busy;
  get('feishu-webhook').disabled = busy;
  get('feishu-secret').disabled = busy;
  get('push-actions').hidden = !delivery.configured && !delivery.persistent;
  get('push-test').hidden = !delivery.configured;
  get('push-test').disabled = busy;
  text('push-test', legacyService ? '测试当前渠道' : '再次发送测试');
  get('remove-connection').disabled = busy;
  get('push-feedback').hidden = !pushError && !delivery.text;
  get('push-feedback').dataset.tone = pushError || ['blocked', 'retry', 'unknown'].includes(delivery.status) ? 'warn' : 'neutral';
  const deliveryNote = delivery.at ? `${time.format(delivery.at)} · ${delivery.text}` : delivery.text;
  text('push-feedback', pushError || deliveryNote);
}

function receive(state) {
  current = state;
  render();
}

function updateOptions(patch) {
  const options = { ...current.options, ...patch };
  return act(() => app.saveOptions(options));
}

if (!app) {
  showToast('桌面服务未启动。请从应用程序重新打开。');
} else {
  for (const nav of document.querySelectorAll('[data-page]')) nav.addEventListener('click', () => showPage(nav.dataset.page));
  get('account-action').addEventListener('click', () => act(() => current?.auth === 'signed-in' ? app.logOut() : app.login()));
  get('monitor-action').addEventListener('click', () => act(() => current?.running ? app.pause() : app.start()));
  get('open-booking').addEventListener('click', () => act(() => app.openVenue(current.venues[0].id)));
  get('open-target').addEventListener('click', () => showPage('target'));
  get('target-form').addEventListener('input', () => { get('target-error').hidden = true; });
  get('target-form').addEventListener('submit', submitTarget);
  get('clear-target').addEventListener('click', () => act(async () => {
    await app.saveTarget(current.options.campus, null);
    showToast('已恢复此校区的全部退订提醒。');
  }));
  get('interval').addEventListener('input', () => { intervalDirty = true; });
  get('interval-form').addEventListener('submit', event => {
    event.preventDefault();
    const input = get('interval');
    if (!current || !input.reportValidity()) return;
    const options = { ...current.options, interval: input.valueAsNumber };
    void act(async () => {
      await app.saveOptions(options);
      intervalDirty = false;
      showToast(`检查频率已设为每 ${options.interval} 分钟。`);
    });
  });
  for (const input of document.querySelectorAll('input[name="campus"]')) {
    input.addEventListener('change', () => { if (input.checked && current) void updateOptions({ campus: input.value }); });
  }
  get('push-guide').addEventListener('click', () => act(() => app.pushGuide()));
  get('push-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const connection = { webhook: get('feishu-webhook').value, secret: get('feishu-secret').value };
    void runPushAction(async () => { await app.connectPush(connection); form.reset(); });
  });
  get('remove-connection').addEventListener('click', () => runPushAction(async () => { await app.disconnectPush(); showToast('通知连接已断开。'); }));
  get('push-test').addEventListener('click', () => runPushAction(app.testPush));
  app.onState(receive);
  app.state().then(state => { if (!current) receive(state); }).catch(() => showToast('桌面服务无法连接，请重新打开应用。'));
  window.addEventListener('focus', () => { if (current) render(); });
}
