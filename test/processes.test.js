import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionSampler, parseProcesses, cpuMilliseconds, sessionTag, attribute, linuxCpu } from '../server/processes.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';

const sessions = [{ sessionId: 'a', runtime: 'local' }, { sessionId: 'b', runtime: 'local' }];
const line = (pid, ppid, cpu, env = '', rss = 1024, start = '10:00:00') => `${pid} ${ppid} ${rss} ${cpu} Tue Nov 10 ${start} 2026 node ${env}`;
const stat = (pid, user, system = 0, start = 100) => {
  const fields = Array(22).fill('0');
  fields[0] = 'R'; fields[11] = user; fields[12] = system; fields[19] = start;
  return `${pid} (process (name)) ${fields.join(' ')}`;
};

test('CPU time formats and ps parsing retain only statistics and the identity tag', () => {
  assert.equal(cpuMilliseconds('0:01.25'), 1250);
  assert.equal(cpuMilliseconds('01:02:03'), 3723000);
  assert.equal(cpuMilliseconds('2-01:02:03'), 176523000);
  assert.equal(cpuMilliseconds('bad'), null);
  const [row] = parseProcesses(line(1, 0, '0:01.25', "AW_SESSION_ID='argument' SECRET=not-for-output AW_SESSION_ID=a"), { environment: true });
  assert.equal(row.tag, 'a');
  assert.equal(row.memoryMiB, 1);
  assert.equal(row.cpuMs, 1250);
  assert.doesNotMatch(JSON.stringify(row), /SECRET|not-for-output|argument|node/);
  assert.equal(sessionTag('X=one\0AW_SESSION_ID=b\0Y=two\0', '\0'), 'b');
});

test('descendants inherit the nearest owner, explicit nested/foreign tags prevent double counting', () => {
  const rows = [
    { pid: 1, ppid: 0, tag: 'a' }, { pid: 2, ppid: 1 },
    { pid: 3, ppid: 2, tag: 'b' }, { pid: 4, ppid: 3 },
    { pid: 5, ppid: 1, tag: 'foreign' }, { pid: 6, ppid: 5 },
    { pid: 7, ppid: 8 }, { pid: 8, ppid: 7 },
  ];
  assert.deepEqual([...attribute(rows, new Set(['a', 'b']))], [[1, 'a'], [2, 'a'], [3, 'b'], [4, 'b'], [5, null], [6, null], [7, null], [8, null]]);
});

test('per-session RSS and interval CPU sum each live process once; disappeared processes drop out', async () => {
  let at = 0;
  let stdout = [line(10, 0, '0:01.00', 'AW_SESSION_ID=a'), line(11, 10, '0:01.00'), line(12, 10, '0:01.00', 'AW_SESSION_ID=b')].join('\n');
  const sample = createSessionSampler({ platform: 'darwin', uid: 1, run: async () => ({ stdout }), now: () => at, monotonic: () => at });
  const first = await sample(sessions);
  assert.equal(first.sessions.a.cpuPercent, null);
  assert.equal(first.sessions.a.memoryMiB, 2);
  at = 5000;
  stdout = [line(10, 0, '0:02.00', 'AW_SESSION_ID=a'), line(11, 10, '0:03.00'), line(12, 10, '0:06.00', 'AW_SESSION_ID=b')].join('\n');
  const next = await sample(sessions);
  assert.equal(next.sessions.a.cpuPercent, 60);
  assert.equal(next.sessions.b.cpuPercent, 100);
  assert.equal(next.sessions.a.processCount, 2);
  at = 10000; stdout = line(12, 0, '0:07.00', 'AW_SESSION_ID=b');
  const ended = await sample(sessions);
  assert.equal(ended.sessions.a.status, 'not-found');
  assert.equal(ended.sessions.a.memoryMiB, null);
});

test('PID reuse and changed ownership do not inherit old CPU usage', async () => {
  let at = 0;
  let stdout = line(10, 0, '0:01.00', 'AW_SESSION_ID=a');
  const sample = createSessionSampler({ platform: 'darwin', uid: 1, run: async () => ({ stdout }), now: () => at, monotonic: () => at });
  await sample(sessions);
  at = 5000; stdout = line(10, 0, '0:20.00', 'AW_SESSION_ID=a', 1024, '10:00:05');
  assert.equal((await sample(sessions)).sessions.a.cpuPercent, null);
  at = 10000; stdout = line(10, 0, '0:21.00', 'AW_SESSION_ID=b', 1024, '10:00:05');
  assert.equal((await sample(sessions)).sessions.b.cpuPercent, null);
});

test('Linux reads NUL-separated identity tags and can inherit across inaccessible child environments', async () => {
  const sample = createSessionSampler({ platform: 'linux', uid: 1, clockTicks: 100, run: async () => ({ stdout: `${line(1, 0, '0:01.00')}\n${line(2, 1, '0:01.00')}` }), read: async (file) => {
    if (file.endsWith('/stat')) return stat(Number(file.split('/')[2]), 100);
    if (file === '/proc/1/environ') return 'SECRET=private\0AW_SESSION_ID=a\0';
    throw new Error('permission denied');
  } });
  const result = await sample(sessions);
  assert.equal(result.sessions.a.processCount, 2);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private|permission/);
});

test('unavailable process access never exposes raw command/environment errors or claims zero usage', async () => {
  const sample = createSessionSampler({ platform: 'darwin', uid: 1, run: async () => { throw new Error('SECRET=private raw stdout'); } });
  await assert.rejects(sample(sessions), (error) => !/SECRET|private/.test(error.message) && /unavailable/.test(error.message));
  const unsupported = createSessionSampler({ platform: 'darwin', uid: 1, run: async () => { throw new Error('must not run'); } });
  const result = await unsupported([{ sessionId: 'remote', runtime: 'cloud' }]);
  assert.equal(result.sessions.remote.status, 'unsupported');
  assert.equal(result.sessions.remote.cpuPercent, null);
});

test('Linux CPU uses subsecond kernel ticks and a stable start-time identity', async () => {
  assert.deepEqual(linuxCpu(stat(1, 12, 3, 987), 100), { pid: 1, identity: '1:987', cpuMs: 150 });
  let at = 0;
  let cpu = 10;
  const sample = createSessionSampler({ platform: 'linux', uid: 1, clockTicks: 100, now: () => at, monotonic: () => at,
    run: async () => ({ stdout: line(1, 0, '00:00:00') }),
    read: async (file) => file.endsWith('/stat') ? stat(1, cpu) : 'AW_SESSION_ID=a\0',
  });
  await sample(sessions);
  at = 500; cpu = 11;
  assert.equal((await sample(sessions)).sessions.a.cpuPercent, 2);
});

test('native Linux collection measures a tagged CPU-active process twice', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const owner = `watermark-process-test-${process.pid}`;
  const child = spawn(process.execPath, ['-e', "setInterval(() => { const until = performance.now() + 20; while (performance.now() < until) {} }, 50); process.send('ready');"], { env: { ...process.env, AW_SESSION_ID: owner }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await once(child, 'message');
    const sample = createSessionSampler();
    const first = await sample([{ sessionId: owner, runtime: 'local' }]);
    assert.equal(first.sessions[owner].status, 'ok');
    assert.ok(first.sessions[owner].memoryMiB > 0);
    await setTimeout(250);
    const next = await sample([{ sessionId: owner, runtime: 'local' }]);
    assert.notEqual(next.sessions[owner].cpuPercent, null);
    assert.ok(next.sessions[owner].cpuPercent > 0 && next.sessions[owner].cpuPercent <= 150);
    assert.equal(next.sessions[owner].processCount, 1);
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
});
