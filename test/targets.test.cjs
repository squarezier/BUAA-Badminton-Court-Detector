'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { CourtMonitor } = require('../src/monitor.cjs');
const { validTarget, matchesTarget, slotKey } = require('../src/courts.cjs');
const { Preferences } = require('../src/preferences.cjs');
const { notice, noticeBatches } = require('../src/push.cjs');

const day = '2028-02-29';
const rule = { date: day, start: '18:00', end: '20:00' };
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

test('target dates and clock ranges are validated', () => {
  assert.ok(validTarget(rule));
  for (const delta of [
    { date: '2027-02-29' }, { date: '2028-02-30' }, { date: '2028-2-29' }, { date: 'invalid' },
    { start: '18:60' }, { start: '9:00' }, { start: '20:00' }, { end: '17:59' }, { end: '24:00' },
  ]) assert.equal(validTarget({ ...rule, ...delta }), false, JSON.stringify(delta));
});

test('whole slots must fit the date and time boundaries at every court in the monitored campus', () => {
  assert.equal(matchesTarget(slot({ end: '20:00' }), rule), true);
  assert.equal(matchesTarget(slot({ start: '19:00', end: '20:00' }), rule), true);
  for (const delta of [
    { start: '17:59' }, { end: '20:01' }, { date: '2028-03-01' },
    { start: '20:00', end: '21:00' },
  ]) assert.equal(matchesTarget(slot(delta), rule), false);
  assert.equal(matchesTarget(slot({ venue: '38', court: 73 }), rule), true);
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
  assert.match(messages[0].title, /目标场次重新可约.*学院路校区 3 场次/);
  const card = JSON.stringify(messages[0].feishuCard);
  assert.match(card, /18:00–19:00 · 体育馆主馆.*19 号/);
  assert.match(card, /18:00–19:00 · 体育馆训练馆.*18、19 号/);
  assert.doesNotMatch(card, /17:00–18:00|19:00–20:00|3月1日|综合馆/);
  await r.sample([...candidates, release]);
  assert.equal(messages.length, 1);
  await r.sample([], [slot()]);
  await r.sample([slot()]);
  assert.equal(messages.length, 2, 'a new booking followed by a new reopening may send again');
});

test('widening a target or removing it does not turn existing green courts into an alert', async t => {
  const messages = [];
  const r = rig(t, async message => { messages.push(message); return accepted; });
  const other = slot({ court: 18, start: '17:00', end: '18:00' });
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
  });
  const courts = [slot(), slot({ court: 18, start: '19:00', end: '20:00' })];
  await r.sample([], courts);
  const inFlight = r.sample(courts);
  await entered.promise;
  r.setRule({ ...rule, end: '19:00' });
  r.setRule(rule);
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

test('all reopened groups reach Feishu across cards, without repeating an accepted card after a rate limit', async t => {
  const acceptedGroups = [];
  let attempts = 0;
  const r = rig(t, async message => {
    if (++attempts === 2) return { kind: 'retry', text: 'limited', retryAfterMs: 1000 };
    const card = JSON.stringify(message.feishuCard);
    assert.doesNotMatch(card, /另有/);
    acceptedGroups.push(...[...card.matchAll(/(18:\d\d)–18:\d\d · /g)].map(match => match[1]));
    return accepted;
  });
  const clock = minute => '18:' + String(minute).padStart(2, '0');
  const candidates = Array.from({ length: 40 }, (_, i) => slot({ start: clock(i), end: clock(i + 1) }));
  await r.sample([], candidates);
  await r.sample(candidates);
  assert.equal(attempts, 2);
  assert.equal(r.monitor.pending.size, 22);
  r.setTime(initialTime + 1000);
  await r.sample(candidates);
  assert.equal(attempts, 4);
  assert.deepEqual(acceptedGroups, candidates.map(item => item.start));
  assert.equal(r.monitor.pending.size, 0);
});

test('saturated cards preserve complete court lists and fit the signed webhook payload', () => {
  const crowded = Array.from({ length: 36 }, (_, minute) => Array.from({ length: 120 }, (_, i) =>
    slot({ start: '18:' + String(minute).padStart(2, '0'), end: '19:01', court: i + 1, price: 9998.99999999999 })
  )).flat();
  const batches = [...noticeBatches(crowded)];
  assert.equal(batches.length, 2);
  assert.equal(batches.flat().length, crowded.length);
  for (const part of batches) {
    const card = notice('xueyuanlu', part, initialTime, true).feishuCard;
    const body = JSON.stringify({ msg_type: 'interactive', card, timestamp: '9999999999', sign: 'A'.repeat(44) });
    assert.ok(Buffer.byteLength(body) <= 20000);
    assert.doesNotMatch(body, /另有/);
    assert.equal([...body.matchAll(/119、120 号/g)].length, 18);
  }
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
  const targets = { shahe: { ...rule, start: '07:00', end: '09:00' }, xueyuanlu: rule };
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

test('a damaged interval cannot widen the saved notification range on upgrade', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'houyu-options-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'prefs.json');
  await writeFile(file, JSON.stringify({ options: { campus: 'xueyuanlu', interval: 0, targets: { xueyuanlu: rule } } }));
  const prefs = new Preferences(file, {});
  await prefs.load();
  assert.deepEqual(prefs.options, { campus: 'xueyuanlu', interval: 2, targets: { xueyuanlu: rule } });
});
