export const liveRequests = (data, owner) => (data?.requests || []).filter((r) => ['queued', 'granted'].includes(r.state) && (!owner || r.owner === owner));
export const budget = (rows) => rows.filter((r) => r.state === 'granted').reduce((sum, r) => ({ memory: sum.memory + r.memoryMiB, cpu: sum.cpu + r.cpuCores }), { memory: 0, cpu: 0 });
export const formatMemory = (mib) => mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;

function element(doc, tag, text, className) {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function render(el, data, { owner = null, api, confirm = (message) => globalThis.confirm(message), now = Date.now() } = {}) {
  const doc = el.ownerDocument;
  const root = element(doc, 'section', undefined, 'watermark');
  root.append(element(doc, owner ? 'h3' : 'h1', owner ? 'Resource reservations' : 'Watermark'));
  const telemetry = data?.telemetry;
  const fresh = telemetry && now >= telemetry.sampledAt && now - telemetry.sampledAt <= 15000;
  const status = element(doc, 'p', data?.error ? `Admissions paused: ${data.error}` : !fresh ? 'Waiting for fresh system telemetry. New admissions are paused.' : telemetry.cpuPercent === null ? 'Measuring CPU usage. New admissions are paused during warm-up.' : `System pressure: ${data.pressure}. Measured on the Wrangler host.`, 'watermark-status');
  status.setAttribute('role', 'status');
  root.append(status);
  if (telemetry) {
    const metrics = element(doc, 'div', undefined, 'watermark-metrics');
    const values = [
      ['CPU', telemetry.cpuPercent, `${telemetry.cpuCores} cores`],
      ['Memory', 100 * (1 - telemetry.availableMemoryMiB / telemetry.totalMemoryMiB), `${formatMemory(telemetry.availableMemoryMiB)} available of ${formatMemory(telemetry.totalMemoryMiB)}`],
    ];
    for (const [label, percent, detail] of values) {
      const metric = element(doc, 'div');
      metric.append(element(doc, 'strong', `${label}: ${percent === null ? 'warming up' : `${percent.toFixed(0)}%`}`));
      if (percent !== null) {
        const meter = element(doc, 'meter');
        meter.min = 0; meter.max = 100; meter.value = percent;
        meter.setAttribute('aria-label', `${label} utilisation`);
        metric.append(meter);
      }
      metric.append(element(doc, 'p', detail));
      metrics.append(metric);
    }
    root.append(metrics, element(doc, 'p', `Memory source: ${telemetry.memorySource}. Updated ${Math.max(0, Math.floor((now - telemetry.sampledAt) / 1000))}s ago.`, 'watermark-muted'));
  }
  const rows = liveRequests(data, owner);
  const reserved = budget(rows);
  root.append(element(doc, 'p', `${owner ? 'Session' : 'All sessions'} reserved: ${formatMemory(reserved.memory)}, ${reserved.cpu.toFixed(2)} CPU cores. ${rows.filter((r) => r.state === 'queued').length} queued.`));
  root.append(element(doc, 'p', 'Budgets are declared estimates, not measured session usage. New grants count both measured usage and full reservations, so the queue is intentionally conservative.', 'watermark-muted'));
  if (!rows.length) root.append(element(doc, 'p', 'No active reservations. Agents can request a budget with watermark_request.'));
  else {
    const table = element(doc, 'table');
    const caption = element(doc, 'caption', 'Active resource requests');
    const head = element(doc, 'thead');
    const headings = element(doc, 'tr');
    for (const title of ['Workload', 'Session', 'State', 'Memory', 'CPU cores', 'Action']) {
      const th = element(doc, 'th', title); th.scope = 'col'; headings.append(th);
    }
    head.append(headings);
    const body = element(doc, 'tbody');
    for (const row of rows) {
      const tr = element(doc, 'tr');
      for (const text of [row.label, row.owner, row.state, formatMemory(row.memoryMiB), row.cpuCores.toFixed(2)]) tr.append(element(doc, 'td', text));
      const action = element(doc, 'td');
      const button = element(doc, 'button', row.state === 'queued' ? 'Cancel' : 'Release');
      button.type = 'button';
      button.addEventListener('click', () => {
        if (row.state === 'granted' && !confirm('Release this budget only if the command AND all background work or containers have stopped. Has all work stopped?')) return;
        api.send({ type: 'watermark-release', id: row.id });
      });
      action.append(button); tr.append(action); body.append(tr);
    }
    table.append(caption, head, body);
    const scroll = element(doc, 'div', undefined, 'watermark-table');
    scroll.append(table); root.append(scroll);
  }
  root.append(element(doc, 'p', 'Queued work expires at its wait deadline. Granted budgets stay reserved across restarts and session archives until released after work stops. Remote runtimes and per-container attribution are unsupported.', 'watermark-muted'));
  // Do not replace a focused release control on each graph tick.
  if (el.contains(doc.activeElement)) return;
  el.replaceChildren(root);
}

export default {
  register(reg) {
    reg.register('view', {
      id: 'resources', label: 'Watermark',
      mount(el) { el.classList.add('watermark-view'); },
      update(el, session, graph) { render(el, graph?.watermark, { api: reg.api }); },
      badge: (graph) => liveRequests(graph?.watermark).filter((r) => r.state === 'queued').length,
    });
    reg.register('panel.section', {
      id: 'resources',
      mount() {},
      update(el, session, graph) {
        if (!session?.sessionId) return;
        render(el, graph?.watermark, { api: reg.api, owner: session.sessionId });
      },
    });
    reg.register('card.pill', {
      id: 'resources', label: 'Resource reservations',
      mount() {},
      update(el, session, graph) {
        const rows = liveRequests(graph?.watermark, session?.sessionId);
        el.hidden = !rows.length;
        const sum = budget(rows);
        el.textContent = `${formatMemory(sum.memory)} / ${sum.cpu.toFixed(1)} CPU · ${rows.filter((r) => r.state === 'queued').length} queued`;
        el.title = 'Declared reserved budgets; not measured process usage';
      },
    });
  },
};
