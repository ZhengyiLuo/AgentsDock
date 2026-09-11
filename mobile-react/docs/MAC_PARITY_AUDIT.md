# Mobile / Mac parity — 2026-09-10

## Current cross-chat update

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

Native simulator touch/pixel QA is unavailable in the current build environment.
Dark/light and narrow/tablet synthetic-host checks exercise render trees and
handlers; they do not claim measured native layouts. The broad baseline suite
also has an unrelated existing privacy-policy wording assertion failure.

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

## Scope and remaining differences

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
