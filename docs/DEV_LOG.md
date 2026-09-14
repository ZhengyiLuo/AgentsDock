# Development and release log

## 2026-09-14 — 1.0.0-beta.7 accepted

- Published source: `a78fd465caed255a356708230f1a8f045d5fce4b`.
- Fix: durable native identity recovery for known completed Codex subagents,
  including repeat/restart deduplication and concurrent lifecycle protection.
- Focused guarded checks passed, with independent old-source failure/new-source
  success and compatibility verification against the existing desktop parser.
- [Release workflow](https://github.com/ZhengyiLuo/AgentsServer/actions/runs/34888789011)
  passed its full gate: 4,008 tests, two skipped.
- Download verification passed: Ed25519 manifest signature, archive digest,
  GitHub asset digests and all 78 packaged source files match the release commit.
- Archive SHA-256:
  `2704bf8783f25e3b0898cbd37f8090b85dea4d0bf0c59c181c5ac31e6d66db98`.
- [Public beta](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.0-beta.7)
  is available on the Beta track; the Stable channel was not changed.
- Publication did not deploy or restart a live server. This release does not
  change goal-steering admission or account/model access behavior.
