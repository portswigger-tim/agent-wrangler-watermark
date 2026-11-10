import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';

const live = (r) => ['queued', 'offered', 'granted'].includes(r.state);
const unstarted = (r) => ['queued', 'offered'].includes(r.state);
export const OFFER_TTL_MS = 5 * 60 * 1000;
export const requestSchema = z.object({
  key: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(160),
  memoryMiB: z.number().finite().positive().max(1048576),
  cpuCores: z.number().finite().positive().max(4096),
  queueTimeoutSeconds: z.number().int().min(1).max(86400).default(1800),
});
const rowSchema = requestSchema.extend({
  id: z.string().uuid(), owner: z.string().min(1).max(200),
  state: z.enum(['queued', 'offered', 'granted', 'released', 'cancelled', 'expired', 'rejected']),
  createdAt: z.number().finite(), deadline: z.number().finite(),
  grantedAt: z.number().finite().optional(), endedAt: z.number().finite().optional(),
  offeredAt: z.number().finite().optional(), claimDeadline: z.number().finite().optional(),
  reason: z.string().max(160).optional(),
}).refine((r) => r.state !== 'offered' || Number.isFinite(r.claimDeadline), 'An offer needs a claim deadline.');
const diskSchema = z.object({ version: z.literal(1), requests: z.array(rowSchema).max(228) });

export function totals(rows) {
  return rows.filter((r) => ['offered', 'granted'].includes(r.state)).reduce((out, r) => ({ memoryMiB: out.memoryMiB + r.memoryMiB, cpuCores: out.cpuCores + r.cpuCores }), { memoryMiB: 0, cpuCores: 0 });
}

const impossible = (row, sample, settings) => row.memoryMiB > sample.totalMemoryMiB * settings.hardPercent / 100 - settings.reserveMemoryMiB || row.cpuCores > sample.cpuCores * settings.hardPercent / 100;
const fresh = (sample, now) => sample && now >= sample.sampledAt && now - sample.sampledAt <= 15000 && sample.cpuPercent !== null;

export function headroom(sample, settings, reserved = { memoryMiB: 0, cpuCores: 0 }) {
  return {
    memoryMiB: Math.max(0, sample.availableMemoryMiB - sample.totalMemoryMiB * (1 - settings.hardPercent / 100) - settings.reserveMemoryMiB - reserved.memoryMiB),
    cpuCores: Math.max(0, sample.cpuCores * (settings.hardPercent - sample.cpuPercent) / 100 - reserved.cpuCores),
  };
}

export class Scheduler {
  constructor({ disk = null, now = Date.now, uuid = randomUUID } = {}) {
    this.disk = disk;
    this.now = now;
    this.uuid = uuid;
    const saved = disk?.load();
    this.rows = saved ? diskSchema.parse(saved).requests : [];
    if (new Set(this.rows.map((r) => r.id)).size !== this.rows.length || new Set(this.rows.map((r) => `${r.owner}\0${r.key}`)).size !== this.rows.length) throw new Error('Duplicate persisted reservations.');
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.closed = false;
  }

  change(fn) {
    if (this.closed) throw new Error('Watermark is disabled.');
    const old = structuredClone(this.rows);
    try {
      const value = fn();
      const terminal = this.rows.filter((r) => !live(r)).sort((a, b) => a.endedAt - b.endedAt).slice(-100);
      this.rows = this.rows.filter(live).concat(terminal);
      this.disk?.save({ version: 1, requests: this.rows });
      this.events.emit('change');
      return structuredClone(value);
    } catch (error) { this.rows = old; throw error; }
  }

  request(owner, input, sample, settings) {
    if (this.closed) throw new Error('Watermark is disabled.');
    const args = requestSchema.parse(input);
    const existing = this.rows.find((r) => r.owner === owner && r.key === args.key);
    if (existing) {
      if (existing.label !== args.label || existing.cpuCores !== args.cpuCores || existing.memoryMiB !== args.memoryMiB || existing.queueTimeoutSeconds !== args.queueTimeoutSeconds) throw new Error('This key already has a different request. Use a new key.');
      return structuredClone(existing);
    }
    if (this.rows.filter(live).length >= 128 || this.rows.filter((r) => r.owner === owner && live(r)).length >= 8) throw new Error('Reservation limit reached (128 global, 8 per session).');
    if (sample && impossible(args, sample, settings)) throw new Error('This request exceeds total admissible capacity. Reduce its budget or change the watermarks.');
    return this.change(() => {
      const r = { ...args, id: this.uuid(), owner, state: 'queued', createdAt: this.now(), deadline: this.now() + args.queueTimeoutSeconds * 1000 };
      this.rows.push(r);
      return r;
    });
  }

  get(owner, id) {
    const row = this.rows.find((r) => r.id === id && r.owner === owner);
    if (!row) throw new Error('Reservation not found for this session.');
    return structuredClone(row);
  }

  release(owner, id) {
    this.get(owner, id);
    return this.change(() => {
      const row = this.rows.find((r) => r.id === id);
      if (live(row)) { row.state = row.state === 'granted' ? 'released' : 'cancelled'; row.endedAt = this.now(); }
      return row;
    });
  }

  claim(owner, id, sample, settings) {
    if (this.closed) throw new Error('Watermark is disabled.');
    const row = this.get(owner, id);
    if (row.state === 'granted') return row; // A retry cannot reserve twice.
    if (row.state !== 'offered') throw new Error('This reservation is not offered. Wait for capacity or request a new budget.');
    if (this.now() >= row.claimDeadline) return this.change(() => {
      const current = this.rows.find((r) => r.id === id);
      current.state = 'expired'; current.endedAt = this.now(); current.reason = 'Offer was not claimed within five minutes.';
      return current;
    });
    if (!fresh(sample, this.now())) throw new Error('Claim paused: fresh telemetry is unavailable or hard pressure is active.');
    const available = headroom(sample, settings, totals(this.rows.filter((r) => r.id !== id)));
    if (row.memoryMiB > available.memoryMiB || row.cpuCores > available.cpuCores) throw new Error('Claim paused: the declared budget no longer fits. The offer stays reserved until its claim deadline.');
    return this.change(() => {
      const current = this.rows.find((r) => r.id === id);
      current.state = 'granted'; current.grantedAt = this.now();
      return current;
    });
  }

  cancelUnavailable(unavailable) {
    const ids = new Set(this.rows.filter((r) => unstarted(r) && unavailable(r.owner)).map((r) => r.id));
    if (ids.size) this.change(() => {
      for (const row of this.rows.filter((r) => ids.has(r.id))) { row.state = 'cancelled'; row.endedAt = this.now(); }
    });
  }

  pump(sample, settings, { admit = true } = {}) {
    const now = this.now();
    const changes = [];
    // Work on a copy first, so no-op sweeps do not write the state file.
    const next = structuredClone(this.rows);
    for (const row of next.filter(unstarted)) {
      if (now >= (row.state === 'offered' ? row.claimDeadline : row.deadline)) {
        row.reason = row.state === 'offered' ? 'Offer was not claimed within five minutes.' : 'Queue deadline reached.';
        row.state = 'expired'; row.endedAt = now; changes.push(row);
      } else if (sample && settings && impossible(row, sample, settings)) {
        row.state = 'rejected'; row.reason = 'Budget exceeds total admissible capacity.'; row.endedAt = now; changes.push(row);
      }
    }
    if (admit && fresh(sample, now)) {
      const remaining = headroom(sample, settings, totals(next));
      for (const row of next.filter((r) => r.state === 'queued')) {
        // Strict FIFO. A small job cannot starve an earlier large job.
        if (row.memoryMiB > remaining.memoryMiB || row.cpuCores > remaining.cpuCores) break;
        row.state = 'offered'; row.offeredAt = now; row.claimDeadline = now + OFFER_TTL_MS;
        remaining.memoryMiB -= row.memoryMiB; remaining.cpuCores -= row.cpuCores;
        changes.push(row);
      }
    }
    if (changes.length) this.change(() => { this.rows = next; });
    return structuredClone(changes);
  }

  async wait(owner, id, seconds = 20) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 25) throw new Error('Wait must be 0–25 seconds.');
    const current = this.get(owner, id);
    if (current.state !== 'queued' || seconds === 0 || this.closed) return current;
    if (this.events.listenerCount('change') >= 128) throw new Error('Too many waiting requests.');
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer); this.events.off('change', changed);
        try { resolve(this.get(owner, id)); } catch (error) { reject(error); }
      };
      const changed = () => {
        try { if (this.closed || this.get(owner, id).state !== 'queued') finish(); }
        catch { finish(); }
      };
      const timer = setTimeout(finish, seconds * 1000);
      this.events.on('change', changed);
    });
  }

  snapshot() { return structuredClone(this.rows); }
  close() { this.closed = true; this.events.emit('change'); }
}
