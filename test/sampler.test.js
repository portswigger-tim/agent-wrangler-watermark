import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSampler, linuxAvailable, macAvailable, cpuUsage } from '../server/sampler.js';

test('Linux uses MemAvailable, not only free memory', () => {
  assert.equal(linuxAvailable('MemFree: 2 kB\nMemAvailable: 2048 kB\n'), 2097152);
  assert.throws(() => linuxAvailable('MemFree: 1 kB'));
});

test('macOS page size is dynamic and purgeable is not double counted', () => {
  assert.equal(macAvailable('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 3.\nPages purgeable: 20.\n'), 33 * 16384);
  assert.throws(() => macAvailable('invalid output'));
});

test('CPU deltas ignore warmup, resets, empty and changed topology', () => {
  const initial = { count: 2, total: 1000, idle: 500 };
  assert.equal(cpuUsage(null, initial), null);
  assert.equal(cpuUsage(initial, { count: 2, total: 1200, idle: 550 }), 75);
  for (const next of [{ count: 2, total: 1000, idle: 500 }, { count: 1, total: 1200, idle: 550 }, { count: 2, total: 1200, idle: 400 }]) assert.equal(cpuUsage(initial, next), null);
});

test('sampler returns a host snapshot and bounds available memory', async () => {
  let idle = 0;
  const system = { cpus: () => [{ times: { idle: idle += 50, user: 50 } }], availableParallelism: () => 1, totalmem: () => 1024 * 1024 };
  const sample = createSampler({ platform: 'linux', system, now: () => 1, read: async () => 'MemAvailable: 2048 kB' });
  assert.equal((await sample()).cpuPercent, null);
  const next = await sample();
  assert.equal(next.availableMemoryMiB, 1);
  assert.equal(next.cpuPercent, 0);
  assert.equal(next.scope, 'wrangler host');
});
