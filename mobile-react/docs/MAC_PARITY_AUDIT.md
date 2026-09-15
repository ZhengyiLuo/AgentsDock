# Mobile / Mac parity — 2026-09-15

## Build 175: active-goal steering and queue accessibility

This focused follow-up closes omissions in build 174's goal workflow: native
goal-steering capability negotiation and chronological rendering of the exact
native follow-up, including attachments and reloaded history. Queue admission
and explicit Steer remain separate actions; neither pauses or replaces a goal.

Phone controls use labeled Stop/Steer/Queue actions. Collapsed goal/queue headers
include their padding and margins in the keyboard height budget. A queue review
sheet exposes full errors and message actions, including when the compact
landscape layout hides the auxiliary rail.
Short portrait keyboards also collapse secondary tools while preserving the
folded panels and primary controls. Live attachment ownership survives queue
removal before the native acknowledgement, without retaining private queue
payloads or enriching imported history from today's queue.
If an old attachment-only acknowledgement has neither explicit file IDs nor
an available earlier queue receipt or saved acknowledgement, mobile does not
guess ownership from unrelated files. That cold-history case requires server
attachment provenance.

Messages already queued by an older client retain their old capabilities.
An explicit Edit/Save updates the same queued message before a separate Steer;
an unchanged Save updates only client capabilities, preserving content, files
and reference metadata. It does not resend the original prompt. The current
server contract does not expose an atomic additive capability update, so Run now
does not silently rewrite the queued item's capability list. A goal-steering refusal can have other causes;
the full server error remains available rather than promising every refusal can
be repaired by Save.

Synthetic tests and signed-build verification do not substitute for physical
device touch/pixel acceptance. Release acceptance is recorded after Apple
validation and processing, independently of these source changes.

## Desktop catch-up for build 174

Reference: committed desktop `2ce43b9` (1.0.0), merged into the mobile release
branch before implementation. Uncommitted desktop work is not part of this
snapshot.

Accepted release: **0.1.2 (174)**, active for internal TestFlight testing with
automatic notifications enabled. Binary source `f686a2e` passed both CI jobs;
Apple validation/upload/processing and local signed archive/export, ABI,
privacy, production-feature and matching-symbol checks passed. Local suites
passed 108 library/API/store modules, 452 rendered/contract checks, and focused
goal/settings/file-transfer interactions. These categories overlap and do not
claim physical-device acceptance. External beta review was not submitted.

| Surface | Implemented behavior | Verification |
| --- | --- | --- |
| Imported history | Exact provider-origin contracts hide proven runtime/replay bookkeeping; same-ID repairs survive full-body hashing before truncation, overlap, and cache restoration | Positive/negative provenance, long-body, partial-page, native notification and real store-ingress regressions |
| Running and unread state | Imported history never changes live ownership, unread state, or the queue; per-chat run IDs and ordered health requests reject stale terminals and polls | Health/start/stop, reconnect/boot, uncertain queue admission and delayed acknowledgement races |
| Server upgrades | Opened caches revalidate once per observed server version; unopened content stays cached without a request fan-out | Missing-version, upgrade, repeated-delta, and mid-request version-change tests |
| Cross-chat cards | Exact receipt-based status, unread mailbox cancellation, and scoped peer-heading navigation across inbox, async, legacy and imported rows | Rendered navigation, cancellation, mismatch, duplicate-tap, and stale-scope tests |
| Native subagents | Inspector exposes bounded current/history state and task-heading fallback; Settings adds explicit concurrency Save and reset to Codex default | Pure projections, rendered disclosures and server-setting request/response races |
| Server-wide goals | Existing controls reject stale confirmations and responses after revalidation, server replacement, or capability loss | Same-tick scope changes, retired confirmations, and stale read/save/retry regressions |
| Working directory | Server-backed folder browser, confirmed existing paths, parent navigation, loading/errors and Retry | Rendered selection, invalid/missing directory, retry and stale-callback tests |
| Scheduled jobs | Running/disabled/scheduled status, runtime-error guards, and Stop only for the exact active job/run owner | Pure lifecycle tests and rendered Run/Edit/Pause/Stop interaction tests |
| Provider chat import | Capability-gated server transcript browsing; exact existing-chat matches open without reimport; explicit import receipt and separate Open action | Bounded parsers, route/receipt validation and rendered import lifecycle tests |
| Team Mail | Typed 25-item pages, revisioned read/unread, address-specific Remove, and draft-only Route/Reply to a chosen local chat | Synthetic Hub responses, mailbox receipts and scope/draft-preservation tests |

Goal and queue panels remain collapsed by default with shared bounded expanded
space. Existing file-download progress, destination selection, retry/cancel and
single attachment ownership remain covered by the regression suite.

### Remaining differences after this pass

This is a substantial catch-up, not complete desktop parity. Still separate:
the full slash workflow/provider-command inventory, bulk import/manual resume
UI, private Mail thread presentation and grants, quiet Mail/Bulletin hint
streams, Team attachment transport, sharing/collaborator attribution, and
desktop-style disk-exhaustion draft recovery. Desktop's complete-context native
delivery alias inference (receipt hashes plus exact provider/run/peer evidence)
is also not ported; unproven candidates remain visible instead of being hidden
by text matching. Explicit server-proven repairs are supported.

Human account/invitation administration needs separately scoped human authority;
mobile's AgentsServer proxy does not grant it. Current desktop Reply stages a
chat draft rather than directly composing/sending private Mail, and mobile now
follows that distinction. The larger navigation redesign remains deferred.

Automated native-host tests exercise React handlers/state and synthetic
transports, not physical-device pixels or touch acceptance. The existing
external-volume CoreSimulator privacy denial still prevents native runtime QA;
the installed Mac app and live server/chats were not used as test fixtures.

## Build 173: compact goals, queues, and current cross-chat behavior

This focused pass follows the desktop's passive sender-grouped inbox, revised
queued-agent-message controls, and chronological async-message activity. It also
retains the delivered-queue reconciliation fixes in build 172 and the main
repository's removal of custom analytics on iOS/iPadOS.

Accepted release: **0.1.2 (173)**, active for internal TestFlight testing with
automatic notifications enabled. Binary source `6687f01` passed both CI jobs;
the signed archive and exported IPA passed metadata, signature, ABI, privacy,
production-feature and matching-symbol verification. External beta review was
not submitted. Apple required the version advance after closing the approved
0.1.1 release train; application behavior was unchanged by that metadata update.

| Surface | Change | Verification |
| --- | --- | --- |
| Goal panel | Collapsed by default; one-line objective and status; expanded actions and scrollable objective share a bounded body | Actual rendered goal and combined Composer tests; long objectives, errors, polling, profile changes, and Pause/Resume/Edit/Clear |
| Queue panel | Collapsed count/status header; bounded list, full-body viewer and editor; folding preserves edit drafts | Actual Composer handlers; 50-message queue, reconnects, long drafts, uncertainty badges, and stale actions |
| Shared composer space | Goal and queue use the same auxiliary height budget; hidden editor blurs without discarding the draft or taking focus from the main composer | Narrow/tablet and keyboard/rotation state tests using native hosts |
| Passive chat inbox | Initially folded, adjacent messages grouped by exact sender/recipient; per-message state, time, Markdown, full-body disclosure, paging and confirmed Delete | API/projection and rendered read-only-open, exact identity/hash, pagination, duplicate-tap, deletion, revision and reconnect tests |
| Async activity order | Activity before and after a cross-chat message remains on the correct side; late tool results stay with their original call; live tail remains visible | Live/stopped/completed projection, lazy trace rendering, cache hydration, and row-reuse tests |
| Queued recipient edits | Exact feature gate and revision-based save; no composer reference grants; sender's original body remains unchanged | Store/API CAS, body/revision/hash, conflict/retry, permission-wait and validated-instance races |
| Run now and route limits | Advertised async controls permit eligible queued messages without bypassing promoted-delivery barriers; nullable route capacity means unlimited | Store and rendered capability/owner/barrier checks and route/API regressions |

Opening the inbox only performs authenticated reads. It never marks messages
read, starts a turn, resumes a goal, or creates route grants. Passive mailbox and
scheduled-job work do not appear as editable user queue entries. Older servers
retain their existing immutable incoming-delivery controls.

Native-host component tests execute React state, effects, and handlers with
synthetic transport; they are not physical-device touch or pixel acceptance.
The existing external-volume CoreSimulator privacy denial still prevents native
runtime QA. No installed Mac app, live chat, goal, or server was modified to test
this release. Signed archive and TestFlight acceptance are recorded separately
in the public development log after verification.

## Remaining Mac differences recorded at build 173

This is not a claim of complete Mac parity. New desktop workflow commands,
provider-session resume browsing, working-directory browsing, private Team Mail
composition/routing, Team attachment opening and human invitation management
remain separate work. Desktop disk-exhaustion recovery and additional proven
import-history replay handling also need their own mobile design and tests.
The larger mobile navigation simplification remains deferred as requested.

## Previous build 171 cross-chat update

Mobile now follows the current desktop source snapshot for async agent-message
negotiation and display, durable route access management, and supported `@@`
recipient discovery. Older exchange and imported-delivery rendering remains
supported without relaxing internal-wrapper provenance checks.

| Surface | Change | Verification |
| --- | --- | --- |
| Async message timeline | Exact protocol gate; stable row per message; queued incoming messages hidden until started; Markdown body with scoped detail loading | Projection, cache/reuse and rendered lifecycle tests, including cancellation, failure and participant mismatches |
| Granted chat access | Granted/will-grant labels, capacity limits, unavailable targets, exact-revision Revoke, loading and Retry | Rendered controls plus real store/API tests for duplicate taps, revision conflicts and stale reads |
| Incoming message queue | Desktop purple styling, sender identity, exact Remove with no user Edit/Run now; authoritative confirmation | Rendered actions and store races, including promoted/replaced owners, queue changes and uncertain acknowledgement |
| `@@` discovery | Offline inboxes, separate Bulletin and all-server targets under native/Hub capability gates | Helper, composer and send/queued-edit tests for capability loss, wrong scope and stale candidates |
| Reconnect behavior | Old callbacks cannot act on refreshed recipients or unlock newer queue/revoke requests | Synthetic-host tests for hung requests, revalidation and same-tick Save/Remove/Revoke |

At build 171, native simulator touch/pixel QA was unavailable in the build environment.
Dark/light and narrow/tablet synthetic-host checks exercise render trees and
handlers; they do not claim measured native layouts. The former privacy wording
failure is no longer present after merging the iOS analytics removal.

Accepted release: **0.1.1 (171)**, active for internal TestFlight testing.
Final checks passed: 112 focused rendered/contract tests, 19 protocol/route-store
regressions, all 75 library test modules, all 12 store/API test modules, goal and
settings components, and file-transfer interactions. The signed native archive
and exported IPA passed signature/ABI/metadata checks; the production bundle
excludes the visual test fixture. These categories overlap and are not a unique
test-case total. External beta review was not submitted.

This source snapshot includes Mac's last-opened-chat location changes and mobile's instant creation,
backend switching, lean Inspector, and photo-upload completion fixes.

## Implemented surfaces

| Surface | Change | Verification |
| --- | --- | --- |
| Persistent Codex goal | Visible objective, status, elapsed time/token use, Pause/Resume, direct editor, confirmed Clear; disabled/blocked/exhausted states remain explicit | Rendered component/provider tests plus goal helper and API regressions |
| Server goal setting | Authenticated server-wide toggle in Settings; disabling requires confirmation; conflicts remain errors, not success | Nine rendered tests including duplicate taps, failure/retry, profile switches and reconnects |
| New chat `+` | Capture the open chat's folder/cwd at the tap while retaining configured backend/model/effort; scoped single-flight | Store tests for creation, failure/retry, old-server responses and immediate selection |
| Inspector | Copy session ID; Fork disabled/rejected during active/stopping/admitting turns, including queued Run now | Inspector wiring and real store-action tests |
| Purple cross-chat card | Release stale busy states on reconnect/revalidation/failed server switch; keep exact cancellation intent when a queued delivery starts; never claim unconfirmed removal | Twelve rendered interaction tests, including stale reads and terminal reconciliation |
| Team Network | Independent mailbox/detail request tracking, per-team draft preservation, stale-team projection rejection, reconnect refresh | Request-sequence, authenticated-route and UI-contract tests |

Existing Ultra selection, provider-envelope filtering, single attachment ownership,
Mac-style purple conversation layout and authenticated Team Network actions are
retained from the latest baseline and covered by the regression suite.

## Scope and remaining differences recorded at build 171

This pass does not claim complete desktop feature parity or physical-device
coverage of every button. Tests execute React state/effects and control handlers
against mocked native boundaries, plus real store/API code with mocked transport.
They do not replace an iPhone/iPad touch and layout smoke test of the accepted build.

Desktop-only flows identified for a separate parity pass include provider-session
resume browsing, the working-directory browser, private Team Mail composition and
routing to a chat, Team attachment opening, and human invitation management.
The larger mobile navigation simplification remains deferred as requested.

Source validation does not authorize changing a live goal, server setting, or
deployment. Keep build artifacts, native dependency caches, temporary files,
and release logs in local directories excluded from Git.
