import { fileURLToPath } from 'node:url';
import { ResourceService } from './server/service.js';
import { persistence, stateFile } from './server/persistence.js';
import { SETTINGS } from './server/config.js';
import { tools } from './server/tools.js';

export const declaration = {
  id: 'watermark', label: 'Watermark',
  description: 'Measured session CPU and memory with a cooperative resource reservation queue.',
  author: 'Tim Birkett',
  requires: ['sessions:read', 'mail:send', 'board:rebuild'],
  engines: { wranglerApi: '^1.57.0' },
};

export default {
  ...declaration,
  dir: fileURLToPath(new URL('.', import.meta.url)),
  defaultEnabled: true,
  help: 'Show measured local process CPU and resident memory on session cards. The Watermark app shows host usage, queued budgets, offers and active grants. Process identity comes from session tags and descendants; raw arguments and environments are never stored or displayed. Claimed grants require release after work stops. Docker usage is not attributed.',
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
  for (const row of scheduler.snapshot().filter((r) => r.owner === owner && ['queued', 'offered'].includes(r.state))) scheduler.release(owner, row.id);
}
