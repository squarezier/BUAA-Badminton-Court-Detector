'use strict';

// These functions run in an isolated world on the normal booking page.
// Their only controls are the date tabs and the timetable paging arrows.
function signedInOnBookingSite() {
  const authenticated = [...document.querySelectorAll('a, button, li, span, div')].some(element =>
    element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && (element.innerText ?? '').trim() === '退出');
  return authenticated;
}

async function readBookingPage({ bookableLabels, nowClock, venueName = '' }) {
  const todayLabel = bookableLabels[0];
  const bookable = new Set(bookableLabels);
  const timePattern = /\b(\d{2}:\d{2})\s*[-–—~～]\s*(\d{2}:\d{2})\b/;
  const visible = element => element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const dateButtons = () => [...document.querySelectorAll('.date_box > div')].filter(button =>
    visible(button) && bookable.has(labelOf(button)) && !button.matches('.disabled, [disabled], [aria-disabled="true"]'));
  const labelOf = button => {
    const text = button?.querySelector('span')?.textContent.trim() ?? '';
    const match = text.match(/^(\d{1,2})月(\d{1,2})日$/);
    return match ? `${Number(match[1])}月${Number(match[2])}日` : '';
  };
  const activeDate = () => labelOf(dateButtons().find(button => button.classList.contains('active')));
  const busySelector = '.spaceTable .ivu-spin-fix, .ivu-table-wrapper > .ivu-spin-fix';
  const gridBusy = () => [...document.querySelectorAll(busySelector)].some(visible);
  const siteBusy = () => [...document.querySelectorAll('.loading.ivu-spin-fix .half-circle-spinner')].some(visible);
  const busy = () => gridBusy() || siteBusy();
  const validClock = text => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text);
  const mins = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));

  function hasGreenFill(block) {
    const style = getComputedStyle(block);
    const rgba = style.backgroundColor.match(/^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/);
    if (!rgba) return false;
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
    const courtRows = new Map();
    for (const row of table.rows) {
      const label = row.cells[0]?.innerText.trim() ?? '';
      const match = /^(B?)([1-9]\d{0,2})号$/.exec(label);
      if (!match) {
        if (row.querySelector('.reserveBlock')) return null;
        continue;
      }
      const number = Number(match[2]);
      const court = match[1] ? `B${number}` : number;
      if (number > 120 || courtRows.has(court) || row.cells.length !== times.length + 1) return null;
      courtRows.set(court, row);
    }
    if (!courtRows.size) return null;
    const slots = [];
    const reserved = [];
    let colorConflict = false;
    let allAdministrative = true;
    for (const [court, row] of courtRows) {
      for (const [index, cell] of [...row.cells].slice(1).entries()) {
        const blocks = cell.querySelectorAll('.reserveBlock');
        if (blocks.length !== 1) return null;
        const block = blocks[0];
        const displayed = block.innerText.trim();
        // The school also uses hourly cells for closures and named activities.
        // They cannot establish a paid booking or a cancellation.
        const administrative = /活动|占用|教学|比赛|维修|维护|闭馆|停用|暂停开放|课(?:程|[、，,\s]|$)/.test(displayed);
        if (administrative) {
          if (!visible(block)) allAdministrative = false;
          continue;
        }
        allAdministrative = false;
        const booked = block.classList.contains('reserved');
        const otherwiseUnavailable = block.matches('.reservation, .disabled, [disabled], [aria-disabled="true"]');
        const unavailable = booked || otherwiseUnavailable;
        const free = block.classList.contains('free');
        const available = free && !unavailable;
        if (!available && !unavailable) return null;
        const shown = visible(block);
        const green = shown && hasGreenFill(block);
        if (available !== green) colorConflict = true;
        const [start, end] = times[index];
        // The site uses "reservation" for unpaid holds and "reserved" for bookings.
        if (booked && shown && !free && !otherwiseUnavailable && /^(?:已售|已预约|已预订)$/.test(displayed)) {
          reserved.push({ court, start, end });
        }
        if (!available || !green) continue;
        const amount = displayed.match(/^[¥￥]\s*(\d+(?:\.\d{1,2})?)$/);
        const freeOfCharge = displayed === '免费';
        if (!amount && !freeOfCharge) return null;
        slots.push({ court, start, end, price: freeOfCharge ? 0 : Number(amount[1]) });
      }
    }
    const footer = table.rows[table.rows.length - 1];
    const mirrored = footer !== header && footer.cells.length === header.cells.length &&
      times.every(([start, end], index) => {
        const match = footer.cells[index + 1].innerText.match(timePattern);
        return match?.[1] === start && match[2] === end;
      });
    return {
      date: activeDate(), times, slots, reserved, colorConflict, allAdministrative,
      mirrored,
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

  async function afterTimetableChange(button, readFrame, paging = false) {
    const timetableData = '.reserveBlock, .ivu-table-tip';
    const old = paging ? null : readWindow();
    let changedAt = null;
    let wasBusy = false;
    let siteLoading = false;
    let siteFinishedAt = null;
    const affectsTimetable = node => node.nodeType === 1 &&
      (node.matches(timetableData) || node.querySelector(timetableData));
    const status = classes => (classes ?? '').split(/\s+/)
      .filter(name => ['free', 'reservation', 'reserved', 'disabled'].includes(name)).sort().join(' ');
    const changedData = change => {
      const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
      const timetable = target?.closest('.spaceTable');
      if (!timetable || !visible(timetable)) {
        // A framework may replace the entire visible timetable at its parent.
        return change.type === 'childList' && [...change.addedNodes].some(node =>
          node.nodeType === 1 && [node, ...node.querySelectorAll('.spaceTable')].some(child =>
            child.matches('.spaceTable') && visible(child) && child.querySelector(timetableData)));
      }
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
      const loading = gridBusy();
      const site = siteBusy();
      if (site) siteFinishedAt = null;
      else if (siteLoading) siteFinishedAt = performance.now();
      siteLoading = site;
      if (loading) {
        wasBusy = true;
        changedAt = null;
      } else if (wasBusy) {
        wasBusy = false;
        changedAt = performance.now();
      }
      return loading || site;
    }
    const observer = new MutationObserver(changes => {
      trackLoading();
      if (changes.some(changedData)) changedAt = performance.now();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeOldValue: true, attributeFilter: ['class', 'style', 'disabled', 'aria-disabled', 'hidden'] });
    try {
      const before = performance.now();
      button.click();
      // Tabs and time headers can change before the reservation cells do.
      const frame = await waitFor(() => {
        if (trackLoading()) return null;
        if (changedAt !== null) return performance.now() - changedAt >= 120 && readFrame();
        // Selecting a date runs the site's full-page loading indicator, then
        // its success handler resets the local pager. A reused sold-out grid
        // needs both that completion and the hour reset in both header rows.
        if (!paging && old?.mirrored && siteFinishedAt !== null && performance.now() - siteFinishedAt >= 120) {
          const view = readFrame();
          if (view?.mirrored && view.date !== old.date && view.first < old.first &&
              !view.colorConflict && !view.slots.length) return view;
        }
        // The official same-day pager slices an already loaded grid. Vue can
        // reuse every cell when two sold-out windows have identical contents.
        // Both independent hour rows must agree. A reused green is never moved.
        if (!paging || performance.now() - before < 1800) return null;
        const view = readFrame();
        return view?.mirrored && !view.colorConflict && !view.slots.length ? view : null;
      });
      if (frame || paging) return frame;
      // If the site's date request is still outstanding, clicking another date
      // can let the older response populate the newly selected tab.
      const populated = [...document.querySelectorAll('.spaceTable table')].some(table =>
        visible(table) && table.querySelector('.reserveBlock'));
      return { error: 'layout', unsettled: changedAt === null || busy() || !populated };
    } finally { observer.disconnect(); }
  }

  function operatingHours() {
    const hoursPattern = /开放时间\s*(\d{2}:\d{2})\s*[-–—~～]\s*(\d{2}:\d{2})/;
    const marker = [...document.querySelectorAll('span, p, div, dd')].find(element =>
      element.childElementCount === 0 && /开放时间/.test(element.textContent));
    return marker?.textContent.match(hoursPattern)?.slice(1) ?? marker?.parentElement?.innerText.match(hoursPattern)?.slice(1) ??
      document.body.innerText.match(hoursPattern)?.slice(1);
  }

  const loaded = await waitFor(() => {
    const hours = operatingHours();
    if (!dateButtons().length || !hours) return false;
    // After closing the selected day can have no grid and no closure message.
    return (activeDate() === todayLabel && nowClock >= hours[1]) || readWindow() || closedMessage() ||
      (activeDate() && !busy() && document.querySelector('.spaceTable table .reserveBlock'));
  }, 9000);
  if (!loaded) return { error: 'layout' };
  const [opening, closing] = operatingHours();
  const labels = dateButtons().map(labelOf);
  if (labels.length > bookable.size || ![opening, closing, nowClock].every(validClock) || mins(opening) >= mins(closing)) return { error: 'layout' };
  // The official notice disappears automatically. Keep only matching date labels.
  const fullDayClosures = new Set();
  if (venueName) {
    const notice = [...document.querySelectorAll('.proContent, .proContentApp')].filter(visible)
      .map(element => element.innerText.replace(/\s/g, '')).join('。');
    for (const match of notice.matchAll(/(\d{1,2})月(\d{1,2})日(?:[（(](?:周|星期)[一二三四五六日天][）)])?([^。；，、\d：:]{2,36}?)羽毛球场地(?:全天)?暂停对外开放[。！]/g)) {
      if (match[3] === venueName) fullDayClosures.add(`${Number(match[1])}月${Number(match[2])}日`);
    }
  }

  async function scanDay(label) {
    if (label === todayLabel && mins(nowClock) >= mins(closing)) {
      return { label, slots: [], reserved: [] };
    }
    const button = dateButtons().find(item => labelOf(item) === label);
    if (!button) return { error: 'layout' };
    const readDay = () => dayFrame(label);
    const dayView = activeDate() === label ? await waitFor(readDay) : await afterTimetableChange(button, readDay);
    if (!dayView) return { error: 'layout' };
    if (dayView.error) return dayView;
    if (dayView.closed || (dayView.allAdministrative && fullDayClosures.has(label))) {
      return { label, slots: [], reserved: [] };
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
      }, true);
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
        columns.set(start, { end, slots: [], reserved: [] });
      }
      for (const slot of view.slots) columns.get(slot.start).slots.push(slot);
      for (const slot of view.reserved) columns.get(slot.start).reserved.push(slot);
      if (view.last === closing) break;
      if (!view.forward || mins(view.last) > mins(closing) || page === 7) return { error: 'layout' };
      const previousLast = view.last;
      view = await afterTimetableChange(view.forward, () => {
        const frame = readWindow();
        return frame && frame.date === label && frame.last > previousLast && frame.first <= previousLast ? frame : null;
      }, true);
      if (!view || (view.first < previousLast && !columns.has(view.first))) return { error: 'layout' };
    }
    if (view.last !== closing) return { error: 'layout' };
    const verified = [...columns.values()];
    return { label, slots: verified.flatMap(column => column.slots), reserved: verified.flatMap(column => column.reserved) };
  }
  const days = [];
  const unread = [];
  for (const label of labels) {
    const result = await scanDay(label);
    if (result.unsettled) {
      for (const remaining of labels.slice(labels.indexOf(label))) unread.push({ label: remaining, error: 'layout' });
      break;
    }
    if (result.error) unread.push({ label, error: result.error });
    else days.push(result);
  }
  if (!days.length) return { error: unread.some(day => day.error === 'colors') ? 'colors' : 'layout' };
  return unread.length ? { days, unread } : { days };
}

module.exports = { signedInOnBookingSite, readBookingPage };
