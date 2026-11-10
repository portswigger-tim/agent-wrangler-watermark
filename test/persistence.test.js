import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { persistence } from '../server/persistence.js';
import { Scheduler } from '../server/scheduler.js';

test('atomic state round trips with private file permissions and fails closed on corruption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watermark-test-'));
  try {
    const file = path.join(dir, 'data', 'reservations.json');
    const disk = persistence(file);
    assert.equal(disk.load(), null);
    const s = new Scheduler({ disk });
    const r = s.request('a', { key: 'build', label: 'Build', memoryMiB: 100, cpuCores: 0.5 }, null, {});
    assert.deepEqual(new Scheduler({ disk }).get('a', r.id), r);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['reservations.json']);
    fs.writeFileSync(file, '{broken');
    assert.throws(() => new Scheduler({ disk }));
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
