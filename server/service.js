import { Scheduler, headroom, totals } from './scheduler.js';
import { createSampler } from './sampler.js';
import { config } from './config.js';
import { createSessionSampler } from './processes.js';

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
  constructor({ disk, sample = createSampler(), sampleSessions = createSessionSampler(), now = Date.now, sendTimeoutMs = 1000 } = {}) {
    this.now = now;
    this.scheduler = new Scheduler({ disk, now });
    this.sample = sample;
    this.telemetry = null;
    this.error = null;
    this.level = 'unknown';
    this.refreshing = null;
    this.closed = false;
    this.notices = new Map();
    this.delivering = null;
    this.sendTimeoutMs = sendTimeoutMs;
    this.sampleSessions = sampleSessions;
    this.measuring = null;
    this.lastMeasurement = -Infinity;
    this.sessionUsage = { sampledAt: null, sessions: {}, error: null, enabled: true };
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
    this.scheduler.cancelUnavailable((owner) => { const session = host.sessions.get(owner); return !session || session.archived; });
    const before = this.level;
    this.level = settings ? pressure(this.telemetry, settings, before) : 'unknown';
    // Configuration errors and missing telemetry block grants, but queued
    // deadlines still advance. Active grants are never reclaimed on a timer.
    this.advance(settings);
    if (before !== this.level && !(before === 'unknown' && this.level === 'normal') && settings?.notifyPressure) {
      for (const owner of new Set(this.scheduler.snapshot().filter((r) => ['queued', 'offered', 'granted'].includes(r.state)).map((r) => r.owner))) {
        this.notice(`pressure:${owner}`, owner, `Watermark: ${this.level} system pressure. ${this.level === 'hard' ? 'New admissions are paused. Reduce concurrency where practical; running work is not killed.' : this.level === 'soft' ? 'Avoid starting additional heavy work without a reservation.' : this.level === 'normal' ? 'System pressure has recovered.' : 'Telemetry unavailable; admissions are paused.'}`);
      }
    }
    if (!this.closed) await host.rebuild();
    // Mail is advisory. It must never stall sampling, admission or the tools.
    void this.drain(host);
    void this.measureSessions(host);
  }

  measureSessions(host) {
    if (this.closed) return this.measuring;
    if (host.settings.all().disableSessionMeasurements === true) {
      this.sessionUsage = { sampledAt: this.now(), sessions: {}, error: null, enabled: false };
      return this.measuring;
    }
    if (this.measuring) return this.measuring;
    if (this.now() - this.lastMeasurement < 5000 && this.now() >= this.lastMeasurement) return null;
    this.lastMeasurement = this.now();
    this.measuring = Promise.resolve().then(() => this.sampleSessions(host.sessions.list?.() ?? [])).then((usage) => {
      if (!this.closed && host.settings.all().disableSessionMeasurements !== true) this.sessionUsage = { ...usage, enabled: true };
    }).catch(() => {
      // Never expose a child-process error containing raw stdout/environment.
      if (!this.closed && host.settings.all().disableSessionMeasurements !== true) this.sessionUsage = { sampledAt: this.now(), sessions: {}, error: 'Session process measurements unavailable.', enabled: true };
    }).then(() => { if (!this.closed) return host.rebuild(); }).catch((error) => host.log?.(error)).finally(() => { this.measuring = null; });
    return this.measuring;
  }

  drain(host) {
    if (this.delivering || this.closed) return this.delivering;
    this.delivering = this.drainBatch(host).catch((error) => host.log?.(error)).finally(() => { this.delivering = null; });
    return this.delivering;
  }

  async drainBatch(host) {
    await Promise.all([...this.notices].slice(0, 8).map(async ([key, notice]) => {
      const drop = () => { if (this.notices.get(key) === notice) this.notices.delete(key); };
      const session = host.sessions.get(notice.owner);
      if (!session || session.archived || this.now() - notice.createdAt > 600000 || (notice.reservation && !this.scheduler.snapshot().some((r) => r.id === notice.reservation.id && r.state === notice.reservation.state))) { drop(); return; }
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => { if (!this.closed) return host.mail.send(notice.owner, notice.text); }),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Mail timeout'), { code: 'WATERMARK_MAIL_TIMEOUT' })), this.sendTimeoutMs); }),
        ]);
        drop();
      } catch (error) {
        notice.attempts++;
        // A timed-out append may still complete: do not risk sending it twice.
        if (error.code === 'WATERMARK_MAIL_TIMEOUT' || notice.attempts >= 3) drop();
      } finally { clearTimeout(timer); }
    }));
  }

  notice(key, owner, text, reservation) {
    if (!this.notices.has(key) && this.notices.size >= 256) this.notices.delete(this.notices.keys().next().value);
    this.notices.set(key, { owner, text, reservation, createdAt: this.now(), attempts: 0 });
  }

  request(owner, args, host) {
    const settings = config(host.settings.all());
    const row = this.scheduler.request(owner, args, this.telemetry, settings);
    this.advance(settings);
    return this.scheduler.get(owner, row.id);
  }

  advance(settings) {
    const changes = this.scheduler.pump(this.error ? null : this.telemetry, settings, { admit: this.level !== 'hard' });
    for (const row of changes) this.notice(`${row.id}:${row.state}`, row.owner, `Watermark reservation ${row.id} (${row.label}): ${row.state}. ${row.state === 'offered' ? 'Capacity is offered for five minutes. Call watermark_claim before starting; run only if the claim returns granted.' : row.reason || 'No resources were reserved.'}`, { id: row.id, state: row.state });
  }

  claim(owner, id, host) {
    return this.scheduler.claim(owner, id, this.error || this.level === 'hard' ? null : this.telemetry, config(host.settings.all()));
  }

  snapshot() {
    const requests = this.scheduler.snapshot();
    return { telemetry: this.telemetry, error: this.error, pressure: this.level, reserved: totals(requests), requests, sessionUsage: structuredClone(this.sessionUsage) };
  }

  status(owner, host) {
    const snapshot = this.snapshot();
    let available = null;
    try { if (this.telemetry && this.telemetry.cpuPercent !== null) available = headroom(this.telemetry, config(host.settings.all()), snapshot.reserved); }
    catch { /* The graph exposes configuration errors on the next sweep. */ }
    const sessionUsage = { ...snapshot.sessionUsage, sessions: Object.fromEntries(Object.entries(snapshot.sessionUsage.sessions).filter(([id]) => id === owner)) };
    return { ...snapshot, sessionUsage, requests: snapshot.requests.filter((r) => r.owner === owner), available, enabled: !this.closed, fresh: Boolean(this.telemetry && this.now() >= this.telemetry.sampledAt && this.now() - this.telemetry.sampledAt <= 15000), accounting: 'Measured host usage plus full declared reservations; intentionally conservative.' };
  }

  close() { this.closed = true; this.scheduler.close(); }
}
