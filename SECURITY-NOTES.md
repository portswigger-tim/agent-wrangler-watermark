# Security notes

## Accepted risks

None recorded.

## Findings and resolutions

- 2026-11-10: Reviewed the initial CI and release workflows. PR jobs use a read-only token, SHA-pinned actions, no persisted checkout credentials, and no execution of pull-request metadata as shell input. Release writes are confined to the release job on main. No unresolved findings in that workflow review.
- 2026-11-10: Independent bootstrap review found that the staged gitleaks hook scans no committed content on a clean CI checkout. Added a second full-history scan and full checkout history; retained the staged scan for local work. Also added PR title validation, narrowed lockfile exclusions, and kept main CI runs from cancelling each other.
- 2026-11-10: Reviewed the resource tools, persistence, sampling and browser mutations. No arbitrary command execution is exposed. Every agent mutation validates an existing caller and limits access to its own reservations; remote runtimes cannot request host budgets. Labels render as text. Read failures and corrupt state block new grants. Grants persist until explicit release. Initial schema dependency had a high-severity advisory; replaced with patched Zod 4.6.7 and verified host SDK compatibility. No unresolved high-severity findings.

## Living threat model

This is a public extension repository. Untrusted contributions must pass the same local and CI verification gate before merging. Dependency updates and action updates require review. Repository protection settings prevent direct default-branch writes and mutable version tags.

The extension runs trusted code on the Wrangler host. Existing local MCP caller identities are advisory; they are not authentication. The trusted board operator can release stranded reservations. Resource estimates, cooperative agent behaviour and unrelated host processes limit the admission guarantee. No remote endpoint, executable command tool, telemetry export, or new credential is added. State remains in the local Wrangler data directory with private permissions. Only the native host is budgeted; container quotas and remote resources are unsupported.

Dependency tooling note: ESLint 9.39.5 is pinned while the current ESLint 10 dependency tree reports a moderate minimatch advisory. The selected development tree and the sole runtime dependency currently audit clean; Dependabot monitors updates. Revisit the supported lint version once its dependency tree is patched.
