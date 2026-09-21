# Public development log

## 2026-09-21 — Clarify the bridge to npm updates

- Document the first coordinated release as a bridge delivered through the
  existing desktop feeds and signed standalone server updater. Existing managed
  users update the app; they do not run the fresh npm installer over their data.
- Separate the accepted beta.8-app/beta.9-server journey from older unsupported
  installations, pre-1.0 feed migrations and custom-path macOS prerequisites.
  Preserve stable/beta channels and retain legacy downloads during transition.
- Correct the migration guide and beta.12 release notes to reflect publication.
  Check the instructions against the shipped coordinator, updater, original
  one-click acceptance and public-distribution verification. No runtime or
  released artifact changes accompany this documentation update.
- Replay the released beta.29 updater contract in an isolated fixture. Its
  macOS runner lacks the new installer's admitted ownership proof, and its
  latest-only selection prevents using the old API to pin an intermediate
  release. The Linux managed-update environment passes this admission check;
  neither result establishes a complete native beta.29 migration. Keep that
  older starting point outside the accepted automatic-migration claim.

## 2026-09-21 — Publish coordinated desktop/server beta.12

- Publish direct desktop `1.0.4-beta.12` build `1189` on the public AgentsDock
  repository and its compatibility release mirror, with the accepted artifacts
  from source `2741c05a0772849f6da82f944789060b77ecb91d` unchanged.
- Publish `@agentsdock/server@1.0.4-beta.12` to the npm beta channel and the
  signed standalone migration bridge to AgentsServer. Verify the public npm
  archive against its signed size, SHA-256 and SHA-512 integrity, then verify
  all 106 runtime files and modes against the public legacy archive before
  exposing either desktop release. Both desktop mirrors retain the accepted
  checksum manifest and signed paired-server descriptor.
- Configure npm trusted publishing for the public repository's protected
  `server-npm-publish.yml` workflow and `npm-release` environment. Existing
  installations retain the signed legacy migration path; the packaged app
  requests its matching server automatically after updating.
- macOS is signed and notarized; Windows remains unsigned. Initial migration
  and execution-runtime replacement wait for idle. Running native goals on old
  servers can retain execution ownership between replies, so a final reply
  alone does not guarantee an idle migration window.

## 2026-09-21 — Accepted desktop beta.12 build 1189 candidate

- Accept the direct desktop 1.0.4-beta.12 build 1189 from committed source
  `2741c05a0772849f6da82f944789060b77ecb91d`. Native workflow
  `35661716190` passes Linux x64, Linux arm64 and Windows x64 build and package
  verification. Windows remains unsigned. The local universal Mac release
  passes 4,646 tests, type checking, compilation, Developer ID signing, Apple
  notarization and stapling, Gatekeeper, mounted-DMG/ZIP parity, updater metadata
  and blockmap checks, and an isolated startup. Five existing tests are skipped.
- Retain all release checks. Fix two asynchronous UI tests to wait for their
  rendered result or effect callback, compare signing keys independently of
  checkout line endings, and cap release test concurrency at four workers.
- Bind the app to signed npm descriptor SHA-256
  `18a4bc7c54dc749b93235bda4e0c3247123e03d85d7b2e2dc525087b7014b5b5`.
  The npm archive is byte-identical to the server candidate that passed all
  eight CI shards (4,971 cases), real Codex and Claude foreground/subagent
  gateway-loss checks, and native Linux/macOS migration and recovery checks.
  Both signed distributions contain the same 106 runtime files and modes.
- Verify the production-signed legacy archive with the original trust key on
  native Linux and macOS. Preserve identity, credentials and saved state through
  forward migration, updater/installer loss and automatic rollback. An abrupt
  macOS VM power loss at the durable activation boundary recovers automatically
  after reboot without an HTTP recovery trigger or manual repair.
- Verify one real update click in the unchanged published beta.8 app: Squirrel
  replaces it with the exact build 1189 ZIP and relaunches it automatically.
  The new packaged coordinator migrates the genuine beta.9 server to beta.12
  without a separate server-update click. Check the installed signature,
  executable, application archive and descriptor against the accepted package;
  retain the same saved profile, server identity and credential, with both
  components current and execution admission released. Discovery uses a private
  HTTPS fixture; public release propagation remains a separate publication check.
- Close the populated-data acceptance gap before publication. A genuine Linux
  beta.9 Hub host survives an interrupted signed upgrade, automatic rollback and
  retry with its saved chat/events, Hub records, approved peer, keys, provider
  paths and credential files preserved. A separate joined-server migration keeps
  its active mutual-TLS connection and content access without pairing again.
  The Mac host migration preserves both Codex and Claude histories, Hub messages,
  board content and peer authority; existing peer credentials authenticate saved
  reads and new writes. Provider credential contents are synthetic preservation
  fixtures, while Hub/peer authentication runs against the actual native services.
  Verify retired bootstrap authority remains retired; a revoked proof file is
  not required to survive snapshot recovery. These checks need no product edits.
- This records accepted build artifacts before desktop upload. Public publication
  and the live Studio upgrade are still pending. Execution-runtime replacement
  waits for idle; simultaneous execution generations are not claimed.

## 2026-09-21 — Prepare updates during work and recover interrupted activation

- Stage and verify server dependencies while agents continue working. Preserve
  the existing pending-update protocol for older clients, then acquire the exact
  idle execution hold before activating the prepared candidate.
- Extend the existing installer transaction to both native services, retaining
  configuration, previous runtime and state recovery. Bind automatic recovery
  to the admitted candidate and journal. Register an independent native recovery
  job before stopping the main services, so recovery also runs while the app
  cannot connect. Join that owner through the existing update action. Keep
  incomplete recovery fenced and distinguish verified rollback from successful
  installation.
- Require both component versions and released execution admission before
  reporting completion. Exercise the coordinator and existing updater endpoints,
  exact transaction recovery, failed launch, stale ownership and rollback results.
- Verify one real Codex turn and one real Claude turn while actual dependency
  preparation and receipt validation run. Each original foreground command and
  provider stays alive and completes exactly once, with ordered event delivery;
  execution admission remains open. These isolated tests do not activate an
  installed release or establish signed delivery acceptance.
- Real fresh installations and migration from the released legacy updater have
  passed on disposable Linux systemd and macOS launchd hosts. A Linux fault test
  kills the updater and installer after service shutdown, then verifies that the
  independent native owner restores the previous installation and reports a
  failed, retryable update without an HTTP trigger. Native testing exposed and
  fixed directory permissions, generated-cache validation and recovery ownership.
- Repeat native acceptance with credentials pinned to the connected process
  before transmission and runtime durability checked before service shutdown.
  An abrupt macOS VM shutdown during activation restores the previous release
  automatically after reboot, retaining identity, credentials and saved state.
  Correct enablement parsing for both launchd output formats found during testing.
- Exercise the production renderer, preload, native transport and coordinator in
  an isolated offscreen Electron app against an installed Linux server. Add and
  authenticate it through the UI, request the signed npm candidate, and verify
  automatic reconnection, both updated components, released admission and the
  Up to date result. Registry, signing key, version enrollment and credential
  storage are controlled QA boundaries; no app binary replacement is asserted.
- Repeat a genuine beta.9 migration after a prior rollback, then abruptly stop
  the Linux VM after the old service is disabled. After reboot, the independent
  systemd owner automatically restores beta.9, retains identity, credentials and
  saved state, and retires its recovery job without an HTTP recovery trigger.
  Cover carried-over legacy intent and pre-arm retry failures with regressions.
- Fix the Linux lock-inode reuse and closed-transport races exposed by the full
  CI suite; rerun their regressions on both Linux and macOS. Final signed-package
  acceptance remains pending. These results do not establish simultaneous
  execution generations. No release has been published or deployed by this entry.

## 2026-09-21 — Verify both server components before update completion

- Keep a coordinated update incomplete until both the gateway and execution
  runtime report the paired release. Reject inconsistent component health,
  retain failed-operation recovery, and observe gateway changes independently
  of the execution process's boot identity. Existing single-process servers
  retain their compatibility path.
- Pass focused coordinator, update and restart settings regressions, TypeScript
  checking and production compilation. Exercise the current production renderer,
  preload, service, native transport and coordinator in an isolated offscreen
  Electron window against real worker and gateway processes from the committed
  execution foundation, with controlled release version files and a QA signing
  key. Add and authenticate the isolated server through the UI, open Updates,
  verify the incomplete result, replace only the gateway, and explicitly refresh.
  Verify the same worker and server boot, both current component versions and
  the resulting Up to date row. All owned processes exit and no model turn runs.
- The QA harness substitutes credential storage and release enrollment. This
  establishes component-status handling, not installed migration, app binary
  replacement, automatic reconnect-only behavior or production signing. The
  installer and runtime migration integration remains in development; this
  change is source only and no release has been accepted or deployed.

## 2026-09-21 — Persistent execution foundation (source only)

- Separate the public gateway from the process owning chats, provider transports,
  pending approvals and tool execution. Preserve authenticated request semantics,
  event ordering and private provider callbacks during gateway replacement.
- Give gateway and execution independent process/release identities. Keep the
  actual execution version visible while an older runtime remains active.
  Retirement requires an idle worker and a durable admission hold; an API
  restart does not close provider managers or cancel accepted commands.
- Complete one disposable real turn each with Codex and Claude. Their foreground
  tools survive both graceful and forced gateway termination, then the original
  turns complete without duplicate execution. Reconnected WebSockets receive
  the complete ordered event sequence. Check both CLI logins remain valid.
- Verify separate native subagent runs for both providers: one child continues
  through both gateway replacement modes and completes its tool once. Claude's
  unanswered tool approval retains its request identity through another restart
  and resolves once after reconnect.
- Lock chat state before loading it or sweeping provider children, across both
  maintained entry points. Test both startup orders with actual processes: a
  competing server is refused while the incumbent and its registered controlled
  child remain intact. Retain ownership through shutdown stragglers.
- Start a copied production runtime through a real pending activation journal.
  Verify recovered queued turns and due jobs reach their admission checks and
  remain deferred, with no provider launch. Reject an incorrect release of the
  admission hold; permit a normal zero-turn mutation after the exact release.
- Add transport, admission, recovery, controlled subprocess and production
  application regressions. Verify existing managed-service proof and pending
  update admission behavior in isolated state. Package the seven execution modules
  in both server distributions and retain explicit single-service installer
  protection for experimental split installations.
- Exercise real launchd and user systemd replacement with controlled application
  and child-process fixtures: gateway upgrade, failed gateway rollback, busy
  worker refusal and exactly one approved side effect. Retain the worker and
  chat identities. Fix systemd working-directory rendering and exact file-mode
  restoration exposed by these native tests; restore the disposable baseline.
- Exercise the existing built desktop through an isolated offscreen Electron
  window with production renderer, preload, IPC and server transport. Connect a
  server, create a Claude chat without a turn, navigate owned history and use
  explicit reconnect after both gateway replacements. Keep selected chat and
  final text. Credential storage is substituted in this QA harness; this does
  not establish automatic reconnect-only or packaged-feature-build acceptance.
- These changes do not yet enable rolling execution generations or the normal
  npm/app migration path. The application routes still live in the retained
  execution process. Native service fixtures and desktop checks do not establish
  production state/Team Hub migration. No release build is accepted, published
  or deployed by this entry.
  See [the implementation boundary](PERSISTENT_EXECUTION.md).

## 2026-09-20 — Revised beta.12 package and public release validation

- Build the revised server package from clean committed source `751c1e0`.
  Its SHA-256 is
  `bc69cb8817d3f085330306a463f61b0353186193b2357600f1613f56288995ea`.
  The standalone export preserves upstream history and all 88 runtime files;
  packaging that export through npm produces the identical archive.
- Pass native macOS fresh-install retry over the exact failed candidate's empty
  folders without cleanup. Refuse another install without changing the running
  process, identity, token or synthetic provider files. Pass candidate activation
  and forced incompatible-API rollback with the exact prior runtime and plist.
- Pass the app-driven Linux update and rollback through the production renderer,
  preload, IPC, coordinator, systemd service and detached installer. Verify all
  88 installed runtime files, identity, token and six synthetic state/history
  files. The failed update remains paused after repeated health refreshes, and
  the isolated HTTPS registry records only the two intended package downloads.
  Inspect dark and light layouts, including the minimum supported window width.
- These results cover disposable native services and controlled app-replacement,
  signing-key and distribution endpoints. Production-signed app replacement,
  public registry transport and live provider work are not established by them.
- Exercise the complete legacy bridge route from an old managed server without
  npm update support. The production app checks and starts a signed legacy
  update; the old detached updater installs the paired runtime and reconnects
  with npm update capability. The app marks the equal-version bridge current
  without a redundant npm download. Discovery and signing endpoints are controlled
  within the disposable guest; no public legacy release was published.
- Correct source CI to use runner paths in step environment variables and run
  for maintained release branches. All eight public server test shards pass.
  Update legacy release assertions for protected public workflows and reviewed
  source-branch ancestry; retain release identity and mirroring checks.
- Correct settings test fixtures to provide the required typed app-update status,
  settle initial loading and distinguish app controls from server controls.
  Pass 4,630 Electron tests with five existing skips, eight script tests and type
  checking. Retain all server operation and recovery assertions.
- Reproduce delayed app-update status dismissing an already open server restart
  confirmation or clearing a restart error. Reset these controls when Settings
  opens, preserving user actions while status finishes loading. Keep server
  polling and profile/boot checks unchanged; add regressions for both cases.
- No released app build or public npm version is accepted by this entry.
  Native signing credentials still need to be supplied to the public release
  environment, and signed publication checks remain pending.

## 2026-09-20 — Current server integration and transition signing — candidate follow-up

- Merge the six newer commits from the maintained standalone release branch,
  preserving automatic Codex/Cursor chat titles and the shared-chat Cursor fix.
  Preserve the updated shared-browser bundle. The earlier `8a52b14` archives
  below are historical QA artifacts and are superseded for release preparation.
- Include automatic title requests in update and restart blockers. Prevent new
  optional title requests after update admission closes, and allow unstarted
  queued requests to retry on a later turn. Verify an actual disposable provider
  subprocess delays update advancement and that shutdown reaps its process group.
- Pass 291 targeted title, provider-background, update and restart tests. Pass
  another 189 focused provider-isolation, storage, shared-chat, terminal and
  packaging checks, plus 33 Node publication/staging/CLI checks. Reproduce the
  terminal cancellation regression with a single-worker executor.
- Make npm packaging work in both the combined repository and standalone
  compatibility export. Select legal notices from the checkout boundary, reject
  unrelated parent files and retain exact canonical license copies in the export.
  Nine packaging tests include real offline npm archives in both layouts.
- Include the license and notice in both published server distributions and
  installed runtimes. Pass 16 focused packaging/manifest tests, including actual
  npm and legacy archive comparison of the legal files and their permissions.
- Reproduce macOS device-number changes across reboot breaking interrupted
  activation recovery. New journals bind their filesystem coordinates to a
  persistent volume UUID while retaining inode, ownership, content and live race
  checks. Negotiate the new guard-path option with older recovery helpers.
  Pass 75 activation/UUID tests and 17 installer recovery tests. In a disposable
  macOS VM, interrupt the real installer, reboot across an actual device-number
  change and verify unchanged installer retry restores the previous runtime,
  exact service plist, identity, token and six synthetic state/history files.
  A second orderly reboot retains that rollback and starts the restored service.
  Legacy journals without saved volume proof still require manual recovery if
  their device numbers changed; specialized interrupted Hub reactivation after
  remount remains unsupported. Do not describe those boundaries as accepted.
- Prepare transitional signing through the standalone repository's existing
  release secret. Its prepare-only workflow can produce both signed server
  distributions after all server test shards pass, without publishing them or
  moving the private key. Publication and native acceptance remain separate.
- Move desktop signing and publication automation into public AgentsDock.
  Keep signing credentials in the branch-restricted `direct-production`
  environment and npm OIDC in `npm-release`; ordinary CI and fork pull requests
  receive neither. Rebase the public workflow's native build counter above 1185
  and retain exact source, signature, immutable-asset and server-runtime checks.
  Preserve the private repository's history and retire its release workflows
  when the public pipeline becomes the active publisher. Secret values must be
  supplied again from their original source; they have not been copied or logged.
- Pass 60 release-orchestration tests, parse both public native workflows and
  check all 50 shell steps. Verify manual/canonical/trusted-branch guards on all
  13 jobs and the release environment on all seven jobs that use secrets.
- Reject the packaged `d9c1f50` candidate after a pristine macOS install exposes
  a missing LaunchAgents parent during volume binding. Bind a safe existing
  ancestor until publication creates and verifies the destination directory.
  Pass 77 activation tests, including missing-parent recovery checks.
- Allow retry after that failure without deleting the empty configuration and
  state/admin directories it leaves behind. Both launcher and locked installer
  reject existing data, credentials, links, locks and registered services;
  fresh installation creates no legacy migration alias. Pass 12 CLI tests,
  14 installer admission tests and two actual installer regressions from a
  clean source snapshot. Exact-package macOS retry acceptance remains pending.
- Availability: committed source candidate. Updated packaged migration and
  recovery verification are in progress; no public release or production service
  has changed.

## 2026-09-20 — npm publication and native migration validation — beta.12 candidate

- Reserve `1.0.4-beta.12` for the coordinated candidate. Do not publish the
  earlier beta.9 QA package under an already-used server release version.
- Add manual unsigned preparation and protected OIDC publication of an exact
  signed npm candidate. Verify reviewed source, accepted descriptor hash,
  signature, package identity, immutable version, channel and registry bytes.
  Keep private signing separate; inspecting or signing a candidate does not
  establish native acceptance or publish a desktop release.
- Reproduce a failed fresh installation leaving only empty runtime folders.
  Allow the npm launcher to retry only safely owned empty scaffolding, while
  retaining rejection of state, configuration, files, links, releases, locks
  and registered services. Delete no existing data and retain the installer's
  repeated admission check under its lock.
- Exercise Update through the actual production renderer, preload, IPC,
  service, coordinator and native HTTP in isolated offscreen Electron against
  a disposable Linux systemd service. Verify the detached updater downloads a
  signed HTTPS archive, validates it, activates the candidate and reconnects
  with the same identity and token. Preserve six synthetic state/history files.
- Send an intentionally incompatible signed API contract through the same
  desktop path. Observe candidate activation, rejection and real rollback to
  the prior runtime. Verify the UI pauses with an explicit retry action and
  repeated health refreshes do not download or install it again. Preserve an
  independent offline profile and inspect light/dark minimum-width layouts.
- Separately exercise real macOS launchd in disposable virtual machines:
  legacy installer to candidate, wrong-API health rejection and restoration of
  the previous runtime and exact service plist. Verify identity, token and
  six synthetic provider/configuration/history files remain unchanged. Fresh
  installation through actual offline npx succeeds; a second installation is
  refused without changing the running service.
- Test boundaries: ephemeral signing key and guest-only HTTPS registry for
  Linux; controlled app download/replacement; synthetic provider data rather
  than live model work. macOS dependency caches are preloaded after guest
  outbound network failure. These tests do not establish public npm transport,
  production-signed packaged-app acceptance or actual app replacement.
- Pass 33 focused Node tests covering publication, packaged metadata and the
  npm CLI, plus five actual npm packaging tests and nine installer admission
  tests. Preserve explicit unsupported-boundary notes instead of treating
  a dry run or simulated app replacement as an accepted public release.
- Prepare the exact beta.12 npm archive from committed source `8a52b14` in a
  clean detached checkout. Its SHA-256 is
  `ce392cf842774eb55fcd889a36e5c875d18e7a70551a77163744413fd9252241`.
  On a third pristine macOS VM, reproduce the actual failed first install and
  retry with this unchanged archive through npx, without removing the leftover
  folders. Verify beta.12/API 28 activation, then refuse repeated installation
  while preserving the running process, identity, token and provider sentinels.
- Keep native build/draft staging possible before registry publication.
  Final release verification requires both the signed npm package and matching
  legacy bridge to be public, with identical runtime files and executable bits.
- Verify the compatibility export preserves the standalone repository's ancestry
  and exact server tree. Build the beta.12 legacy archive from that export and
  compare it with the committed npm archive: all 85 runtime files and their
  executable permissions match. Both manifests remain unsigned until production
  signing; these local archives have not been made available to installed users.
- Availability: committed source candidate after focused validation. Registry
  publication, trusted-publisher execution and the complete signed native
  release remain pending. Production services and CLI credentials are untouched.

## 2026-09-20 — Coordinated npm updates — source candidate

- Import the maintained server under `server/` with its complete history.
  Retire the frozen snapshot and its legacy Swift server-text assertions.
  Verify that the initial subtree export reproduces the original standalone
  commit; require subsequent compatibility exports to preserve ancestry and
  exact contents. Keep legacy signed downloads available during migration.
- Prepare `@agentsdock/server` from the exact runtime allowlist, with no npm
  installation hooks. Stage a separate signed descriptor tying the app's
  public version to an immutable npm archive, integrity hashes and API contract.
  Keep source package metadata private and publication disabled in preparation.
- Add authenticated, identity-bound reconciliation through the existing managed
  updater. Persist signed bytes across queued work and restart, queue while busy,
  and validate candidate identity, version and API before activation commits.
  Fresh npm installation refuses existing state and services, including a
  repeated check under the installer lock.
- Add desktop coordination with durable per-server receipts, independent offline
  recovery, explicit enrollment, exact downloaded app version pinning and a
  compatibility gate before restart. Ordinary unenrolled builds keep the existing
  update behavior. The app and server retain their native packaging formats.
  Failed or canceled owned attempts stay paused until an explicit scoped retry;
  enrolled releases keep legacy controls under Advanced server recovery.
- Pass 233 focused server checks, including real HTTP authentication and
  identity guards, signed metadata, queued-work recovery, installer protection
  and candidate health rejection. Verify actual offline npm packing, CLI native
  transport, exact payload bytes and executable permissions, paired artifact
  staging and Git export rejection on divergent history.
- Pass 722 affected desktop tests, TypeScript validation and production
  compilation. Exercise the production renderer, preload, IPC, profile service,
  updater, coordinator and native HTTP against an isolated production FastAPI
  server in native offscreen Electron. Click Update, reopen a second process,
  preserve the queued receipt, display an independent offline profile, pause on
  failure/cancellation and retry explicitly. Verify dark/light minimum-width
  layouts and no automatic legacy release lookup. Feed/download, signing key,
  provider work, server activation and app quit are controlled test boundaries;
  simulated completion is not recorded as a real managed update.
- Separately exercise the real installer in a disposable Ubuntu systemd VM:
  legacy beta.9 to guest-stamped beta.12, then a deliberately incompatible
  beta.13 candidate rolls back to beta.12. Authenticated health verifies exact
  version and API, stable identity and preserved token. Six synthetic provider,
  configuration and history/state files remain byte-identical. This validates
  Linux service activation and rollback, not real provider sessions or the full
  registry-to-app update journey.
- Install the committed local npm tarball through actual offline `npx` in a
  second disposable Linux user account. Verify its independent real systemd
  service, identity and token; a second fresh-install attempt is refused and
  both services remain unchanged. Package retrieval from the public registry
  and same-user multiple-server installation are not claimed by this test.
- Compile the legacy Swift guardrail executable successfully. Its unchanged
  React mobile source-text assertion still fails before later checks; this is
  not recorded as a passing full Swift guardrail run.
- Availability: source candidate only. macOS launchd migration and rollback,
  active real-provider work and retained live chat data, registry publication,
  the complete coordinated upgrade and packaged native acceptance remain
  required before a coordinated release. No production service or published
  release is changed by this source work.

## 2026-09-20 — Compact running command blocks — 1.0.4-beta.11 local acceptance

- Keep the active Codex tool inside its compact command group. Update the
  group's single row to the latest running call and retain previous calls
  behind its disclosure. Preserve commentary boundaries and visible reasoning
  chronology. Only the current activity pulses.
- Hide extra trace-history controls in compact live Codex turns. Keep manual
  pagination in expanded live traces and explicitly opened completed history.
- Retain live-only reasoning display and identical collapsed completed/stopped
  history. This supersedes the undelivered beta.10 candidate, whose running
  call could still appear beside a separate completed-command group.
- Pass 4,598 source tests (10 skipped), 164 focused timeline checks, TypeScript
  validation and production compilation. Verify real native Codex commands
  separated by reasoning within one commentary block, including a delayed
  second call: one compact pulsing row retains both calls. Confirm a later
  commentary creates its own chronological block. Exercise the actual Settings
  entry and switch, completion, stop, unchanged completed history, reduced
  motion, both themes and no automatic trace requests in isolated native
  Electron through the production server and authenticated transport.
  Provider Responses are controlled fixtures; this is transport and display
  acceptance against the supplied visual reference, not external-model output
  or native GUI pixel parity.
- Accept signed, notarized universal macOS **1.0.4-beta.11 / 1185** from
  `494c91fd7236a430d498cb90481fc06697b5a500`. All 88 compiled files match the
  frozen source, and the final ZIP's ASAR matches the exact packaged full-app
  completion and interruption replays. Verify actual Sidebar → Settings
  interaction, compact command blocks, no extra default live controls,
  identical terminal history, reload, reduced motion and supported minimum
  width. The packaged replay uses captured native events and offline IPC;
  production transport was exercised separately in the source acceptance.
- Pass Developer ID signature, Gatekeeper, stapling, universal architecture,
  version/build, ZIP updater hashes and feed checks. The actual signed app
  launches cleanly for ten seconds with isolated user data and is then closed.
  Matching ZIP SHA-256:
  `60792d4c880914d9c05c7769289532b6d9ffe93d972fce94071d2325e923f3e9`.
- Availability: accepted local `.app` and matching ZIP. Public desktop
  publication remains blocked by the private Actions budget. Local app
  acceptance does not imply cross-platform or DMG installer acceptance.

## 2026-09-19 — Live-only reasoning display — 1.0.4-beta.10 candidate

- Apply the reasoning display preference only during an active Codex turn.
  Collapse finished and stopped turns under both settings; changing Settings
  leaves completed history unchanged. Explicit history expansion retains all
  available text in chronological order, independently of the preference.
- Group adjacent commands across hidden reasoning entries. Retain visible
  commentary and reasoning boundaries instead of moving or dropping content.
  Update the English and Chinese setting descriptions.
- Exercise completion and interruption through actual sandboxed Codex, an
  isolated production server, authenticated WebSocket, desktop service,
  preload and timeline in native offscreen Electron. Click the real Settings
  switch while running and after completion; verify both settings converge
  to collapsed history, manual expansion retains text, and hidden reasoning
  produces one command group. Check dark/light narrow layouts and no automatic
  history requests. Responses are controlled fixtures; this validates native
  transport and presentation, not external-model output or native GUI parity.
- Pass 4,594 tests (10 skipped), eight build/license guard checks, TypeScript
  validation and production compilation. Keep release verification temporary
  extraction under the configured temporary directory, with a writable-path
  check. This presentation change requires no server contract update.
- Availability: source candidate; signed local package acceptance is pending.

## 2026-09-19 — Codex activity and per-chat limits — 1.0.4-beta.9

- Present Codex commentary and command rows inline, with one muted pulsing
  current activity. Stop animation on completion or interruption and honor
  reduced motion. Preserve earlier summaries under a compact disclosure.
- Add a persistent **Show reasoning traces** switch in Settings → General.
  Keep compact presentation by default; optionally expand summaries and
  separately labeled plaintext supplied by Codex. Do not decode encrypted
  content or imply that unavailable reasoning can be recovered.
- Carry the distinct plaintext event through live transport, timeline
  projection, completion, interruption and history. Keep transient updates
  outside durable cache/cursors and distinguish summaries sharing an item ID.
  Verify the previous desktop renderer ignores the new plaintext event even
  when its trace is expanded, while continuing to display ordinary summaries.
- Add optional Codex and Claude sub-agent limits in the chat Inspector.
  Fence saves to the original server identity and generation, reject old
  servers before mutation, and retain drafts after failure. Saving during
  active work is allowed; explain each provider's application boundary.
- Verify the actual Settings entry and toggle, native Chromium animation,
  reduced motion, complete text expansion, persistence, and light/narrow
  layouts in isolated offscreen Electron. Exercise limit saves and clearing
  through production preload, IPC, HTTP authorization and server persistence;
  preserve a sibling chat and active-work status and reject unauthenticated
  writes. Provider execution is verified separately in the paired server.
- Pass 4,585 source tests (10 skipped), eight build/license guard checks and
  TypeScript validation, including scoped and unscoped preload compatibility.
- Accept local universal macOS **1.0.4-beta.9 / 1182** from
  `1641cb97dfba17b6c3b3807c79c0f63e4a36cca3`. Developer ID signatures,
  notarization, Gatekeeper, DMG/ZIP parity and updater checks pass. The signed
  executable passes its clean CI launch; all 88 packaged compiled files match
  the frozen source. Replay the native capture through the exact packaged
  renderer and preload, including Settings, persistence, reduced motion and
  completion. This packaged replay uses offline fixture transport; native
  provider and authenticated transport checks are recorded separately.
- Verify the copied app on a second Mac: matching archive SHA-256, version,
  build, deep signature and Gatekeeper acceptance. Preserve its existing app.
- Correct a Linux arm64 test that checked an unread callback before its React
  effect committed. Pass all 111 affected module tests and TypeScript checks.
  Follow-up source `5ff80a385957722c99026084036750934fcc564f` changes only
  test synchronization and type declarations; its 88 compiled files are
  byte-identical to accepted build 1182.
- Desktop publication remains blocked: the replacement prepare for build
  1183 could not start because of the GitHub Actions budget. No desktop
  beta.9 release was published. The local Mac acceptance does not certify
  the incomplete cross-platform release.
- The paired [AgentsServer beta.9](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.4-beta.9)
  is published and independently verified. Managed updates are queued to
  apply when active work finishes; scheduling is not deployment acceptance.

## 2026-09-19 — Live thinking summaries — 1.0.4-beta.8

- Display thinking summaries directly and retain expansion through completion.
  Opening historical traces loads one bounded activity page automatically;
  additional pages remain available without loading all history in the background.
- Carry live summary snapshots through the native WebSocket, profile-scoped
  service and renderer state. Keep them outside SQLite and durable read cursors,
  replace them with authoritative completed items, and restore current snapshots
  on reconnect. Retain interrupted summary text with a partial marker.
- Show custom-model summary support separately from basic tool compatibility.
- Pass 822 transport, service, state, locale and custom-provider checks, plus
  173 timeline and projection checks and TypeScript validation.
- Native acceptance follows controlled Responses through the real Codex
  app-server, production server, authenticated WebSocket, desktop service,
  preload, state and timeline. Compare rendered text and completed sections
  exactly with native public-summary notifications. Verify live visibility,
  summary/tool/summary order, reconnect, authoritative replacement and retention
  after completion without persisting transient rows.
- Stop an actual native turn that omits item completion; retain its received
  text as a partial summary. Reopen SQLite in a fresh desktop process and
  expand its historical trace to verify the partial marker and bounded load.
  Inspect light/dark layouts at narrow width. Retain finite Chromium
  ResizeObserver notifications in the evidence; geometry and warning counts
  settle, with no application errors. This is public-summary validation,
  not native GUI pixel parity or a claim about unavailable internal reasoning.
- Accept desktop **1.0.4-beta.8 / 1181** from
  `3bb296e1ea076f76f235905d3d2deb965b28e08b`. All 88 packaged compiled files
  match the source fingerprints frozen before artifact download. Replay the
  accepted native capture through the exact packaged full-app renderer,
  preload and state; live/final text and chronological tool placement match.
  This packaged replay uses offline fixture transport.
- Universal Developer ID signatures, notarization, Gatekeeper, mounted
  DMG/ZIP parity and updater checks pass locally; the signed executable passes
  its clean CI launch. Preserve the previous accepted app separately.
- Pass all four platform builds and package checks, then all four publication
  replay checks. macOS and both Linux suites pass 4,564 tests (10 skipped);
  Windows passes 4,528 (16 skipped). Publish the Windows installer under the
  documented unsigned beta policy.
- Publish after the matching signed AgentsServer **1.0.4-beta.8** is publicly
  accepted. Verify 14 exact assets and authored notes on both desktop feeds,
  every public asset digest and size against independently hashed held files,
  the exact source tag, anonymous asset availability, and downloaded checksum
  manifests/updater metadata. Release/tag metadata uses authenticated API reads.
- Releases: [desktop beta.8](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.4-beta.8),
  [legacy Beta feed](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.0.4-beta.8).

## 2026-09-19 — Custom endpoint model compatibility — 1.0.4-beta.7

- Separate optional saved-model compatibility checks from endpoint saving.
  Display unverified, unsupported and basic-check-passed states without
  treating model discovery as proof of native Codex compatibility.
- Respect explicit per-model effort capabilities, including empty effort
  lists, and retain manual entry for unfamiliar model IDs. Fence saved-model
  checks to the selected server and credential revision.
- Pair this client candidate with AgentsServer 1.0.4-beta.7. Its 72 focused
  provider and side-chat checks pass, including stale effort cleanup and
  retained credential ownership. Native loopback capture confirms the
  production override helper clears inherited effort while preserving
  thread instructions and unrelated thread settings.
- Exercise Settings, New chat and Composer in native offscreen Electron
  through production preload, service, native HTTP, server middleware and
  provider routes. Save without a model or test, and while a connection or
  compatibility check is pending; verify late results cannot relabel saved
  settings. Complete repeated checks through isolated native Codex against a
  controlled streaming endpoint. Filter an embedding model, clamp advertised
  efforts, and clear effort for unfamiliar/manual models. Inspect light/dark
  narrow layouts, with no overflow or typing/idle requests. Ordinary account
  status and full profile bootstrap are fixtures; chat-turn execution is
  covered separately by server regression and native request capture.
- Pass focused app, service and transport regressions, TypeScript, production
  compilation and output verification. Also complete a basic check against a
  configured external provider while preserving its saved credentials and
  ordinary account configuration. This does not certify every model or tool.
- Accept desktop **1.0.4-beta.7 / 1180** from
  `26d6e4586e077997b7a5de203fa3b0d41e876699`. All 88 packaged compiled files
  match the reviewed source and the fingerprints recorded before download.
  Inspect the exact packaged renderer/preload in isolated offscreen Electron.
  Universal Developer ID signatures, notarization, Gatekeeper, mounted
  DMG/ZIP parity and updater checks pass locally; the signed executable passes
  a clean CI launch. Recheck the native endpoint workflow against the final
  paired server code, using isolated native Codex and a controlled provider.
- Pass all four platform build and package checks, followed by all four
  publication replay checks. macOS and both Linux release suites pass 4,550
  tests (10 skipped); Windows passes 4,514 (16 skipped). Publish the Windows
  installer under the documented unsigned distribution policy.
- Publish matching sets of 14 assets and authored notes to both Beta feeds.
  Match every public asset digest and size against independently hashed held
  files, verify the exact source tag, and anonymously check all public asset
  URLs. Download both checksum manifests and all updater metadata anonymously
  and verify byte parity. Release/tag metadata uses authenticated public API
  reads after the shared anonymous API rate limit is reached.
- Releases: [desktop beta.7](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.4-beta.7),
  [legacy Beta feed](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.0.4-beta.7).

## 2026-09-19 — Center the Team Network mail reader — 1.0.4-beta.6

- Center mail threads in a wider reading column instead of pushing sent
  messages against the far-right edge. Align incoming and sent messages,
  increase message spacing, and soften the sent-message background.
- Reproduce the previous layout at 2,000 pixels and 70% zoom in native
  offscreen Electron using the production mail and Markdown components.
  Inspect the corrected reader at 2,000, 1,200 and 600 pixels in light and
  dark themes, including long text, code blocks and attachments. Verify no
  page overflow, native navigation and scrolling, code copy and attachment
  preview. The fixture uses synthetic read-only mail and an isolated
  clipboard; delivery and production server data are outside this check.
- Pass all 114 existing mail/style tests, TypeScript, production compilation
  and the compiled-output verifier. This layout change needs no server update.
- Accept desktop **1.0.4-beta.6 / 1178** from
  `7e9ec89e007bc32e1f7889c4f558160385773ba9`. All 88 packaged compiled files
  match the reviewed source. Inspect the packaged renderer/preload in isolated
  offscreen Electron. Universal signing, notarization, Gatekeeper, mounted
  DMG/ZIP parity and updater checks pass locally; the signed executable passes
  a clean CI launch. All four native platform builds and package checks pass,
  and the release test suite passes 4,547 tests (10 skipped).
- Publish matching sets of 14 reviewed assets and authored notes to both Beta
  feeds after all four platform replay checks pass. Verify public asset
  digests, updater metadata, exact source tag and canonical/legacy parity.
- Release: [desktop beta.6](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.4-beta.6).

## 2026-09-19 — Preserve side chats across servers — 1.0.4-beta.5

- Keep side-chat state and its native conversation owned by the saved server
  identity and chat, across connection generations. Preserve drafts, replies,
  pending work and follow-up context when switching away and back. Retain
  dispatch checks and explicit cancellation, removal and shutdown cleanup.
- Reproduce lost history/drafts and a switch-triggered close request in native
  offscreen Electron. Exercise the production panel/controller/lifecycle,
  preload, AppService switching, isolated settings/cache and native HTTP to two
  controlled servers with matching chat IDs. Verify background completion,
  follow-up continuity, server separation and cancellation after returning.
  Inspect dark and narrow/light views. The picker and store hydration are
  outside this focused fixture; provider responses are explicitly controlled.
- Also exercise a real Codex side chat against an existing authenticated
  server, using one disposable main chat with a random verification fact.
  Switch servers while its side question runs, restore its answer and draft,
  and complete a contextual follow-up in the same native side conversation.
  Verify both answers, then remove the disposable chat. Existing conversations
  and login settings remain untouched.
- Remove Electron's internal fork-error prefix. Exercise the production chat
  menu through HTTP and native Codex: reproduce a valid symlink-workspace fork
  rejection, then verify repeated forks and a child continuation with the
  corrected standalone server while the parent continues running.
- Pass 111 focused side-chat checks, four fork-error checks, TypeScript and
  production compilation with output verification. The side-chat navigation
  fix needs no server contract change; the fork workspace correction is in
  AgentsServer 1.0.4-beta.5. Include authored notes for both releases.
- Accept desktop **1.0.4-beta.5 / 1177** from
  `56f268292b889f173f7d1e0a10bdc43796545575`. All 88 packaged compiled files
  match the reviewed source. Inspect the packaged renderer/preload in isolated
  offscreen Electron. Local universal signing, notarization, Gatekeeper,
  mounted DMG/ZIP payload parity, checksums and updater metadata pass; the
  signed executable passes a clean CI launch. The macOS release suite passes
  4,547 tests (10 skipped).
- Publish matching sets of 14 reviewed assets and authored notes to both Beta
  feeds after all four native platform checks pass. Verify public asset
  digests, updater metadata, source tag and canonical/legacy parity.
- Publish the signed standalone server 1.0.4-beta.5 and submit its managed
  update for idle installation. The running service remains on beta.4 while
  active work continues; its pending update has no error.
- Releases: [desktop beta.5](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.4-beta.5)
  and [server beta.5](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.4-beta.5).

## 2026-09-19 — Inter-chat chronology — 1.0.4-beta.4

- Accept desktop **1.0.4-beta.4 / 1176** from
  `d2b40e5b3e8f208d9b36f20be1efcb460ba821f4`.

- Keep inter-chat cards among the work that happened around them, ahead of a
  later final answer even when the turn has early-created files or media.
  Give the trailing media group a presentation anchor consistent with its
  displayed position, and refresh cached rows when that anchor advances.
  Preserve original message timestamps and attachment metadata.
- Reproduce the incorrect order with the production Timeline, virtualizer and
  row components in native offscreen Electron using synthetic event snapshots.
  Exercise native controls for live/completed work, late read receipts, cold
  reopen, a genuinely later send and card expansion. Inspect light/dark output.
  Provider execution and production chat data are outside this renderer check.
- Pass 229 focused timeline tests, TypeScript and production compilation with
  output verification. No server contract change or deployment is required.
- Pass 4,538 desktop tests (10 skipped) in release CI. Verify all 88 packaged
  compiled files against the committed source and inspect the packaged
  renderer/preload. Universal macOS signing, notarization, Gatekeeper,
  DMG/ZIP parity and clean executable launch pass. Linux x64/arm64 and Windows
  x64 package and launch checks also pass; Windows remains an unsigned preview.
- Publish identical sets of 14 assets, checksum manifests and authored
  version-specific notes to both desktop Beta feeds. Independent public
  download checks confirm the exact source tag, asset digests and all four
  updater metadata files after publication.
- Release: [desktop beta.4](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.4-beta.4).

## 2026-09-18 — Custom endpoint model controls — 1.0.4-beta.3

- Accept desktop **1.0.4-beta.3 / 1175** from
  `c1dc59c56a666fe881317ff36781f78fcde6decd`, with matching standalone
  AgentsServer **1.0.4-beta.4** from
  `b4b116d022ba9d73949e56476cbfc46fdba27160`.
- Configure a Codex endpoint with its URL and separate key. Saving no longer
  requires a successful test or a model ID, and a pending test does not block it.
- Discover the endpoint's models and choose a model and reasoning effort in
  the normal chat controls. Keep an explicit model entry for endpoints without
  discovery, and keep custom catalogs separate from ordinary Codex.
- Require the matching server capability before using the new controls.
  Existing custom chats retain their endpoint when the default is edited.
- Validate production compilation and focused renderer, service and transport
  regressions. Exercise native Electron input through the production service
  and HTTP boundary with disposable state and controlled provider endpoints.
- The matching server scopes messaging instructions to its helper contract;
  the harness enforces messaging access instead of broad prompt restrictions.
  Remove the blanket identifier prohibition without adding a special
  permission paragraph for local log diagnosis or changing messaging grants.
- Exercise simultaneous normal/custom native Codex threads against controlled
  endpoints. Save and reset during active turns and a pending test; retain the
  original endpoint through model/effort changes, follow-ups and native forks.
  Stop one custom turn without interrupting the normal turn. Verify zero
  account-login calls and unchanged normal runtime identity. Live external
  gateway credentials and production background startup remain outside these
  disposable acceptance fixtures.
- Pass 4,536 desktop tests (10 skipped), TypeScript and production compilation.
  Verify all packaged compiled files against the committed source and inspect
  the packaged renderer/preload. Universal macOS signing, notarization,
  Gatekeeper, DMG/ZIP parity and clean executable launch pass. Linux x64/arm64
  and Windows x64 package and launch checks also pass; Windows remains an
  explicitly approved unsigned preview.
- Publish identical sets of 14 assets and checksum manifests to both desktop
  Beta feeds. Independent publication checks revalidate every native platform
  and confirm public updater metadata and Beta discovery. The matching signed
  server release is published and its managed update is accepted for idle
  installation; it remains pending while active work continues.
- Releases: [desktop beta.3](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.4-beta.3)
  and [server beta.4](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.4-beta.4).

## 2026-09-18 — Codex credential isolation — 1.0.4-beta.2

- Accept published desktop **1.0.4-beta.2 / 1173** from
  `f87790cf69e66261a2271c2056bd5bcd06ff666a`, with matching standalone
  AgentsServer **1.0.4-beta.2** from
  `dfc05e997b7c97b366c87400f35e4c640f8f2f85`.
- Remove shared API-key sign-in from Settings and every desktop transport
  layer. Normal Codex account status is read-only. The matching server rejects
  the legacy login route before accessing the account manager, including
  requests from older clients. This prevents Settings from overwriting the
  credentials used by ordinary Codex chats and the CLI.
- Keep one explicit Custom endpoint flow: enter URL/model/key, Test, then
  Save. Explain that a new chat must select **Codex · Custom endpoint**.
  Normal account-status failures no longer block endpoint configuration.
- Reproduce the original shared-login call in a disposable native runtime.
  Exercise the corrected Settings with native mouse/keyboard input through
  the full production server module and actual Codex process against a
  controlled Responses service. Verify failed tests and retry, exact URL/model
  persistence, invalidated tests after edits, busy-save rejection, Remove,
  account-status failure recovery and legacy-route rejection. Confirm zero
  native login calls and unchanged ordinary account state.
- Verify simultaneous normal/custom native threads and follow-ups retain
  separate credentials and models. Inspect the packaged renderer/preload and
  all 88 compiled files; the removed shared-login paths are absent. UI fixtures
  use disposable profiles and controlled endpoints; production background
  lifecycle and a live external provider account are not claimed by these checks.
- Pass focused regressions, TypeScript and production compilation. The macOS
  release run passes 4,528 tests (10 skipped), universal signature/notarization,
  DMG/ZIP parity and clean executable launch. Linux x64/arm64 and Windows x64
  packaging and native launch checks also pass. Windows remains an explicitly
  approved unsigned preview.
- Publish the verified desktop packages to the canonical and legacy Beta
  feeds with identical assets and checksum manifests. Independent publication
  checks verify every platform again and confirm public Beta discovery.
  Matching signed server artifacts are published; the managed server update
  is queued for idle installation without interrupting active work.
- Releases: [desktop beta.2](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.4-beta.2)
  and [server beta.2](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.4-beta.2).

## 2026-09-17 — Per-chat native Codex endpoint selection (beta candidate)

- Accept local desktop **1.0.4-beta.1 / 1175** from `59451a6` and matching
  standalone server **1.0.4-beta.1** from `46d72a4a`. Stamp only the desktop
  package metadata in the clean build snapshot; verify all 88 compiled files
  byte-for-byte, ARM64 Developer ID signature and disabled local updater.
  The server archive matches all 85 allowlisted source files and its checksum.
- Add **Codex · Custom endpoint** beside ordinary Codex in the composer and
  New chat. Configure its base URL, exact model and separate masked key in
  Settings; test explicitly before saving. Ordinary Codex sign-in remains
  available and existing chats retain their original provider.
- Persist the choice per chat and reject unsupported older servers before
  they can silently ignore it or replace a global provider. Started chats
  cannot switch providers. Custom readiness does not require ordinary OpenAI
  sign-in; removing the endpoint leaves custom chats unavailable, not rerouted.
- Run a real native Codex manager with simultaneous normal/custom threads and
  repeated follow-ups against two controlled Responses endpoints. Verify
  separate credentials/models, unchanged process defaults and no tool calls,
  external requests or production account/history changes. The earlier real
  gateway probe verifies the configured native protocol separately.
- Add no polling, automatic model requests or per-keystroke network work.
  Focused transport, renderer, persistence and provider-isolation checks pass.
  Scheduled jobs use the same provider-specific readiness and label.
- Exercise native offscreen mouse/keyboard input through the production
  picker, New chat and Settings, real preload/main HTTP transport and extracted
  production session routes/store. Verify Save, default/custom switching,
  persisted selection, locked-thread rejection, older-server refusal and no
  typing/idle requests. Inspect light/dark narrow layouts. Full application
  bootstrap/cache/profile lifecycle remain fixture boundaries; packaged
  production-profile startup is not claimed.
- The clean-source package pass has 4,539 desktop tests passing (10 skipped),
  TypeScript and production compilation. The clean standalone snapshot passes
  175 focused tests and the real same-manager native provider check. These are
  local test candidates, not published/notarized releases; no installed app,
  production server or active chat was replaced or restarted.

## 2026-09-17 — Native Codex custom endpoint controls (source only)

- Add endpoint base URL, exact model ID and a masked provider key to Codex
  account settings, with explicit Test connection, Save and reset actions.
  Test uses native Codex Responses behavior rather than a replacement agent.
- Keep provider credentials separate from normal Codex sign-in. Require a
  successful test of the current form before saving; invalidate it on edits
  and fence late responses by server/profile generation. Never reuse a saved
  key for a newly entered endpoint or show raw provider errors.
- Add no polling, per-keystroke requests or automatic retries. Test does not
  save configuration; Save/reset reconcile runtime readiness once.
- Exercise native offscreen Electron Settings navigation and the real
  renderer/preload/service/HTTP/router/native Codex path against a controlled
  Responses endpoint. Verify failed tests and retries, unchanged unsaved
  configuration, stale-result invalidation, busy/authorization failures,
  save/reset, missing-credential recovery and narrow localized themes.
- Full profile bootstrap, account status and runtime refresh callbacks remain
  fixture boundaries in UI acceptance; isolated tests cover admission and
  readiness reconciliation. A separate authorized probe also completes a
  native Codex response against a real external Responses gateway with its
  exact model ID. That verifies a small model request, not every tool or
  billing capability. Requires matching standalone server endpoints. No
  release, production deployment or existing account change is included.
- Full desktop tests, TypeScript and production compilation pass after the
  recovery changes. The standalone server's selective source snapshot passes
  its focused authentication, provider, side-chat and manifest regressions.

## 2026-09-17 — Native Codex API-key authentication (source only)

- Add Settings → Codex account with masked API-key sign-in, account status and
  an explicit Recheck action. Explain server-wide account scope, native Codex
  credential storage and separate API billing. Support English and Chinese.
- Use the installed Codex app-server's native account API through the selected
  server's operator-only HTTP endpoint. Do not replace Codex with a model API
  client or put credentials into settings, histories, logs or command arguments.
- Clear credentials on submit, cancel, close and server switch. Fence requests
  by profile/generation, reject redirects and use fixed secret-free errors.
  Add no polling, automatic login retries or per-keystroke network activity.
- Preserve active/queued Codex work during authentication changes. Refresh
  runtime readiness once after a successful save, including same-timestamp
  health records and a pre-login probe that was already in flight.
- Exercise the real UI with native offscreen Electron keyboard/mouse input,
  production preload, scoped service methods, native HTTP, server authorization
  and the actual Codex process using synthetic credentials in an ephemeral
  store. Verify save/recheck/repeat, busy and permission failures, stale replies,
  clearing secrets, idle traffic and narrow light/dark localized layouts.
- Full Settings/profile bootstrap and runtime-catalog behavior remain isolated
  fixture boundaries in UI acceptance; focused service tests cover readiness
  reconciliation. TypeScript, production compilation and desktop regressions
  pass. Native credential acceptance alone is not a live model/billing test.
- Requires matching standalone server authentication endpoints. Availability
  is source only: no public release, production deployment or account switch.

## 2026-09-17 — Native provider side conversations (local build)

- Build **1.0.3-local.1174 / 1174** from `36ba482`. Verify all 88 compiled
  payload files, ARM64 Developer ID signature and local-only updater marker.
- Place Side chat below Media & files, after Subagents, within one inspector.
  Verify expanded/collapsed media and narrow/light/dark native Electron layouts.
- Replace visible-text snapshots with native context: a persistent ephemeral
  Codex fork, or Claude's native side-question control used by `/btw`. Include
  provider tool results without injecting a new message into the main chat.
- Keep follow-up identity and history on the server. Clear closes only the
  selected side conversation; late requests cannot recreate it. Profile/chat
  ownership, cancellation and provider-generation fences protect the main task.
  No polling or per-keystroke network work is added.
- Require the matching native-context server capability. Do not silently fall
  back to a copied transcript on an older server or incompatible provider.
- Real disposable-provider checks cover hidden tool-result recall, follow-ups,
  cancellation while the main request runs, unchanged parent history/goals and
  Claude cold resume without a main query. Focused transport and lifecycle
  regressions cover cancellation, duplicate requests, expiry and cleanup races.
- Exercise native offscreen Electron mouse/keyboard input through production
  preload, native HTTP authorization, router, provider binding and Claude SDK
  manager into a real authenticated Claude provider. Verify first answer,
  follow-up, cancellation, Clear/new conversation and continued main work.
  Both provider adapters also pass real disposable-provider checks; synthetic
  full-boundary UI fixtures cover both providers. Session store/SDK option
  construction and full app-profile bootstrap remain fixture boundaries.
- TypeScript, production compilation and the clean-source desktop suite pass
  (4,412 tests, 10 skipped). Matching standalone server source is `39e59aad`.
  Packaged startup is not exercised; payload/signature validation does not
  claim an installed production-profile test. No server deployment, publication
  or replacement of the running app is included.

## 2026-09-17 — Side chat in the shared inspector (local only)

- Build **1.0.3-local.1173 / 1173** from `85471ed`. Verify the ARM64
  Developer ID signature, local-only updater marker and exact compiled payload
  against the accepted source. Do not replace the installed app or publish.
- Place Side chat directly below Subagents in the existing inspector scroll;
  remove its separate tab and nested inspector landmark. Keep Review available.
- Preserve per-chat drafts, replies and pending requests across panel/review
  navigation. Only the explicit Side chat shortcut focuses the composer;
  merely opening the inspector cannot steal main-chat input focus.
- Validate focused component/App regressions and TypeScript. Exercise the
  production Inspector and Side chat with native offscreen Electron input in
  light/dark and narrow layouts, using synthetic sessions and provider replies.
  This is layout/interaction acceptance; transport and providers are unchanged.
- Catch and correct a narrow-window clipping case by revealing the complete
  composer rather than only its textarea. Verify long-history wheel scrolling,
  localization and no extra transport/global-store writes while typing.
- The final package pass has 4,387 tests passing, 10 skipped. One earlier run
  encountered an intermittent pre-existing Team Network address-label timing
  assertion; its focused rerun and final full run pass without changing that
  feature. Package startup and live-provider behavior are not retested here.
- Prepare a local desktop package only. No publication, server update or
  replacement of the running application is part of this change.

## 2026-09-17 — Desktop 1.0.3 stable accepted

- Publish [AgentsDock 1.0.3](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.3),
  build **1172**, from `fa5d815118c28a1c18fa6d9afc3cc77f7d089fff`.
  Include Workspace Changes, native Side chat transport correction and the
  small 9px sidebar app-version label. Matching AgentsServer 1.0.3 is published
  for Git controls and the Codex Side chat startup correction.
- Preparation `35277907016` and publication `35279799800` pass all four
  platform gates. macOS is Developer ID signed and notarized; Windows retains
  the approved unsigned policy. Verify the exact downloaded universal Mac
  package's 1.0.3/build 1172 metadata, signature, notarization, public Stable
  update feed, bundled feature code and version typography.
- Verify identical 14-asset public and legacy releases, the pinned source tag,
  sealed checksums and fresh public updater metadata for every platform.
  Checksum-manifest SHA-256:
  `6ede115f1bceb8acbfcb37cb951b3bc10753582051db378f57913a945b44f39a`.
- Native offscreen interaction covers Sidebar themes/widths, real-repository
  Changes workflows through the production client/server boundary, and real
  provider Side chat answers, follow-ups and cancellation. A disposable Codex
  overlap check confirms cancelling the side turn leaves its separate test
  main turn active through normal completion. Official package clean-start
  checks run on disposable CI machines; local native fixtures do not claim a
  full packaged production-profile Changes journey.
- Preserve concurrent uncommitted work. Publication does not replace the
  user's running app, install on another machine, or restart either server.

## 2026-09-17 — Quiet sidebar version label (unreleased)

- Keep the installed app version beside the brand at a small, muted 9px size;
  preserve the title and control layout and keep the full version in its tooltip.
- Check production Sidebar rendering in isolated offscreen Electron at narrow
  and normal sidebar widths, light and dark themes. Verify no title/control
  overlap, working keyboard navigation, one local metadata read and no network
  requests. This is renderer acceptance, not packaged-release acceptance.

## 2026-09-17 — Workspace Changes first cut (unreleased)

- Add a lazy Changes workspace tab for repository-wide staged, unstaged,
  untracked and conflicted files, on-demand diffs, whole-file staging,
  staged-set commit review, and text conflict resolution. Continue reports
  further conflicts honestly; abort requires explicit confirmation.
- Use native operator-only, profile-scoped requests and repository revisions.
  Preserve conflict drafts on stale writes, reject late responses from another
  workspace, and add no polling or per-keystroke Git requests.
- Exercise production workspace entry/renderer, preload, HTTP client, server
  Git router and native authorization with mouse/keyboard in isolated offscreen
  Electron against disposable real repositories. Verify actual commits/index,
  stale stage and resolution rejection, merge completion, confirmed abort,
  tab switching/closing, light/dark and narrow views, and zero idle requests.
  Session lookup and app-shell context are fixtures; full installed-app startup
  and production-profile acceptance are not claimed.
- Validate focused desktop regressions, TypeScript and production compilation.
  This feature needs the matching standalone server Git endpoints. PR/MR,
  push and branch creation remain outside this first cut. Not published,
  installed or deployed; existing applications and research jobs remain intact.

## 2026-09-17 — Desktop 1.0.3 acceptance checkpoint (not published)

- Validate clean source `f387a1ac874ab3e153a648bd53e42bf4347ae4e4` with TypeScript,
  production compilation, 4,369 passing desktop tests (10 skipped) and eight
  package/license guards. Keep unrelated working-tree changes out of the pin.
- Exercise Side chat with native Electron input, production preload IPC,
  request ownership and HTTP client, the unchanged server authorization/router,
  and a real Claude provider. First answer, contextual follow-up and cancellation
  pass; the old generic transport reproduces 403. Session context and the main
  task are synthetic: this does not validate a concurrent live main agent or
  full production profile bootstrap.
- The equivalent real Codex check uncovers a separate server adapter startup
  failure before a thread starts: fresh temporary state indexes existing
  provider history synchronously and initialization times out. Do not classify
  that as an app authentication failure or extend deadlines to hide the work.
- Hold publication pending the known Codex limitation and release decision.
  No installed app or production server was replaced or restarted.

## 2026-09-17 — Desktop 1.0.3 side-chat transport and visible versions

- Correct side-question POST and cancellation to use the existing native HTTP
  transport. Generic fetch added a browser-style header that the server's
  native-only authorization rejects. Preserve the authentication boundary,
  response ownership, follow-up history, cancellation and timeout behavior.
- Replace mock-only HTTP checks with loopback wire checks reproducing the 403
  and exercising the corrected requests, redirects and cancellation.
- Show the app version and selected server version in the sidebar using local
  app status and scoped server metadata, without polling. Validate light/dark,
  narrow layout and server switching in an isolated native Electron renderer.
- Add the app development operational manual to the repository rules, requiring
  hands-on workflows and explicit accounting for real versus mocked boundaries.
- These desktop changes do not require a matching server update. Source
  preparation and focused checks are not publication or live-provider acceptance;
  record those separately when completed.

## 2026-09-17 — Desktop 1.0.2 stable accepted

- Publish [AgentsDock 1.0.2](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.2),
  build **1170**, from `94659a201581a2adf1f0938f157e519a859e1459`.
  The public and legacy repositories carry identical sets of 14 release assets
  and Stable updater metadata. Preserve unrelated uncommitted work.
- Native release preparation `35195524801` and publication `35197194846` pass
  all platform gates. macOS universal is Developer ID signed and notarized;
  Linux x64/arm64 and the explicitly unsigned Windows x64 installer are verified.
- Validate the exact committed desktop source with TypeScript, production
  compilation, 4,360 desktop tests (10 skipped) and eight package/license guards.
  Deterministic regressions cover both first-click races found by the initial
  native release attempt; the failed candidate was never published.
- Inspect the actual isolated Electron recovery dialog and full Team Network
  surface in light/dark and wide/narrow layouts. Verify cancel/focus, wrong-host
  errors, offline-to-workspace recovery and no typing-triggered requests or
  global store writes. Synthetic endpoints never mutate live networks.
- Pair with the published standalone AgentsServer 1.0.2 recovery contract.
  Members must update their own server and explicitly change a moved host's
  saved address; publication does not migrate addresses or restart services.

## 2026-09-17 — Preserve the first recovery and attachment click

- Native release checks expose a commit/passive-effect ordering race: a late
  identity reset can close the freshly opened host-address dialog or invalidate
  the first explicit attachment preview request.
- Reset only these identity-bound local states in layout effects, before the
  controls can be used. Preserve the existing stale-request fences and exact
  dependencies; add no timers, polling or per-keystroke work.
- Add deterministic commit-phase click regressions. Both reproduce the old
  failure and pass after the correction; all 300 affected renderer tests and
  TypeScript checks pass. Rebuild the held desktop 1.0.2 source rather than
  publishing the failed candidate or weakening its tests.

## 2026-09-17 — Desktop 1.0.2 endpoint recovery prepared

- Add a single Change host address action for the current Team Network and
  saved approved connections, including offline members. Reuse one localized
  dialog with the previous address prefilled; preserve approval and routes.
- Require the additive member-side AgentsServer 1.0.2 capability. Verify the
  exact local server instance, saved connection and remote trust before a
  write; reject stale replies and leave inactive connections inactive.
- Retire old authenticated state only when a validated write begins, then
  revalidate the current connection once. A lost write response permits one
  status check, not a repeated mutation. Add no polling or per-keystroke work.
- Inspect the actual isolated Electron actions and dialog in light/dark,
  wide/narrow, error, pending and unsupported-server states. Exercise explicit
  save/cancel and confirm typing makes no global store writes. These UI checks
  use synthetic endpoints and cannot mutate real Team Networks.
- Prepare stable notes against desktop 1.0.1. The release also includes the
  committed independent Side chat, indexed Mail/Bulletin search, visible
  changed-file summaries and quiet syncing status. Unrelated unfinished
  changes remain excluded. Publication acceptance is recorded separately.

## 2026-09-16 — Local desktop 1.0.1 build 1170 accepted

- Package committed source `7f116b2` as an Apple Silicon local desktop build
  with the Details / Side chat inspector layout, independent follow-ups and
  retained drafts. Exclude unrelated unfinished worktree changes.
- Validate full desktop tests, type checks, production compilation and package
  guards. Confirm all 86 compiled files match the packaged archive and the
  Developer ID signature verifies; keep local auto-updates disabled.
- Exercise the actual isolated Electron panel in light/dark and wide/narrow
  layouts, including follow-ups, hide/reopen, cancellation and stale replies.
  Provider responses are mocked in these UI checks, not live model runs.
- Prepare the matching standalone server `1.0.1-beta.2` package. Side chat needs
  that server capability installed; neither server deployment, publication nor
  replacement of the running desktop application is part of this local build.

## 2026-09-16 — Side chat in the inspector dock

- Replace the temporary question dialog with a full-height Side chat tab next
  to Details. A labeled chat-header action opens and focuses it directly,
  leaving the main conversation visible and usable.
- Keep per-chat drafts and side answers in memory when the dock is hidden or
  Details is selected. Follow-ups carry only the side conversation's bounded
  completed question/answer pairs; Clear and Cancel affect only Side chat.
- Keep typing local and introduce no polling, main timeline subscription or
  normal chat turn. Fence in-flight work by server profile, generation, chat
  and request identity; unsupported servers explain the missing capability.
- Pair with the standalone server's additive side-history support. Packaging
  does not install, publish or restart either running application or server.

## 2026-09-15 — Independent side questions (unreleased)

- Add a localized Side question entry for Codex and Claude chats. Questions and
  answers stay in a temporary panel, with independent cancellation and explicit
  context limits; they never become a normal prompt, queued turn or goal steer.
- Use one request per question, with no polling or event subscriptions. Fence
  answers and cancellation by server profile, generation, chat and request ID;
  discard stale replies when a panel closes or the user changes chats/servers.
- Require the additive standalone server capability. Older servers explain the
  missing support instead of silently forwarding a question to the main agent.
- Validate request/cancellation races and the actual renderer in light/dark,
  wide/narrow, keyboard focus, pending, answer, error and localized states.
  No installed application replacement, server restart or publication.
- Guard cross-chat Markdown whitespace and preserve the exact sent body. The
  standalone sender guidance discourages joining words and technical values;
  historical text is not rewritten by speculative spacing corrections.

## 2026-09-15 — Keep file changes visible outside collapsed progress (unreleased)

- Keep known changed-file summaries and Review accessible when a turn's progress
  is collapsed. Show a compact filename list with aggregate line counts while
  leaving full diffs and tool activity behind their existing disclosures.
- Reuse recorded diff metadata without fetching activity or parsing arbitrary
  tool output on chat open. Keep scheduled-job summaries single-rendered.
- Validate completed and live-to-completed turns, collapse/expand, exact Review
  targets and scheduled-run identity. Check actual renderer layouts in light
  and dark themes at wide and narrow sizes with network access disabled.
  Type checks, desktop regressions and production compilation pass.
- Desktop-only presentation change; no polling, provider runs, server update,
  publication or running-app replacement.

## 2026-09-15 — Local desktop 1.0.1 build 1169 accepted

- Package committed source `9ca56af` as an Apple Silicon local desktop build,
  including explicit Mail/Bulletin search and the quiet synchronization status.
  Exclude unrelated unfinished worktree changes.
- Verify TypeScript, desktop regressions, compile/license guards and production
  compilation. Confirm all 86 compiled files match the packaged archive, the
  hardened Electron bundle passes its audit, and the Developer ID signature
  verifies. Keep local auto-updates disabled.
- No publication, running-app replacement or server deployment. Indexed search
  still requires the matching standalone server update; the synchronization
  status change works without it.

## 2026-09-15 — Quiet chat synchronization status (unreleased)

- Replace the uncertain incoming-delivery warning during chat synchronization
  with a muted “Syncing…” status. Keep known incoming-delivery notices and
  explicit Stop/Send now confirmations unchanged. This is a desktop-only
  presentation change with no new requests, subscriptions or server changes.

## 2026-09-15 — Indexed Mail and Bulletin search (unreleased)

- Add explicit Search/Enter and Clear controls to Inbox, Sent and Bulletin.
  Search current subjects, message contents and sender names across accessible
  history, with indexed server queries and explicit result pagination. Typing
  stays local; no polling, timers or per-keystroke requests are introduced.
- Keep filtered results separate from ordinary snapshots, unread counts and
  notification acknowledgements. Fence old-query and old-connection results;
  preserve route, read, edit and delete behavior for individual results.
- Capability-gate the feature on the matching standalone server contract and
  migration. Older hosts retain ordinary Mail with an update explanation.
  See [Mail search](TEAM_MAIL_SEARCH.md) for compatibility and migration notes.
- Validate renderer, IPC, direct and secure-peer paths, pagination, stale
  responses, notification isolation and current-content indexing. The actual
  renderer passes eight isolated light/dark and wide/narrow journeys: typing
  and idle issue no requests; Enter searches, open/back retains the query, and
  Clear restores the normal list. Type checks and production compilation pass.
  No published artifact, installed app or running server is changed.

## 2026-09-15 — Desktop 1.0.1 accepted

- Published stable [AgentsDock 1.0.1](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.1),
  build `1168`, from reviewed source `9a13649eb5a8f01d83c4c33b8bd3af3a70163cda`.
  Includes member self-rename, durable join observation and force-update
  confirmation recovery. See [release notes](RELEASE_1.0.1.md).
- All four native build and package gates passed, followed by independent
  package replay before publication. macOS is universal, Developer ID signed,
  notarized and Gatekeeper-accepted. Windows remains unsigned under the
  release owner's standing distribution policy; its status is explicit in
  both public release listings.
- The canonical and legacy repositories publish the same fourteen artifacts.
  Both stable update feeds resolve to `1.0.1` for macOS, Linux x64, Linux arm64
  and Windows. The sealed checksum manifest's SHA-256 is
  `b1fcdc86950f190891ee6c0ea4e9bd1fd8a4495886b821362ed270d6e5250b58`;
  the verified Mac update ZIP is
  `c0649157f5f31a7b9cea37f447f7a3e465666d3f5a4f5a057b764353f01dbfc9`.
- Confirmed the downloaded Mac package contains the member-rename renderer,
  preload and main-process implementation. No installed app, live server,
  mobile distribution or unrelated worktree change was included.

## 2026-09-15 — Member self-rename, desktop 1.0.1 candidate

- Committed member self-rename in `ee277b162b34a341d2d771e92bea2697342bcc3e`.
  The owned member's directory menu now offers Rename. Saving changes its Team
  Network display and recipient names in place, without changing its host role,
  peer identity, connection or local profile label. Other members remain
  protected; stale identities and mismatched receipts are rejected.
- Verified the real paired-service principal, whose identity is distinct from
  its directory node, along with legacy node-shaped sessions. The existing
  published server API passes isolated self-rename, read-only, reprovision,
  current-mention and new-mail-label checks; no server changes were required.
- A clean archive of the committed source passes TypeScript, 4,218 desktop
  tests (10 platform/intentional skips), eight compile/license guards and
  production compilation. The actual renderer passes isolated offscreen
  dark/light and narrow-layout checks for Save, Cancel and editable failures;
  saving preserves row identity and adds no polling or role-switch operation.
- Release notes are prepared in [RELEASE_1.0.1.md](RELEASE_1.0.1.md). Native
  release packaging and publication remain pending per-release Windows signing
  approval. This is not yet an accepted or published application package.
  No installed app or live server was changed.

## 2026-09-15 — Durable team join waiting (unreleased)

- Keep one automatic-join observer attached across long HTTP observation
  windows when the server confirms a durable pending approval or activation.
  Renew only the same held read, with unchanged request, transcript, server and
  cancellation fences. Reject early responses instead of creating a hot retry
  loop; do not add inbox polling, repeated Join requests or UI refresh timers.
- Make legacy expired incoming requests discoverable in a collapsed section,
  separate from pending approvals and without approval controls. A replacement
  request hides the stale attempt. New non-expiring joins require the matching
  standalone server change on both host and joining server.
- Accepted locally: 600 focused desktop checks, type checks, production
  compilation and compile-output verification. Inspect the real host panel
  offscreen at narrow width in light and dark themes, including expired and
  replacement requests; no overflow, new network calls or approval mutations.
  No package, installation, publication or live server restart performed.

## 2026-09-14 — Force-update status recovery (unreleased)

- Recover from a force-update confirmation refused because the queued update
  changed while the confirmation was open. Read status once; never retry a
  restart or update automatically. Follow an already-started update only when
  its schedule, target and track match the approved reservation.
- Show actual installer/preflight failures instead of a stale confirmation
  error. If status cannot be verified, re-enable Check server. Clear only the
  handled recovery notice after a successful check or server-scope change;
  preserve unrelated failures and ignore responses from an old server/boot.
- Support the existing beta.8 response, including bridges that preserve only
  its error prose. No server contract change or background polling is added.
- Validate focused confirmation-race and recovery regressions, the full desktop
  suite, type checks, production compilation and compile/license guards. Inspect
  the actual Settings dialog in isolated offscreen Electron in both themes,
  covering install progress, preflight failure and manual-check recovery.
- Source fix only: no new package, publication, installation or live restart.

## 2026-09-14 — Desktop 1.0.0 replacement accepted

- Published desktop `1.0.0`, build `1167`, from committed source
  `45eb06c9db69cf0afad0fe8a1a38cf0823f1c035`. The canonical release is
  [AgentsDock v1.0.0](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.0).
  This includes the native subagent setting and corrected untitled-child
  headings. The separate server history-proof correction requires the rebuilt
  standalone server; installing the desktop alone does not repair server imports.
- The explicitly approved same-version replacement preserves a verified backup
  of the withdrawn package. Existing `1.0.0` installations need a manual
  download/reinstall; same-version automatic discovery is not claimed.
- All four native package gates pass. macOS is universal, Developer ID signed,
  notarized and Gatekeeper-verified; Linux x64/arm64 and Windows x64 artifacts
  pass their package and launch checks. Windows remains an explicitly approved
  unsigned preview. The platform source suites pass: 4,130 checks on macOS and
  each Linux architecture, and 4,094 on Windows, with platform-specific skips.
- Both public repositories contain the same fourteen sealed artifacts. All
  eight public update-metadata files match the accepted replacement bytes.
  GitHub permanently retired the deleted immutable legacy `v1.0.0` tag, so the
  [legacy compatibility mirror](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/1.0.0)
  uses the exact tag `1.0.0`. App versions, package filenames, signatures and
  canonical `v1.0.0` are unchanged; the frozen legacy tag was not modified.
- Actual native updates from Stable `0.2.12` and Beta `1.0.0-beta.2` both install
  the new `1.0.0` ZIP, whose SHA-256 is
  `f6914dfc7cba0ab9d762e0185c41e948a98709afb87bf113b091c3abcab919c2`.
  Real UI download/install and native replacement/relaunch pass; each journey
  retains its profile, language and original channel, then checks the canonical
  feed. Final UI screenshots were reviewed. Validation used disposable CI
  profiles, not live user apps or servers.

## 2026-09-14 — Partial-page cross-chat replay regression

- Reproduce two old, owned async deliveries reimported as provider user text.
  Full-history desktop projection can correlate the original receipts; a
  recent-only page cannot establish that proof locally.
- Add regression coverage for the server's existing source-proven replay
  marker on recent-only pages, stale cache merges, older-page overlap and a
  genuinely user-authored quotation. Original agent messages and answers keep
  their positions. This adds no desktop runtime change or background polling;
  the correction requires the rebuilt standalone server package.

## 2026-09-14 — Untitled subagent headings

- Correct the inspector fallback for native children without an explicit
  title: show a readable task/path heading and retain the provider nickname
  underneath. Explicit titles, child identities, ordering and selected output
  remain unchanged; no polling or provider-state writes are added.
- Regression cases reproduce the former nickname-first behavior and cover
  null/omitted titles, title clearing, legacy identity fields, locale changes,
  separator-only tasks and sixteen simultaneously active children.
- Inspect the actual inspector in isolated offscreen Electron at narrow width
  in light and dark themes, including completed children and open output.
- Prepare an explicitly approved replacement desktop 1.0.0, not a version
  bump. Existing 1.0.0 installations need a manual reinstall to receive it.
  The desktop naming correction is separate from the rebuilt server's
  history-proof correction. Package and publication acceptance is recorded above.

## 2026-09-14 — Local subagent-settings build accepted

- Accepted Apple Silicon local `1.0.0-beta.2`, build `1165`, from committed
  source `a1ef7b0f6314b74c1244d8504f9643099fbf3eb7`. This supersedes local
  build `1164` with caller-bound server selection for settings requests.
- Type checks, focused native HTTP/service scope tests, production compilation,
  and the full desktop suite pass. One existing secure-peer cancellation test
  failed in the initial concurrent full run, then passed independently and in
  the full rerun; its source was not changed in this work.
- Isolated offscreen Electron validation covers light/dark narrow layouts,
  local typing, save/disabled states, compatibility hints and profile-switch
  races. It does not launch the production app or access a live server.
- All 86 packaged compiled files match validated output. Developer ID signature,
  hardened runtime, entitlements, fuses and packaged version checks pass.
  Existing app bundles are preserved; this package is not installed, notarized
  or publicly released, and local automatic updates are disabled.
- The control requires standalone server `1.0.0-beta.8`. Publishing that server
  is separate from updating a live installation; no live runs are interrupted.

## 2026-09-14 — Native Codex subagent setting

- Add Codex subagent limit to desktop Settings > Server. A positive integer
  sets the server's native provider override; clearing it uses Codex's default,
  not an unlimited sentinel. The main agent is excluded from this count.
- Read on opening the settings page and write only on Save. No polling,
  keystroke requests, chat-state writes or provider restarts are introduced.
- Show when an older server, non-admin connection or legacy exec transport
  cannot change the setting. Preserve drafts on failed saves and ignore stale
  replies after switching servers. Explain new/reloaded-thread scope and
  chat-specific override precedence; provide English and Chinese labels.
- Bind settings reads and writes to the server selection displayed by the
  renderer, checking it before dispatch as well as after the response. A stale
  screen cannot send its old draft to a newly selected server.
- Use exact native-admin GET/PUT transport with request validation. Real
  loopback transport and service-scope checks cover token framing, reset,
  errors and profile races; component checks cover local editing and no polls.
- Requires AgentsServer 1.0.0-beta.8 for the setting. That server release also
  fixes plain goal steering with automatically attached saved chat routes;
  the active goal's owner and existing permissions remain unchanged.

## 2026-09-14 — Project licensing

- Add the Apache License 2.0 and project attribution notice. Preserve existing
  Expo, SwiftTerm, native-module, and other third-party licensing terms.
- Document licensing in the README and contribution guide, and declare it in
  first-party desktop, mobile, website, and Team Hub package metadata.
- Include the project LICENSE and NOTICE in future Electron packages. Existing
  published artifacts and tags are unchanged; no release is cut by this change.
- Validate the canonical license text, package metadata, preserved component
  licenses, and Electron's actual resource-copy behavior with focused checks.

## 2026-09-13 — Local live-activity build

- Accepted local-only Apple Silicon `1.0.0-beta.2`, build `1163`, from
  `f76c1f4087d855924a4498f831d8c30e05b8ac0b`, including live activity freshness,
  quiet-run/compaction indicators and native Codex subagent display names.
- Type checks, the full desktop suite, production compilation and isolated
  light/dark renderer journeys pass. All 86 packaged compiled files match the
  validated output; strict Developer ID signature, entitlements and fuse checks
  pass. Existing app bundles were preserved.
- This local app has automatic updates disabled and is not notarized or
  published. It was not launched or installed over a running app.
- Source-proven duplicate answers and leaked native wake imports still require
  the matching standalone server update; this app alone cannot fix the older
  server's history reconciliation.

## 2026-09-13 — Live activity and mailbox replay

- Preserve newer streamed run ownership when an older health request finishes
  late. Connection-only notifications do not replace live activity with cached
  health. Fresh idle health can still settle a run whose terminal was missed.
- Show a compact Working indicator when an owned run has no visible trace yet,
  including a quiet mailbox wake. Show Compacting context during live compaction
  and animate the Running header; completed and historical views stay settled.
- Keep activity reconciliation local and scoped to the connected server. No
  polling, provider requests, synthetic chat messages or minimap rows are added.
- The separate large-history server correction also suppresses source-proven
  duplicate answers imported after mailbox wakes, retaining the original answer,
  peer deliveries and real human messages. It requires a server update.
- Type checks, the full desktop suite and production compilation pass. Isolated
  full-renderer checks cover quiet wake, live compaction, resumed progress and
  actual completion in both themes, with stable timeline geometry and no added
  user messages. The duplicate correction was also checked against source-proven
  native/import pairs without changing stored transcripts or message delivery.
- No installed app, running server or published release has been changed in
  this pass.

## 2026-09-13 — Codex subagent display names

- Show the explicit Codex child-thread title before its nickname, task or path
  fallback. Names stay literal in every locale. Nicknames and paths remain
  available in details; no names are generated from prompts.
- Accept optional `subagent_title` snapshots from the standalone server's
  existing thread metadata and name-update stream. Omitted or malformed fields
  retain the known title; explicit clearing restores the existing fallback.
- Keep one stable child row and update an already-open output panel's title in
  place. Naming does not introduce polling, new provider requests or UI timers.
- Desktop type checks, production compilation, the full suite and focused
  rename/clear/lifecycle regressions pass. Isolated full-renderer checks cover
  dark/light and narrow layouts, including renaming and clearing a title while
  the output panel stays open. The change requires the matching
  standalone server update to supply explicit titles. No installed application,
  running server or published release has been changed.

## 2026-09-13 — Large-history cron and mailbox replay correction

- Correct the standalone server's native-history proof path for large chats.
  Tool-heavy logs no longer bypass duplicate checks at a total-file-size limit.
  Incomplete or cancelled proof defers import without advancing its cursor.
- Existing desktop projection keeps the original scheduled-job group and purple
  mailbox delivery while suppressing only source-proven imported copies. Genuine
  human messages remain intact, including identical quoted text.
- Add a combined desktop regression fixture covering interior same-ID repairs,
  stale event replay, overlapping older pages and SQLite reopen. Type checks and
  focused tests pass. Isolated full-renderer checks verify the read receipt,
  chronology, chat reopen and renderer reload in light and dark themes.
- This requires a server update; no desktop runtime change, package, deployment
  or release was made. Delivery, wake behavior, jobs and provider transcripts are
  unchanged. No polling or per-event filesystem reads were added.

## 2026-09-13 — Video playback in shared chats

- Interactive shares now reuse the existing chat video thumbnails and player
  for videos attached to sent messages or explicitly published by the agent.
  View only snapshots include native video players for those captured videos.
- The matching standalone server provides token-checked playback and seeking
  for the exact shared chat. Unused uploads, unrelated files and workspace paths
  remain inaccessible. Revocation checks are demand-driven; no polling or extra
  stored video copies were added.
- Preserve native event identities and chronology through current, historical
  and trace views. Unsupported native file actions stay hidden in shared mode;
  the normal desktop file controls are unchanged.
- Desktop type checks, focused media/bridge tests, the full desktop suite and
  production compilation pass. Isolated server checks cover ownership, token
  entry, byte ranges, revocation, file mutation and cancellation cleanup.
- Isolated browser acceptance passed for an uploaded WebM and a distinct
  agent-published H.264 MP4 in both viewers: decoded frames, playback, seeking,
  separate token entry and blocked media requests after revocation. Testing
  used synthetic chats and hidden browser windows, not live user sessions.
- This requires a server update, including the generated shared-web bundle.
  Existing Interactive links can be refreshed afterward; older text-only View
  only snapshots must be recreated to include videos. Browser codec support
  still applies. No desktop package, server deployment or release was made.

## 2026-09-13 — Choose a LAN address for chat sharing

- Add one localized Share address field to the existing View only / Interactive
  dialog, defaulting to the selected server connection. Operators may choose
  another reachable HTTP or HTTPS address of the same server when creating a
  share. Previously created links and tokens are unchanged.
- Keep share management and native credentials on the authenticated connection.
  The chosen browser address is validated body data, never a probe or a new
  credential destination. Creation remains one-shot; malformed or mismatched
  responses cannot silently produce a link at the wrong address.
- Editing stays local to the dialog, with no polling, address discovery or
  background refresh. The existing standalone server contract supports this
  client change without an update or restart.
- Accepted local-only Apple Silicon `1.0.0-beta.2`, build `1162`, from
  `b8a100ce75782d22edb9529d90811b5360d67a6d`. Desktop type checks, the full
  desktop suite, focused address/response regressions, and production
  compilation passed. All 151 packaged compile-output files match; bundle/fuse
  audit and strict Developer ID signature verification passed.
- Isolated offscreen renderer checks passed for both modes, light/dark themes,
  narrow layouts, localized labels, keyboard activation, invalid addresses,
  busy state, draft reset, and unchanged existing links. These used synthetic
  services; no real chat share or recipient connection was created for testing.
- This build is not notarized or published and has automatic updates disabled.
  The running app and servers were left untouched.

## 2026-09-13 — Local main integration build

- Accepted local-only Apple Silicon `1.0.0-beta.2`, build `1161`, from
  `bc73ab326c5a6fcc4a8425be41384faf9ec3ff1a`, which merges public main
  `935a76b64af2b2a7c263a15d91af87342dd88381` into the release branch.
- Include the local-chat import label correction while retaining the released
  Team Network changes. Scheduled-job controls remain in each row's context
  menu; this fetched main does not contain visible inline action buttons.
- Type checks, focused import/menu checks and production compilation passed.
  All 151 packaged compile-output files match the source build; bundle/fuse
  audit and strict Developer ID signature verification passed.
- This local build is not notarized or published and has automatic updates
  disabled. No running app, installed server or published artifact was replaced.

## 2026-09-13 — Published server goal-steering correction

- Published [AgentsServer `1.0.0-beta.4`](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.0-beta.4)
  from immutable source `b5fa0728ede6e99f228685f625198b5bdcde20a0`.
  The full release gate, downloaded signature, public asset digests and all
  76 packaged source files passed verification.
- Preserve active native Codex goals when steering during the initial turn or
  a continuation, including uploaded attachments and between-turn delivery.
  Keep one chronological follow-up across acknowledgement rollover and prevent
  stale-prompt recovery after accepted or uncertain steering. No polling added.
- Existing desktop `1.0.0-beta.2`, build `1160`, supports this server correction;
  there is no new desktop binary for the regression-only app changes below.
- An accepted idle deployment schedule is not a completed installation.
  Live-provider acceptance remains separate from the isolated protocol tests.
  Stable readiness also requires resolving the idle-goal mailbox-authority
  limitation and completing the stable-upgrade and platform acceptance gates.

## 2026-09-13 — Active-goal steering regression coverage

- Verify Send now and Cmd/Ctrl+Enter while a goal is active across a pending
  server response, acceptance and rejection. The goal and other queued work
  remain unchanged; retries cannot duplicate prompt submission or promotion.
- Confirm native goal follow-ups retain attachment rendering when reopened.
  These are renderer regression checks accompanying a standalone server fix;
  no desktop runtime change or new app build is required.
- Full Composer tests, focused goal timeline tests and desktop type checks pass.
  No app or server installation, deployment or publication is part of this change.

## 2026-09-13 — Published Team Network and cross-chat beta

- Accepted direct desktop `1.0.0-beta.2`, build `1160`, from the immutable
  source `516213ddb27b4fc641c418609a7667d14e391918`. Native build and package
  verification passed for universal macOS, Linux x64/ARM64 and Windows x64.
  macOS is signed and notarized; Windows remains an unsigned beta preview.
- Published the identical 14-asset set to the
  [public release](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.0-beta.2)
  and [legacy mirror](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.0.0-beta.2).
  Both match checksum-manifest SHA-256
  `6fa6cb2877d411ef423ef0c808a10286cd919f0acc5727c364e1de0620b5c445`.
  The protected publisher independently replayed all platform verifiers;
  publication recovery retained the original artifacts and source identity.
- Include quiet, separately tracked Mail and Bulletin indications through one
  metadata-only connection. Refresh stays explicit; arrivals do not fetch
  content, move the current view, interrupt an agent or change a draft.
  Bulletin edits retain version history, and incomplete refreshes cannot clear
  attention to unseen changes.
- The matching
  [AgentsServer `1.0.0-beta.3`](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.0-beta.3)
  fixes Chats provider-tool stdin replies and returns an original canceled
  receipt on exact retries without resending or waking the recipient. The
  complete server release gate, downloaded signature, exact source contents
  and older-updater compatibility passed. An app-only update does not apply
  the server corrections.
- The isolated full-desktop lifecycle journey passed 15 checkpoints using
  actual renderer, IPC and SQLite cache with synthetic transport: sent/read/
  replied messages, disconnect/backfill, reopening, single canceled-message
  identity, explicit Bulletin refresh, author edit/history/delete and scope
  retirement. A 1,000-hint burst preserved drafts, focus and scroll position
  without content requests. Real helper/TLS server journeys additionally
  covered access revocation, concurrent reads, late arrivals and idle wakes.
- No user's active provider run or live server was used for these checks.
  Publication did not install or restart either component. Stable and mobile
  channels are unchanged.

## 2026-09-13 — Quiet Team activity and cross-chat delivery regression

- Local, unreleased candidate: extend the existing single Mail notification
  connection with an independently tracked Bulletin cursor. Posts, revisions
  and deletions produce metadata-only hints; older servers retain Mail v1.
- Show quiet navigation indicators and explicit refresh affordances. Arrival
  never fetches content, navigates, interrupts an agent, or changes a draft.
  Main-process publications coalesce bursts, with no recurring idle timer;
  only small indicator components subscribe to pending state.
- A Bulletin refresh acknowledges the head captured before its complete fresh
  traversal. Partial, failed, cached or stale-scope loads cannot clear it, and
  an update arriving during refresh remains pending. Author-only, versioned
  Bulletin revisions remain supported.
- Add a cross-chat projection regression: an assistant's claim is not a send
  receipt. Actual registered/received events appear on both sides immediately,
  before recipient wake or read, without duplicate rows or repositioning.
  The matching standalone server corrects Chats provider-tool stdin handling;
  that fix and Bulletin v2 require a server update.
- Validation passed: TypeScript, the full desktop suite (3,972 tests passed,
  10 skipped), four compile-output guard tests, and production compilation.
  An isolated Electron UI journey checked dark/light and narrow Chinese
  layouts. A 200-hint burst caused no content/receipt requests or acknowledgments
  and preserved the draft node, text, focus and scroll container. Explicit
  refresh performed only the expected content requests and local acknowledgments.
- This source-change entry preceded release acceptance; see the published
  beta entry above. No live-server deployment is included.

## 2026-09-12 — Published 1.0 desktop migration bridge

- Published `1.0.0-beta.1`, build `1159`, from the exact reviewed source
  `885bfa9a382c734f7b66e9a2b6bb025333ba9d0a`. This is a beta migration bridge;
  stable `1.0.0` is not published.
- Native release builds and platform verification passed for universal macOS,
  Linux x64, Linux ARM64, and Windows x64. The macOS artifacts are Developer ID
  signed and notarized. Windows remains an explicitly unsigned beta preview,
  not a signed stable distribution.
- The release embeds the public AgentsDock desktop feed and preserves
  application identity, saved update-track preference, and explicit installation.
  Its Beta track can select a newer stable release without adding background
  polling or changing Team Network behavior.
- The exact 14-asset set is published in the
  [canonical public release](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.0-beta.1)
  and [legacy mirror](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.0.0-beta.1).
  Release API checks verified both releases' matching asset digests and sealed
  checksum-manifest identity. The source tag resolves to the reviewed commit above;
  checksum-manifest SHA-256 is
  `237bfd4ef1ed42fbe8e16b5549510eaea88a935296fa6b96903b5335486d169f`.
- The protected publisher replayed all four native platform verifiers and
  published the original sealed artifacts without rebuilding or replacing them.
  Canonical beta download links now point to the public source repository.
- Installed legacy-feed → public-feed upgrade acceptance passed on an isolated
  macOS runner using the signed production packages and actual updater UI.
  `0.2.13-beta.33` downloaded the bridge, completed native replacement and
  relaunch, and then checked the public feed successfully. The profile, Beta
  preference, and language were preserved. Installed application payload matched
  the published bridge; screenshots and a machine-readable receipt were retained.
  No operator app or live server was used for this acceptance journey.
- Current stable `0.2.12` downloads and the Android release feed remain on the
  legacy repository. No standalone server deployment or mobile release is part
  of this desktop migration.

## 2026-09-12 — Public desktop release migration

- Prepare the `1.0.0-beta.1` migration bridge with the public AgentsDock
  repository as its canonical desktop download and update destination.
  Keep the legacy release feed available for older installations and Android;
  publish the same verified desktop artifacts to both repositories.
- Beta subscribers can receive a newer stable release without losing their
  Beta preference. Selecting stable metadata during a normal Beta check does
  not enable downgrades. Existing startup and four-hour checks are unchanged;
  downloads still require an explicit install action to restart the app.
- Preserve application identity, signing requirements, saved settings and
  connections. Merge the current public UI and pinned-message navigation
  changes while retaining shared-chat restrictions and attribution.
- Validate release ordering against both feeds. Publication must pin the public
  source tag to the reviewed commit and resume mirrors only when the sealed
  source identity and artifact checksums match; published conflicts fail closed.
- Stable `1.0.0` remains a separate release gate. Existing stable downloads
  continue to use the verified `0.2.12` artifacts until that promotion.

## 2026-09-12 — Reusable-token chat sharing

- Keep share addresses separate from access tokens. Copy invitation includes
  both on separate lines; opening the interactive address requires manual token
  entry. Existing browser sessions can resume without storing raw tokens in
  browser storage. View-only sharing also offers an explicit token-in-link copy.
- Use one reusable token per share for multiple collaborators. Remove the
  one-person claim wording, and move revoked entries into collapsed history.
- Preserve initial-latest timeline positioning without new scroll timers or
  background refreshes. The matching server supplies paginated full-log
  snapshots and starts their viewer at the latest page.
- Focused component, bridge, URL-validation and timeline-position checks,
  TypeScript, the desktop suite and production compilation passed. Actual
  compiled desktop clicks verified both share actions, separate URL/token,
  copy/open dispatch, snapshot-only token links, and revoked-history folding
  against isolated fixtures without creating real shares.
- Accepted local arm64 candidate: `0.2.13-beta.37`, build `203`, source `699911b`.
  Developer ID signing, strict signature verification, bundle audit, and all
  151 packaged compiled-file byte comparisons passed. This local build is not
  notarized or publicly released; automatic updates are disabled. The running
  desktop was not replaced.
- These changes require AgentsServer `0.1.26-beta.66` or later. Server release
  and installation are tracked separately; the local app does not update a
  server automatically.

## 2026-09-12 — Two-action HTTP chat sharing

- Replace the preview/checkbox workflow with View only and Interactive actions.
  Each explicitly creates, copies and opens a link; existing-link revocation is
  available on demand without background refreshes.
- Derive share addresses from the selected native server connection. Support
  direct HTTP as well as HTTPS without requiring a separately configured domain.
  This requires the matching standalone server change; an app update alone is
  insufficient. HTTP is intended for trusted networks and is not encrypted.
- Serve a styled static snapshot with user bubbles, assistant Markdown, dates
  and responsive light/dark layouts. Interactive sharing reuses the chat UI and
  keeps explicit one-time Join, chat-scoped access, same-origin and CSRF checks.
- Verified actual compiled desktop right-click, both creation buttons, exact
  copy/open dispatch and lazy existing-link management with isolated fixtures.
  Verified served pages on a genuinely non-secure HTTP browser origin: Join,
  reload, prompt, queue Send now, Stop, wrong-origin/CSRF denial and used-invite
  denial. Static pages were checked at desktop and mobile widths in light/dark
  themes. These synthetic journeys did not execute providers or expose real chats.
- Accepted local arm64 candidate: `0.2.13-beta.36`, build `202`, source `ce1e0d9`.
  Production compilation, desktop checks, strict Developer ID signature, bundle
  audit and exact packaged main/preload/renderer byte comparisons passed.
  Automatic updates are disabled; this local candidate is not notarized or
  published. The running desktop was not replaced. Server changes are committed
  separately and were not deployed by this validation.

## 2026-09-12 — Quiet idle-mail wake presentation

- Keep the server-generated mailbox availability input out of the user-message
  timeline while retaining the receiving agent's progress and final answer.
  Suppression requires exact native wake metadata, not matching message text.
- Preserve genuine user inputs and unproved imported history. Verified cold and
  incremental projection for Claude and Codex with focused checks and TypeScript.
- Idle execution requires the corresponding standalone server change; this
  desktop change alone does not wake an idle recipient or update its server.
- Validated the compiled Electron renderer with synthetic Claude and Codex
  live-progress, completion and sidebar-reopen journeys. Each retained one
  genuine user bubble and both original and wake answers, without duplicate
  output or an internal wake notice. No live provider execution was exercised.
- Accepted local arm64 candidate: `0.2.13-beta.35`, build `201`, source `ffe6168`.
  Production compilation, desktop tests, strict Developer ID signature, bundle
  audit and matching packaged main/preload/renderer bytes passed. The app has
  automatic updates disabled; it is not notarized or published. The running
  desktop was not replaced.

## 2026-09-12 — Local desktop beta.34 candidate

- Accepted local universal macOS installer: `0.2.13-beta.34`, build `157`, exact
  committed source `85654170df60df954d0efea1f68d0fd34e37a2a2`.
- Verified Developer ID signing, notarization ticket, Gatekeeper acceptance,
  embedded version/build and updater ZIP checksum. This candidate includes the
  large-share preview and browser-sharing changes described below.
- Desktop publication was canceled at the user's request. No public beta.34
  release was created; the installer was retained locally and the running app
  was not replaced. The signed candidate has normal direct-update support.
- Full cross-platform release acceptance is not claimed: macOS and Linux x64
  build jobs passed, an ARM renderer fixture exposed a passive-effect assertion
  race, and the remaining workflow was canceled. The fixture correction is
  retained separately and is not part of this installer.

## 2026-09-12 — Large chat sharing

- Preview and confirm text snapshots independently of raw tool-log size and
  message count, retaining bounded UTF-8 snapshot and individual message sizes.
  The matching server release preserves existing shared links and revocations
  when upgrading snapshot storage.
- Page the review dialog in groups of 20 messages, resetting scroll position on
  each page. Confirmation still covers the complete reviewed snapshot, not just
  the visible page. Strip native IPC boilerplate from share errors.
- Give snapshot requests transport headroom beyond the server's bounded scan;
  do not change unrelated request deadlines or add retries or background work.
- Verified the actual desktop right-click, preview, paging, confirmation and
  old-server error journey with a synthetic 2,384-message snapshot and a source
  boundary larger than 64 MiB. Only 20 message elements were mounted at once;
  confirmation from the second page retained the original full-snapshot digest.
- Interactive sharing requires the matching standalone server implementation;
  publishing the desktop alone does not add missing server endpoints.

## 2026-09-12 — Shared-browser recovery and control parity

- Resume an already joined browser session on reload without consuming another
  invitation. Preserve session identity when loading older timeline pages.
- Disable shared provider controls and close permission popovers when access is
  lost; retain a usable Close action and explain the disconnected state.
- Stop further writes after an uncertain acknowledgment instead of offering an
  automatic duplicate send. Do not misreport an accepted action as failed when
  only its subsequent refresh fails. Release failed local upload staging slots.
- Expand exact cross-chat message bodies on demand within the shared chat,
  preserving recipient edits without sending messages or marking mail read.
- Wire the web file-drop surface into the existing one-way upload path. Reject
  oversized selections before staging a partial selection. Native desktop file
  selection behavior is unchanged.
- Rechecked the actual compiled shared renderer in an isolated Chromium browser:
  join/reload, older history, expanded message scrolling, queue controls, Stop,
  goal controls, settings/models/permissions, approvals, schedules, uploads,
  pushed owner results, one-use invitations and read-only/interactive revocation.
  The idle stream made no additional chat-history requests across its heartbeat.
  Provider callbacks and owner state were synthetic, not production research jobs.
- The final web pass also verified Claude approval/Stop and revoked-popover
  behavior, actual rejected/accepted file drops, a narrow light-mode layout and
  lost-response duplicate prevention. Confirmed reload after a retained draft
  created a fresh document and restored one accepted queue receipt without a
  resend. Claude permissions saved and re-rendered through browser form events;
  native OS popup interaction remains unverified because the isolated window
  could not take keyboard focus.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `200`, committed desktop
  source `d44e1ad`. Developer ID signature and all 86 compiled archive files
  verified. The running app was preserved; this candidate is not notarized or
  published and has automatic updates disabled. The subsequent web-only drop
  change is included in the separately packaged shared renderer at `6839cf2`.
- The matching standalone server changes and web bundle are committed locally,
  not deployed. Public HTTPS ingress and real provider execution remain separate
  deployment acceptance steps. No direct file, terminal or other-chat API was
  added to guest access; sharing remains trusted agent collaboration, not a sandbox.

## 2026-09-12 — Receipt-based outgoing chat status

- Replace the unconditional outgoing “Sent to” heading with “To” and an
  explicit status. Distinguish unconfirmed delivery, stored unread mail,
  agent-read receipts, cancellation and failure; preserve legacy queue status.
- Correlate receipts to the exact message and participants. A default unread
  state or registration event alone is not proof of mailbox storage. Reading
  is not represented as processing or replying.
- Preserve target navigation, on-demand message expansion and existing
  controls. Add no polling, automatic resend, agent invocation or server change.
- Verified synthetic receipt states in the actual desktop renderer, including
  on-demand expansion and target navigation, plus focused component checks.
  These checks do not establish the delivery of any particular live message.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `198`, source
  `2734708`. Developer ID signature and all 86 compiled archive files verified.
  The running app was preserved. This candidate is not notarized or publicly
  released and has automatic updates disabled.

## 2026-09-12 — Full control within a shared chat

- Expand the interactive invitation disclosure and required confirmation to
  full control of the one shared chat: prompt/upload, stop/steer, send queued
  messages now, manage the queue, change model/chat settings and permissions,
  manage goals, and create/edit/delete scheduled jobs.
- Retain the boundary against direct terminal access, file browsing/download,
  other chats and server administration. The collaborator can still ask the
  existing agent to use its tools and context; this is not a tool sandbox.
- Explicitly explain that revoking access does not undo accepted work or
  scheduled jobs. Snapshot sharing remains read-only and unchanged.
- Reuse the native timeline, composer, queue, approvals, goal and schedule
  components in the token-scoped browser view. Keep file browsing/downloads,
  working-directory controls, terminals, other chats and administration out.
- Receive shared-chat changes through one demand-open stream, not polling.
  Keep model choices across updates and refresh cached Codex/Claude status
  after a snapshot commits. Use the native positioned settings modal.
- Validated the compiled browser UI against the isolated token router and
  native adapters with synthetic provider/store mutations: prompt queueing,
  edit/reorder/send-now/stop, goal pause/resume, settings and permissions,
  model choices, schedule create/edit/delete and approval responses. Verified
  that a second browser cannot reuse an invitation and revocation disables
  further guest actions and ends the live stream. No
  production provider run or live user job was started by these checks.
- The expanded guest controls require the matching standalone server update;
  this source change does not deploy or publish that server.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `197`, desktop source
  `ed1b20e`. Developer ID signature and all 86 compiled archive files verified.
  The running app was preserved. This candidate is not notarized or publicly
  released and has automatic updates disabled. The subsequent settings-modal
  correction affects only the separately packaged web renderer.

## 2026-09-12 — Explicit chat sharing

- Add right-click **Share chat** with two separate choices: a reviewed,
  read-only text snapshot and a one-time invitation to a live chat.
- Interactive sharing explicitly grants trusted use of the existing agent's
  tools/context. The guest web surface has no native terminal, file browser,
  downloads, other chats, or administration; it is not a provider sandbox.
- Use exact native-authenticated, server-scoped management requests with no
  redirects or automatic retries. Show missing HTTPS hosting honestly, retain
  new link secrets only in the open dialog, and provide exact revocation.
- Mark shared-chat prompts as Collaborator in the timeline and queue. Do not
  add an inbox poller, background navigation, or automatic sharing.
- Validated the actual isolated Electron right-click/preview/confirmation,
  copy/revoke and collaborator-label journey against synthetic share responses,
  plus actual loopback native-header transport and affected regression checks.
  New interactive sharing requires the separately updated standalone server;
  no server deployment or public app release is included in this source change.

## 2026-09-12 — Preserve proven assistant replay corrections

- Keep exact server-proven Codex and Claude assistant replay corrections in the
  local SQLite cache when an older page or buffered stream repeats the same
  event. Reuse the existing identity/provenance merge checks; do not infer
  duplicates from similar text or remove original scheduled reports.
- The standalone server also corrects Codex history comparisons when native
  delivery removed leading decorations from the same provider message. That
  server correction is separate and requires deployment before historical
  duplicates can be repaired. No polling or background refresh was added.
- Verified the actual isolated Electron service, SQLite cache and renderer:
  repair, stale replay, switching chats and reload preserve corrections while
  all original scheduled reports, genuine messages and the running job remain
  intact. Provider transport was synthetic. Claude's equivalent cache path was
  verified with SQLite close/reopen and shared provenance checks, not a second
  graphical journey.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `193`, source `c9c5210`.
  Developer ID signature and all 86 compiled archive files verified. The
  running app was preserved; this candidate is not notarized or publicly
  released and has automatic updates disabled. The standalone server patch
  is committed separately and has not been deployed.

## 2026-09-11 — Cross-chat heading navigation

- Make the sender or recipient name on purple cross-chat messages open the
  exact referenced chat. Grouped inbox messages keep a separate unread-count
  disclosure, so clicking the sender does not expand or consume mail.
- Reuse normal chat navigation without additional requests, polling or route
  grants. Guard the originating server scope; do not resolve duplicate display
  names or turn imported label-only messages into guessed links.
- Verified actual isolated Electron navigation for Codex and Claude, both
  directions, keyboard activation, historical exchange legs and grouped inbox
  messages. Unread mail remains unread and collapsed after returning. The
  synthetic transport recorded no mail or execution actions.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `192`, source `9fae5cff`.
  Developer ID signature and all 86 compiled archive files verified. The
  running app was preserved; this local candidate is not notarized or publicly
  released and has automatic updates disabled. No server change is required.

## 2026-09-11 — Lazy history repair after server upgrades

- On an observed server-version change, invalidate only that server's cached
  history verification. Opening a chat then uses the existing bounded
  authoritative history check so corrections to older messages are received.
- Do not clear cached content on version change or refresh every chat.
  Repeated health responses do not trigger another invalidation. Version and
  verification changes share one transaction, preserving retryability if
  storage is exhausted. Failed or offline history requests keep cached content.
- Verified the actual isolated Electron health-upgrade journey: one lazy
  history audit corrects older runtime records, genuine inputs and answers
  remain visible, and the unsent draft survives. Repeated health responses,
  switching chats and reloading do not repeat the audit or fetch unopened
  chats. Transport was synthetic; no live provider run was started.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `190`, source `fb986357`.
  Developer ID signature and all 86 compiled archive files verified. Automatic
  updates are disabled; this candidate is not notarized or publicly released.
  The running app was left untouched. Historical corrections require standalone
  server `0.1.26-beta.61` and reopening the affected chat after the upgrade.
- Published standalone server `0.1.26-beta.61` from `34b66875` after its full
  release validation passed. Verified the downloaded manifest signature,
  archive digest and all 67 packaged files against the committed source.
  Managed activation is when-idle; publication does not imply installation.
  No public desktop or mobile release was made in this pass.

## 2026-09-11 — Typed provider notice coverage

- Extend the same source-proven runtime metadata contract to known provider
  compaction summaries and infrastructure notices. A provider user-role record
  is not automatically a message authored by a person.
- Keep real user text, quotations, assistant output and live activity intact;
  preserve exact repairs through stale event replay and disk-cache reloads.
  No background refresh or polling is added. Historical repair requires the
  matching standalone server update.
- Verified mixed Codex and Claude messages in the actual isolated Electron
  service, SQLite, IPC and renderer: user input, quotations, public progress,
  expanded tool details, final answers, goal activity, scheduled output and
  passive purple mail remain visible. Runtime notices stay out of user bubbles
  across stale replay and reopening. Transport was synthetic; unknown future
  provider formats and live provider execution are not certified by this check.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `189`, source `864e15de`.
  Developer ID signature and all 86 compiled archive files verified. Automatic
  updates are disabled; the app is not notarized or publicly released. Historical
  repair requires standalone server `0.1.26-beta.61`; the running app was left
  untouched.

## 2026-09-11 — Codex interruption notice provenance

- Apply the source-proven runtime notification contract to typed interruption
  notices as well as subagent completions. Neither becomes a message from the
  user, and an old imported notice does not stop current work.
- Preserve genuine user quotations and retain exact corrections across stale
  event responses and disk-cache reloads. Historical corrections require the
  matching standalone server update; this is a local desktop change only.
- Verified both runtime notice types together in the actual isolated Electron
  service, SQLite, IPC and renderer: source-proven corrections, stale replay,
  switching chats and reload preserve genuine quotations and assistant output.
  Provider transport was synthetic; no live provider turn was started.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `188`, source `9cbed1e3`.
  Developer ID signature and all 86 compiled archive files verified. Automatic
  updates are disabled; this candidate is not notarized or publicly released.
  The running app was left untouched. Historical repair requires standalone
  server `0.1.26-beta.61`.

## 2026-09-11 — Codex subagent notification provenance

- Treat source-proven imported subagent completion notifications as runtime
  metadata, not messages authored by the user. Preserve genuine quotations,
  assistant answers, native subagent activity and original timestamps.
- Keep the exact correction across stale same-ID events and disk-cache reloads;
  require source identity, a full-text digest and no positive human provenance.
- Verified the actual isolated Electron service, cache and renderer: the legacy
  bubble is corrected, a genuine identical quotation remains, and stale replay,
  switching chats and reloading do not restore the bogus input. Transport and
  provider history were synthetic; no real provider turn was started.
- Historical repair also requires the matching standalone server correction.
  No mobile or public desktop release is included in this local change.

## 2026-09-11 — Storage recovery and native history replay

- Keep the desktop open after local storage exhaustion. Preserve the original
  database and saved drafts; use temporary storage only for rebuildable cache
  data. Failed draft saves block window close, with an explicit Retry saving
  action after space is freed. An incomplete legacy credential migration keeps
  its original settings protected and requires reopening after recovery.
- Prevent failed event-cache batches from advancing the durable history cursor.
  Handle browser storage quota errors in layout controls without crashing React.
  Recovery is user-triggered, with no new storage or inbox polling.
- Recognize the server's exact source-proven native replay marker. Keep original
  human messages and scheduled reports, suppress only verified imported copies,
  and preserve the correction when an older cached response arrives later.
- Verified disk-full startup, preserved drafts, failed-close handling and a
  successful explicit retry using the actual desktop service, SQLite, IPC,
  preload and renderer with isolated fault injection. The system disk was not
  filled, and no provider turn was started by this check.
- Verified the native replay correction in the actual isolated Electron UI:
  duplicate history is removed while the original human message, scheduled
  report and genuine later question remain, including after switching chats
  and reloading. Preserve unmatched output across silent imported boundaries.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `186`, source `a4fc5ba1`.
  Developer ID signature and all 86 compiled archive files verified. Automatic
  updates are disabled; the app is not notarized or publicly released, and the
  installed/running app was not replaced. Historical corrections and passive
  mailbox reads require standalone server `0.1.26-beta.61`.

## 2026-09-11 — Passive agent mailbox

- Show passive incoming agent messages as compact purple sender groups in
  chronological position. Only adjacent messages are grouped; human follow-ups
  and progress remain boundaries. Preserve individual identities and replies.
- Expand and delete exact messages on demand. Opening a message does not mark
  it read by the agent. Long expanded bodies have a bounded scroll surface.
- Use the existing event stream, without inbox polling or duplicate execution
  queue rows. Grouping is linear and preserves immutable cached inputs.
- Verified the actual desktop main process, cache, IPC and renderer with
  synthetic transport: grouping, edited full-body scrolling, exact deletion,
  read-state updates and reopening. This is not a live-provider execution test.
- Requires the matching standalone server mailbox contract. No server
  deployment or public release is included in this local implementation.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `185`, source `bac1876e`.
  Developer ID signature and all 86 compiled archive files verified. Automatic
  updates are disabled; this candidate is not notarized or published, and the
  installed/running app was not replaced.

## 2026-09-11 — Scheduled history ownership

- Keep explicitly job-owned output inside Scheduled Job cards even when a
  paged response omits the start event or scheduled-purpose field. Match cold
  history, incremental updates, and late ownership metadata.
- Preserve ordinary imported/user messages and independently rendered
  emergency, Mail, and cross-chat receipts.
- Older Claude imports also require the standalone server's source-proven
  historical-page correction; this desktop change does not replace that repair.
- Local arm64 candidate: `0.2.13-beta.33` build `184`, source `3088ead6`.
  Production build, signature and all compiled archive files verified; not
  notarized or published. The installed/running app was left untouched.

## 2026-09-11 — Expanded queued messages

- Keep expanded message rows at their natural height so the queue scrolls
  instead of clipping the body. The queue retains its existing height limit.
- Verified long Codex and Claude messages with wheel scrolling to the final
  paragraph, reachable queue actions, and collapse in light/dark narrow views
  using the actual desktop renderer and synthetic transport.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `183`, source
  `a300d1d9`. Signature and compiled archive verified; not notarized or
  published. No server update is required.

## 2026-09-11 — Chronological agent messages

- Place agent messages between the progress before and after their send or
  delivery-start event. Keep the sender's live or stopped state below the
  message, and retain that position when delivery receipts arrive later.
- Preserve earlier answers during incremental receipt updates. Keep tool
  calls and results together when activity is split around a message, including
  explicitly loaded trace pages.
- Preserve full queued message bodies, recipient edits, and compare-and-swap
  revisions during stream updates and stale receipt replay.
- Do not display scheduled-job input as a public result. Preserve genuine
  user-authored quotations of provider control text.
- Validated live, completed, queued-reply, and reopened views in the actual
  desktop renderer with synthetic Codex and Claude transport. Checked both
  themes, narrow layout, and typing/scrolling in long cached conversations.
  This does not certify live provider execution, server history pagination,
  or minimap navigation. No server deployment or public release is included.
- Accepted local desktop candidate: `0.2.13-beta.33` build `182`, arm64,
  source `22a19ce1`. Developer ID signature and compiled archive contents
  verified. Final desktop UI pass includes stop-after-send, late delivery
  receipts, and reopening for both providers. This candidate is not notarized
  or published, and its automatic updater is disabled.

## 2026-09-11 — Current desktop development

- Bring current desktop changes into this repository: source-proven history
  deduplication, readable asynchronous agent-message queues, revision-safe
  recipient edits, explicit Send now priority, and actual chat names.
- Include on-demand Mail threads, agent-only replies, searchable chat routing,
  guarded Host rename, negotiated unlimited chat routes, and Team Network
  translations. Quiet arrival hints update a badge without polling Inbox
  contents or navigating away from the current chat.
- Include native provider skills and commands in the slash palette, retaining
  capability negotiation and unsupported-server fallbacks.
- Preserve synthetic test data, the source-only CI boundary, and the existing
  public binary update feed. No release, native mobile build, or server
  deployment is part of this source migration.
- Validation: desktop type checks, the complete desktop test run, and the
  production bundle build passed. Local validation used Node 26; source CI
  remains pinned to the documented Node 24 environment.

## Source verification

- Mobile CI now runs the cross-chat protocol, projection, route/queue race,
  rendering, recipient-picker, and native-workspace resolution regressions.
- The additional checks use synthetic data and mocked native boundaries;
  source CI still does not build signed applications or publish releases.

## Documentation

- Reorganized the README into a product overview, installation steps, and
  separate desktop, mobile, and website development workflows.
- Clarified the client/server boundary, current versus legacy client sources,
  and the distinction between local builds and release publishing.
- Checked development commands against package scripts and source CI, and
  checked installation guidance against the standalone server documentation.
- Refreshed the public README hero with a centered product introduction,
  website, community, and release badges, and an approved desktop and mobile
  product image. Placed the introduction below a more compact product image to
  keep the opening layout focused.
- Updated the introduction to name the currently supported agent backends,
  speak directly to AI researchers, and provide direct current download links
  for every available platform with a matching desktop release badge.
- Verified the README with GitHub's Markdown renderer and checked every new
  destination and badge URL before review. Reviewed the supplied image and its
  metadata before inclusion.

## Mobile cross-chat parity — 0.1.1 (171)

- Apple validation and processing completed successfully; build 171 is active
  for internal TestFlight testing with automatic notifications enabled.
  External beta review was not submitted. Binary source: `aa1153be`.
- Align mobile with the current desktop async agent-message protocol: one
  Markdown card per message, pending incoming messages in the queue, and
  delivery-time chronology without duplicating internal provider prompts.
- Show granted chat access, pending grants, route limits, loading/errors, and
  revision-safe Revoke controls. Reconnects fence stale requests and callbacks.
- Add exact queued-message removal with truthful confirmation, duplicate-tap
  protection, and desktop purple pending-message styling.
- Include offline server inboxes in `@@` discovery and distinguish capability-gated
  `@@bulletin` posts from `@@all` inbox broadcasts.
- Validate real component handlers against synthetic native hosts, projection
  and store/API race regressions, broad library tests, and native build checks.
  Synthetic rendering does not substitute for physical-device touch/pixel QA.
- Release preparation uses generated, ignored native projects and resolves the
  configured workspace name rather than assuming the legacy project name.
- Signed arm64 iPhone/iPad archive and exported IPA passed deep signature,
  framework ABI, version, production-entitlement, and matching-symbol checks.
  The production JavaScript bundle contains the new features and excludes the
  visual test fixture.

## Source snapshot

- Includes the Electron desktop and React Native mobile clients, legacy Swift
  targets, compatibility fixtures, and project documentation.
- Private development history, operational incident notes, and unreviewed
  screenshots and recordings are not included.
- This source snapshot does not itself publish or change any installed release.

## Electron workflow controls

- Added native provider skills and commands to the composer slash palette.
- Refined scheduled-job status, direct actions, working-directory navigation,
  and compact unavailable-agent guidance.
- Added a grouped keyboard-shortcuts page to Settings with localized labels.
- Documented privacy-preserving usage events for these workflows.
- Validated the affected Electron behavior with focused tests, type checking,
  a production build, and a local desktop UI pass.

Future entries should describe public-facing changes and validation without
including credentials, user data, private infrastructure, or internal history.
