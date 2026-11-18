'use strict';

// These functions run in an isolated world on the normal booking page.
// Their only controls are the date tabs and the timetable paging arrows.
function signedInOnBookingSite() {
  const authenticated = [...document.querySelectorAll('a, button, li, span, div')].some(element =>
    element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && (element.innerText ?? '').trim() === '退出');
  return authenticated;
}

async function readBookingPage({ todayLabel, nowClock }) {
  const timePattern = /\b(\d{2}:\d{2})\s*[-–—~～]\s*(\d{2}:\d{2})\b/;
  const datePattern = /^\d{1,2}月\d{1,2}日$/;
  const visible = element => element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const dateButtons = () => [...document.querySelectorAll('.date_box > div')].filter(button =>
    visible(button) && datePattern.test(labelOf(button)));
  const labelOf = button => button?.querySelector('span')?.textContent.trim() ?? '';
  const activeDate = () => labelOf(dateButtons().find(button => button.classList.contains('active')));
  const busySelector = '.spaceTable .ivu-spin-fix, .ivu-table-wrapper > .ivu-spin-fix';
  const busy = () => [...document.querySelectorAll(busySelector)].some(visible);
  const validClock = text => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text);
  const mins = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));

  function hasGreenFill(block) {
    const style = getComputedStyle(block);
    const rgba = style.backgroundColor.match(/^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/);
    if (!rgba || !visible(block)) return false;
    const [, red, green, blue, alpha = '1'] = rgba;
    // The site's green is rgb(138, 212, 112). Allow changes in shade while
    // rejecting the table's red, gray, white, and transparent fills.
    return Number(alpha) > 0 && Number(green) - Math.max(Number(red), Number(blue)) >= 8;
  }

  function readWindow() {
    if (busy()) return null;
    const table = [...document.querySelectorAll('.spaceTable table')].find(candidate =>
      visible(candidate) && timePattern.test(candidate.rows[0]?.innerText ?? ''));
    if (!table) return null;
    const header = table.rows[0];
    const times = [...header.cells].slice(1).map(cell => cell.innerText.match(timePattern)?.slice(1));
    if (!times.length || times.some((range, index) => !range || !range.every(validClock) ||
        mins(range[0]) >= mins(range[1]) || (index > 0 && times[index - 1][1] !== range[0]))) return null;
    const courtRows = [...table.rows].filter(row => /^\s*\d+号\s*$/.test(row.cells[0]?.innerText ?? ''));
    if (!courtRows.length || courtRows.some(row => row.cells.length !== times.length + 1)) return null;
    const slots = [];
    let colorConflict = false;
    for (const row of courtRows) {
      const court = Number.parseInt(row.cells[0].innerText, 10);
      for (const [index, cell] of [...row.cells].slice(1).entries()) {
        const block = cell.querySelector('.reserveBlock');
        if (!block) return null;
        const unavailable = block.matches('.reserved, .disabled, [disabled], [aria-disabled="true"]');
        const available = block.classList.contains('free') && !unavailable;
        if (!available && !unavailable) return null;
        const green = hasGreenFill(block);
        if (available !== green) colorConflict = true;
        if (!available || !green) continue;
        const amount = block.innerText.trim().match(/^[¥￥]\s*(\d+(?:\.\d{1,2})?)$/);
        const freeOfCharge = /^免费$/.test(block.innerText.trim());
        if (!amount && !freeOfCharge) return null;
        const [start, end] = times[index];
        slots.push({ court, start, end, price: freeOfCharge ? 0 : Number(amount[1]) });
      }
    }
    return {
      date: activeDate(), times, slots, colorConflict,
      first: times[0][0], last: times.at(-1)[1],
      back: header.querySelector('.ivu-icon-ios-arrow-back'),
      forward: header.querySelector('.ivu-icon-ios-arrow-forward'),
    };
  }

  async function waitFor(compute, timeout = 5500) {
    const stop = performance.now() + timeout;
    let value;
    do {
      value = compute();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 90));
    } while (performance.now() < stop);
    return null;
  }

  function closedMessage() {
    return [...document.querySelectorAll('.ivu-table-tip, .spaceTable')].some(element =>
      visible(element) && /^(?:该日|当日|当天)?\s*(?:暂无可预约(?:的)?场地|场地(?:暂)?停开放|未开放预约)[。！\s]*$/.test(element.innerText.trim()));
  }

  function dayFrame(label) {
    if (activeDate() !== label || busy()) return null;
    return readWindow() ?? (closedMessage() ? { closed: true } : null);
  }

  async function afterTimetableChange(button, readFrame) {
    const timetableData = '.reserveBlock, .ivu-table-tip';
    let changedAt = null;
    let wasBusy = false;
    const affectsTimetable = node => node.nodeType === 1 &&
      (node.matches(timetableData) || node.querySelector(timetableData));
    const status = classes => (classes ?? '').split(/\s+/)
      .filter(name => ['free', 'reserved', 'disabled'].includes(name)).sort().join(' ');
    const changedData = change => {
      const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
      if (change.type !== 'attributes') {
        return target?.closest(timetableData) || [...change.addedNodes, ...change.removedNodes].some(affectsTimetable);
      }
      const attribute = change.attributeName;
      if (target.matches('.ivu-table-tip')) return attribute === 'hidden';
      if (!target.matches('.reserveBlock')) return false;
      if (attribute === 'class') return status(change.oldValue) !== status(target.getAttribute('class'));
      return ['disabled', 'aria-disabled'].includes(attribute) && change.oldValue !== target.getAttribute(attribute);
    };
    function trackLoading() {
      const loading = busy();
      if (loading) {
        wasBusy = true;
        changedAt = null;
      } else if (wasBusy) {
        wasBusy = false;
        changedAt = performance.now();
      }
      return loading;
    }
    const observer = new MutationObserver(changes => {
      if (!trackLoading() && changes.some(changedData)) changedAt = performance.now();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeOldValue: true, attributeFilter: ['class', 'style', 'disabled', 'aria-disabled', 'hidden'] });
    try {
      button.click();
      // Tabs and time headers can change before the reservation cells do.
      return await waitFor(() => !trackLoading() && changedAt !== null && performance.now() - changedAt >= 120 && readFrame());
    } finally { observer.disconnect(); }
  }

  function operatingHours() {
    const hoursPattern = /开放时间\s*(\d{2}:\d{2})\s*[-–—~～]\s*(\d{2}:\d{2})/;
    const marker = [...document.querySelectorAll('span, p, div, dd')].find(element =>
      element.childElementCount === 0 && /开放时间/.test(element.textContent));
    return marker?.textContent.match(hoursPattern)?.slice(1) ?? marker?.parentElement?.innerText.match(hoursPattern)?.slice(1) ??
      document.body.innerText.match(hoursPattern)?.slice(1);
  }

  const loaded = await waitFor(() => dateButtons().length && operatingHours() && (readWindow() || closedMessage()), 9000);
  if (!loaded) return { error: 'layout' };
  const [opening, closing] = operatingHours();
  const labels = dateButtons().map(labelOf);
  if (labels.length > 7 || ![opening, closing, nowClock].every(validClock) || mins(opening) >= mins(closing)) return { error: 'layout' };
  const days = [];

  for (const label of labels) {
    if (label === todayLabel && mins(nowClock) >= mins(closing)) {
      days.push({ label, slots: [] });
      continue;
    }
    const button = dateButtons().find(item => labelOf(item) === label);
    if (!button) return { error: 'layout' };
    const readDay = () => dayFrame(label);
    const dayView = activeDate() === label ? await waitFor(readDay) : await afterTimetableChange(button, readDay);
    if (!dayView) return { error: 'layout' };
    if (dayView.closed) {
      days.push({ label, slots: [] });
      continue;
    }
    let view = dayView;
    // The first window for today is usually close to the current time.
    // Go back if necessary so no upcoming time is skipped.
    const firstNeeded = label === todayLabel ? Math.max(mins(opening), mins(nowClock)) : mins(opening);
    for (let count = 0; mins(view.first) > firstNeeded && count < 5; count++) {
      if (!view.back) return { error: 'layout' };
      const previousFirst = view.first;
      view = await afterTimetableChange(view.back, () => {
        const frame = readWindow();
        return frame && frame.date === label && frame.first < previousFirst ? frame : null;
      });
      if (!view) return { error: 'layout' };
    }
    if (mins(view.first) > firstNeeded) return { error: 'layout' };
    const columns = new Map();
    for (let page = 0; page < 8; page++) {
      if (view.colorConflict) return { error: 'colors' };
      for (const [start, end] of view.times) {
        const earlier = columns.get(start);
        if (earlier && earlier.end !== end) return { error: 'layout' };
        // An overlapping column is more recent, even if it now has no slots.
        columns.set(start, { end, slots: [] });
      }
      for (const slot of view.slots) columns.get(slot.start).slots.push(slot);
      if (view.last === closing) break;
      if (!view.forward || mins(view.last) > mins(closing) || page === 7) return { error: 'layout' };
      const previousLast = view.last;
      view = await afterTimetableChange(view.forward, () => {
        const frame = readWindow();
        return frame && frame.date === label && frame.last > previousLast && frame.first <= previousLast ? frame : null;
      });
      if (!view || (view.first < previousLast && !columns.has(view.first))) return { error: 'layout' };
    }
    if (view.last !== closing) return { error: 'layout' };
    days.push({ label, slots: [...columns.values()].flatMap(column => column.slots) });
  }
  return { days };
}

module.exports = { signedInOnBookingSite, readBookingPage };
