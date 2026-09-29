# Unpublished macOS candidate rehearsal

This is a scoped test in the existing registered `ci.yml`, not a product release
workflow. It installs exact signed packages and changes origin routing/trust only
on disposable GitHub-hosted macOS runners. It never signs or publishes packages.
All candidate receipts and observations remain `publicationEligible: false`;
observations also remain `releaseAcceptance: false`. A successful job does not
turn blocked or unobserved scenarios into full release acceptance.

## Exact journey

- Desktop baseline: published, update-enabled, signed/notarized AgentsDock
  `1.0.6` from the legacy desktop feed. The real settings UI first checks Stable,
  then selects Beta and retains Beta through installation and relaunch.
- Server baseline: the published signed legacy AgentsServer `1.0.7-beta.21`
  archive. This is the same-Beta **server** path; no local beta desktop is used.
- Target: the one independently pinned unpublished beta app/server candidate.
  The real app updater installs its exact signed macOS ZIP. The production
  coordinator updates the populated server after an offline/reconnect interval;
  a second native client must observe the same update operation. Compare IDs
  within their own namespace: both clients must retain a common scheduling or
  execution ID, and any jointly present same-type IDs must agree. An execution
  ID is not the scheduling ID it supersedes. Both exact-version clients must be
  current and unpaused on the same final server instance; matching health alone
  cannot satisfy this observation.
- Separate disposable jobs exercise legacy installation-root modes `0755` and
  `0750`. Each mode also has a separate recovery job that truncates one response
  containing the exact signed legacy archive, observes failed download and the
  unchanged healthy incumbent, then retries the same version normally.
- A fresh-install job exercises the exact npm archive and native service manager.
- Separate `stage-recovery` jobs cover both legacy root modes. A private,
  run-owned dependency delegate fails one exact signed candidate's preparation.
  The real installer must remove its stage and release its lock, while both
  incumbent components, service registrations and data remain unchanged. Retry
  uses the same public update API and accepted bytes. The delegate remains an
  explicitly disclosed QA dependency until the disposable VM ends.

The recovery fault does not modify signed bytes, patch the updater, remove update
fences, signal the incumbent, or establish post-takeover rollback. Installer state,
private fixture tokens, TLS keys, native logs and screenshots are not uploaded.
Only bounded sanitized observation JSON is retained; trust/routing cleanup runs
before artifact upload even after failure.

The stage-recovery check does not remove staging files itself or repair journals.
It reports maintenance-fence cleanup and post-takeover rollback as unobserved;
passing this earlier preparation failure is not evidence of either later phase.

## Source and artifact contract

Commit this harness before freezing the candidate source. Package all targets and
the signed npm/legacy descriptors from the same reviewed source. A later harness
retry must descend from that source, change only the existing explicit test/docs
allowlist, and keep truthful, distinct artifact and harness commit identities.
Runtime, build payload and production authorization changes are not harness-only
retries. Never forge `GITHUB_SHA` or a successful preparation run.

The candidate receipt requires an exact original successful standalone signing
run/attempt and its immutable Actions archive digest. Its server bundle verifies
both signatures, canonical source/export identity, runtime bytes and executable
modes. It includes the original signer archive and verified import report. The
macOS asset set and embedded server descriptor are also byte-bound. Sealing is
not signing and cannot manufacture missing signer provenance.

The unpublished `candidate-replay-vVERSION` draft must contain exactly
`candidate.json` and `candidate-bundle.zip`, target the packaged source commit,
and remain an unpublished prerelease. Review their SHA-256 hashes independently.
The candidate input action verifies everything before installation or trust
changes. GitHub requires `contents: write` on the job token to read an unpublished
draft; this is not a technically read-only credential. Only the input action
and the separate stable-fixture download step receive it as `GH_TOKEN` and use
read operations. It is not exported to the
installed software. No production signing secrets or publication commands are in
these jobs.

Dispatch `ci.yml` on the receipt's reviewed `release/*` branch with:

```text
candidate_replay=true
candidate_tag=candidate-replay-v1.0.8-beta.2
candidate_receipt_sha256=<independently reviewed candidate.json SHA-256>
candidate_bundle_sha256=<independently reviewed candidate-bundle.zip SHA-256>
npm_native_validation=false
candidate_server_rollback=false
```

Leave all npm-only artifact inputs empty. The three native modes are mutually
exclusive; ordinary source CI does neither installation journey. Existing npm-only
validation remains available separately and does not establish desktop acceptance.
Do not invoke the hosted-runner trust/process helpers on a developer machine or
an existing local guest, and never remove an app's `disable-auto-update` marker.

## Separate stable-server no-downgrade case

Stable server `1.0.8` must not be downgraded to the receipt's `1.0.8-beta.N`
candidate (currently `1.0.8-beta.2`). The fixture accepts only that same-base
numbered Beta line and binds every observation to the exact signed candidate
receipt; it rejects other bases, Stable, RC and locally relabeled versions.
That requires a
distinct native fixture and observation, not weakening the positive migration's
strictly-older-baseline assertion. The separate `candidate-no-downgrade` job
installs genuine stable server `1.0.8` on its own disposable hosted macOS runner,
then launches the exact signed beta app directly. It does not replace an older
desktop, install origin routing, or alter TLS trust.

The stable archive and signed descriptor are independent inputs, never rewritten
candidate receipt fields. The helper pins stable source
`8a965007408c6ab9672d746366b9fc0bd58feff6`, descriptor SHA-256
`64881777ab0ebf8ad029ec1f4f1212e1699f9ee7a1d62420ae32e5f3dcfe7198`,
and archive SHA-256
`c9846ca863312478f64979cc579feea521902dc23c15f0f30ca5eebdb544808f`.
CI downloads the official `npm-candidate-v1.0.8` draft's three files and compares
its archive byte-for-byte with anonymous official npm registry delivery before
the helper verifies the committed release-key signature and exact stable pins.
Neither the stable release nor its registry tags are changed.

The native helper observes the app's coordination requests through a transparent
loopback relay, checks its real settings UI, and verifies that the healthy stable
service identity and process remain unchanged. Its separate bounded reports have
kind `candidate-no-downgrade-observations` and retain both
`publicationEligible: false` and `releaseAcceptance: false`. Candidate artifact
source, truthful harness source, and stable fixture source remain distinct. A
passing unit suite only validates the harness contract; this native case is not
accepted until the exact signed-package job runs and its observations are reviewed.

Run `36617827033`, attempt 2, passes this scoped case for signed beta.2 build
1234 using artifact source `7b01c458` and harness source `ca611a8`. Reviewed
observations confirm both stable components and process identity remain unchanged
through Settings reopening and app reopening. The valid transparent observer
records eight health requests, five WebSocket upgrades and zero update-endpoint
requests. Signed stable/candidate pins and the installed app hash match their
sealed inputs. This proves no downgrade for that fixture, not provider-history
migration, app self-replacement or public-feed delivery.

## Separate Linux server rollback rehearsal

`candidate_server_rollback=true`, with `candidate_replay=false` and
`npm_native_validation=false`, selects only the server rollback jobs (root modes
`0755` and `0750`) plus source checks. Supply the same independently reviewed
`candidate_tag`, `candidate_receipt_sha256` and `candidate_bundle_sha256` above.
This default-off mode has its own concurrency group; it does not rerun the macOS
desktop matrix.

The `candidate-server-linux` execution scope requires the real hosted Linux
`candidate-server-rollback-linux` job. It uses the existing matched macOS
candidate seal as immutable **server** provenance, without relabeling that seal
or accepting a Linux desktop. Original signer artifact, signatures, source tree,
package bytes and harness ancestry are checked unchanged. No new harness paths
are allowlisted. The listener exposes only signed-server discovery and archive
routes; desktop assets are hash-verified as sealed inputs but never served or run.

After installing the genuine older signed Beta, the existing kernel-pidfd
watcher targets only a newly started exact candidate worker under its verified
`candidate-starting` transaction. It never selects the incumbent or another
service by process name. The real installer must roll back; the harness then
requires restored authenticated component versions, native service PIDs, unit
files, runtime link, identity/token/session snapshot, released execution
maintenance and cleared activation journals. Only after the watcher stops does
it retry the same accepted version and verify both installed components plus
runtime byte/mode parity. If the health-fault window is missed, the job fails
without claiming rollback.

Run `36617217705`, attempt 1, passes both native Linux permission cases for
`1.0.8-beta.2`. Its reports bind artifact source
`7b01c4586e2c2cbe45bcd8b871e54b92a8aa7e37`, harness source
`ed24d709513b878c9e46296cf4971e43eb76ad24` and candidate receipt SHA-256
`67d3492468e7af635a8b116777a7d530110dfb3d9dd4bac4bfe4c928bbd5b80d`.
Both observe actual rollback, the restored authenticated incumbent, preserved
identity/token/snapshot, cleared installer journals, and successful same-byte
retry with both components healthy and all 118 runtime files verified. These are
scoped server observations, not desktop or populated-provider acceptance.
The reports retain `publicationEligible: false`, `releaseAcceptance: false` and
`desktopAcceptance: false`. Team Hub fence consumption, authenticated provider
history, power-loss/reboot recovery and macOS rollback are not established by
this server-only journey.

## Deliberately uncovered

This rehearsal does not establish authenticated provider-history preservation, busy or
queued real work, logout/reboot, Windows native
update acceptance, or real public-feed/registry delivery. Inspect the structured
reports for blocked checks; scoped observations cannot authorize publication.
The macOS matrix does not establish Linux candidate-health rollback; only an
actual successful separately reviewed Linux rollback run can provide that
scoped evidence.

## Manual fresh-account checks for this candidate

Use a separate new Apple Silicon macOS account with a normal logged-in desktop
session, Node 22.14 or newer, trusted `uv`, and the provider CLIs you intend to
test. Authenticate those providers normally in that test account. No npm account
or publishing/signing credential is needed. Do not copy another account's private
credentials, change `HOME`, use `sudo`, or remove existing history to make an
installation proceed.

The supplied `1.0.8-beta.2` files must have these SHA-256 hashes:

```text
bc00e50d84743b60c63e335ccc1ccf812b50d5595fec29a0f4674543bec963a3  AgentsDock-1.0.8-beta.2-mac-universal.zip
44b3ee3d2f263cba3779df33d8b7a648625ed4877a7bfaa55f677eabb4f8baa5  server-1.0.8-beta.2.tgz
```

After comparing `shasum -a 256` output for both Downloads files, install the
exact supplied npm archive, not the still-older floating `beta` registry tag:

```sh
cd "$HOME/Downloads"
AGENTSDOCK_QA_CLI="$(mktemp -d "${TMPDIR:-/tmp}/agentsdock-beta2-cli.XXXXXX")"
npm install --offline --ignore-scripts --no-audit --no-fund \
  --package-lock=false --prefix "$AGENTSDOCK_QA_CLI" \
  "$PWD/server-1.0.8-beta.2.tgz"
node "$AGENTSDOCK_QA_CLI/node_modules/@agentsdock/server/npm/cli.cjs" --version
```

Stop unless the CLI version prints exactly `1.0.8-beta.2`. Then run:

```sh
node "$AGENTSDOCK_QA_CLI/node_modules/@agentsdock/server/npm/cli.cjs" \
  install --port 17850 --bind 127.0.0.1
```

The runtime installer still needs network access. If it refuses an existing
installation or custom root, stop; do not bypass the refusal. Extract the supplied
Mac ZIP and launch that exact app from the test account. Connect to
`http://127.0.0.1:17850` using the installer's token privately. Expect app build
1234 and both app/server version `1.0.8-beta.2`.

- Complete a real chat and harmless file action in a disposable folder with
  each provider being accepted.
- Quit/reopen the app, reopen the same chat and continue it. Check saved server
  settings, history and attachments.
- Log out/in or reboot, reconnect and continue that same chat. This checks
  service persistence, not cache independence; the separate native npm jobs
  test independence from the temporary npm installation.
- Report exact app/server versions, macOS/architecture, providers and pass/fail
  results. Redact tokens, private paths and identifiers from shared evidence.

These checks do not establish an old-to-new one-click update, populated-history
migration, or active/queued-work preservation. Those require an older same-Beta
server containing genuine provider sessions and queued work, followed through the
exact signed updater/relaunch/coordinator journey in an authorized isolated
replay. Do not install the hosted-runner origin/trust fixture on a working Mac or
spoof its safeguards. Public feeds cannot deliver this candidate before it is
published; manually copying the ZIP is not updater acceptance.

Both preparation-failure and rollback observations bind the installation root
to its original device/inode/owner. The audited signed installer intentionally
tightens legacy `0755`/`0750` permissions to `0700` under its installation lock;
it does not restore broader permissions after failure. The harness permits
only that exact transition (or retained `0700`), bound to the verified installer
bytes, while keeping the other native preservation checks exact.
