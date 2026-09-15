# Public development log

## Mobile goal steering and accessible queue controls — build 175 source

- Negotiate the native Codex goal-steering capability on supported Codex
  connections. Preserve the goal and active owner when explicitly steering a
  follow-up; ordinary Send remains queue admission while work is running.
- Render exact native-goal follow-ups as chronological user-message segments,
  including attachments, display text, history reloads and bounded lazy traces.
  Do not merge separate human messages by equal text.
- Preserve exact visible file ownership across live queue removal and native
  acknowledgements with empty file lists. Keep queue bookkeeping hidden and
  fence the bounded file-only association to its validated server scope.
- Keep labeled Stop, Steer and Queue controls visible in active chats. Rebalance
  the keyboard layout for the complete collapsed goal/queue headers and expose
  a queue review sheet with full errors and touch-sized message actions.
  Short portrait keyboards collapse secondary tools while retaining folded
  panels, primary actions and keyboard dismissal.
- Offer explicit Edit/Save recovery for messages queued by an older client,
  retaining their queue IDs. Saving is separate from steering and never
  automatically resends a prompt or changes a goal. An unchanged Save refreshes
  only client capabilities, preserving content, attachments and route metadata.
- Retain unsaved queue edits when the original message leaves the queue. Offer
  Copy and confirmed Discard while releasing the remaining message controls.
- Reconcile accepted-send responses that cross a same-server reconnect through
  fresh reads, preserving newer drafts instead of replaying the request.
- Physical-device acceptance and release acceptance are separate gates; neither
  is implied by synthetic protocol, store, layout or rendered-control tests.

## Mobile desktop catch-up — 0.1.2 (174)

- Apple validation, upload, and processing completed successfully; build 174
  is active for internal TestFlight testing with automatic notifications
  enabled. External beta review was not submitted. Binary source: `f686a2e`.
- Both source CI jobs passed for that exact commit. Local verification passed
  all 108 library/API/store test modules, 452 rendered/contract checks, 20 goal,
  18 server-goal and 9 subagent-setting component checks, and file-transfer
  interactions. Focused suites overlap broad suites; these are not a unique
  combined test count or physical-device acceptance tests.
- The signed arm64 iPhone/iPad archive and exported IPA passed version,
  distribution-signature, framework ABI, privacy, production-feature and
  fixture-exclusion checks, with matching app/debug symbols. Final build
  artifacts and release logs remain on the external development volume.

- Merge committed desktop `2ce43b9` and bring source-proven history repairs,
  run-owned activity reconciliation, and lazy server-version revalidation to
  mobile. Imported bookkeeping cannot create unread/running/queued state.
- Use exact delivery receipts in cross-chat status labels; add scoped peer
  heading navigation and confirmed unread-mailbox cancellation.
- Add native subagent history/details and server concurrency settings, a
  working-directory browser, and exact-owner scheduled-job Stop controls.
- Add capability-gated provider chat import with existing-chat matching,
  explicit success receipts, and separate navigation after import.
- Bring Team Mail paging, revisioned read/unread, address-specific removal,
  and draft-only Route/Reply into the server-proxy mobile workflow.
- Preserve folded goals/queues and file-transfer progress/retry controls.
  Fence server-wide goal confirmations and responses against revalidation,
  server replacement, and capability loss. Make the background-network test
  distinguish delayed foreground arrival from a new background dispatch.
  Expand CI to all mobile library/API/store and rendered regression suites.
  Physical-device acceptance and complete desktop parity are not claimed;
  remaining differences are documented in the mobile parity audit.

## Mobile compact panels and cross-chat catch-up — 0.1.2 (173)

- Apple validation and processing completed successfully; build 173 is active
  for internal TestFlight testing with automatic notifications enabled.
  External beta review was not submitted. Binary source: `6687f01`.
- Signed archive and exported IPA passed distribution-signature, framework ABI,
  version, privacy, production-feature/fixture-exclusion and matching-symbol
  checks. Both source CI jobs passed for the exact binary source commit.
- Source verification passed 388 rendered/contract checks, all 81 library,
  2 API and 12 store test modules, 20 goal-component and 9 server-goal-settings
  checks, and rendered file-transfer interactions. Counts overlap between
  focused and broad suites; these are not physical-device acceptance tests.
- Advance the marketing version to 0.1.2 after Apple closed the approved 0.1.1
  release train. The initial 0.1.1 build-173 candidate was rejected during
  validation and was not uploaded; application behavior is unchanged.

- Collapse goals and queued messages by default into touch-sized summary
  headers. Expanded content stays scrollable within a shared composer height
  budget; folding preserves queued edits and hidden editors release focus.
- Add the desktop's passive sender-grouped chat inbox with bounded Markdown,
  per-message receipt state/time, full-body loading, pagination and confirmed
  deletion. Opening it does not mark messages read or start agent work.
- Keep cross-chat activity in chronological segments, including lazy-loaded
  traces and tool results that finish after a message was sent. Preserve the
  visible live-progress tail and avoid repeating commentary in earlier traces.
- Support revision-safe recipient editing and Run now only when explicitly
  advertised by the server. Validate message identity and body hashes, retain
  the sender's original body, and fence stale reconnect/permission-wait actions.
- Retain build 172's delivered-queue reconciliation and the main repository's
  iOS/iPadOS analytics removal. Nullable route limits now mean unlimited access.
- Extend CI with mailbox, body verification, activity chronology, queue control
  races, folding and actual rendered-button regressions. Native-host tests do
  not claim physical-device or simulator pixel acceptance; broader desktop
  workflow and import-history parity remain documented follow-up work.

## Mobile queue reconciliation — 0.1.1 (172)

- Apple validation and processing completed successfully; build 172 is active
  for internal TestFlight testing with automatic notifications enabled.
  External beta review was not submitted. Binary source: `9748210`.
- The signed arm64 iPhone/iPad archive and exported IPA passed version,
  distribution-signature, framework-ABI, production-bundle, and matching-symbol
  checks. Both source CI jobs passed for the binary source commit.
- Remove delivered native-goal messages and explicitly superseded queue IDs
  without matching by message text or hiding unrelated queued work.
- Fence delayed timeline and queue reads against newer delivery observations,
  concurrent reads, reconnects, and server-instance changes. Empty or partial
  queue membership signals now request an authoritative queue refresh.
- Keep older stream packets from restoring a stale queued row; confirm covered
  queue signals by a fresh read without treating timeline sequence numbers as
  an atomic queue version. Refresh retries are bounded.
- Do not recreate a "still queued" warning from a late deferred response after
  the message has left the queue. Exact admission clears an uncertainty warning;
  cancellation or unrelated messages do not claim delivery confirmation.
- Preserve the desktop async cross-chat lifecycle when legacy compatibility
  receipts appear later, avoiding duplicate pending cards and status regressions.
- Add pure observation-clock tests, real-store delivery/reconnect races, and
  rendered queue/card regressions to source verification. Native-host mocks do
  not substitute for physical-device interaction or pixel testing.
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
