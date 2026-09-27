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

### Exact fresh-install commands for the Apple Silicon test account

Use a separate macOS account **logged into the desktop**, not merely `sudo -u`
from the development account. Do not copy an existing server's configuration,
provider credentials or history into it. Install Node.js 22.14 or newer, `uv`
and `tmux` through your usual trusted package manager. Log into the provider
you intend to test in that account through its native login flow.

The candidate handoff must include the versioned npm tarball, macOS app ZIP,
signed descriptors, a receipt and checksums. These commands assume the handoff
has been extracted and Terminal is inside its `manual-test` directory. Do not
substitute `@beta` or `@latest`: those tags do not identify this unpublished
candidate.

The `--offline` flag covers npm staging only. The server installer still needs
outbound access for Python/runtime dependencies. Connect this unpublished app
only to the matching fresh test server. Do not import older real servers into
its profile: automatic reconciliation would try to fetch the unpublished npm
version, which is available only inside the isolated CI replay.

```sh
uname -m
node --version
npm --version
command -v uv tmux
shasum -a 256 -c SHA256SUMS

npm install --prefix ./cli --ignore-scripts --no-audit --no-fund --offline \
  ./server-1.0.7-beta.18.tgz
node ./cli/node_modules/@agentsdock/server/npm/cli.cjs --version
node ./cli/node_modules/@agentsdock/server/npm/cli.cjs install \
  --bind 127.0.0.1 --port 7850
```

Expected architecture is `arm64`; expected package version is
`1.0.7-beta.18`. Stop if either differs. Do not run the installer with `sudo`
or override its installation roots. If it reports existing state, use another
account; do not delete history to bypass that guard. Keep the pairing token
local and use it only in the app's server-connection dialog.

macOS accounts still share TCP ports. If `7850` belongs to another account,
choose an unused port in the install command and use that same port when
pairing. Do not stop another account's server to free the port.

Extract the notarized ZIP into a new folder owned by the test account, then
open that app. Do not replace an app in `/Applications` shared by other users.

```sh
test ! -e ./app
mkdir ./app
ditto -x -k ./AgentsDock-1.0.7-beta.18-mac-universal.zip ./app
codesign --verify --deep --strict ./app/AgentsDock.app
spctl --assess --type execute --verbose=2 ./app/AgentsDock.app
open ./app/AgentsDock.app
```

Pair `http://127.0.0.1:7850`, complete a new chat and follow-up, then close and
reopen the app. Confirm the app and server both report the candidate version.
To check independence from the npm staging directory, quit the app, retire
only that directory, then reopen and continue the same chat:

```sh
test ! -e ./cli-retired && mv ./cli ./cli-retired
open ./app/AgentsDock.app
```

Then log out/back in and reboot the test machine, checking the same chat each
time. Renaming `cli-retired` back to `cli` restores the installation command;
it does not affect the managed runtime. The installed service must not depend
on either directory. Use the earlier result template, without including tokens.
