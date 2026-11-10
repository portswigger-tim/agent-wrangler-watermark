import { Scheduler, headroom, totals } from './scheduler.js';
import { createSampler } from './sampler.js';
import { config } from './config.js';

export function pressure(sample, settings, previous = 'normal') {
  if (!sample || sample.cpuPercent === null) return 'unknown';
  const value = Math.max(sample.cpuPercent, 100 * (1 - sample.availableMemoryMiB / sample.totalMemoryMiB));
  if (value >= settings.hardPercent) return 'hard';
  if (previous === 'hard' && value >= settings.hardPercent - 5) return 'hard';
  if (value >= settings.softPercent) return 'soft';
  if ((previous === 'soft' || previous === 'hard') && value >= settings.softPercent - 5) return 'soft';
  return 'normal';
}

export class ResourceService {
  constructor({ disk, sample = createSampler(), now = Date.now } = {}) {
    this.now = now;
    this.scheduler = new Scheduler({ disk, now });
    this.sample = sample;
    this.telemetry = null;
    this.error = null;
    this.level = 'unknown';
    this.refreshing = null;
    this.closed = false;
    this.notices = new Map();
  }

  refresh(host) {
    if (this.closed) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshOnce(host).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async refreshOnce(host) {
    let settings;
    try {
      settings = config(host.settings.all());
      if (!this.telemetry || this.now() < this.telemetry.sampledAt || this.now() - this.telemetry.sampledAt >= 2000) this.telemetry = await this.sample();
      this.error = null;
    } catch (error) {
      this.error = error.message;
      this.telemetry = null;
    }
    if (this.closed) return;
    const before = this.level;
    this.level = settings ? pressure(this.telemetry, settings, before) : 'unknown';
    // Configuration errors and missing telemetry block grants, but queued
    // deadlines still advance. Active grants are never reclaimed on a timer.
    this.advance(settings);
    if (before !== this.level && settings?.notifyPressure) {
      for (const owner of new Set(this.scheduler.snapshot().filter((r) => ['queued', 'granted'].includes(r.state)).map((r) => r.owner))) {
        this.notice(`pressure:${owner}`, owner, `Watermark: ${this.level} system pressure. ${this.level === 'hard' ? 'New admissions are paused. Reduce concurrency where practical; running work is not killed.' : this.level === 'soft' ? 'Avoid starting additional heavy work without a reservation.' : this.level === 'normal' ? 'System pressure has recovered.' : 'Telemetry unavailable; admissions are paused.'}`);
      }
    }
    // Delivery errors do not roll back a grant. Keep a bounded retry outbox.
    for (const [key, notice] of this.notices) {
      if (notice.reservation && !this.scheduler.snapshot().some((r) => r.id === notice.reservation.id && r.state === notice.reservation.state)) { this.notices.delete(key); continue; }
      try { await host.mail.send(notice.owner, notice.text); this.notices.delete(key); }
      catch { /* Retry on the next sweep; status/wait remains authoritative. */ }
    }
    if (!this.closed) await host.rebuild();
  }

  notice(key, owner, text, reservation) {
    if (!this.notices.has(key) && this.notices.size >= 256) this.notices.delete(this.notices.keys().next().value);
    this.notices.set(key, { owner, text, reservation });
  }

  request(owner, args, host) {
    const settings = config(host.settings.all());
    const row = this.scheduler.request(owner, args, this.telemetry, settings);
    this.advance(settings);
    return this.scheduler.get(owner, row.id);
  }

  advance(settings) {
    const changes = this.scheduler.pump(this.error || this.level === 'hard' ? null : this.telemetry, settings);
    for (const row of changes) this.notice(`${row.id}:${row.state}`, row.owner, `Watermark reservation ${row.id} (${row.label}): ${row.state}. ${row.state === 'granted' ? 'Your declared budget is reserved. Check watermark_status before starting work; release only after all work stops.' : 'No resources were reserved.'}`, { id: row.id, state: row.state });
  }

  snapshot() {
    const requests = this.scheduler.snapshot();
    return { telemetry: this.telemetry, error: this.error, pressure: this.level, reserved: totals(requests), requests };
  }

  status(owner, host) {
    const snapshot = this.snapshot();
    let available = null;
    try { if (this.telemetry && this.telemetry.cpuPercent !== null) available = headroom(this.telemetry, config(host.settings.all()), snapshot.reserved); }
    catch { /* The graph exposes configuration errors on the next sweep. */ }
    return { ...snapshot, requests: snapshot.requests.filter((r) => r.owner === owner), available, enabled: !this.closed, fresh: Boolean(this.telemetry && this.now() >= this.telemetry.sampledAt && this.now() - this.telemetry.sampledAt <= 15000), accounting: 'Measured host usage plus full declared reservations; intentionally conservative.' };
  }

  close() { this.closed = true; this.scheduler.close(); }
}
