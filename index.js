import { fileURLToPath } from 'node:url';
import { ResourceService } from './server/service.js';
import { persistence, stateFile } from './server/persistence.js';
import { SETTINGS } from './server/config.js';
import { tools } from './server/tools.js';

export const declaration = {
  id: 'watermark', label: 'Watermark',
  description: 'CPU and memory monitoring with a cooperative resource reservation queue.',
  author: 'Tim Birkett',
  requires: ['sessions:read', 'mail:send', 'board:rebuild'],
  engines: { wranglerApi: '^1.31.0' },
};

export default {
  ...declaration,
  dir: fileURLToPath(new URL('.', import.meta.url)),
  defaultEnabled: true,
  help: 'Reserve declared CPU and memory before heavy local commands. Watermark queues requests until headroom is available and shows system usage and session reservations. Commands retain their existing permission controls. Reservations survive restart and require explicit release after work stops. Docker and process usage are not attributed to individual sessions.',
  stores: { resources: () => new ResourceService({ disk: persistence(stateFile()) }) },
  settings: SETTINGS,
  tools,
  graph: ({ host }) => ({ watermark: host.stores.resources.snapshot() }),
  sweeps: [{ id: 'sample', everyMs: 5000, run: ({ host }) => host.stores.resources.refresh(host) }],
  deactivate: ({ host }) => host.stores.resources.close(),
  session: {
    onArchive: ({ host, sessionId }) => cancelQueued(host, sessionId),
    onPurge: ({ host, sessionId }) => cancelQueued(host, sessionId),
  },
  handlers: [{
    type: 'watermark-release',
    async handler(message, host) {
      // The browser belongs to the same trusted local operator as core's
      // controls. It may free a stranded reservation after confirming work stopped.
      const service = host.stores.resources;
      const row = service.scheduler.snapshot().find((r) => r.id === message.id);
      if (!row) throw new Error('Reservation not found.');
      service.scheduler.release(row.owner, row.id);
      await service.refresh(host);
    },
  }],
  skills: ['resource-budget'],
  client: 'public/index.js',
  styles: 'public/styles.css',
};

function cancelQueued(host, owner) {
  const scheduler = host.stores.resources.scheduler;
  for (const row of scheduler.snapshot().filter((r) => r.owner === owner && r.state === 'queued')) scheduler.release(owner, row.id);
}
