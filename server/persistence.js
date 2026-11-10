import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export function stateFile() {
  const raw = process.env.AW_DATA_DIR;
  const root = raw ? (raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : path.resolve(raw)) : path.join(os.homedir(), '.agent-wrangler');
  return path.join(root, 'watermark', 'reservations.json');
}

export function persistence(file) {
  return {
    load() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    save(value) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.tmp`;
      let fd;
      try {
        fd = fs.openSync(temp, 'wx', 0o600);
        fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temp, file);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        fs.rmSync(temp, { force: true });
      }
    },
  };
}
