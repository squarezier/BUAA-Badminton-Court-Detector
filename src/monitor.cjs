'use strict';

const { CAMPUSES, VENUES, groupSlots, matchesTarget, nextBookingRelease, slotKey, startsAt } = require('./courts.cjs');
const { notice, noticeBatches } = require('./push.cjs');

class UserError extends Error {
  constructor(message, code = 'general') {
    super(message);
    this.code = code;
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
      return { id, label: VENUES[id].label, at: snapshot?.at ?? null, error: snapshot?.error ?? '', dates: snapshot?.dates ?? [] };
    });
    const verified = this.auth === 'signed-in' ? [...this.snapshots.values()].filter(snapshot => !snapshot.error) : [];
    const slots = verified.flatMap(snapshot => snapshot.slots).filter(slot => startsAt(slot) > now);
    return {
      options: { ...this.options }, auth: this.auth, running: this.running,
      checking: Boolean(this.task && !this.task.signal.aborted), suspended: this.suspended,
      nextAt: this.nextAt, lastAt: this.lastAt, slotCount: slots.length, rows: groupSlots(slots), venues,
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
      this.nextAt = Math.min(this.nextRegularAt, nextBookingRelease(now));
      this.timer = setTimeout(() => void this.check(), this.nextAt - now);
    }
    this.emit();
  }

  pollDelay() {
    const interval = this.options.interval * 60000;
    return Math.min(interval * 2 ** this.cyclesWithErrors, Math.max(interval, 15 * 60000));
  }

  applySnapshot(id, sample) {
    const now = this.now();
    const upcoming = sample.slots.filter(slot => startsAt(slot) > now);
    const prior = this.previousReservations.get(id);
    this.snapshots.set(id, { at: now, dates: sample.dates, slots: upcoming, error: '' });
    if (prior && this.delivery.configured) {
      const available = new Map(upcoming.map(slot => [slotKey(slot), slot]));
      for (const [key, item] of this.pending) {
        if (item.venue === id && !available.has(key)) this.pending.delete(key);
      }
      for (const [key, slot] of available) {
        if ((prior.has(key) || this.pending.has(key)) && matchesTarget(slot, this.target)) this.pending.set(key, slot);
      }
    }
    this.previousReservations.set(id, new Set((sample.reserved ?? []).map(slotKey)));
  }

  async notifyPending(failedVenues, signal) {
    const pending = this.pending;
    const now = this.now();
    const candidates = [];
    for (const [key, slot] of pending) {
      if (startsAt(slot) <= now || !matchesTarget(slot, this.target)) pending.delete(key);
      else if (!failedVenues.has(slot.venue)) candidates.push(slot);
    }
    if (!candidates.length || signal.aborted || !this.delivery.configured ||
        this.delivery.status === 'blocked' || now < this.pushNotBefore) return;
    for (const part of noticeBatches(candidates)) {
      if (signal.aborted || this.pending !== pending) return;
      const at = this.now();
      const batch = part.filter(slot => pending.has(slotKey(slot)) && startsAt(slot) > at);
      if (batch.length && !await this.sendBatch(batch, pending, signal, at)) return;
    }
  }

  async sendBatch(batch, pending, signal, now) {
    // After dispatch, an interrupted request may already have been accepted.
    for (const slot of batch) pending.delete(slotKey(slot));
    const eligible = new Map(batch.map(slot => [slotKey(slot), slot]));
    this.inFlightSlots = eligible;
    let result;
    try {
      result = await this.dispatch(notice(this.options.campus, batch, now, Boolean(this.target)), signal);
    } catch {
      result = { kind: 'unknown', text: '推送过程异常，送达状态待确认。' };
    } finally {
      this.inFlightSlots = new Map();
    }
    // Sleep preserves confirmed retries. Pausing or switching connections discards the queue.
    if (this.pending !== pending) return false;
    if (result.kind === 'retry' || result.kind === 'blocked') {
      for (const [key, slot] of eligible) if (startsAt(slot) > this.now()) pending.set(key, slot);
    }
    this.recordDelivery(result);
    return result.kind === 'accepted';
  }

  async check() {
    if (!this.running || this.suspended || this.task) return;
    clearTimeout(this.timer);
    this.timer = null;
    const task = new AbortController();
    const releaseAt = nextBookingRelease(this.now());
    this.task = task;
    this.nextAt = null;
    this.nextRegularAt = null;
    this.emit();
    const failed = new Set();
    const venueIds = CAMPUSES[this.options.campus].venues;
    try {
      for (const id of venueIds) {
        try {
          const sample = await this.checkVenue(id, task.signal);
          if (task.signal.aborted) return;
          this.applySnapshot(id, sample);
        } catch (error) {
          if (task.signal.aborted) return;
          if (error instanceof UserError && error.code === 'auth') {
            this.setAuth('expired');
            return;
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
        this.schedule(task.signal.aborted || this.now() >= releaseAt ? 0 : this.pollDelay());
      }
    }
  }
}

module.exports = { CourtMonitor, UserError };
