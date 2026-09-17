# Development and release log

## 2026-09-17 — Codex Side chat startup correction (unreleased)

- Retain Codex's configured runtime state instead of creating a fresh SQLite
  database against its existing history root on every side question. Preserve
  provider-owned authentication, temporary threads, disabled workspace/tools,
  per-request process ownership and cancellation; do not copy credentials.
- Exercise a real Codex first answer, contextual follow-up and cancellation
  through native offscreen Electron, production preload/client and the native
  server authorization/router. Observe temporary threads with no saved path,
  no transcript for those threads, and cleanup of all owned child processes.
  The main-chat context and app shell are fixtures, not a concurrently running
  production research task or full installed-profile acceptance.
- Validate focused isolation/cleanup regressions. Also make the Git worktree
  assertion compare canonical paths on macOS's symlinked temporary directory.
  These changes are prepared for 1.0.3; publication and deployment are separate.

## 2026-09-17 — Native workspace Git controls (unreleased)

- Add on-demand worktree status, staged/unstaged file diffs, conflict versions,
  stage/unstage, reviewed commits, text resolutions and existing operation
  continuation/confirmed abort. Restrict every endpoint to native operator
  authorization, not shared-chat guests or arbitrary workspace file access.
- Resolve the canonical worktree and serialize mutations using Git's index
  lock and revision checks. Preserve coherent conflict indexes when a rebase
  continues into another conflict. Refuse executable hooks/affected custom
  filters with actionable guidance rather than silently bypassing them.
- Exercise real disposable repositories for stale state, unborn and linked
  worktrees, renames, merge/rebase continuation, abort, unsafe paths and storage
  failures; validate package file inclusion. Native offscreen desktop checks
  cross the actual Git router/auth boundary, with fixture session lookup.
- No server restart, deployment or publication performed. Matching desktop
  support is required; these endpoints do not add any background polling.

## 2026-09-17 — AgentsServer 1.0.2 stable accepted

- Publish [AgentsServer 1.0.2](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.2)
  from `c1f3cc45d0317cf8f7789a62a787ada2f3728515`. Includes the endpoint
  recovery API and the preceding collaboration and Side chat beta changes.
- [Release preparation](https://github.com/ZhengyiLuo/AgentsServer/actions/runs/35193337072)
  passes dependency-lock validation, compilation and all 4,295 server tests
  (two skipped), then packages and signs the release manifest.
- Verify the Ed25519 signature, Stable/API 28 metadata and byte-for-byte
  equality of all 81 packaged files with the release commit. Fresh public
  downloads of the archive, manifest and signature match the verified assets.
  Archive SHA-256:
  `75c7c6f9d0285ac341a29e2e6e445c3c9be234518426c653fe437f0e6eafdb43`.
- Cancel the redundant tag-triggered rebuild after publishing those verified
  assets. Unrelated uncommitted work remains excluded. Installation is a
  separate managed operation; publication itself does not restart servers.

## 2026-09-17 — 1.0.2 stable release prepared

- Set the standalone server release version to `1.0.2` for the explicitly
  requested stable app/server release. The committed runtime includes the
  1.0.1 beta mail gateway, durable joins, indexed search, exact-recipient reads,
  isolated Side chat and shutdown-budget fixes, followed by endpoint recovery
  in source `4753c8dd0b70e6896c04b81608c813b84010ca25`.
- Add [stable release notes](RELEASE_1.0.2.md) against the published 1.0.0
  baseline. API contract remains 28; Team Hub schema is 23, introduced by the
  indexed-search migration in beta.2. Existing trust, approvals and routes are
  preserved by explicit endpoint recovery; each member requires its own update
  and endpoint migration after a host address change.
- Prepare this release only from committed source. Unrelated uncommitted
  Claude history, subagent and deployment/packaging changes remain excluded.
  Local validation uses a temporary source snapshot, rejects `agent_server`
  imports and process launches, and allows only private test transports.
- All 39 endpoint recovery checks pass on that committed snapshot. Four of
  five release-manifest checks also pass; the remaining check identifies the
  frozen `secure_peer.py` source digest that must be refreshed after the
  recovery change before the full release gate can pass.
- Publication and deployment are pending. Run the release workflow in
  `prepare_only` mode, then verify the held signed assets against the committed
  source before publication. Record the accepted workflow, archive digest and
  public-download verification in a subsequent entry after they succeed.

## 2026-09-16 — Secure Team Network endpoint recovery (unreleased)

- Identify a vanished host bind address explicitly instead of repeatedly
  reporting a generic initialization/database failure. Permit a confirmed
  reconfiguration to a current address without restarting the main server,
  resetting the host CA or revoking approved members. Failed changes preserve
  the prior configuration and restore a previously live listener when possible.
- Add an authenticated member endpoint-migration control. Probe the explicitly
  selected endpoint with the existing pinned CA and client certificate; verify
  host, Hub, team and peer identity before changing the saved address. Preserve
  routes and active selection, reject concurrent trust/renewal/endpoint changes,
  and never reactivate a disconnected member or fall back to unverified TLS.
- Preserve notification callbacks across host rebind/rollback. An inactive
  connection migration does not invalidate the active connection's hint stream.
  Add no renderer polling, network discovery or automatic address switching.
- Focused tests cover actual missing-address socket failures, real TLS endpoint
  verification, wrong certificates/identities, persistence failure, rollback,
  revocation and renewal races, inactive connections, schema compatibility and
  the authenticated asynchronous API boundary. Tests use isolated state and
  private test transports, never the monolithic server or production chats.
- See [endpoint recovery](SECURE_PEER_ENDPOINT_RECOVERY.md) for operator steps
  and compatibility. This implementation is not yet published or deployed;
  migrating a host alone cannot update endpoints saved by member servers.

## 2026-09-16 — 1.0.1-beta.2 publication verified

- Published [AgentsServer 1.0.1-beta.2](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.1-beta.2)
  from source `da063729e20a6163f96a26ec119a6c77b77c6a3c`. Includes isolated
  Side chat follow-ups, indexed Mail/Bulletin search and exact-recipient
  Team Network reads; unrelated unfinished worktree changes are excluded.
- Release validation caught obsolete installer import assertions and the
  missing Side chat cleanup allowance. Align all 18 bounded shutdown phases
  with the cooperative watchdog and the installer's 185-second maximum
  launchd wait. Add a guarded check of the complete budget relationship;
  preserve existing forced-restart and systemd service bounds.
- [Release preparation](https://github.com/ZhengyiLuo/AgentsServer/actions/runs/35164753174)
  passed the full suite (4,256 tests, two skipped), packaging and Ed25519
  manifest signing. Verify the held assets before uploading and publishing;
  cancel the redundant tag-triggered run after publication.
- Fresh unauthenticated public downloads pass signature verification, all
  three GitHub asset digests, Beta/API 28 metadata and byte-for-byte comparison
  of all 81 packaged source files with the release commit. Archive SHA-256:
  `2ac24796d4a2cd6dd88c0c1b1060021a247dc90f7ff1cabc7791d138db87af46`.
- The matching Side chat interface is in desktop 1.0.1 local build 1170.
  Publication does not install or restart a running server or desktop app.
  The stable server release remains 1.0.0.

## 2026-09-15 — Direct Team Network reads from mentions (unreleased)

- Teach both provider runtimes and their shared tool description that
  `@@bulletin` and named `@@` mentions refer to Team Network, not external
  connectors. Reading mail or the Bulletin does not require manual routing
  and does not authorize an automatic send or post.
- Expose `team bulletin` as a read-only alias for the existing feed. Follow
  sender-filtered inbox pages on demand, retaining explicit continuation and
  incomplete status instead of claiming no mail after filtering one page.
- Resolve selected mentions on demand to exact team/sender identities, so
  duplicate names and renamed members cannot silently select different mail.
- Keep runtime guidance out of user messages; add no polling, refresh timer,
  new route grant or message mutation. See [agent reads](TEAM_AGENT_READS.md).
  Guarded helper-to-endpoint-to-Hub journeys cover duplicate names, renames,
  exact Bulletin selection, history pages and unchanged unread mail. Isolated
  checks also cover multi-team scope, revoked authority and bounded output.
  No installed app or running server is changed by this implementation.

## 2026-09-15 — 1.0.1-beta.1 replacement accepted

- Republished the explicitly authorized same-version beta from source
  `d209ab4c77ac5a970232359fb4317aafd79dfc1b`. The canonical
  [beta.1 release](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.1-beta.1)
  and tag now identify the revised durable-join implementation while retaining
  the earlier Team Mail gateway correction. A verified backup of the original
  package is retained; unrelated unfinished changes are excluded.
- [Release preparation](https://github.com/ZhengyiLuo/AgentsServer/actions/runs/34946030454)
  passed 4,128 tests with two skipped, packaging and manifest signing. Its
  prepare-only mode held the signed assets for verification before the existing
  release was replaced. The redundant tag-push run was cancelled afterward.
- Fresh unauthenticated public downloads pass Ed25519 signature verification,
  all three asset digest checks, Beta/API 28 metadata and byte-for-byte
  comparison of all 78 packaged source files with the accepted commit.
  Archive SHA-256:
  `24e3a1d388fa4730a8020230491562cc63d976bea3329b0fdd8a45c5af759f62`.
- Durable joins require the revised server on both host and joining server.
  Already-installed beta.1 instances require manual reinstall from the
  verified archive; Check for updates and Force update reject equal versions.
  Matching desktop observation/display changes remain separately committed.
- The stable release remains 1.0.0. Publication performed no live server
  restart, installation, request approval or mail send.

## 2026-09-15 — Durable join approval waiting implementation

- New explicitly submitted joins negotiate a signed durable-approval
  capability when both servers support it. Pending approval and automatic-join
  consent then wait for a decision rather than expiring after ten minutes.
  Preserve the exact request and consent through restart and lost-response
  recovery; no extra authority or automatic approval is created.
- Remove the shared-IP cap of 16 pending requests, which can reject legitimate
  teammates behind one network. Keep overall storage/response/flood bounds,
  identity and signature checks, host approval, cancellation, revocation,
  connection replacement fences and certificate validity.
- A 600-second HTTP observation window no longer falsely expires a pending
  Join. Return an explicit observation-window result while retaining consent;
  desktop observers can renew the same long-held read without inbox polling.
  Project a durable approval deadline as null, not the Unix epoch.
- Existing positive legacy deadlines remain unchanged; old expired, rejected
  or cancelled requests are never revived. A new request and updated host and
  joining servers are required for durable waiting. Older binaries do not
  understand the new stored zero deadline; see the contract's downgrade note.
- Local isolated checks exercise eight-day approval waiting, restart,
  lost-response replay beyond the old attempt-retention window, shared-NAT
  admission, cancel/approval races, observer cleanup and old/new compatibility.
  The combined guarded acceptance run passes 121 checks, including the fresh
  member mail flow and release source manifest. Production state, provider
  processes and live network endpoints are excluded from this local harness.
  These local checks performed no live approval, server restart, installation
  or publication.

## 2026-09-15 — 1.0.1-beta.1 publication verified (UTC)

- Published source: `ce5a245546cbc8d4b55c16a05afc31a25104e6fa`.
- [Release workflow](https://github.com/ZhengyiLuo/AgentsServer/actions/runs/34938118639)
  passed its full gate: 4,098 tests, two skipped. Packaging and Ed25519
  manifest signing succeeded. Publication completed at 06:59:23 UTC.
- Fresh public downloads passed signature verification, all three GitHub
  asset digests, Beta/API 28 metadata, and byte-for-byte comparison of all 78
  packaged source files with the release commit. Archive SHA-256:
  `8d4b6ff0d08b96df8cda5b418f988a243068eee672a6f866aca6ae3abde0af2d`.
- [Public beta](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.1-beta.1)
  is available; the latest stable remains 1.0.0. The exact committed source
  also passed 43 guarded local mail/lifecycle/package checks, independently
  of unrelated uncommitted work in the development tree.
- Publication did not install or restart Supersonic, Studio or any member
  server; it did not send/retry mail or approve pending joining servers.

## 2026-09-14 — 1.0.1-beta.1 member mail gateway correction

- Preserve the recipient's `mail_route_lifecycle_id` in the secure-peer mail
  adapter. Durable `@@` grants already attach this inbox-identity precondition,
  and the Hub API/store already support it; the adapter's older field allowlist
  rejected valid member sends before the message could reach the store.
- Keep value, recipient ownership and incarnation checks inside the existing
  message transaction. Do not remove the precondition, widen peer permissions,
  re-enroll members or retry mail automatically.
- Reproduce the failure through real private-socketpair mTLS with a freshly
  approved member, exact mention resolution and durable grant admission. The
  former tests passed an unbound recipient and missed this field mismatch.
- This correction belongs on the receiving Team host. No desktop contract,
  database migration, polling or live restart is introduced by the source fix.
- Focused guarded acceptance passed 38 tests, including fresh-member-to-host
  and fresh-member-to-member mail through actual private-socketpair mTLS,
  exact `@@` resolution and durable route admission, threaded replies,
  idempotent retries, and revocation/rejoin between resolution and commit.
  Unknown fields and malformed or stale inbox identities still reject without
  committing mail. No live sends, approvals, provider runs or server restarts
  were performed. Publication and downloaded-asset acceptance follow below.
- Keep this beta limited to the mail gateway correction. Uncommitted cron
  history and subagent assignment work is not part of this release.

## 2026-09-14 — 1.0.0 continuation and history replacement accepted

- Published source: `6f7a43c324a252f4ca847375b17524092752d3c2`.
- [Clean release workflow](https://github.com/ZhengyiLuo/AgentsServer/actions/runs/34915559905)
  passed: 4,087 tests, two skipped; package and manifest signing succeeded.
  Published at 2026-09-15 01:18:12 UTC as release ID `388807461`.
- Fresh public downloads passed Ed25519 signature verification, all three
  GitHub asset digests, stable/API 28 metadata and byte-for-byte comparison of
  all 78 packaged source files against the release commit. Archive SHA-256:
  `3dc9f0466f314d9e9f75dfc586cc3fc180e3f179de77e5657f578aa81e6b7bfb`.
- [The replacement](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.0)
  is the latest public stable server release. Version remains 1.0.0 by explicit
  approval; existing 1.0.0 installations require an explicit reinstall.
  Earlier same-version publication records below are historical.

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
- The guarded transport, ordinary/native-goal lifecycle and history
  regression group passed 254 tests, including 30 new ordinary continuation
  scenarios. The guard rejects any import of the server monolith.
- Final ordering review added an exact completed-parent check so delayed
  consumption of an already-finished native follow-up cannot start another
  unnecessary turn. Stop skips interruption only for an explicitly completed
  native handle. The final targeted group passed 153 checks, including both
  regressions; full clean release acceptance follows separately.
- Correct the Cursor idle-warning test to arm its short test deadline after
  actual provider readiness, rather than counting process startup as a second
  idle period. Runtime deadlines and behavior are unchanged by that fixture fix.
- Read-only compatibility review of desktop build 1167 confirms its existing
  active-run contract keeps Working/Running and Stop available during child
  collection. This was a source review, not a live UI test; no desktop runtime
  change is required for this correction.
- No live server, app or user task was installed, opened, restarted or changed
  by these checks or publication.

## 2026-09-14 — 1.0.0 cross-chat history correction included

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
- Included in the accepted 1.0.0 replacement above. No live deployment or
  restart performed.

## 2026-09-14 — original 1.0.0 stable accepted (superseded above)

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
