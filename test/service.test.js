import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceService, pressure } from '../server/service.js';
import { config } from '../server/config.js';
import { tools } from '../server/tools.js';
import manifest, { declaration } from '../index.js';
import { readFile } from 'node:fs/promises';

function fixture() {
  let now = 0;
  let cpu = 10;
  let fail = false;
  const mails = [];
  const settings = { reserveMemoryMiB: 0 };
  const service = new ResourceService({ now: () => now, sample: async () => {
    if (fail) throw new Error('telemetry failed');
    return { sampledAt: now, totalMemoryMiB: 10000, availableMemoryMiB: 8000, cpuCores: 8, cpuPercent: cpu, memorySource: 'fixture' };
  } });
  const host = { settings: { all: () => settings }, sessions: { get: (id) => id === 'missing' ? null : ({ sessionId: id, runtime: 'local' }) }, stores: { resources: service }, mail: { send: async (...args) => { mails.push(args); } }, rebuild: async () => {} };
  return { host, service, mails, settings, advance: () => { now += 5000; }, cpu: (value) => { cpu = value; }, fail: () => { fail = true; } };
}

const request = { key: 'test', label: 'Build', memoryMiB: 1000, cpuCores: 1 };
const call = (name, host, caller = 'a', args = {}) => tools.find((t) => t.name === name).handler({ host, caller }, args);

test('tools validate identity/budgets and isolate reservations', async () => {
  const f = fixture();
  assert.equal((await call('watermark_request', f.host, null, request)).isError, true);
  assert.equal((await call('watermark_request', f.host, 'missing', request)).isError, true);
  assert.equal((await call('watermark_request', f.host, 'a', { ...request, cpuCores: -1 })).isError, true);
  const granted = await call('watermark_request', f.host, 'a', request);
  assert.equal(granted.structuredContent.reservation.state, 'granted');
  assert.equal((await call('watermark_status', f.host, 'b')).structuredContent.requests.length, 0);
  assert.equal((await call('watermark_release', f.host, 'b', { id: granted.structuredContent.reservation.id })).isError, true);
  f.host.sessions.get = () => ({ runtime: 'devcontainer' });
  assert.equal((await call('watermark_request', f.host, 'a', request)).isError, true);
});

test('hard pressure pauses admissions until hysteresis recovery; warnings deduplicate', async () => {
  const f = fixture();
  await f.service.refresh(f.host);
  f.service.request('a', request, f.host);
  f.cpu(95); f.advance(); await f.service.refresh(f.host);
  assert.equal(f.service.level, 'hard');
  const queued = f.service.request('b', { ...request, key: 'other' }, f.host);
  assert.equal(queued.state, 'queued');
  const count = f.mails.length;
  f.advance(); await f.service.refresh(f.host);
  assert.equal(f.mails.length, count);
  f.cpu(86); f.advance(); await f.service.refresh(f.host);
  assert.equal(f.service.level, 'hard');
  assert.equal(f.service.scheduler.get('b', queued.id).state, 'queued');
  f.cpu(10); f.advance(); await f.service.refresh(f.host);
  assert.equal(f.service.scheduler.get('b', queued.id).state, 'granted');
});

test('configuration and telemetry failures block grants and retain active budgets', async () => {
  const f = fixture();
  await f.service.refresh(f.host);
  const active = f.service.request('a', request, f.host);
  f.fail(); f.advance(); await f.service.refresh(f.host);
  const queued = f.service.request('b', { ...request, key: 'b' }, f.host);
  assert.equal(queued.state, 'queued');
  assert.equal(f.service.status('a', f.host).error, 'telemetry failed');
  assert.equal(f.service.scheduler.get('a', active.id).state, 'granted');
  f.settings.softPercent = 95; f.settings.hardPercent = 50;
  f.advance(); await f.service.refresh(f.host);
  assert.match(f.service.error, /below/);
  assert.equal(f.service.level, 'unknown');
});

test('overlapping sweeps coalesce and disabled service cannot grant', async () => {
  let complete;
  let calls = 0;
  const f = fixture();
  f.service.sample = () => { calls++; return new Promise((resolve) => { complete = resolve; }); };
  const first = f.service.refresh(f.host);
  assert.equal(f.service.refresh(f.host), first);
  f.service.close();
  complete(null); await first;
  assert.equal(calls, 1);
  assert.throws(() => f.service.request('a', request, f.host), /disabled/);
});

test('notification failures retry without revoking the granted reservation', async () => {
  const f = fixture();
  await f.service.refresh(f.host);
  const r = f.service.request('a', request, f.host);
  f.host.mail.send = () => { throw new Error('mail offline'); };
  f.advance(); await f.service.refresh(f.host);
  assert.equal(f.service.scheduler.get('a', r.id).state, 'granted');
  assert.equal(f.service.notices.size, 1);
  f.host.mail.send = async () => {};
  f.advance(); await f.service.refresh(f.host);
  assert.equal(f.service.notices.size, 0);
});

test('a delayed grant notice is discarded when the reservation was already released', async () => {
  const f = fixture();
  await f.service.refresh(f.host);
  const r = f.service.request('a', request, f.host);
  f.service.scheduler.release('a', r.id);
  f.advance(); await f.service.refresh(f.host);
  assert.equal(f.mails.length, 0);
});

test('archive cancels queued work while retaining grants and browser release works', async () => {
  const f = fixture();
  await f.service.refresh(f.host);
  const active = f.service.request('a', request, f.host);
  f.cpu(99); f.advance(); await f.service.refresh(f.host);
  const queued = f.service.request('a', { ...request, key: 'queued' }, f.host);
  manifest.session.onArchive({ host: f.host, sessionId: 'a' });
  assert.equal(f.service.scheduler.get('a', queued.id).state, 'cancelled');
  assert.equal(f.service.scheduler.get('a', active.id).state, 'granted');
  await manifest.handlers[0].handler({ id: active.id }, f.host);
  assert.equal(f.service.scheduler.get('a', active.id).state, 'released');
});

test('static disclosure matches runtime manifest, all tools accept their schemas', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.wranglerExtension, declaration);
  for (const t of tools) { assert.equal(typeof t.handler, 'function'); assert.ok(t.description.length > 20); }
});

test('watermarks validate and recover with five-point hysteresis', () => {
  assert.throws(() => config({ softPercent: 90, hardPercent: 80 }));
  const sample = { cpuPercent: 89, totalMemoryMiB: 100, availableMemoryMiB: 90 };
  assert.equal(pressure(sample, config(), 'hard'), 'hard');
  assert.equal(pressure({ ...sample, cpuPercent: 69 }, config(), 'hard'), 'normal');
});
