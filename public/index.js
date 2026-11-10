export const liveRequests = (data, owner) => (data?.requests || []).filter((r) => ['queued', 'offered', 'granted'].includes(r.state) && (!owner || r.owner === owner));
export const budget = (rows) => rows.filter((r) => ['offered', 'granted'].includes(r.state)).reduce((sum, r) => ({ memory: sum.memory + r.memoryMiB, cpu: sum.cpu + r.cpuCores }), { memory: 0, cpu: 0 });
export const formatMemory = (mib) => mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;
const fresh = (at, now) => Number.isFinite(at) && now >= at && now - at <= 15000;
const duration = (seconds) => seconds >= 60 ? `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s` : `${Math.max(0, Math.floor(seconds))}s`;
const sessionName = (sessions, id) => { const s = sessions.find((s) => s.sessionId === id); return s?.label || s?.name || s?.lastLabel || id; };

function element(doc, tag, text, className) {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function requestTable(doc, rows, { state, api, sessions, now, confirm }) {
  const table = element(doc, 'table');
  const head = element(doc, 'thead');
  const headings = element(doc, 'tr');
  for (const title of ['Workload', 'Session', 'Budget', state === 'queued' ? 'Queue / wait' : state === 'offered' ? 'Claim within' : 'Running for', '']) {
    const th = element(doc, 'th', title); th.scope = 'col'; headings.append(th);
  }
  head.append(headings);
  const body = element(doc, 'tbody');
  rows.forEach((row, index) => {
    const tr = element(doc, 'tr');
    tr.append(element(doc, 'td', row.label));
    const owner = element(doc, 'td');
    const open = element(doc, 'button', sessionName(sessions, row.owner), 'watermark-session');
    open.type = 'button'; open.title = row.owner;
    open.addEventListener('click', () => api.openSession?.(row.owner));
    owner.append(open); tr.append(owner);
    tr.append(element(doc, 'td', `${formatMemory(row.memoryMiB)} · ${row.cpuCores} CPU`));
    const timing = state === 'queued' ? `#${index + 1} · ${duration((now - row.createdAt) / 1000)}` : state === 'offered' ? duration((row.claimDeadline - now) / 1000) : duration((now - (row.grantedAt ?? row.createdAt)) / 1000);
    tr.append(element(doc, 'td', timing));
    const action = element(doc, 'td');
    const button = element(doc, 'button', state === 'granted' ? 'Release' : 'Cancel');
    button.dataset.watermarkRequest = row.id;
    button.type = 'button';
    button.addEventListener('click', () => {
      if (state === 'granted' && !confirm('Release this budget only if the command AND all background work or containers have stopped. Has all work stopped?')) return;
      api.send({ type: 'watermark-release', id: row.id });
    });
    action.append(button); tr.append(action); body.append(tr);
  });
  table.append(head, body);
  const scroll = element(doc, 'div', undefined, 'watermark-table');
  scroll.append(table);
  return scroll;
}

export function render(el, data, { api, sessions = [], confirm = (message) => globalThis.confirm(message), now = Date.now() } = {}) {
  const doc = el.ownerDocument;
  const focused = el.contains(doc.activeElement) ? doc.activeElement : null;
  const focusedRequest = focused?.dataset?.watermarkRequest;
  const focusedStatus = focused?.classList?.contains('watermark-status');
  const root = element(doc, 'section', undefined, 'watermark');
  root.append(element(doc, 'h1', 'Watermark'));
  const telemetry = data?.telemetry;
  const status = element(doc, 'p', data?.error ? `Admissions paused: ${data.error}` : !fresh(telemetry?.sampledAt, now) ? 'Waiting for fresh host telemetry. Admissions paused.' : telemetry.cpuPercent === null ? 'Measuring host CPU. Admissions paused during warm-up.' : `Host pressure: ${data.pressure}`, 'watermark-status');
  status.setAttribute('role', 'status'); root.append(status);
  if (telemetry) {
    const metrics = element(doc, 'div', undefined, 'watermark-metrics');
    for (const [label, percent, detail] of [
      ['CPU', telemetry.cpuPercent, `${telemetry.cpuCores} host cores`],
      ['Memory', 100 * (1 - telemetry.availableMemoryMiB / telemetry.totalMemoryMiB), `${formatMemory(telemetry.availableMemoryMiB)} available of ${formatMemory(telemetry.totalMemoryMiB)}`],
    ]) {
      const metric = element(doc, 'div');
      metric.append(element(doc, 'strong', `${label}: ${percent === null ? 'warming up' : `${percent.toFixed(0)}%`}`));
      if (percent !== null) {
        const meter = element(doc, 'meter'); meter.min = 0; meter.max = 100; meter.value = percent;
        meter.setAttribute('aria-label', `Host ${label} utilisation`); metric.append(meter);
      }
      metric.append(element(doc, 'p', detail)); metrics.append(metric);
    }
    root.append(metrics);
  }
  const rows = liveRequests(data);
  const summary = element(doc, 'div', undefined, 'watermark-counts');
  for (const [state, label] of [['queued', 'Queued'], ['offered', 'Awaiting claim'], ['granted', 'Active grants']]) {
    const group = rows.filter((row) => row.state === state);
    const count = element(doc, 'a', undefined, `watermark-count watermark-${state}`);
    count.href = `#watermark-${state}`;
    count.append(element(doc, 'strong', String(group.length)), element(doc, 'span', label));
    // Keep navigation inside this view; the board owns the URL hash.
    count.addEventListener('click', (event) => { event.preventDefault(); root.querySelector(`#watermark-${state}`)?.scrollIntoView?.({ block: 'nearest' }); });
    summary.append(count);
  }
  root.append(summary);
  for (const [state, label, empty] of [
    ['queued', 'Queue', 'No workloads waiting.'],
    ['offered', 'Offers awaiting claim', 'No offers awaiting claim.'],
    ['granted', 'Active grants', 'No active grants.'],
  ]) {
    const group = rows.filter((row) => row.state === state);
    const section = element(doc, 'section', undefined, `watermark-group watermark-${state}`);
    section.id = `watermark-${state}`;
    section.append(element(doc, 'h2', `${label} (${group.length})`));
    if (group.length) section.append(requestTable(doc, group, { state, api, sessions, now, confirm }));
    else section.append(element(doc, 'p', empty, 'watermark-muted'));
    root.append(section);
  }
  root.append(element(doc, 'p', 'Budgets are declared estimates, not measured session usage. Offers expire after five minutes. Release grants only after all work stops.', 'watermark-muted'));
  el.replaceChildren(root);
  if (focusedRequest || focusedStatus) {
    const replacement = [...el.querySelectorAll('[data-watermark-request]')].find((button) => button.dataset.watermarkRequest === focusedRequest);
    if (replacement) replacement.focus();
    else { status.tabIndex = -1; status.focus(); }
  }
}

export function renderCard(el, session, data, { now = Date.now(), navigate = () => { globalThis.location.hash = '#view=ext:watermark:resources'; } } = {}) {
  let button = el.querySelector('button');
  if (!button) {
    button = element(el.ownerDocument, 'button', undefined, 'card-tag watermark-card'); button.type = 'button';
    button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); navigate(); });
    el.append(button);
  }
  const usage = data?.sessionUsage;
  const measured = usage?.sessions?.[session?.sessionId];
  const valid = measured?.status === 'ok' && fresh(usage?.sampledAt, now);
  const cpu = valid && measured.cpuPercent !== null ? `${measured.cpuPercent.toFixed(0)}%` : '—';
  const memory = valid && measured.memoryMiB !== null ? formatMemory(measured.memoryMiB) : '—';
  const rows = session?.sessionId ? liveRequests(data, session.sessionId) : [];
  const counts = ['queued', 'offered', 'granted'].map((state) => ({ state, count: rows.filter((row) => row.state === state).length })).filter((entry) => entry.count);
  const suffix = counts.map(({ state, count }) => `${count} ${state === 'granted' ? 'grant' : state === 'offered' ? 'offer' : 'queued'}${count > 1 && state !== 'queued' ? 's' : ''}`).join(' · ');
  button.textContent = `CPU ${cpu} · RAM ${memory}${suffix ? ` · ${suffix}` : ''}`;
  const sum = budget(rows);
  const unavailable = usage?.enabled === false ? 'Process measurement disabled.' : usage?.error || (measured?.status === 'unsupported' ? 'Remote/container process measurement unsupported.' : !valid ? 'No fresh, attributable local processes.' : measured.cpuPercent === null ? 'CPU is warming up.' : '');
  button.title = `Measured local process CPU (100% = one core) and summed resident memory. ${valid ? `${measured.processCount} processes. ` : ''}${unavailable}\nDeclared budget held: ${formatMemory(sum.memory)} · ${sum.cpu} CPU.\nOpen Watermark for queue, offers and grants.`;
  button.setAttribute('aria-label', `${button.textContent}. ${unavailable} Open Watermark queue and grants.`);
}

export default {
  register(reg) {
    reg.register('view', {
      id: 'resources', label: 'Watermark',
      mount(el) { el.classList.add('watermark-view'); },
      update(el, session, graph) { render(el, graph?.watermark, { api: reg.api, sessions: graph?.sessions || [] }); },
      badge: (graph) => liveRequests(graph?.watermark).filter((r) => r.state === 'queued').length,
    });
    reg.register('card.pill', {
      id: 'resources', label: 'CPU, memory and resource reservations',
      mount() {},
      update(el, session, graph) { renderCard(el, session, graph?.watermark); },
    });
  },
};
