import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import { ProcessSamplingError, streamProcesses } from './process-stream.js';
export { ProcessSamplingError } from './process-stream.js';

const exec = promisify(execFile);
const options = { timeout: 2500, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } };

async function readEnvironment(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(file.endsWith('/stat') ? 8192 : 256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) throw new Error('Environment exceeds read limit.');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

export function cpuMilliseconds(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return null;
  return ((Number(match[1] || 0) * 86400) + Number(match[2] || 0) * 3600 + Number(match[3]) * 60 + Number(match[4])) * 1000;
}

export function sessionTag(value, separator = ' ') {
  // Darwin ps appends the initial environment to the command. Prefer the
  // last assignment: shell argv may also contain an AW_SESSION_ID prefix.
  // Only this tag survives parsing; never retain or expose other env/argv.
  const expression = separator === '\0' ? /(?:^|\0)AW_SESSION_ID=([^\0]*)(?=\0|$)/g : /(?:^|\s)AW_SESSION_ID=([A-Za-z0-9_-]{1,200})(?=\s|$)/g;
  let tag;
  for (const match of value.matchAll(expression)) tag = match[1];
  return tag;
}

export function parseProcesses(stdout, { environment = false } = {}) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    // LC_ALL=C lstart has five fields, giving PID reuse a stable identity.
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const cpuMs = cpuMilliseconds(match[4]);
    if (cpuMs === null) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), memoryMiB: Number(match[3]) / 1024, cpuMs, identity: `${match[1]}:${match[5].replace(/\s+/g, ' ')}`, tag: environment ? sessionTag(match[6] || '') : undefined });
  }
  return rows;
}

export function linuxCpu(text, ticks) {
  const end = text.lastIndexOf(')');
  const pid = Number(/^(\d+) \(/.exec(text)?.[1]);
  const fields = text.slice(end + 1).trim().split(/\s+/);
  const user = Number(fields[11]);
  const system = Number(fields[12]);
  const started = fields[19];
  if (end < 0 || !pid || !/^\d+$/.test(started || '') || !Number.isFinite(user) || !Number.isFinite(system) || user < 0 || system < 0 || !(ticks > 0)) throw new Error('Invalid process stat.');
  // fields 14/15 are this process only; omit waited-for children (16/17).
  return { pid, identity: `${pid}:${started}`, cpuMs: (user + system) / ticks * 1000 };
}

export function attribute(rows, sessionIds) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const owners = new Map();
  for (const row of rows) {
    const path = [];
    const seen = new Set();
    let current = row;
    let owner = null;
    while (current && !seen.has(current.pid)) {
      if (owners.has(current.pid)) { owner = owners.get(current.pid); break; }
      seen.add(current.pid); path.push(current.pid);
      if (current.tag !== undefined) { owner = sessionIds.has(current.tag) ? current.tag : null; break; }
      current = byPid.get(current.ppid);
    }
    for (const pid of path) owners.set(pid, owner);
  }
  return owners;
}

// Read only the current user's processes. Raw arguments/environments are
// transient inputs and never returned, cached, logged or written to disk.
export function createSessionSampler({ platform = os.platform(), uid = process.getuid?.(), run = exec, read = readEnvironment, clockTicks = null, now = Date.now, monotonic = () => performance.now(), stream = streamProcesses } = {}) {
  let previous = new Map();
  let ticks = clockTicks;
  return async (sessions, { signal } = {}) => {
    const eligible = sessions.filter((session) => !session.archived && session.runtime === 'local');
    const result = Object.fromEntries(sessions.map((session) => [session.sessionId, { status: session.runtime === 'local' ? 'not-found' : 'unsupported', cpuPercent: null, memoryMiB: null, processCount: 0 }]));
    if (!eligible.length) return { sampledAt: now(), sessions: result, error: null };
    if (!['darwin', 'linux'].includes(platform) || !Number.isInteger(uid)) throw new Error('Session process measurements are supported on native macOS and Linux.');
    let rows;
    try {
      if (platform === 'linux' && ticks === null) {
        const { stdout } = await run('/usr/bin/getconf', ['CLK_TCK'], { ...options, signal });
        const rate = Number(stdout.trim());
        if (!Number.isInteger(rate) || rate <= 0 || rate > 1000000) throw new Error('Invalid clock tick rate.');
        ticks = rate;
      }
      const fields = `pid=,ppid=,rss=,time=,lstart=${platform === 'darwin' ? ',command=' : ''}`;
      const args = ['-U', String(uid), '-x', ...(platform === 'darwin' ? ['-Eww'] : []), '-o', fields];
      const snapshotAt = monotonic();
      if (platform === 'darwin' && run === exec) rows = await stream(args, (line) => parseProcesses(line, { environment: true }), { signal });
      else {
        const { stdout } = await run('/bin/ps', args, { ...options, signal });
        rows = parseProcesses(stdout, { environment: platform === 'darwin' });
      }
      for (const row of rows) row.counterAt = snapshotAt;
      if (!rows.length) throw new Error('No process rows.');
      if (platform === 'linux') {
        // Limit concurrent procfs reads. A process can exit or deny env reads;
        // its parent attribution still works when that happens.
        for (let start = 0; start < rows.length; start += 32) {
          signal?.throwIfAborted();
          await Promise.all(rows.slice(start, start + 32).map(async (row) => {
            await Promise.all([
              (async () => {
                try {
                  const stat = linuxCpu(await read(`/proc/${row.pid}/stat`, 'utf8'), ticks);
                  if (stat.pid !== row.pid) throw new Error('Process identity changed.');
                  Object.assign(row, stat, { counterAt: monotonic() });
                } catch { row.cpuMs = null; }
              })(),
              (async () => { try { row.tag = sessionTag(await read(`/proc/${row.pid}/environ`, 'utf8'), '\0'); } catch { /* Exit/permissions: do not invent an owner. */ } })(),
            ]);
          }));
        }
      }
    } catch (error) { throw error instanceof ProcessSamplingError ? error : new ProcessSamplingError(signal?.aborted ? 'timeout' : 'unavailable'); }
    signal?.throwIfAborted();
    const sampledAt = now();
    const owners = attribute(rows, new Set(eligible.map((session) => session.sessionId)));
    const next = new Map();
    for (const row of rows) {
      const owner = owners.get(row.pid);
      if (!owner) continue;
      const usage = result[owner];
      usage.status = 'ok';
      usage.memoryMiB = (usage.memoryMiB ?? 0) + row.memoryMiB;
      usage.processCount++;
      const last = previous.get(row.identity);
      const delta = last?.owner === owner && row.cpuMs !== null && last.cpuMs !== null ? row.cpuMs - last.cpuMs : null;
      const elapsed = last ? row.counterAt - last.counterAt : null;
      // Do not use lifetime %CPU or include terminated-child CPU in a parent:
      // this is an interval delta per live process, summed exactly once.
      if (elapsed > 0 && delta !== null && delta >= 0) usage.cpuPercent = (usage.cpuPercent ?? 0) + delta / elapsed * 100;
      next.set(row.identity, { owner, cpuMs: row.cpuMs, counterAt: row.counterAt });
    }
    previous = next;
    return { sampledAt, sessions: result, error: null };
  };
}
