# Security notes

## Accepted risks

None recorded.

## Findings and resolutions

- 2026-11-10: Reviewed the initial CI and release workflows. PR jobs use a read-only token, SHA-pinned actions, no persisted checkout credentials, and no execution of pull-request metadata as shell input. Release writes are confined to the release job on main. No unresolved findings.

## Living threat model

This is a public extension repository. Untrusted contributions must pass the same local and CI verification gate before merging. Dependency updates and action updates require review. Repository protection settings prevent direct default-branch writes and mutable version tags.
