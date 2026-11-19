'use strict';

const { CAMPUSES, VENUES, groupSlots, matchesTarget, nextBookingRelease, intervalSeconds, slotKey, startsAt } = require('./courts.cjs');
const { notice, noticeBatches } = require('./push.cjs');

class UserError extends Error {
  constructor(message, code = 'general') {
    super(message);
    this.code = code;
  }
}

class CampusRateLimit extends UserError {
  constructor(retryAfter, now = Date.now()) {
    super('官网请求限流，已延后下次检查。', 'rate-limit');
    const value = typeof retryAfter === 'string' ? retryAfter.trim() : '';
    const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    this.retryAfterMs = Number.isSafeInteger(now + delay) && delay > 60000 ? delay : 60000;
  }
}

class CourtMonitor {
  constructor({ options, checkVenue, dispatch, onChange, now = Date.now }) {
    this.options = options;
    this.checkVenue = checkVenue;
    this.dispatch = dispatch;
    this.onChange = onChange;
    this.now = now;
    this.auth = 'signed-out';
    this.running = false;
    this.suspended = false;
    this.nextAt = null;
    this.nextRegularAt = null;
    this.lastAt = null;
    this.timer = null;
    this.task = null;
    this.cyclesWithErrors = 0;
    this.siteNotBefore = 0;
    this.snapshots = new Map();
    this.previousReservations = new Map();
    this.pending = new Map();
    this.inFlightSlots = new Map();
    this.pushNotBefore = 0;
    this.delivery = { configured: false, persistent: false, status: 'off', text: '', at: null };
  }

  state() {
    const now = this.now();
    const venues = CAMPUSES[this.options.campus].venues.map(id => {
      const snapshot = this.snapshots.get(id);
      return { id, label: VENUES[id].label, at: snapshot?.at ?? null, error: snapshot?.error ?? '', dates: snapshot?.dates ?? [], unreadDates: snapshot?.unreadDates ?? [] };
    });
    const verified = this.auth === 'signed-in' ? [...this.snapshots.values()].filter(snapshot => !snapshot.error) : [];
    const slots = verified.flatMap(snapshot => snapshot.slots).filter(slot => startsAt(slot) > now);
    const rows = groupSlots(slots);
    if (this.target) {
      for (const row of rows) row.inTarget = matchesTarget(row, this.target);
    }
    return {
      options: { ...this.options }, auth: this.auth, running: this.running,
      checking: Boolean(this.task && !this.task.signal.aborted), suspended: this.suspended,
      nextAt: this.nextAt, lastAt: this.lastAt, slotCount: slots.length, rows, venues,
      delivery: { ...this.delivery },
    };
  }

  emit() { this.onChange(this.state()); }

  get target() { return this.options.targets?.[this.options.campus]; }

  setOptions(options) {
    const campusChanged = options.campus !== this.options.campus;
    if (this.running && campusChanged) throw new UserError('请先暂停监控再切换校区。');
    const intervalChanged = options.interval !== this.options.interval;
    const previousDelay = this.pollDelay();
    if (campusChanged) {
      this.snapshots.clear();
      this.lastAt = null;
    }
    this.options = options;
    for (const queue of [this.pending, this.inFlightSlots]) {
      for (const [key, slot] of queue) if (!matchesTarget(slot, this.target)) queue.delete(key);
    }
    if (this.running && intervalChanged && this.nextAt > this.now()) {
      const updated = this.nextRegularAt - previousDelay + this.pollDelay();
      this.schedule(Math.max(0, updated - this.now()));
      return;
    }
    this.emit();
  }

  setAuth(auth) {
    if (this.auth === auth) return;
    this.auth = auth;
    if (auth !== 'signed-in') {
      this.stop(false);
      this.snapshots.clear();
      this.lastAt = null;
    }
    this.emit();
  }

  setDelivery(configured, persistent, text = '') {
    this.pending = new Map();
    this.pushNotBefore = 0;
    this.delivery = { configured, persistent, status: configured ? 'ready' : 'off', text, at: null };
    this.emit();
  }

  recordDelivery(result) {
    if (!result || result.kind === 'cancelled' || !this.delivery.configured) return;
    const now = this.now();
    if (result.kind === 'retry' && Number.isFinite(result.retryAfterMs) && result.retryAfterMs > 0) {
      this.pushNotBefore = Math.max(this.pushNotBefore, now + result.retryAfterMs);
    }
    if (result.kind === 'accepted') this.pushNotBefore = 0;
    this.delivery = { ...this.delivery, status: result.kind, text: result.text, at: now };
    this.emit();
  }

  start() {
    if (this.running) return;
    if (this.auth !== 'signed-in') throw new UserError('请先登录北航。');
    this.running = true;
    this.cyclesWithErrors = 0;
    this.schedule(0);
  }

  interrupt() {
    clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
    this.nextRegularAt = null;
    this.task?.abort();
  }

  stop(announce = true) {
    this.running = false;
    this.interrupt();
    this.previousReservations.clear();
    this.pending = new Map();
    if (announce) this.emit();
  }

  setSuspended(value) {
    if (this.suspended === value) return;
    this.suspended = value;
    if (value) this.interrupt();
    if (!value && this.running) this.schedule(0);
    else this.emit();
  }

  schedule(delay) {
    clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
    this.nextRegularAt = null;
    if (this.running && !this.suspended && !this.task) {
      const now = this.now();
      this.nextRegularAt = now + delay;
      this.nextAt = Math.max(this.siteNotBefore, Math.min(this.nextRegularAt, nextBookingRelease(now)));
      this.timer = setTimeout(() => void this.check(), Math.min(2147483647, this.nextAt - now));
    }
    this.emit();
  }

  pollDelay() {
    const interval = intervalSeconds(this.options.interval) * 1000;
    if (!this.cyclesWithErrors) return interval;
    const firstRetry = Math.max(60000, interval * 2);
    return Math.min(firstRetry * 2 ** (this.cyclesWithErrors - 1), Math.max(interval, 15 * 60000));
  }

  applySnapshot(id, sample, readStarted) {
    const now = this.now();
    const upcoming = sample.slots.filter(slot => startsAt(slot) > now);
    const prior = this.previousReservations.get(id) ?? new Map();
    const unread = new Set(sample.unreadDates);
    this.snapshots.set(id, { at: now, dates: sample.dates, unreadDates: sample.unreadDates, slots: upcoming, error: '' });
    if (this.delivery.configured && (prior.size || this.pending.size)) {
      const available = new Map(upcoming.map(slot => [slotKey(slot), slot]));
      for (const [key, item] of this.pending) {
        if (item.venue === id && !unread.has(item.date) && !available.has(key)) this.pending.delete(key);
      }
      const lead = VENUES[id].paidRefundLeadMs;
      for (const [key, slot] of available) {
        if (!matchesTarget(slot, this.target)) continue;
        const sold = prior.get(slot.date);
        const reopening = sold?.keys.has(key) && (slot.price === 0 || lead === undefined || sold.started <= startsAt(slot) - lead);
        if (this.pending.has(key) || reopening) this.pending.set(key, slot);
      }
    }
    // Keep the last reliable observation only for dates explicitly marked unreadable.
    // A withdrawn date must start from a fresh baseline if the site publishes it again.
    for (const date of prior.keys()) if (!unread.has(date)) prior.delete(date);
    const started = sample.started ?? readStarted;
    for (const slot of sample.reserved ?? []) {
      if (!prior.has(slot.date)) prior.set(slot.date, { started, keys: new Set() });
      prior.get(slot.date).keys.add(slotKey(slot));
    }
    this.previousReservations.set(id, prior);
  }

  async notifyPending(failedVenues, signal) {
    const pending = this.pending;
    const now = this.now();
    const candidates = [];
    for (const [key, slot] of pending) {
      if (startsAt(slot) <= now || !matchesTarget(slot, this.target)) pending.delete(key);
      else if (!failedVenues.has(slot.venue) && this.snapshots.get(slot.venue)?.dates.includes(slot.date)) candidates.push(slot);
    }
    if (!candidates.length || signal.aborted || !this.delivery.configured ||
        this.delivery.status === 'blocked' || now < this.pushNotBefore) return;
    for (const part of noticeBatches(candidates)) {
      if (signal.aborted || this.pending !== pending) return;
      const at = this.now();
      const batch = part.filter(slot => pending.has(slotKey(slot)) && startsAt(slot) > at);
      if (batch.length && !await this.sendBatch(batch, pending, signal)) return;
    }
  }

  async sendBatch(batch, pending, signal) {
    // After dispatch, an interrupted request may already have been accepted.
    for (const slot of batch) pending.delete(slotKey(slot));
    const eligible = new Map(batch.map(slot => [slotKey(slot), slot]));
    this.inFlightSlots = eligible;
    // Unlocking the system vault may wait for the user. Build the card only
    // when the transport is ready, using the current target and start times.
    const buildNotice = () => {
      const now = this.now();
      const slots = [...eligible.values()].filter(slot => startsAt(slot) > now);
      return slots.length ? notice(this.options.campus, slots, now, Boolean(this.target)) : null;
    };
    let result;
    try {
      result = await this.dispatch(buildNotice, signal);
    } catch {
      result = { kind: 'unknown', text: '推送过程异常，送达状态待确认。' };
    } finally {
      this.inFlightSlots = new Map();
    }
    // Sleep preserves confirmed retries. Pausing or switching connections discards the queue.
    if (this.pending !== pending) return false;
    if (result.kind === 'skipped') return true;
    if (result.kind === 'retry' || result.kind === 'blocked') {
      for (const [key, slot] of eligible) if (startsAt(slot) > this.now()) pending.set(key, slot);
    }
    this.recordDelivery(result);
    return result.kind === 'accepted';
  }

  async check() {
    if (!this.running || this.suspended || this.task) return;
    if (this.now() < this.siteNotBefore) {
      this.schedule(this.siteNotBefore - this.now());
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
    const task = new AbortController();
    const began = this.now();
    const releaseAt = nextBookingRelease(began);
    const supplemental = this.nextAt !== null && this.nextAt <= began && began < this.nextRegularAt;
    const regularAnchor = supplemental ? this.nextRegularAt - this.pollDelay() : null;
    this.task = task;
    this.nextAt = null;
    this.nextRegularAt = null;
    this.emit();
    const failed = new Set();
    const venueIds = CAMPUSES[this.options.campus].venues;
    let siteLimit;
    try {
      for (const id of venueIds) {
        try {
          if (siteLimit) throw siteLimit;
          const readStarted = this.now();
          const sample = await this.checkVenue(id, task.signal);
          if (task.signal.aborted) return;
          this.applySnapshot(id, sample, readStarted);
        } catch (error) {
          if (task.signal.aborted) return;
          if (error instanceof UserError && error.code === 'auth') {
            this.setAuth('expired');
            return;
          }
          if (error instanceof CampusRateLimit && !siteLimit) {
            siteLimit = error;
            this.siteNotBefore = this.now() + error.retryAfterMs;
          }
          failed.add(id);
          const previous = this.snapshots.get(id) ?? { at: null, slots: [], dates: [] };
          const message = error instanceof UserError ? error.message : '暂时无法读取预约表。';
          this.snapshots.set(id, { ...previous, error: message });
        }
      }
      this.lastAt = this.now();
      await this.notifyPending(failed, task.signal);
    } finally {
      if (this.task === task) {
        this.task = null;
        if (!task.signal.aborted) this.cyclesWithErrors = failed.size === venueIds.length ? Math.min(this.cyclesWithErrors + 1, 3) : 0;
        const finished = this.now();
        let delay = this.pollDelay();
        if (regularAnchor !== null && !this.cyclesWithErrors && regularAnchor + delay > finished) {
          delay = regularAnchor + delay - finished;
        }
        this.schedule(task.signal.aborted || finished >= releaseAt ? 0 : delay);
      }
    }
  }
}

module.exports = { CourtMonitor, UserError, CampusRateLimit };
