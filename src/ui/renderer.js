'use strict';

const app = window.courtWatch;
document.documentElement.dataset.platform = app?.platform ?? '';
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
let editorDay;
let targetDirty = false;
let replacingConnection = false;
let bookingVenues = '';

const venueNames = { '38': '主馆', '39': '训练馆', '57': '综合馆' };
const venueName = venue => venueNames[venue.id] ?? venue.label;

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
  if (page !== 'feishu') {
    get('push-form').reset();
    replacingConnection = false;
    pushError = '';
    if (current) render();
  }
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
  document.querySelector('.workspace').scrollTop = 0;
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
  const coverage = `${venues.map(venueName).join('、')} · 全部场号`;
  text('target-coverage', coverage);
  const today = isoDay.format(now);
  let range = '全部退订';
  let place = '所有时段、所有场号';
  let note = '';
  if (target) {
    const year = target.date.slice(0, 4);
    const yearLabel = year === today.slice(0, 4) ? '' : `${year}年`;
    range = `${yearLabel}${shortDay(target.date)}${expired ? ' · 已结束' : ''}`;
    place = `${target.start}–${target.end}`;
    if (expired) note = '目标已结束。修改日期或移除目标后可继续接收提醒。';
  } else if (target === null) {
    range = '目标无法读取';
    place = '提醒已暂停';
    note = '请重新保存或移除目标。';
  }
  text('target-campus', campus);
  text('saved-range', range);
  text('shortcut-range', range);
  text('saved-place', place);
  text('shortcut-place', place);
  text('saved-note', note);
  get('saved-note').hidden = !note;
  text('target-link-label', target === undefined ? '设置' : '编辑');
  get('clear-target').hidden = target === undefined;
  get('target-date').min = today;
  if (version !== editorVersion) targetDirty = false;
  if (version !== editorVersion || (!target && !targetDirty && editorDay !== today)) {
    editorVersion = version;
    get('target-date').value = target?.date ?? isoDay.format(now + 86400000);
    get('target-start').value = target?.start ?? '18:00';
    get('target-end').value = target?.end ?? '20:00';
    get('target-error').hidden = true;
    get('target-date').removeAttribute('aria-invalid');
    get('target-end').removeAttribute('aria-invalid');
  }
  editorDay = today;
  for (const control of get('target-form').elements) control.disabled = busy;
  get('clear-target').disabled = busy;
  const nextMidnight = Date.parse(`${today}T00:00:00+08:00`) + 86400000;
  return endsAt > now ? Math.min(endsAt, nextMidnight) : nextMidnight;
}

function validateTargetRange(focus = false) {
  const date = get('target-date');
  const start = get('target-start');
  const end = get('target-end');
  const error = get('target-error');
  let field;
  let message = '';
  if (date.value && date.value < date.min) {
    field = date;
    message = '请选择今天或以后的日期。';
  } else if (start.value && end.value && start.value >= end.value) {
    field = end;
    message = '结束时间需要晚于开始时间。';
  } else if (Date.parse(`${date.value}T${end.value}:00+08:00`) <= Date.now()) {
    field = end;
    message = '请选择尚未结束的北京时间段。';
  }
  for (const input of [date, end]) input.setAttribute('aria-invalid', String(input === field));
  text('target-error', message);
  error.hidden = !message;
  if (focus && field) field.focus();
  return !field;
}

function submitTarget(event) {
  event.preventDefault();
  if (!current || !validateTargetRange(true)) return;
  const date = get('target-date').value;
  const start = get('target-start').value;
  const end = get('target-end').value;
  const error = get('target-error');
  const campus = current.options.campus;
  const target = { date, start, end };
  void act(async () => {
    try {
      await app.saveTarget(campus, target);
      error.hidden = true;
      showToast('提醒目标已保存。');
    } catch (err) { text('target-error', err.message || '目标保存失败，请重试。'); error.hidden = false; }
  });
}

function appendCell(row, value) {
  const cell = row.insertCell();
  cell.textContent = value;
  return cell;
}

function renderBookingLinks(venues) {
  const key = venues.map(venue => venue.id).join(',');
  if (bookingVenues === key) return;
  bookingVenues = key;
  get('booking-links').replaceChildren(...venues.map((venue, index) => {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'quiet';
    if (index === 0) link.id = 'open-booking';
    link.textContent = `${venueName(venue)}预约 ↗`;
    link.setAttribute('aria-label', `打开${venue.label}官方预约页`);
    link.addEventListener('click', () => act(() => app.openVenue(venue.id)));
    return link;
  }));
}

function renderTable(rows, venues) {
  const fingerprint = JSON.stringify(rows);
  if (fingerprint === renderedRows) return;
  renderedRows = fingerprint;
  const body = get('rows');
  const focusedSlot = body.contains(document.activeElement) ? document.activeElement.dataset.slot : null;
  body.replaceChildren();
  let restoreFocus;
  let dateCell;
  for (const slot of rows) {
    const row = body.insertRow();
    if (dateCell?.dataset.date !== slot.date) {
      row.className = 'new-day';
      dateCell = document.createElement('th');
      dateCell.className = 'date-cell';
      dateCell.id = `day-${slot.date}`;
      dateCell.dataset.date = slot.date;
      dateCell.setAttribute('aria-label', shortDay(slot.date));
      const day = document.createElement('strong');
      day.textContent = slot.date.slice(5).replace('-', '/');
      const week = document.createElement('small');
      week.textContent = weekday.format(new Date(`${slot.date}T12:00:00+08:00`));
      dateCell.append(day, week);
      row.append(dateCell);
    } else {
      dateCell.rowSpan++;
    }
    appendCell(row, `${slot.start}–${slot.end}`).className = 'slot-time';
    const venue = venues.find(item => item.id === slot.venue);
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'quiet venue-link';
    link.dataset.venue = slot.venue;
    link.dataset.slot = JSON.stringify([slot.date, slot.start, slot.end, slot.venue, slot.price]);
    if (focusedSlot === link.dataset.slot) restoreFocus = link;
    link.textContent = venue ? venueName(venue) : '预约页';
    link.setAttribute('aria-label', `打开${venue?.label ?? '场馆'}官方预约页`);
    link.addEventListener('click', () => act(() => app.openVenue(slot.venue)));
    row.insertCell().append(link);
    const courts = document.createElement('span');
    courts.className = 'court-numbers';
    courts.setAttribute('role', 'group');
    courts.setAttribute('aria-label', `${slot.courts.join('、')}号`);
    for (const court of slot.courts) {
      const mark = document.createElement('span');
      mark.className = 'court-number';
      mark.textContent = court;
      courts.append(mark);
    }
    row.insertCell().append(courts);
    appendCell(row, slot.price ? `¥${number.format(slot.price)}` : '免费').className = 'price';
    const columns = ['time', 'venue', 'courts', 'price'];
    row.querySelectorAll('td').forEach((cell, index) => cell.headers = `${dateCell.id} col-${columns[index]}`);
  }
  if (focusedSlot) (restoreFocus ?? get('schedule-title-label')).focus({ preventScroll: true });
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
  text('monitor-context', anyResult && !checking ? `，${campusNames[options.campus]}可约 ${slotCount} 场次` : '');
  get('monitor-state').dataset.tone = tone;
  text('selected-campus', campusNames[options.campus]);
  text('selected-venues', venues.map(venueName).join(' · '));
  renderBookingLinks(venues);
  text('count', anyResult ? number.format(slotCount) : '—');
  text('checked', lastAt ? time.format(lastAt) : '—');
  text('next', nextAt ? time.format(nextAt) : checking ? '查询中' : '—');
  text('monitor-action-label', running ? '暂停监控' : '开始监控');
  get('monitor-action').dataset.running = String(running);
  get('monitor-action').disabled = busy || !signedIn;
  get('campus-field').disabled = busy || running;
  get('campus-field').title = running ? '暂停监控后可切换校区' : '';
  for (const input of document.querySelectorAll('input[name="campus"]')) input.checked = input.value === options.campus;
  if (!intervalDirty) get('interval').value = String(options.interval);
  get('interval').disabled = busy;
  get('save-interval').disabled = busy || !intervalDirty;
  text('schedule-title-label', !running && anyResult ? '上次核验空场' : '当前空场');

  const dates = [...new Set(verifiedVenues.flatMap(venue => venue.dates))].sort();
  const showDate = value => `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
  const range = dates.length > 1 ? `${showDate(dates[0])}–${showDate(dates.at(-1))}` : dates[0] ? showDate(dates[0]) : '';
  text('scope', range);
  get('read-error').hidden = !errors.length;
  text('read-error', errors.map(venue => `${venueName(venue)} · ${venue.error}`).join('\n'));
  renderTable(rows, venues);
  get('empty').hidden = rows.length > 0;
  get('table-wrap').hidden = rows.length === 0;
  if (!rows.length) {
    let title = '登录北航后可查看场地';
    let note = '';
    if (signedIn) title = '开始监控后查看空场';
    if (checking) title = '正在读取场地…';
    else if (errors.length) { title = '部分场地未能核验'; note = running ? '将在下轮检查时重试。' : ''; }
    else if (anyResult) title = running ? '当前没有绿色可约场次' : '上次检查没有绿色可约场次';
    text('empty-title', title);
    get('empty-note').hidden = !note;
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
  const connected = delivery.configured && current.pushService === 'feishu';
  get('push-form').hidden = connected && !replacingConnection;
  get('cancel-replace').hidden = !connected || !replacingConnection;
  get('cancel-replace').disabled = busy;
  get('replace-connection').hidden = !connected || replacingConnection;
  get('replace-connection').disabled = busy;
  get('push-actions').hidden = (!delivery.configured && !delivery.persistent) || (connected && replacingConnection);
  get('push-test').hidden = !delivery.configured;
  get('push-test').disabled = busy;
  text('push-test', legacyService ? '测试当前渠道' : '发送测试');
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
  get('open-target').addEventListener('click', () => showPage('target'));
  get('target-form').addEventListener('input', () => {
    targetDirty = true;
    if (!get('target-error').hidden) validateTargetRange();
  });
  get('target-form').addEventListener('focusout', event => {
    if (targetDirty && !busy && event.target.matches('input')) validateTargetRange();
  });
  get('target-form').addEventListener('submit', submitTarget);
  get('clear-target').addEventListener('click', () => act(async () => {
    await app.saveTarget(current.options.campus, null);
    showToast('已恢复此校区的全部退订提醒。');
  }));
  get('interval').addEventListener('input', () => { intervalDirty = true; get('save-interval').disabled = busy; });
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
  get('replace-connection').addEventListener('click', () => {
    replacingConnection = true;
    pushError = '';
    render();
    get('feishu-webhook').focus();
  });
  get('cancel-replace').addEventListener('click', () => {
    get('push-form').reset();
    replacingConnection = false;
    pushError = '';
    render();
    get('replace-connection').focus();
  });
  get('push-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const connection = { webhook: get('feishu-webhook').value, secret: get('feishu-secret').value };
    void runPushAction(async () => { await app.connectPush(connection); form.reset(); replacingConnection = false; });
  });
  get('remove-connection').addEventListener('click', () => runPushAction(async () => { await app.disconnectPush(); get('push-form').reset(); replacingConnection = false; showToast('通知连接已断开。'); }));
  get('push-test').addEventListener('click', () => runPushAction(app.testPush));
  app.onState(receive);
  app.state().then(state => { if (!current) receive(state); }).catch(() => showToast('桌面服务无法连接，请重新打开应用。'));
  window.addEventListener('focus', () => { if (current) render(); });
}
