'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { CourtMonitor } = require('../src/monitor.cjs');
const { validTarget, matchesTarget, slotKey } = require('../src/courts.cjs');
const { Preferences } = require('../src/preferences.cjs');

const day = '2028-02-29';
const rule = { date: day, start: '18:00', end: '20:00', venue: '39', court: 19 };
const slot = (overrides = {}) => ({
  venue: '39', court: 19, date: day, start: '18:00', end: '19:00', price: 25, ...overrides,
});
const accepted = { kind: 'accepted', text: 'accepted' };
const initialTime = Date.parse('2028-02-28T07:00:00+08:00');

function rig(t, dispatch, target = rule) {
  let now = initialTime;
  let available = [];
  let booked = [];
  const options = { campus: 'xueyuanlu', interval: 2, targets: { xueyuanlu: target } };
  const monitor = new CourtMonitor({
    options, now: () => now, onChange() {}, dispatch,
    async checkVenue(id) {
      return { dates: [day], slots: available.filter(s => s.venue === id), reserved: booked.filter(s => s.venue === id) };
    },
  });
  monitor.setAuth('signed-in');
  monitor.setDelivery(true, true);
  monitor.start();
  t.after(() => monitor.stop());
  return {
    monitor,
    setRule(value) { monitor.setOptions({ ...options, targets: value === undefined ? {} : { xueyuanlu: value } }); },
    setTime(value) { now = value; },
    sample(green, reserved = []) { available = green; booked = reserved; return monitor.check(); },
  };
}

test('target dates, times, venue and optional court are validated for the selected campus', () => {
  assert.ok(validTarget(rule, 'xueyuanlu'));
  assert.ok(validTarget({ ...rule, venue: null, court: null }, 'shahe'));
  for (const delta of [
    { date: '2027-02-29' }, { date: '2028-02-30' }, { date: '2028-2-29' }, { date: 'invalid' },
    { start: '18:60' }, { start: '9:00' }, { start: '20:00' }, { end: '17:59' }, { end: '24:00' },
    { venue: '57' }, { venue: 39 }, { court: 0 }, { court: 121 }, { court: 1.5 }, { court: '19' },
  ]) assert.equal(validTarget({ ...rule, ...delta }, 'xueyuanlu'), false, JSON.stringify(delta));
});

test('whole booking slots must fit the date, closed interval, venue and court boundaries', () => {
  assert.equal(matchesTarget(slot({ end: '20:00' }), rule), true);
  assert.equal(matchesTarget(slot({ start: '19:00', end: '20:00' }), rule), true);
  for (const delta of [
    { start: '17:59' }, { end: '20:01' }, { date: '2028-03-01' }, { venue: '38' }, { court: 18 },
    { start: '20:00', end: '21:00' },
  ]) assert.equal(matchesTarget(slot(delta), rule), false);
  assert.equal(matchesTarget(slot({ venue: '38', court: 73 }), { ...rule, venue: null, court: null }), true);
  assert.equal(matchesTarget(slot(), undefined), true);
  assert.equal(matchesTarget(slot(), null), false);
});

test('a mixed two-venue reopening sends just the matching courts and leaves the overview complete', async t => {
  const messages = [];
  const r = rig(t, async message => { messages.push(message); return accepted; });
  const candidates = [slot(), slot({ court: 18 }), slot({ venue: '38' }), slot({ start: '17:00', end: '18:00' }), slot({ date: '2028-03-01' })];
  await r.sample([], candidates);
  const release = slot({ start: '19:00', end: '20:00' });
  await r.sample([...candidates, release]);
  assert.equal(r.monitor.state().slotCount, 6);
  assert.equal(messages.length, 1);
  assert.match(messages[0].title, /目标场次重新可约.*学院路校区 1 场次/);
  const card = JSON.stringify(messages[0].feishuCard);
  assert.match(card, /18:00–19:00.*体育馆训练馆.*19 号/);
  assert.doesNotMatch(card, /体育馆主馆|18 号|19:00–20:00|3月1日/);
  await r.sample([...candidates, release]);
  assert.equal(messages.length, 1);
  await r.sample([], [slot()]);
  await r.sample([slot()]);
  assert.equal(messages.length, 2, 'a new booking followed by a new reopening may send again');
});

test('widening a target or removing it does not turn existing green courts into an alert', async t => {
  const messages = [];
  const r = rig(t, async message => { messages.push(message); return accepted; });
  const other = slot({ court: 18 });
  await r.sample([], [other]);
  await r.sample([other]);
  r.setRule(undefined);
  await r.sample([other]);
  assert.equal(messages.length, 0);
  await r.sample([], [other]);
  await r.sample([other]);
  assert.equal(messages.length, 1);
  assert.match(messages[0].title, /学院路校区疑似退订 1 场次/);
});

test('a future target waits through the normal 07:00 release, then reports a verified cancellation on that date', async t => {
  const messages = [];
  const r = rig(t, async message => { messages.push(message); return accepted; });
  const release = Date.parse('2028-02-27T07:00:00+08:00');
  r.setTime(release - 1000);
  await r.sample([], [slot({ date: '2028-02-28' })]);
  assert.equal(r.monitor.state().nextAt, release);
  r.setTime(release);
  await r.sample([slot(), slot({ date: '2028-02-28' })]);
  assert.equal(messages.length, 0);
  await r.sample([], [slot()]);
  await r.sample([slot()]);
  assert.equal(messages.length, 1);
  assert.match(messages[0].title, /目标场次重新可约/);
});

test('narrowing a rule during delivery keeps only still eligible retries, even if the rule is widened again', async t => {
  const entered = Promise.withResolvers();
  const limited = Promise.withResolvers();
  const messages = [];
  const r = rig(t, async message => {
    messages.push(message);
    if (messages.length === 1) { entered.resolve(); return limited.promise; }
    return accepted;
  }, { ...rule, court: null });
  const courts = [slot(), slot({ court: 18 })];
  await r.sample([], courts);
  const inFlight = r.sample(courts);
  await entered.promise;
  r.setRule(rule);
  r.setRule({ ...rule, court: null });
  limited.resolve({ kind: 'retry', text: 'rate-limited', retryAfterMs: 60000 });
  await inFlight;
  assert.deepEqual([...r.monitor.pending.keys()], [slotKey(courts[0])]);
  r.setTime(initialTime + 60000);
  await r.sample(courts);
  assert.match(messages[1].markdown, /19号/);
  assert.doesNotMatch(messages[1].markdown, /18号/);
});

test('pending notifications follow live edits and expiry never falls back to all courts', async t => {
  const messages = [];
  const r = rig(t, async message => { messages.push(message); return { kind: 'retry', text: 'limited', retryAfterMs: 1000 }; });
  const matching = slot();
  await r.sample([], [matching]);
  await r.sample([matching]);
  r.setRule({ ...rule, start: '19:00' });
  assert.equal(r.monitor.pending.size, 0);
  r.setTime(Date.parse('2028-02-29T20:00:00+08:00'));
  const later = slot({ date: '2028-03-01' });
  await r.sample([], [later]);
  await r.sample([later]);
  assert.equal(messages.length, 1);
  assert.equal(r.monitor.state().slotCount, 1);
});

test('preferences migrate older files and restore each campus target independently', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'houyu-targets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'prefs.json');
  const legacy = { campus: 'xueyuanlu', interval: 9 };
  await writeFile(file, JSON.stringify({ options: legacy }));
  const old = new Preferences(file, {});
  await old.load();
  assert.deepEqual(old.options, { ...legacy, targets: {} });
  const targets = { shahe: { ...rule, venue: '57', court: 2 }, xueyuanlu: rule };
  await old.saveOptions({ ...legacy, targets });
  const next = new Preferences(file, {});
  await next.load();
  assert.deepEqual(next.options, { ...legacy, targets });
  await writeFile(file, JSON.stringify({ options: { ...legacy, targets: { ...targets, xueyuanlu: { ...rule, end: 'bad' } } } }));
  await next.load();
  assert.equal(next.options.targets.xueyuanlu, null);
  assert.deepEqual(next.options.targets.shahe, targets.shahe);
  await writeFile(file, JSON.stringify({ options: { ...legacy, targets: 'damaged' } }));
  await next.load();
  assert.deepEqual(next.options.targets, { shahe: null, xueyuanlu: null });
});
