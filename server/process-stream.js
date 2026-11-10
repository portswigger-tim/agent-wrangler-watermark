import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class ProcessSamplingError extends Error {
  constructor(code = 'unavailable') {
    super({ timeout: 'Session process measurement timed out.', limit: 'Session process snapshot exceeds its output limit.', unavailable: 'Session process measurements unavailable.' }[code] || 'Session process measurements unavailable.');
    this.code = code;
  }
}

// Parse each line before reading the next; only numeric/tag rows survive.
// Neither stderr nor a raw snapshot becomes an error, log or retained value.
export async function streamProcesses(args, parseLine, { signal, spawnProcess = spawn, maxBytes = 64 * 1024 * 1024, maxLine = 1024 * 1024, timeoutMs = 2500 } = {}) {
  const child = spawnProcess('/bin/ps', args, { signal, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
  let failure = null;
  const exited = new Promise((resolve) => {
    child.once('error', () => { failure = signal?.aborted ? 'timeout' : 'unavailable'; resolve(-1); });
    child.once('close', resolve);
  });
  const timer = setTimeout(() => { failure = 'timeout'; child.kill('SIGKILL'); }, timeoutMs);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const rows = [];
  let bytes = 0;
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line) + 1;
      if (line.length > maxLine || bytes > maxBytes || rows.length >= 20000) throw new ProcessSamplingError('limit');
      rows.push(...parseLine(line));
    }
    const code = await exited;
    if (failure || code !== 0 || signal?.aborted) throw new ProcessSamplingError(failure || 'unavailable');
    return rows;
  } catch (error) {
    throw error instanceof ProcessSamplingError ? error : new ProcessSamplingError(signal?.aborted ? 'timeout' : 'unavailable');
  } finally {
    clearTimeout(timer); lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
