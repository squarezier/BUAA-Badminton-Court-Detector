'use strict';

const CAMPUS_ORIGIN = 'https://cgyy.buaa.edu.cn';
const LOGIN_URL = `${CAMPUS_ORIGIN}/venue/login`;
const BEIJING = 'Asia/Shanghai';
const DAY_MS = 24 * 60 * 60 * 1000;
const BOOKING_RELEASE_OFFSET = 7 * 60 * 60 * 1000;
const MIN_INTERVAL = 1 / 60;
const MAX_INTERVAL = 1440;
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const VENUES = Object.freeze({
  '38': { id: '38', campus: 'xueyuanlu', label: '体育馆主馆' },
  '39': { id: '39', campus: 'xueyuanlu', label: '体育馆训练馆（副馆）', paidRefundLeadMs: THREE_HOURS_MS },
  '57': { id: '57', campus: 'shahe', label: '综合馆', paidRefundLeadMs: THREE_HOURS_MS },
});
const CAMPUSES = Object.freeze({
  shahe: { label: '沙河校区', venues: ['57'] },
  xueyuanlu: { label: '学院路校区', venues: ['38', '39'] },
});

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: BEIJING, year: 'numeric', month: '2-digit', day: '2-digit',
});
const clockFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: BEIJING, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const courtOrder = new Intl.Collator('en', { numeric: true });

function venueUrl(id) {
  if (!Object.hasOwn(VENUES, id)) throw new Error('未知场馆。');
  return `${CAMPUS_ORIGIN}/venue/venue-reservation/${id}`;
}

function beijingDay(at) {
  return dayFormat.format(at);
}

function beijingClock(at) {
  return clockFormat.format(at);
}

function beijingMidnight(at) {
  return Date.parse(`${beijingDay(at)}T00:00:00+08:00`);
}

function nextBookingRelease(at) {
  const release = beijingMidnight(at) + BOOKING_RELEASE_OFFSET;
  return release > at ? release : release + DAY_MS;
}

function calendarDates(at) {
  const today = beijingMidnight(at);
  const length = at < today + BOOKING_RELEASE_OFFSET ? 2 : 3;
  return new Map(Array.from({ length }, (_, offset) => {
    const date = beijingDay(today + offset * DAY_MS);
    const [, month, day] = date.split('-');
    return [`${Number(month)}月${Number(day)}日`, date];
  }));
}

// Stored intervals are expressed in minutes, including legacy whole-minute settings.
function intervalSeconds(minutes) {
  if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL || minutes > MAX_INTERVAL) return null;
  const seconds = minutes * 60;
  const whole = Math.round(seconds);
  return Math.abs(seconds - whole) <= Number.EPSILON * seconds ? whole : null;
}

function validOptions(value) {
  return Boolean(value && typeof value.campus === 'string' && Object.hasOwn(CAMPUSES, value.campus) &&
    intervalSeconds(value.interval) !== null);
}

function parseToken(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const token = value.trim();
  return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null;
}

function validTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validTarget(target) {
  if (!target) return false;
  const { date, start, end } = target;
  if (typeof date !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date)) return false;
  const day = Date.parse(`${date}T00:00:00+08:00`);
  return Number.isFinite(day) && beijingDay(day) === date && validTime(start) && validTime(end) && start < end;
}

function targetFields({ date, start, end }) {
  return { date, start, end };
}

function matchesTarget(slot, target) {
  // A missing target means all reopenings. A damaged saved target mutes this campus until repaired.
  if (target === undefined) return true;
  return Boolean(target && slot.date === target.date && slot.start >= target.start && slot.end <= target.end);
}

function startsAt({ date, start }) {
  return Date.parse(`${date}T${start}:00+08:00`);
}

function slotKey({ venue, date, start, end, court }) {
  return `${venue}/${date}/${start}/${end}/${court}`;
}

function validatedCourt(id, { court, start, end }) {
  const numbered = Number.isInteger(court) && court >= 1 && court <= 120;
  const shaheB = id === '57' && typeof court === 'string' && court.length === 2 && /^B[1-6]$/.test(court);
  if ((!numbered && !shaheB) || !validTime(start) || !validTime(end) || start >= end) {
    throw new Error('官网时段或场号格式异常。');
  }
  return { court, start, end };
}

function validatedSnapshot(id, days, started, unread = []) {
  const knownDays = calendarDates(started);
  if (!Array.isArray(days) || !days.length || days.length > knownDays.size) throw new Error('官网返回的日期范围异常。');
  const slots = new Map();
  const reserved = new Map();
  const dates = new Set();
  for (const day of days) {
    const date = knownDays.get(day.label);
    const booked = day.reserved ?? [];
    if (!date || dates.has(date) || !Array.isArray(day.slots) || day.slots.length > 1024 ||
        !Array.isArray(booked) || booked.length > 1024) {
      throw new Error('官网日期或场次数量异常。');
    }
    dates.add(date);
    for (const row of day.slots) {
      const { price } = row;
      if (!Number.isFinite(price) || price < 0 || price > 9999) throw new Error('官网场地价格格式异常。');
      const slot = { venue: id, date, ...validatedCourt(id, row), price };
      const key = slotKey(slot);
      if (slots.has(key) && slots.get(key).price !== price) throw new Error('官网同一场次出现不同价格。');
      slots.set(key, slot);
    }
    for (const row of booked) {
      const slot = { venue: id, date, ...validatedCourt(id, row) };
      const key = slotKey(slot);
      if (slots.has(key)) throw new Error('官网同一场次出现互相冲突的状态。');
      reserved.set(key, slot);
    }
  }
  if (!Array.isArray(unread) || days.length + unread.length > knownDays.size) throw new Error('官网核验日期异常。');
  const unreadDates = new Set();
  for (const day of unread) {
    const date = knownDays.get(day?.label);
    if (!date || dates.has(date) || unreadDates.has(date) || !['layout', 'colors'].includes(day.error)) throw new Error('官网核验日期异常。');
    unreadDates.add(date);
  }
  return { started, dates: [...dates].sort(), unreadDates: [...unreadDates].sort(), slots: [...slots.values()], reserved: [...reserved.values()] };
}

function groupSlots(slots) {
  const groups = new Map();
  for (const slot of slots) {
    const { venue, date, start, end, court, price } = slot;
    const key = `${date}/${start}/${end}/${venue}/${price}`;
    if (!groups.has(key)) groups.set(key, { venue, date, start, end, price, courts: [] });
    groups.get(key).courts.push(court);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => ({
    ...group, courts: [...new Set(group.courts)].sort(courtOrder.compare),
  }));
}

module.exports = {
  CAMPUS_ORIGIN, LOGIN_URL, BEIJING, CAMPUSES, VENUES, MIN_INTERVAL, MAX_INTERVAL,
  venueUrl, beijingDay, beijingClock, intervalSeconds, validOptions, validTarget, targetFields, matchesTarget,
  parseToken, calendarDates, nextBookingRelease, startsAt, slotKey, validatedSnapshot, groupSlots,
};
