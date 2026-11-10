import { z } from 'zod';
import { requestSchema } from './scheduler.js';

const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value });
const idSchema = z.object({ id: z.string().uuid() });

function tool(name, description, schema, action) {
  return {
    name, description, inputSchema: schema.shape,
    async handler({ host, caller }, args = {}) {
      try {
        if (!caller || !host.sessions.get(caller) || host.sessions.get(caller).archived) throw new Error('A live Agent Wrangler session identity is required.');
        const parsed = schema.parse(args);
        const service = host.stores.resources;
        return result(await action(service, caller, parsed, host));
      } catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
    },
  };
}

export const tools = [
  tool('watermark_status', 'Read measured host CPU/memory, conservative admission headroom and your own reservations. Session budgets are declarations, not process measurements. See the resource-budget skill.', z.object({}), async (service, caller, args, host) => {
    await service.refresh(host);
    return service.status(caller, host);
  }),
  tool('watermark_request', 'Request declared peak memoryMiB and cpuCores before a heavy local command. Returns queued or offered with an id. An offer holds capacity for five minutes; claim it with watermark_claim before starting. Use one unique key per workload; retry it after uncertain responses. Release only after ALL work stops. This does not launch commands or enforce OS limits.', requestSchema, async (service, caller, args, host) => {
    if (host.sessions.get(caller).runtime !== 'local') throw new Error('Only work on the Wrangler host can be budgeted. Remote and devcontainer runtimes are unsupported.');
    await service.refresh(host);
    const row = service.request(caller, args, host);
    await host.rebuild();
    return { reservation: row };
  }),
  tool('watermark_wait', 'Wait up to 25 seconds for your queued reservation to change. A timeout leaves it queued. Repeat only while waiting for this workload; use the same id. An offered budget must be claimed with watermark_claim within five minutes. Never start until the claim returns granted.', idSchema.extend({ seconds: z.number().min(0).max(25).default(20) }), async (service, caller, args) => ({ reservation: await service.scheduler.wait(caller, args.id, args.seconds), enabled: !service.closed })),
  tool('watermark_claim', 'Claim your offered budget immediately before starting the workload. Offers expire after five minutes; claimed grants remain reserved until explicit release. Rechecks fresh telemetry, pressure and headroom. Run only if the response says granted. Safe to retry after an uncertain response; do not start a second copy of work.', idSchema, async (service, caller, args, host) => {
    await service.refresh(host);
    const row = service.claim(caller, args.id, host);
    await host.rebuild();
    return { reservation: row };
  }),
  tool('watermark_release', 'Release your granted budget only after its command and all background work/containers have stopped, or cancel your queued request. Safe to retry. Never releases another session\'s reservation.', idSchema, async (service, caller, args, host) => {
    const row = service.scheduler.release(caller, args.id);
    await service.refresh(host);
    return { reservation: row };
  }),
];
