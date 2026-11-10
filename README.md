# agent-wrangler-watermark

CPU and memory admission control for Agent Wrangler. When several agents want to
run expensive work, Watermark reserves their declared budgets and queues work
until the host has enough headroom.

The extension samples the Wrangler host every five seconds, shows utilisation and
per-session reservations on the board, and mails participating sessions when
pressure changes or queued work is granted. Commands run through the agent's
existing tools and permissions. Watermark never launches or kills commands.

## Install

Requires Node.js 22 or newer and Agent Wrangler host API **1.31.0 or newer in the
1.x series**. In **Settings → Extensions → + Add extension → Git URL**, enter:

```text
https://github.com/portswigger-tim/agent-wrangler-watermark.git
```

Review the capabilities and enable **Watermark**. New/resumed agents receive the
`resource-budget` skill and five MCP tools. Existing agents may need a resume to
receive the skill. Open the **Watermark** view in the board's navigation to see
host usage and the queue; session cards and panels show declared reservations.

The extension needs `sessions:read` to identify callers and their runtime,
`mail:send` for grant/pressure notices, and `board:rebuild` for dashboard updates.
Like other extensions, it executes trusted code in the Wrangler server process.

## Agent workflow

Before a heavy build, test suite, local model or Docker workload, estimate its
**peak** memory and CPU needs, including child processes and background work.
Use project requirements or observed usage; there is no automatic command-cost
predictor. Reduce worker counts when a workload will not fit.

1. Call `watermark_status` to see measured usage, headroom and your reservations.
2. Call `watermark_request`, for example:

   ```json
   {
     "key": "build-001",
     "label": "Production build with two workers",
     "memoryMiB": 2048,
     "cpuCores": 2,
     "queueTimeoutSeconds": 1800
   }
   ```

3. If the returned reservation is `queued`, call `watermark_wait` with its `id`
   and optionally `seconds` (default 20, maximum 25), or do lightweight work
   while waiting for mail. A wait timeout leaves the reservation queued.
4. When its state is `offered`, call `watermark_claim` with its `id` immediately
   before starting. Offers reserve capacity for five minutes; unclaimed offers
   expire automatically. The claim rechecks telemetry, pressure and capacity.
   Start only if the claim returns `granted`. Run with your normal execution tool
   and permission controls. If claiming is paused, do lightweight work and retry
   after the next five-second sample; an expired offer needs a new request key.
5. Call `watermark_release` with the `id` once the command **and all background
   work or containers have stopped**. The same tool cancels queued requests.

One core means one fully occupied logical CPU; fractional budgets are supported.
MiB means 1,048,576 bytes. Labels and keys appear on the board and in local state:
keep secrets and sensitive command arguments out of them.

Use a unique key for each workload. Retrying the same key with the same arguments
returns the existing request; different arguments are rejected. Status and wait
responses are authoritative; notification delivery is best effort. Only the
caller's requests appear in its status response. The board operator can see and
release all reservations after confirming the work stopped.

## Admission policy

- **Soft watermark: 75%** measured CPU or memory usage. Warn participating
  sessions; grants can continue while they fit below the hard watermark.
- **Hard watermark: 90%**. Pause new grants. Recovery uses five percentage points
  of hysteresis to avoid repeated warnings around the threshold.
- **Additional memory headroom: 512 MiB** beyond the hard watermark margin.
- Admit only when **both** CPU and memory fit, counting measured host usage plus
  all outstanding declared reservations plus the new budget. This intentionally
  counts running reserved work conservatively, sometimes twice.
- Strict FIFO: small jobs cannot overtake and starve a large earlier request.
  Cancel or reduce a large request if it is holding up the queue.
- Queue deadlines default to 30 minutes and can be set from 1 second to 24 hours.
  Unclaimed offers expire after five minutes. Impossible queued/offered budgets
  are rejected when telemetry or settings show they cannot fit. Missing, stale
  (over 15 seconds old), or warming CPU telemetry blocks new grants.
- Maximum 128 live requests globally, 8 per session, and 100 retained terminal
  requests. Idempotency is retained while the corresponding record is retained.

Watermarks, memory headroom and pressure mail are configurable in
**Settings → Extensions → Watermark**. Soft must remain below hard; an invalid
configuration pauses admissions and explains the error. Pressure mail defaults
to on and only targets sessions holding or waiting for resources. Grant and
expiry notices remain enabled. Watermark does not wake dormant sessions itself.

## Restarts and stranded reservations

Claimed budgets never expire automatically: an agent can disconnect while its
command keeps running. Reservations persist across restarts, disable/re-enable
and session archive/purge. Archive/purge cancels queued requests and unclaimed
offers, but keeps grants. Sweeps also reconcile requests belonging to sessions
that were archived or purged while the extension was disabled.
After a disconnect, inspect existing work before starting another copy.

If an agent cannot release its grant, stop the workload and use **Release** in the
Watermark view. Releasing a reservation does not stop a command. Only confirm once
all work stopped. Disabling Watermark removes its tools and monitoring; it does
not stop any workload or erase outstanding reservations.

State is atomically written with private file permissions to
`$AW_DATA_DIR/watermark/reservations.json`, or
`~/.agent-wrangler/watermark/reservations.json` when `AW_DATA_DIR` is unset. A
corrupt state file prevents activation rather than discarding granted budgets.
Uninstall leaves this file in place. Remove it only after every reserved workload
has stopped and no Wrangler instance is using it.

Only one Wrangler instance may manage a given data directory and host budget.
The extension relies on Wrangler's instance lock and does not coordinate across
separate instances. A process killed during a write may leave an ignored `.tmp`
file; the last successfully replaced state file remains authoritative.

## Measurement and scope

CPU comes from deltas of the OS CPU counters, with one initial warm-up sample.
Linux memory uses `/proc/meminfo`'s `MemAvailable`. macOS uses `vm_stat` free,
inactive and speculative pages, an estimate of reclaimable memory; purgeable
pages are not added separately. Other systems use free memory conservatively.
Read failures pause admission. No shell or user-supplied executable is used for
sampling.

Run Wrangler natively on the machine doing the work. This release budgets the
**host**, and does not model container cgroup quotas or remote resources.
Requests from remote/devcontainer session runtimes are refused. A native session
can budget local Docker work, but must include its expected CPU/memory and retain
the grant until containers stop. Docker Desktop VM usage contributes to host
pressure; there is no per-container or per-process attribution. Session figures
are **declared reservations**, not measured process usage.

This is cooperative scheduling, not an OS resource limit or an OOM guarantee.
Agents must use the tools and estimate responsibly. Commands run without a
reservation, unrelated applications, an underestimated peak and a remote Docker
daemon can defeat the budget. A grant is not permission to bypass an execution
restriction. Existing Wrangler caller identities are advisory, not a new
authentication boundary.

The sampler uses the [Node.js OS API](https://nodejs.org/api/os.html) and Linux
[`MemAvailable`](https://docs.kernel.org/filesystems/proc.html). Thresholds apply
to the telemetry estimate rather than the operating system's OOM policy.

## Development

```sh
npm ci --ignore-scripts
npm run lint
npm test
pre-commit install -t pre-commit -t pre-merge-commit -t pre-push -t commit-msg
pre-commit run --all-files
```

Use a feature branch. Hooks cover whitespace and file hygiene, staged and
committed-history secret scans, workflow/security linting, JavaScript syntax,
ESLint and tests. CI runs the same gate, audits runtime dependencies, and checks
conventional PR titles for squash releases. Hook revisions and actions are pinned
to commit SHAs. Tests use isolated temporary state and synthetic telemetry; they
do not start workloads or modify a running Wrangler instance.

The repository stays public. Private vulnerability reporting is described in
[SECURITY.md](SECURITY.md); review decisions live in
[SECURITY-NOTES.md](SECURITY-NOTES.md). Releases use conventional commits and
release-please. Installation is from Git; there is no npm registry publication.

MIT licensed; see [LICENSE](LICENSE).
