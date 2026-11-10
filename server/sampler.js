import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MiB = 1024 * 1024;

export function linuxAvailable(text) {
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(text);
  if (!match) throw new Error('MemAvailable is unavailable.');
  return Number(match[1]) * 1024;
}

export function macAvailable(text) {
  const page = /page size of (\d+) bytes/.exec(text);
  if (!page) throw new Error('vm_stat page size is unavailable.');
  // Inactive and speculative pages are an estimate of reclaimable memory.
  // Do not add purgeable pages: those can overlap inactive pages.
  let pages = 0;
  for (const key of ['free', 'inactive', 'speculative']) {
    const match = new RegExp(`^Pages ${key}:\\s+(\\d+)\\.`, 'm').exec(text);
    if (!match) throw new Error(`vm_stat ${key} pages are unavailable.`);
    pages += Number(match[1]);
  }
  return pages * Number(page[1]);
}

export function cpuCounters(cpus) {
  return cpus.reduce((sum, cpu) => {
    sum.idle += cpu.times.idle;
    sum.total += Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return sum;
  }, { idle: 0, total: 0, count: cpus.length });
}

export function cpuUsage(previous, current) {
  if (!previous || previous.count !== current.count || !current.count) return null;
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return 100 * (1 - idle / total);
}

// Read-only telemetry. No shell, user-controlled executable, or process scan.
export function createSampler({ platform = os.platform(), read = readFile, run = exec, system = os, now = Date.now } = {}) {
  let previous = null;
  return async () => {
    const counters = cpuCounters(system.cpus());
    const cpuPercent = cpuUsage(previous, counters);
    previous = counters;
    let available;
    let source;
    if (platform === 'linux') {
      available = linuxAvailable(await read('/proc/meminfo', 'utf8'));
      source = 'Linux MemAvailable';
    } else if (platform === 'darwin') {
      const { stdout } = await run('/usr/bin/vm_stat', [], { timeout: 2000, maxBuffer: 65536, env: { ...process.env, LC_ALL: 'C' } });
      available = macAvailable(stdout);
      source = 'macOS free + inactive + speculative pages (estimate)';
    } else {
      available = system.freemem();
      source = 'OS free memory (conservative)';
    }
    const total = system.totalmem();
    const cpuCores = Math.min(counters.count, system.availableParallelism());
    if (!(total > 0) || !Number.isFinite(available) || available < 0 || !(cpuCores > 0)) throw new Error('Invalid system telemetry.');
    return { sampledAt: now(), totalMemoryMiB: total / MiB, availableMemoryMiB: Math.min(total, available) / MiB, cpuCores, cpuPercent, memorySource: source, scope: 'wrangler host' };
  };
}
