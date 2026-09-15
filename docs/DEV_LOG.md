# Development and release log

## 2026-09-14 — 1.0.0 ordinary Codex child continuation prepared

- Retain ordinary parent ownership across native completion while its current
  children finish. Use a receive-order child lifecycle tracker and one guarded
  empty-input native continuation to collect pending results. Keep existing
  run authority and original answer positions; add no fake prompt or polling.
- Fence Stop, steering, delayed native turn acknowledgements and unsubscribe
  cleanup by their exact owner and native turn. Uncertain continuation delivery
  is not permission to replay the original user request.
- Native Codex `0.154.0-alpha.6.2` v1 and v2 subagent probes confirmed the
  empty-input primitive consumes the exact child result without a new native
  user-message item. Probes used an isolated OS-sandboxed native binary and a
  local synthetic Responses provider, not AgentsServer or real model calls.
- Six immediate child-completion repetitions using the modified transport
  passed (three per native subagent mode). The native continuation DTO does not
  expose a client user-message identity: uncertain acceptance is proved only
  by the retained native stream, never by guessing the latest history turn.
- Preserve sidebar recency, unread state and active ownership when importing
  typed native child notifications. Both import paths keep those records silent;
  identical user-authored quotations remain visible.
- The final guarded transport, ordinary/native-goal lifecycle and history
  regression group passed 254 tests, including 30 new ordinary continuation
  scenarios. The guard rejects any import of the server monolith.
- Correct the Cursor idle-warning test to arm its short test deadline after
  actual provider readiness, rather than counting process startup as a second
  idle period. Runtime deadlines and behavior are unchanged by that fixture fix.
- Keep the explicitly approved 1.0.0 replacement version. Clean release CI and
  signed-download acceptance remain pending. No live server, app or user task
  was installed, opened, restarted or changed by these checks.

## 2026-09-14 — 1.0.0 cross-chat history correction prepared

- Repair legacy asynchronous delivery wrappers that provider history could
  re-import as user messages when the native ledger stored only their clean
  bodies. Require the exact completed native owner, delivery receipts, body
  digest and checkpointed provider item; retain genuine user quotations.
- Apply the same proof before a new import is committed or broadcast, and
  project already-imported duplicates silently on partial history pages.
  Preserve original agent messages, replies, identities and source timestamps;
  do not rewrite provider transcripts or grant messaging authority.
- Guarded, isolated parser/proof/import-boundary checks passed (51 tests),
  including cancellation, changed source, split import ranges, steering,
  conflicting receipts and large histories. No server process was imported or
  started locally. Desktop regression checks and isolated component rendering
  preserve original purple messages, real user quotations and inactive state.
- Read-only validation against the reported stored records passed for both
  historical projection and first-import filtering; original delivery and
  answer events and provider transcript bytes remain unchanged.
- Keep control-only Codex imports from moving sidebar recency forward to the
  import time or backward to an old source timestamp. Eight focused boundary
  checks passed, including unchanged unread state and native run ownership.
- Version remains 1.0.0 by explicit approval. Release publication and signed
  asset acceptance are still pending; no live deployment or restart performed.

## 2026-09-14 — 1.0.0 stable accepted

- With explicit approval, replaced the published release record in place at
  22:44 UTC (release ID `388756248`) using the exact original three signed
  assets. Original metadata and downloads were preserved for recovery.
  Fresh draft and public downloads passed signature, digest and source-file
  verification. The source tag, runtime, release notes and version remain
  unchanged; no rebuild or live deployment was performed. The paired desktop
  replacement corrects untitled subagent headings without a server change.
- Published source: `c12efa92c8e91358bbbbba041f29b7a00a1d434e`.
- Promotes the validated beta.8 runtime without additional API, dependency,
  signing-key or storage-schema changes. The release notes compare the full
  upgrade from the previous stable 0.1.25 and distinguish the latest beta.
- [Release workflow](https://github.com/ZhengyiLuo/AgentsServer/actions/runs/34901118266)
  passed: 4,026 tests, two skipped; package and manifest signing succeeded.
- Independent download verification passed: Ed25519 signature, stable channel,
  API contract 28, all three asset digests and all 78 packaged source files.
  Archive SHA-256:
  `0e9dfa4711c1d5ae6d46f83e3d8078c93980d2d9e0fdc997af24c5b640a345c8`.
- [Stable release](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.0)
  is the latest stable server release. Publication did not install or restart
  a live server or change active work. Team Network remains a beta feature.

## 2026-09-14 — 1.0.0-beta.8 accepted

- Published source: `0abf6c7777aff11cecc758c31ae100a88c125781`.
- Plain follow-ups with automatic saved-route metadata now steer scheduled and
  resumed native goals under their unchanged owner and permissions. Explicit
  grants, provider commands, settings changes and Stop/Pause fences remain
  protected. Old/new source differential checks reproduce the former rejection
  and verify exactly-once delivery without goal interruption.
- Add native-admin subagent concurrency settings, preserving other settings
  and active work. Defaults remain owned by Codex; no unlimited sentinel or
  hidden AgentsServer subagent cap is introduced.
- [Release workflow](https://github.com/ZhengyiLuo/AgentsServer/actions/runs/34894048014)
  passed its full gate: 4,026 tests, two skipped.
- Download verification passed: Ed25519 manifest signature, all three GitHub
  asset digests and all 78 packaged source files match the release commit.
  Archive SHA-256:
  `18ce190d7c274c8d6072692cc677feaaf2bf62bc607613800bcfeadd410064b7`.
- [Public beta](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.0-beta.8)
  is available on the Beta track. The Stable channel remains unchanged.
  Publication did not install or restart a live server.

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
