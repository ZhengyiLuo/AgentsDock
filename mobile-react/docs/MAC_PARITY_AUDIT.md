# Mobile / Mac parity — 2026-09-09

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
