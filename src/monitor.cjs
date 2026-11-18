'use strict';

const { CAMPUSES, VENUES, groupSlots, slotKey, startsAt } = require('./courts.cjs');
const { notice } = require('./push.cjs');

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
    this.lastAt = null;
    this.timer = null;
    this.task = null;
    this.cyclesWithErrors = 0;
    this.snapshots = new Map();
    this.previous = new Map();
    this.pending = new Map();
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
    if (this.running && intervalChanged && this.nextAt > this.now()) {
      const updated = this.nextAt - previousDelay + this.pollDelay();
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
    this.pending.clear();
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
    this.task?.abort();
  }

  stop(announce = true) {
    this.running = false;
    this.interrupt();
    this.previous.clear();
    this.pending.clear();
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
    if (this.running && !this.suspended && !this.task) {
      this.nextAt = this.now() + delay;
      this.timer = setTimeout(() => void this.check(), delay);
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
    const prior = this.previous.get(id);
    const current = new Map(upcoming.map(slot => [slotKey(slot), slot]));
    this.snapshots.set(id, { at: now, dates: sample.dates, slots: upcoming, error: '' });
    if (prior && this.delivery.configured) {
      for (const [key, item] of this.pending) {
        if (item.venue === id && !current.has(key)) this.pending.delete(key);
      }
      for (const [key, slot] of current) {
        if (!prior.has(key) || this.pending.has(key)) this.pending.set(key, slot);
      }
    }
    this.previous.set(id, current);
  }

  async check() {
    if (!this.running || this.suspended || this.task) return;
    clearTimeout(this.timer);
    this.timer = null;
    const task = new AbortController();
    this.task = task;
    this.nextAt = null;
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
      for (const [key, slot] of this.pending) {
        if (startsAt(slot) <= this.lastAt) this.pending.delete(key);
      }
      const batch = [...this.pending].filter(([, slot]) => !failed.has(slot.venue));
      if (batch.length && this.delivery.configured && this.delivery.status !== 'blocked' && this.lastAt >= this.pushNotBefore) {
        // Once handed off, a cancelled request may already have been accepted.
        for (const [key] of batch) this.pending.delete(key);
        let result;
        try {
          result = await this.dispatch(notice(this.options.campus, batch.map(([, slot]) => slot), this.lastAt), task.signal);
        } catch {
          result = { kind: 'unknown', text: '推送过程异常，送达状态待确认。' };
        }
        if (task.signal.aborted) return;
        if (result.kind === 'retry' || result.kind === 'blocked') {
          for (const [key, slot] of batch) this.pending.set(key, slot);
        }
        this.recordDelivery(result);
      }
    } finally {
      if (this.task === task) {
        this.task = null;
        if (!task.signal.aborted) this.cyclesWithErrors = failed.size === venueIds.length ? Math.min(this.cyclesWithErrors + 1, 3) : 0;
        this.schedule(task.signal.aborted ? 0 : this.pollDelay());
      }
    }
  }
}

module.exports = { CourtMonitor, UserError };
