import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { streamProcesses, ProcessSamplingError } from '../server/process-stream.js';
import { parseProcesses } from '../server/processes.js';

function childFor(chunks, { pending = false } = {}) {
  const child = new EventEmitter();
  child.stdout = pending ? new Readable({ read() {} }) : Readable.from(chunks);
  child.exitCode = null; child.signalCode = null;
  child.kill = () => { child.signalCode = 'SIGKILL'; child.stdout.push(null); return true; };
  child.stdout.once('end', () => {
    if (!child.signalCode) child.exitCode = 0;
    queueMicrotask(() => child.emit('close', child.exitCode));
  });
  return child;
}

test('Darwin snapshots stream above the former 16 MiB cap without retaining raw environments', async () => {
  const payload = 'X'.repeat(20000);
  function* lines() {
    for (let pid = 1; pid <= 1000; pid++) yield `${pid} 0 1024 0:01.00 Tue Nov 10 10:00:00 2026 node SECRET=${payload} AW_SESSION_ID=a\n`;
  }
  const rows = await streamProcesses([], (line) => parseProcesses(line, { environment: true }), { spawnProcess: () => childFor(lines()) });
  assert.equal(rows.length, 1000);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|XXXXX/);
  assert.ok(JSON.stringify(rows).length < 200000);
});

test('stream size limits and deadlines fail with fixed messages and stop the child', async () => {
  const limited = childFor(['SECRET=private'.repeat(100)]);
  await assert.rejects(streamProcesses([], () => [], { spawnProcess: () => limited, maxBytes: 32 }), (error) => error instanceof ProcessSamplingError && error.code === 'limit' && !/SECRET|private/.test(error.message));
  assert.ok(limited.exitCode === 0 || limited.signalCode === 'SIGKILL');
  const hung = childFor([], { pending: true });
  await assert.rejects(streamProcesses([], () => [], { spawnProcess: () => hung, timeoutMs: 5 }), (error) => error.code === 'timeout');
  assert.equal(hung.signalCode, 'SIGKILL');
});
