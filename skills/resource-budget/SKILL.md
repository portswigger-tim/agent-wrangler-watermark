---
name: resource-budget
description: Use before heavy local work to request CPU and memory budgets, wait for capacity, and release resources after the workload stops.
---

# Resource budgets

Watermark monitors the Wrangler host and coordinates cooperating sessions. It does
not execute commands, grant permissions or enforce OS limits. Session cards show
measured local process CPU and resident memory separately from declared budgets.
Keep using your existing execution tools and permission controls.

Before a memory-hungry build, test suite, local model, or Docker workload:

1. Call `watermark_status`. It reports measured host usage, conservative admission
   headroom and your existing reservations. Budgets apply only to work on this
   host; remote and devcontainer runtimes cannot request them.
2. Estimate **peak** memory in MiB and CPU cores, including child processes and
   containers. One CPU core is one fully occupied logical core; fractional
   budgets are allowed. Use known project requirements or previous observations;
   if uncertain, use a larger budget or reduce workers. There is no automatic
   command-cost predictor. Use a descriptive label, without secrets or command
   arguments that could contain credentials.
3. Call `watermark_request` with `key`, `label`, `memoryMiB`, `cpuCores`, and
   optionally `queueTimeoutSeconds` (default 1800, maximum 86400). Use a unique
   key per workload. Retry that same key after an uncertain response to avoid
   duplicate reservations. Reusing it with different arguments is an error.
4. If queued, call `watermark_wait` with its `id` (up to 25 seconds per call), or
   work on something lightweight while offer mail arrives. A wait timeout leaves
   it queued; expired/cancelled/released/rejected requests require a new key.
   Mail is a hint; status
   and wait responses are authoritative.
5. An `offered` budget holds capacity for five minutes. Immediately before
   starting, call `watermark_claim` with its `id`. Start only if the claim returns
   **granted**. The claim checks fresh telemetry, pressure and remaining headroom.
   If paused, do lightweight work and retry after the next five-second sample.
   If the offer expires, request a new budget with a new key. Never start from
   an offer or a notification alone.
6. Run through your normal command tools. Keep the reservation throughout the
   whole workload. In cleanup/finally, call `watermark_release` only once the
   command **and all background descendants/containers have stopped**. Cancelling
   a queued reservation uses the same tool. Never release merely because a
   command tool returned a background session id or detached a container.

Reservations intentionally count in full on top of observed usage, so a running
job may effectively be counted twice. Strict FIFO prevents small jobs starving a
large one; a large request can hold up smaller requests until it fits, expires or
is cancelled. A budget larger than total admissible capacity is rejected when
telemetry is available.

Unclaimed offers expire after five minutes, so abandoned work cannot hold capacity
forever. Claimed grants never expire automatically: a disconnected agent may still have
running work. Grants persist across restarts and session archives. Before
restarting work after a disconnect, inspect status and recover or stop existing
work; do not launch it a second time. The operator can free a stranded reservation
from the Watermark view after confirming all work stopped. Queued requests and
offers are cancelled on archive/purge, while claimed grants remain visible.

Pressure mail is sent only to participating sessions. At soft pressure reduce
parallelism where practical. At hard pressure do not start more heavy work.
Watermark never kills processes. A reservation is cooperative admission, not a
guarantee against OOM: underestimated budgets, other applications, remote Docker
daemons and work launched without reservations remain outside its control.
