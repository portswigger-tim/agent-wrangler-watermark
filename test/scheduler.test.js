import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, headroom, OFFER_TTL_MS } from '../server/scheduler.js';
import { config } from '../server/config.js';

const settings = config({ reserveMemoryMiB: 0 });
const sample = (time = 0, extra = {}) => ({ sampledAt: time, totalMemoryMiB: 10000, availableMemoryMiB: 7000, cpuCores: 8, cpuPercent: 10, ...extra });
const input = (key, extra = {}) => ({ key, label: key, memoryMiB: 2000, cpuCores: 2, ...extra });

test('admissions reserve both resources atomically and do not overcommit', async () => {
  const scheduler = new Scheduler({ now: () => 0 });
  await Promise.all(Array.from({ length: 8 }, (_, i) => Promise.resolve().then(() => {
    scheduler.request(`owner${i}`, input(`${i}`), sample(), settings);
    scheduler.pump(sample(), settings);
  })));
  assert.equal(scheduler.snapshot().filter((r) => r.state === 'offered').length, 3);
  assert.equal(scheduler.snapshot().filter((r) => r.state === 'queued').length, 5);
  const available = headroom(sample(), settings, { memoryMiB: 6000, cpuCores: 6 });
  assert.equal(available.memoryMiB, 0);
  assert.ok(Math.abs(available.cpuCores - 0.4) < 0.00001);
});

test('FIFO blocks small later work, then drains after release', () => {
  const s = new Scheduler({ now: () => 0 });
  const first = s.request('a', input('first', { memoryMiB: 5000, cpuCores: 4 }), sample(), settings);
  s.pump(sample(), settings);
  const large = s.request('b', input('large'), sample(), settings);
  const small = s.request('c', input('small', { memoryMiB: 500, cpuCores: 0.1 }), sample(), settings);
  s.pump(sample(), settings);
  assert.equal(s.get('c', small.id).state, 'queued');
  s.release('a', first.id); s.pump(sample(), settings);
  assert.equal(s.get('b', large.id).state, 'offered');
  assert.equal(s.get('c', small.id).state, 'offered');
});

test('CPU and memory each independently constrain admissions', () => {
  for (const telemetry of [sample(0, { cpuPercent: 89 }), sample(0, { availableMemoryMiB: 1100 })]) {
    const s = new Scheduler({ now: () => 0 });
    const row = s.request('a', input('x'), telemetry, settings);
    s.pump(telemetry, settings);
    assert.equal(s.get('a', row.id).state, 'queued');
  }
});

test('impossible and invalid budgets are rejected', () => {
  const s = new Scheduler({ now: () => 0 });
  for (const extra of [{ memoryMiB: 9500 }, { cpuCores: 8 }, { memoryMiB: -1 }, { cpuCores: NaN }, { cpuCores: Infinity }, { memoryMiB: 0 }]) {
    assert.throws(() => s.request('a', input('x', extra), sample(), settings));
  }
  assert.equal(s.snapshot().length, 0);
});

test('unknown, stale and warming telemetry never grants', () => {
  for (const telemetry of [null, sample(0, { cpuPercent: null }), sample(-16000), sample(1000)]) {
    const s = new Scheduler({ now: () => 0 });
    const r = s.request('a', input('x'), null, settings);
    s.pump(telemetry, settings);
    assert.equal(s.get('a', r.id).state, 'queued');
  }
});

test('claimed grants survive time and restart while queued work expires', () => {
  let now = 0;
  let saved;
  const disk = { load: () => saved, save: (value) => { saved = structuredClone(value); } };
  const s = new Scheduler({ disk, now: () => now });
  const granted = s.request('a', input('a'), sample(), settings);
  s.pump(sample(), settings);
  s.claim('a', granted.id, sample(), settings);
  const queued = s.request('b', input('b', { queueTimeoutSeconds: 1 }), sample(), settings);
  now = 2000; s.pump(null, settings);
  const restarted = new Scheduler({ disk, now: () => now });
  assert.equal(restarted.get('a', granted.id).state, 'granted');
  assert.equal(restarted.get('b', queued.id).state, 'expired');
});

test('idempotency prevents uncertain requests from reserving twice; owner isolation', () => {
  const s = new Scheduler({ now: () => 0 });
  const r = s.request('a', input('x'), sample(), settings);
  assert.deepEqual(s.request('a', input('x'), sample(), settings), r);
  assert.throws(() => s.request('a', input('x', { memoryMiB: 1 }), sample(), settings), /different/);
  assert.throws(() => s.get('b', r.id), /not found/);
  assert.throws(() => s.release('b', r.id), /not found/);
  assert.equal(s.release('a', r.id).state, 'cancelled');
  assert.equal(s.release('a', r.id).state, 'cancelled');
});

test('waiting is event-driven and cleans listeners on grant, timeout and disable', async () => {
  const s = new Scheduler({ now: () => 0 });
  const a = s.request('a', input('x'), sample(), settings);
  const wait = s.wait('a', a.id, 1);
  s.pump(sample(), settings);
  assert.equal((await wait).state, 'offered');
  const b = s.request('a', input('y'), sample(), settings);
  assert.equal((await s.wait('a', b.id, 0.001)).state, 'queued');
  const disabled = s.wait('a', b.id, 1); s.close(); await disabled;
  assert.equal(s.events.listenerCount('change'), 0);
});

test('failed durable writes roll back mutations and do not grant', () => {
  const s = new Scheduler({ disk: { load: () => null, save: () => { throw new Error('disk full'); } } });
  assert.throws(() => s.request('a', input('x'), sample(), settings), /disk full/);
  assert.deepEqual(s.snapshot(), []);
});

test('corrupt persistence fails closed, session and global caps are bounded', () => {
  assert.throws(() => new Scheduler({ disk: { load: () => ({ version: 9 }), save() {} } }));
  const s = new Scheduler({ now: () => 0 });
  for (let i = 0; i < 8; i++) s.request('a', input(String(i)), sample(), settings);
  assert.throws(() => s.request('a', input('ninth'), sample(), settings), /limit/);
  for (let i = 8; i < 128; i++) s.request(`owner${i}`, input(String(i)), sample(), settings);
  assert.throws(() => s.request('b', input('extra'), sample(), settings), /limit/);
});

test('unclaimed offers expire and free capacity; claimed grants do not', () => {
  let now = 0;
  const s = new Scheduler({ now: () => now });
  const a = s.request('a', input('a'), sample(), settings);
  const b = s.request('b', input('b'), sample(), settings);
  s.pump(sample(), settings);
  assert.equal(s.get('a', a.id).state, 'offered');
  assert.equal(s.claim('a', a.id, sample(), settings).state, 'granted');
  assert.equal(s.claim('a', a.id, null, settings).state, 'granted');
  now = OFFER_TTL_MS;
  s.pump(sample(now), settings);
  assert.equal(s.get('b', b.id).state, 'expired');
  assert.equal(s.get('a', a.id).state, 'granted');
  assert.throws(() => s.claim('b', b.id, sample(now), settings), /not offered/);
});

test('claim rejects stale telemetry and increased usage, and cannot revive an expired offer', () => {
  let now = 0;
  const s = new Scheduler({ now: () => now });
  const a = s.request('a', input('a'), sample(), settings);
  s.pump(sample(), settings);
  assert.throws(() => s.claim('a', a.id, null, settings), /paused/);
  assert.throws(() => s.claim('a', a.id, sample(0, { cpuPercent: 89 }), settings), /no longer fits/);
  now = OFFER_TTL_MS;
  assert.equal(s.claim('a', a.id, sample(now), settings).state, 'expired');
});

test('new telemetry and settings reject impossible head requests instead of blocking FIFO', () => {
  const s = new Scheduler({ now: () => 0 });
  const a = s.request('a', input('a', { memoryMiB: 8000 }), null, settings);
  const b = s.request('b', input('b'), null, settings);
  s.pump(sample(), config({ hardPercent: 70, softPercent: 60, reserveMemoryMiB: 0 }));
  assert.equal(s.get('a', a.id).state, 'rejected');
  assert.equal(s.get('b', b.id).state, 'offered');
});

test('disable also rejects idempotent request and claim retries', () => {
  const s = new Scheduler({ now: () => 0 });
  const a = s.request('a', input('a'), sample(), settings);
  s.pump(sample(), settings);
  s.claim('a', a.id, sample(), settings);
  s.close();
  assert.throws(() => s.request('a', input('a'), sample(), settings), /disabled/);
  assert.throws(() => s.claim('a', a.id, sample(), settings), /disabled/);
});

test('sequential claims retain the conservative policy when another offered job starts', () => {
  const cfg = config();
  const initial = sample(0, { totalMemoryMiB: 16384, availableMemoryMiB: 12384, cpuCores: 16 });
  const s = new Scheduler({ now: () => 0 });
  const a = s.request('a', input('a', { memoryMiB: 4000 }), initial, cfg);
  const b = s.request('b', input('b', { memoryMiB: 5000 }), initial, cfg);
  s.pump(initial, cfg);
  assert.equal(s.get('a', a.id).state, 'offered');
  assert.equal(s.get('b', b.id).state, 'offered');
  s.claim('a', a.id, initial, cfg);
  // Measured usage grows after A starts; its full reservation still counts.
  const running = { ...initial, availableMemoryMiB: 8384 };
  assert.throws(() => s.claim('b', b.id, running, cfg), /no longer fits/);
  assert.equal(s.get('b', b.id).state, 'offered');
  s.release('a', a.id);
  // Once A stops and telemetry recovers, B can claim the same offer.
  assert.equal(s.claim('b', b.id, initial, cfg).state, 'granted');
});
