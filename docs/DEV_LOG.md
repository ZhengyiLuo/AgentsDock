# Public development log

## 2026-09-12 — Quiet idle-mail wake presentation

- Keep the server-generated mailbox availability input out of the user-message
  timeline while retaining the receiving agent's progress and final answer.
  Suppression requires exact native wake metadata, not matching message text.
- Preserve genuine user inputs and unproved imported history. Verified cold and
  incremental projection for Claude and Codex with focused checks and TypeScript.
- Idle execution requires the corresponding standalone server change; this
  desktop change alone does not wake an idle recipient or update its server.

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

Future entries should describe public-facing changes and validation without
including credentials, user data, private infrastructure, or internal history.
