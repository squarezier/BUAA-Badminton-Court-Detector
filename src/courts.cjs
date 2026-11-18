'use strict';

const CAMPUS_ORIGIN = 'https://cgyy.buaa.edu.cn';
const LOGIN_URL = `${CAMPUS_ORIGIN}/venue/login`;
const BEIJING = 'Asia/Shanghai';
const DAY_MS = 24 * 60 * 60 * 1000;
const BOOKING_RELEASE_OFFSET = 7 * 60 * 60 * 1000;
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 1440;
const VENUES = Object.freeze({
  '38': { id: '38', campus: 'xueyuanlu', label: '体育馆主馆' },
  '39': { id: '39', campus: 'xueyuanlu', label: '体育馆训练馆（副馆）' },
  '57': { id: '57', campus: 'shahe', label: '综合馆' },
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

function validOptions(value) {
  return Boolean(value && typeof value.campus === 'string' && Object.hasOwn(CAMPUSES, value.campus) &&
    Number.isInteger(value.interval) && value.interval >= MIN_INTERVAL && value.interval <= MAX_INTERVAL);
}

function parseToken(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const token = value.trim();
  return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null;
}

function validTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function startsAt({ date, start }) {
  return Date.parse(`${date}T${start}:00+08:00`);
}

function slotKey({ venue, date, start, end, court }) {
  return `${venue}/${date}/${start}/${end}/${court}`;
}

function validatedCourt({ court, start, end }) {
  if (!Number.isInteger(court) || court < 1 || court > 120 || !validTime(start) || !validTime(end) || start >= end) {
    throw new Error('官网时段或场号格式异常。');
  }
  return { court, start, end };
}

function validatedSnapshot(id, days, started) {
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
      const slot = { venue: id, date, ...validatedCourt(row), price };
      slots.set(slotKey(slot), slot);
    }
    for (const row of booked) {
      const slot = { venue: id, date, ...validatedCourt(row) };
      const key = slotKey(slot);
      if (slots.has(key)) throw new Error('官网同一场次出现互相冲突的状态。');
      reserved.set(key, slot);
    }
  }
  return { dates: [...dates].sort(), slots: [...slots.values()], reserved: [...reserved.values()] };
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
    ...group, courts: [...new Set(group.courts)].sort((a, b) => a - b),
  }));
}

module.exports = {
  CAMPUS_ORIGIN, LOGIN_URL, BEIJING, CAMPUSES, VENUES, MIN_INTERVAL, MAX_INTERVAL,
  venueUrl, beijingDay, beijingClock, validOptions, parseToken, calendarDates, nextBookingRelease, startsAt, slotKey, validatedSnapshot, groupSlots,
};
