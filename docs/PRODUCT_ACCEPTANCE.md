# Native product acceptance

## Status

The workflow and native harnesses are implemented on the product-pipeline PR.
No complete production candidate or successful native acceptance run is recorded.
Do not interpret passing helper unit tests as an accepted release. Publication
remains blocked; the workflow does not generate passed records for unobserved
scenarios.

Implemented, awaiting execution against sealed packages:

- Exact receipt/source/signature/runtime/permission verification before tests.
- Real npm installation on Linux and macOS, native service restart, permanent
  runtime independent of the npm staging/cache, and refusal of a fresh install
  over an existing installation. Invalid signatures and wrong identities are
  rejected through the authenticated production update API.
- Signed legacy server fixtures with `0755` and `0750` roots, real API-created
  sessions/settings/custom working directories, and preservation comparisons.
- Signed baseline desktop, real update UI input, Squirrel replacement and
  relaunch, exact installed app bytes and embedded server descriptor.
- App update while its server is offline, automatic reconciliation after
  reconnect, two native clients sharing one operation, and Stable/Beta
  subscription discovery using exact-package replay.
- One-shot interruption of the real signed legacy archive transfer, incumbent
  health/state verification, then retry of the same target and installed runtime
  byte/mode verification. This is not post-takeover rollback acceptance.
- Linux-only candidate-health fault, using kernel pidfds and exact native
  service/process ownership checks; observe real rollback and retry. This
  harness still requires execution against the actual prepared packages.

Required work/observations still blocking acceptance:

- An isolated authenticated provider chat and native session IDs/history, not
  merely an empty API-created session. The existing fixture deliberately does
  not claim this and marks full legacy preservation blocked.
- A real running provider turn and queued message during update admission,
  drain and retry. A `tmux sleep` is not an agent run and cannot establish this.
- Execution of the implemented failure/rollback harnesses with real artifacts.
- Interactive pairing/token-copy and optional dependency decline/error paths;
  survival of an actual logout/reboot. A service-manager restart is narrower.
- Native Windows acceptance and natural provider OAuth renewal remain separate
  unverified boundaries; this workflow does not claim them.

## Operator sequence

1. Configure the existing release credentials in canonical `direct-production`;
   reuse the current Developer ID identity and server Ed25519 key. Check npm's
   trusted publisher and explicitly resolve its stable-default policy. See
   [release configuration](PRODUCT_RELEASES.md#required-external-configuration).
2. Review and register the workflows through the agreed default-branch process.
   They do not run privileged/native acceptance on PR events. Registration is
   not permission to publish or bypass missing native cases.
3. Commit the complete candidate and reserve an unused beta version. Dispatch
   `Release AgentsDock` with `operation=prepare` and the full source SHA.
   Keep the resulting product receipt hash and exact retained artifacts.
4. Dispatch `Accept prepared AgentsDock product` on that exact source revision.
   Inputs are preparation run ID, accepted receipt SHA-256, published stable app
   baseline (currently `1.0.6`) and signed server baseline (currently `1.0.3`).
   A source change after preparation needs a new candidate; do not rebuild under
   the old receipt. Both workflows require `main` or a reviewed `release/*` ref.
5. Inspect each native report, not just job exit codes. The collector requires
   all platform/layout reports from the same run attempt and every required
   check passed. A blocked report is expected while the gaps above remain.
6. Only after complete acceptance and explicit publication approval, reuse the
   exact packages in order: npm, legacy server bridge, desktop. Repeat the
   fresh-install check using the exact registry package after npm publication,
   before exposing desktop updates. Never publish merely to make a test pass.

Acceptance uses ephemeral TLS trust for only the existing GitHub/npm origins
on disposable hosted runners. It does not alter descriptors or signed packages,
disable TLS verification, patch the production updater, or touch developer
machines. Only sanitized JSON evidence is uploaded. Private service tokens,
TLS keys, raw logs, user profiles and screenshots stay off artifacts.

## Short candidate checklist

The designated manual test target is **macOS on Apple Silicon**, on another
machine. Use a disposable macOS user account for a fresh installation: changing
the working directory or port does not isolate an existing server installation.
Do not run the CI trust-routing or process-fault helpers on that machine. They
are strictly for disposable hosted CI runners.

Manual results are a separate evidence source. They do not automatically turn
blocked CI observations into passing ones. Record the exact candidate receipt,
app build, npm tarball hash and source commit; review results before updating
release acceptance. Do not send provider credentials, server tokens, raw private
logs or personal chat contents.

Fresh npm install, on a disposable account/VM:

1. Install the **exact accepted candidate tarball**, run its installation CLI,
   pair the app, and complete a real chat.
2. Verify app/server version and source, permanent runtime path and native
   service health. Retire the npm/npx cache; test logout and reboot.
3. Try optional-dependency decline, interrupted install, occupied port and a
   second fresh install; existing state must be preserved/refused safely.

One-click upgrade, with a populated supported older installation:

1. Back up disposable test data; record identity, token, profiles, chat/native
   IDs, custom paths and queued messages. Select Beta for a beta candidate.
2. Click the app update action once. App installation/relaunch must not wait
   for a busy/offline server; show accurate per-server pending status.
3. Finish work/reconnect. The server must reconcile automatically to the
   matching npm version without lost history, duplicate messages or new identity.
4. Repeat with two clients, interrupted download and failed candidate health.
   Verify recovery/rollback and retry; never downgrade a newer compatible server.

The desktop bundles the signed npm **descriptor and signature**, not a private
npm token or the server runtime. Remote servers fetch the exact matching package
when coordination admits their update.

### Send back this short report

```text
Candidate version / app build:
Source commit / receipt SHA-256:
macOS version / Apple Silicon model:
Fresh npm install + pairing: PASS / FAIL / NOT TESTED
Real new chat + follow-up + app reopen: PASS / FAIL / NOT TESTED
Logout/reboot and npm-cache independence: PASS / FAIL / NOT TESTED
One-click app upgrade + automatic server update: PASS / FAIL / NOT TESTED
Busy/queued work survives and update waits: PASS / FAIL / NOT TESTED
Offline server reconnects and updates automatically: PASS / FAIL / NOT TESTED
Identity, profiles, history and native session IDs preserved: PASS / FAIL / NOT TESTED
Failure: exact action, expected/actual result, sanitized screenshot
```

An unpublished candidate can establish fresh install/chat behavior when delivered
as files. An ordinary installed app cannot discover that unpublished candidate
on its production feed. The one-click journey needs the authorized exact-origin
CI replay or a separately authorized beta publication; manually replacing the
app does not establish updater acceptance.
