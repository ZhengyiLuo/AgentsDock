# Private macOS candidate rehearsal and publication records

This is a scoped test in the existing registered `ci.yml`, not a product release
workflow. It installs exact signed packages and changes origin routing/trust only
on disposable GitHub-hosted macOS runners. It never signs or publishes packages.
All candidate receipts and observations remain `publicationEligible: false`;
observations also remain `releaseAcceptance: false`. A successful job does not
turn blocked or unobserved scenarios into full release acceptance.

## 1.0.10-beta.3 harness preparation only

The exact `1.0.10-beta.3` candidate may use the same independently pinned
`beta1101` baseline and both `0755`/`0750` macOS journeys described below.
Historical beta.2 support and receipts remain unchanged; beta.3 requires its
own committed source, native build reservation, signed packages and sealed
candidate receipt/bundle. The complete beta.3 installer is byte-identical to
the reviewed beta.1/beta.2 installer pinned below. No other candidate version,
baseline, execution scope, source/hash guard or acceptance policy is added.
Dispatch inputs, when separately authorized and those exact artifacts exist,
must name `candidate-replay-v1.0.10-beta.3` and its own independently reviewed
hashes. This preparation is not a native-run, signing or publication receipt:
`publicationEligible: false`, `releaseAcceptance: false` and every unobserved
provider-history, active/queued-work, reboot, public-feed, Windows and short-CLI
boundary remain intact. Never relabel beta.2 observations as beta.3 evidence.

## Frozen 1.0.10-beta.2: exact beta.1 upgrade rehearsal

For this frozen beta.2 rehearsal, `beta1101` targets `1.0.10-beta.2`, build 1246,
whose frozen application/server source is
`8d5327a9077f69f9a0a14c58b8e087a80f7f1762`. A reviewed harness-only descendant
may exercise those unchanged signed bytes; its own truthful source SHA remains
separate, and the receipt still names `release/1.0.10-beta.2`. Existing checkout,
ancestry, hosted-runner and explicit test/docs allowlist guards remain intact.

The baseline is the published signed app `1.0.10-beta.1`, native build 1245,
and matching signed npm server, both from
`7790690fc91f0d6331b265820ef64234f5213abd`. The public release identity, actual
downloaded assets, descriptor signature and archive bytes were independently
checked. The npm archive also matched anonymous official-registry delivery.
The committed profile pins are:

| Baseline input | SHA-256 |
| --- | --- |
| Public desktop `SHA256SUMS` | `bf692d32c2b86d1b117761b1a9bd46e9bbe285b11a3fa57be44f965585d4505c` |
| Universal Mac ZIP, build 1245 | `6ba42d86aa8bfd36f3c6abf8e90b385a16c4f5bf857ef171bb35453054e420d4` |
| `beta-mac.yml` | `b923370acefed234af4bdd107a92ebcfbf388b98b75d750813953ef3e751bea8` |
| Npm descriptor | `01286c1d46b6c0673d849b23b258056ebba35068e195ae500e789eb82b21f3fc` |
| Npm signature | `52286edbd8bf9c40bee555ff9defb4e223ba002eec749d1043609d4171281986` |
| Npm archive, 3,727,576 bytes | `050ddc103670df77b3fe31236cd119c71d7b933e0948b7cf85f92afe2ce2056b` |

For this exact candidate, `candidate_replay=true` adds `beta1101` positive
macOS jobs with installation-root modes `0755` and `0750` to the existing
legacy/fresh/recovery matrix. The real app begins and remains on Beta, installs
the exact signed candidate, relaunches, and reconciles the saved server through
the real coordinator. No manual server-update click substitutes for that path.
The npm-baseline fixture still refuses a fresh candidate install over its
incumbent, retires both temporary npm prefixes/caches before native restart, and
authenticates the pinned installed runtime. Beta.2 retains the complete reviewed
beta.1 installer, SHA-256
`51a6ae6f242476ae4f19712b95ecbaba212b2256e3928d389d8f617a6c367ed7`;
only that exact version association is added to the root-normalization policy.

Dispatch the existing `ci.yml` on `release/1.0.10-beta.2` with
`candidate_tag=candidate-replay-v1.0.10-beta.2`, independently reviewed candidate
receipt/bundle hashes, `candidate_replay=true`, `npm_native_validation=false`
and `candidate_server_rollback=false`. Leave npm-only inputs empty. The private
draft must retain exactly the original `candidate.json` and
`candidate-bundle.zip`; the signed candidate is never rebuilt by this harness.

This harness support and its tests do not record a successful native run or
publication. The old no-downgrade fixture remains limited to its actual
same-base `1.0.8-beta.N` scope; it is not relabeled as beta.2 evidence. Keeping
public stable `1.0.9` and its registry/feed tags unchanged is a separate release
publication invariant. Reports retain `publicationEligible: false` and
`releaseAcceptance: false`. Empty API-session persistence is not genuine older
provider-history acceptance; the fixture deliberately stops its owned server
before app replacement and cannot establish active/queued-work safety. Reboot,
Windows updater and public candidate-feed delivery remain unobserved. The new
unscoped CLI global-auto-setup and split-layout lifecycle checks are separate
native acceptance gaps, not covered by scoped npm installation or this replay.

## Reviewed stable 1.0.9 rehearsal extension

The harness now also accepts the exact stable version `1.0.9`, with a stable
signed descriptor and `latest-mac.yml`. Other stable versions remain rejected.
This harness support does not confer release acceptance; completed scoped runs
are recorded below. Its candidate draft remains unpublished and marked prerelease as
a test transport; the sealed payload itself has the genuine stable identity.
Every report retains `publicationEligible: false` and `releaseAcceptance: false`.
The existing production receipt, publication and hosted-runner guards are unchanged.

For `candidate-replay-v1.0.9`, the macOS matrix contains eleven jobs: the existing
fresh, legacy, interrupted-download and failed-stage cases, plus both `0755` and
`0750` root modes for each independently pinned profile below. Beta candidates
retain their original seven positive jobs and separate no-downgrade job. The
same-base `1.0.8-beta.N` no-downgrade job is skipped for `1.0.9`, never reinterpreted
as a stable upgrade. The separate two-case Linux rollback dispatch remains
server-only and starts from the genuine signed legacy `1.0.7-beta.21`.

| Profile | Actual desktop baseline | Actual server baseline | Desktop subscription |
| --- | --- | --- | --- |
| `stable108` | Published signed app `1.0.6` | Published signed npm server `1.0.8` | Stable before and after replacement |
| `beta1085` | Published signed app `1.0.8-beta.5`, build 1242 | Published signed npm server `1.0.8-beta.5` | Beta before and after stable promotion |
| `legacy` | Published signed app `1.0.6` | Signed legacy server `1.0.7-beta.21` | Stable for the stable candidate; existing Stable → Beta journey for beta candidates |

The independent source, descriptor, signature, archive, public checksum and
updater-metadata pins are committed in `product-candidate-receipt.mjs`.
The `1.0.6` ZIP is pinned to
`1ca6530cf72818d26e68af571f77d2eb0473e0e7b07923358f696b4a1673b7ee`;
its public `SHA256SUMS` is pinned to
`4bbe9fb4db61234542116f5de518872ebd4f2aa0805b1c06afd2032282eed828`.
The beta.5 public checksum manifest is the full release inventory, not the
smaller checksum manifest in the earlier scoped replay bundle. Baseline npm
archives must also match anonymous official-registry bytes before installation.
Neither baseline metadata nor a rewritten candidate receipt can substitute for
these independently authenticated incumbent identities.

The npm baselines are installed only into an empty disposable runner account.
Their exact runtime is checked after retiring temporary npm prefixes/caches and
performing a native service restart. The candidate fresh-install CLI must refuse
that incumbent without changing its identity or process. This is fixture setup,
not permission to install fresh npm over an existing user server. The actual
upgrade still follows the signed desktop updater, native replacement/relaunch,
offline saved-server reconciliation and two-client operation checks. Stable
users do not select Beta; beta.5 subscribers do not switch to Stable to obtain
the stable candidate. A successful beta.5 server upgrade exercises the real
production channel handling, but reports do not claim an independently observed
HTTP 409 or legacy-bridge wire count.

Use the existing explicit dispatch inputs with
`candidate_tag=candidate-replay-v1.0.9` and the independently reviewed receipt
and bundle hashes. Do not substitute beta.5 hashes or source pins. A later
harness-only retry must still descend from the exact sealed product source and
pass the same explicit test/docs allowlist; `GITHUB_SHA` remains the real harness
commit. The installer permission policy retains whole-file pins: the reviewed
`1.0.9` installer differs by the Side chat progress module inventory and compile
registration, not by its lock or root-normalization behavior.

These jobs still seed an empty persisted API session. Genuine authenticated
provider history, active or queued real work, interactive setup, logout/reboot,
Windows updater acceptance and public candidate-feed delivery remain unobserved.
In particular, this journey deliberately stops the owned server before the
desktop update; it cannot pass a busy-server safety check. Passing source tests
or these scoped native jobs cannot clear those release blockers.

### 1.0.9 prerequisite failures and reviewed test-only correction

The sealed `1.0.9` build 1243 remains pinned to source
`33c21482170010108830aef8009831d5d1da624c`. Mac replay
[`36826142416`](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/36826142416)
and Linux rollback
[`36826167466`](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/36826167466)
both failed their repeated Electron source-test prerequisite on attempt 1.
Neither native matrix started; neither run produced native observations.

- The Mac dispatch reported 5,111 passing tests but caught an uncaught Radix
  deferred-unmount `dispatchEvent`/jsdom Event-realm error attributed to
  `ProviderUsageIndicator.test.tsx`. Its cleanup must await the owned next-task
  unmount work before the test environment restores globals.
- The Linux dispatch failed the `SecurePeerPanel.test.tsx` late-completion Cancel
  test: it expected one stopped observer but had not established that the observer
  had started. The correction waits for that setup precondition, then retains
  the immediate stop assertion and every late-completion/cancellation check.

Ignored local diagnostics used the actual React/Radix/jsdom renderer and actual
SecurePeer component to reproduce both orderings. Draining the owned unmount
callback avoids the realm error; cancel-before-observer has nothing to stop but
still clears consent and fences adoption, while cancel-after-observer stops it
immediately. These diagnoses ran on local Node 26.7, not the hosted CI Node 24;
they do not substitute for the next complete hosted prerequisite/native run.
No error suppression, assertion removal, timeout increase or runtime correction
is part of these two test-only changes.

The candidate guard keeps its generic harness allowlist unchanged. A separate
exception is bound to the exact sealed source above and `release/1.0.9`, and
admits only these modified regular `100644` files with the exact Git blobs:

| Test | Original blob | Corrected blob |
| --- | --- | --- |
| `ProviderUsageIndicator.test.tsx` | `69fab9e26f994a1d50c10797887d3dc16f8492bb` | `b054eb3ed2b6bf9b08d8d0fec4c12c71dc9e64f7` |
| `SecurePeerPanel.test.tsx` | `9bdd50a7ddc761c843fc7eff36eaed23cf83709f` | `6be941a7eb733169661685aac581096b576e1770` |

Both live under `electron/src/renderer/src/components/`. Other sources/refs,
blobs, modes, additions, deletions, renames, third test files and runtime/build
changes remain rejected. A corrected descendant harness must report its own
truthful commit independently of the unchanged signed artifact source. The
original failed runs and all non-acceptance flags remain part of the evidence.

### Completed 1.0.9 scoped runs; original pre-publication evidence

Mac run [36828381882](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/36828381882)
passes all eleven native jobs on attempt 1. Linux run
[36828384720](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/36828384720)
passes both server-only rollback/retry jobs on attempt 1. Their hosted Node 24
source prerequisites also pass after the reviewed test-lifecycle corrections.
The truthful harness source is `9cda924f88c795a81c869f02b74994638ff30888`;
the unchanged signed artifact source remains
`33c21482170010108830aef8009831d5d1da624c`, version `1.0.9`, build 1243.

Independent hashes for these unchanged inputs are:

```text
36f46a01cfb1488bcbc4719fbb4a2a01e9989d3bd1ff0de256ad48e0e98718f1  candidate.json
a7e892779d1e0f4f7b5003c529deab77104910b365f7c8ba5b61d5eb5aaaa20e  candidate-bundle.zip
58cffd8372f495f18dcf77d1aff0c8240543548e3b1fa984d35c8993e024df1d  npm descriptor
8b5c44b5872392f89cd43b9996ba658c2d364c541748b0cb05f2801258f2be5c  full desktop SHA256SUMS
```

All thirteen original observation ZIPs and 31 contained reports match their
GitHub artifact digests, run/attempt, source identities and candidate pins. The
six positive Mac journeys observe actual signed app replacement/relaunch,
automatic saved-server reconciliation, zero manual server-update clicks,
preserved subscription preferences and two clients sharing a completed operation.
Both root modes pass for all three baseline profiles above. Interrupted-download
and preparation-failure recovery pass; Linux observes genuine candidate-worker
failure, restored healthy incumbent and successful same-byte retry with all 119
runtime files verified.

The green jobs do not erase blocked report fields: each positive Mac report's
provider-history migration check remains blocked because the fixture has no
populated native provider history; fresh interactive setup and busy-work checks
also remain blocked. No real-provider reply, active/queued-work preservation,
logout/reboot, native Windows updater journey, complete recovery-service
retirement or Team Hub fence cleanup is established. Eligibility/acceptance
flags remain false. No package is public as a result of these tests, and no
existing user service or installation was changed.

### Packaged real-provider follow-up

A separate delegated native run exercises the exact signed `1.0.9` Mac package,
build 1243, through production IPC and the unchanged signed npm runtime from
source `33c21482170010108830aef8009831d5d1da624c`. It uses a real Codex provider
with isolated app/server state and a foreground server, not a managed service
installation. The release review checked the supplied receipt and UI evidence;
the original hosted observation archives are not rewritten.

The run records a real tool call reading a disposable canary, Side chat inheriting
that tool context, a contextual follow-up, visible side tool activity and side
cancellation while the parent continues working. The parent finishes normally;
renderer reload in the same app/server processes retains side history; this is
not an app relaunch or service restart. The context check establishes retrieval
of the prior tool output, not complete native-context parity. The receipt reports
unchanged original authentication, removal of the owned test credential snapshot
and termination of the foreground test server. It does not independently
establish termination of every app or provider descendant. No private test
transcripts, authentication or state are committed.

```text
b50630a24781abb704105940fcca0dbbda5140b259eb9273860b05bea054bf9f  packaged live-provider receipt
197bf67c06558a6dc547e7a328c52e2ed309b698297d5c92a05330dd608a3e02  scoped follow-up audit
```

This closes the scoped real-Codex packaged UI gap, not the remaining installation
and migration gates: genuine populated native history across installation,
active native work plus a durable queue during a managed update, interactive
pairing and optional-dependency decline, and logout/reboot service survival.
It does not establish another provider's behavior, natural OAuth renewal or
public-feed delivery. The audit still records `releaseAcceptance: false` and no
publication. At that review, the dedicated CI publishing credential was missing.
The subsequent verified publication path is recorded below; the accepted source,
build, package hashes and original acceptance flags remain unchanged.

## Current delivery status

Stable `1.0.9`, build 1243, is now public in the canonical desktop repository,
legacy desktop mirror, npm registry and signed server bridge. Product source is
`33c21482170010108830aef8009831d5d1da624c`; standalone export is
`77cbd97d55bc6ec4063157f863dec80a06ac9ba8`. The source and hashes above still
identify the released bytes. Npm `latest` now selects `1.0.9`; `beta` remains
`1.0.8-beta.5`, and the previously published stable `1.0.8` is retained.

The original four native desktop publication jobs passed in
[36835821983](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/36835821983),
attempt 1, using verification workflow
`9c4eaa1ec34dc1c730d9468eb90d5a26edf395d8`. Its original receipt artifact and
live GitHub run/job identities were independently checked against all five equal
checksum seals. The verification-only run did not publish. The exact npm tarball
was then published and downloaded/verified by its existing OIDC workflow
[36836420634](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/36836420634),
followed by the signed bridge and desktop/mirror through the immutable helpers
with existing local GitHub authentication. No token was extracted or repurposed.

Publication was explicitly requested after disclosure of the remaining native
migration, active/queued-work, interactive setup, reboot and Windows-update gaps.
Those boundaries remain unvalidated: all original observation archives and
`publicationEligible: false` / `releaseAcceptance: false` fields are retained.
This publication record is not a replacement acceptance receipt. See
[the public release record](DEV_LOG.md#2026-10-01--publish-matched-stable-109-build-1243).

### Previous Beta delivery (unchanged)

The newest published Beta is `1.0.8-beta.5`, build 1242, from source
`85327b94a378c441949da5e775e265626743b6c6`. It adds bounded contention handling
to the pinned installer preparation/activation path and retains the beta.4
desktop contribution and admission/identity safeguards. Signed server bundles,
fresh npm validation and all platform builds pass. The Mac app and DMG are
signed/notarized and independently verified. Exact-package Mac replay
`36801481030` (all eight scenarios) and Linux rollback/retry `36801483306`
(both root modes) pass on attempt 1. All ten original observation archives
match their GitHub provenance and exact candidate pins. The signed app really
replaces/relaunches, then automatically reconciles the reconnected server;
the stable `1.0.8` no-downgrade case and scoped recovery checks also pass.
The exact npm, signed legacy bridge, desktop and mirror packages are public;
publication is recorded separately in [DEV_LOG.md](DEV_LOG.md). This does not
promote these scoped observations to full production acceptance. Receipt SHA-256:
`fdcf48e5f256a21856a1b3e0475b467ebd903bb9c12ce8a466d57c7a07e4ee5f`;
transport ZIP SHA-256:
`4d479f1c9ee64f4784da2cdb52cda345c80187565a105cc5a324d8267b312b8e`.
At that Beta publication, npm `beta` selected `1.0.8-beta.5` and `latest` remained
stable `1.0.8`. The newer stable publication is recorded above.
Beta.4's frozen evidence below is retained;
none may be relabeled as beta.5 acceptance.

The preceding candidate is `1.0.8-beta.4`, build 1241, from source
`1a99b00b6e50271bc97dadd12ec3d701c3168809`. Its universal Mac app is signed,
notarized and checked; its matched npm/legacy archives retain the existing
server trust key. Exact fresh npm installation passes on macOS and Linux in
run `36790484232`. Linux x64/ARM64 and Windows x64 package verification pass in
run `36790520350`; Windows is explicitly an unsigned beta preview.

All eight Mac native replay jobs pass in run `36791634579`, attempt 1, on the
same source. Both legacy permission cases observe actual signed app replacement
and relaunch, automatic server reconciliation after reconnect, two native clients
sharing one operation, and fixture-state preservation. Interrupted-download and
failed-stage retry pass, and the stable `1.0.8` no-downgrade case passes. The
sealed candidate receipt SHA-256 is
`f136eb822b8196a951e09e343ae262744262579ec1fafc7d5209a55dbde8ff0b`;
transport ZIP SHA-256 is
`03f24da4ab615c4c6e788af6b8cd8f63d6232e297fd3b01ea4fe9019118d6297`.
These observations do not fill the real-provider, busy-work or reboot gaps.

The beta.4 npm, bridge and desktop assets are still unpublished drafts. Linux
rollback run `36791637171`, attempt 1, passes `0750` but fails `0755` while
waiting for exact candidate health after a verified rollback and retry request.
The original failure is retained and publication is held for diagnosis; the
passing sibling does not clear it. npm `beta` still selects
`1.0.8-beta.2`; `latest` remains stable `1.0.8`. Do not expect a floating tag or
public feed to deliver this candidate until its publication receipt appears in
[DEV_LOG.md](DEV_LOG.md). Frozen earlier candidate assets are unchanged.

A diagnostic-only harness descendant adds bounded retry-admission, on-disk
update status and owned lock/recovery observations for an instrumented Linux
replay. It does not change the signed packages, waits, retry count, fault scope
or acceptance assertions. The original failed run remains part of the evidence;
instrumentation passing its own tests is not recovery acceptance.
Run `36796459142`, attempt 1, passes both instrumented Linux cases on harness
`963ddeba38f7e9b77435e7fa89562b6b2aabab8d` and unchanged signed source. The
reports observe successful exact-package retries but do not establish the
first run's timeout cause. Its failure remains unresolved; publication is still
held pending targeted investigation rather than silently cleared by a rerun.
A separate function-boundary probe reproduces a live recovery-lock collision
causing the published beta.21 preparation path to fail without automatic
continuation after unlock. It does not establish the original CI cause or
native acceptance. A production correction requires a new version/source pin
and rebuilt matched packages; beta.4's signed bytes must not be replaced.

This is an explicitly authorized Beta testing release, not complete coordinated
release acceptance. Genuine authenticated provider-history preservation and
active/queued provider work during migration remain unverified. The observations
below keep their original scope and `releaseAcceptance: false` values.

For an existing server saved in the beta app, let its work finish, then
use **Settings → Updates → Retry server update** on one server first. Verify the
reported version and reopen/continue an existing chat before retrying others.
Compatible stable `1.0.8` servers must remain unchanged. Do not run a fresh npm
installation over an existing managed server.

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
candidate_tag=candidate-replay-v1.0.8-beta.5
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
candidate (currently `1.0.8-beta.5`). The fixture accepts only that same-base
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

## Current 1.0.9 private candidate: manual fresh-account checks

These instructions apply only to the privately supplied `1.0.9` build 1243
candidate, not a published release or an updater acceptance result. At this
checkpoint, the public npm `latest` tag still selects stable server `1.0.8`.
Do not substitute a floating registry tag for the exact archive below.

Use a separate new Apple Silicon macOS account with a normal logged-in desktop
session, Node 22.14 or newer, trusted `uv`, and the provider CLIs being tested.
Authenticate providers normally in that account. No npm/publishing credential is
needed. Do not copy another account's credentials, redirect `HOME`, use `sudo`,
or delete existing history to make installation proceed.

Compare `shasum -a 256` for the two supplied Downloads files with these exact hashes:

```text
4d5125a374a1e20ea15a4aa42d9d5c2eb36a7f8ed46ab694500c0ba5e38eeeb9  AgentsDock-1.0.9-mac-universal.zip
33ca47b105e8d2e8256df6b5c199e0e95972f9228399d8944e32c2e910de8ab8  server-1.0.9.tgz
```

Install only the supplied npm archive into a new temporary CLI directory:

```sh
cd "$HOME/Downloads"
AGENTSDOCK_QA_CLI="$(mktemp -d "${TMPDIR:-/tmp}/agentsdock109-cli.XXXXXX")"
npm install --offline --ignore-scripts --no-audit --no-fund \
  --package-lock=false --prefix "$AGENTSDOCK_QA_CLI" \
  "$PWD/server-1.0.9.tgz"
node "$AGENTSDOCK_QA_CLI/node_modules/@agentsdock/server/npm/cli.cjs" --version
```

Stop unless the version is exactly `1.0.9`. Then run the interactive installer:

```sh
node "$AGENTSDOCK_QA_CLI/node_modules/@agentsdock/server/npm/cli.cjs" \
  install --port 17850 --bind 127.0.0.1
```

The runtime installer needs network access. Stop if it refuses an existing
installation or custom root; do not bypass the refusal. Extract the exact Mac
ZIP into a new folder, launch that app and pair privately with
`http://127.0.0.1:17850` using the installer's token. Verify app build 1243 and
both app/server version `1.0.9`.

- Complete a real chat and harmless file action in a disposable folder with
  each provider being accepted. In the packaged app, exercise Side chat tool
  context, a follow-up, pending Stop and active Clear; the parent must remain
  unaffected and navigation/reopening must not resurrect or misattribute replies.
- Record interactive pairing and any optional-dependency-decline branch actually
  exercised. If no such prompt appears, leave that branch unobserved.
- Quit/reopen and continue the same chat; check saved server settings, history
  and attachments. Once work is idle, log out/in or reboot, reconnect and continue
  it again. This proves only the persistence actually observed, not live-turn
  survival through worker death or reboot.
- Report exact versions/build, macOS/architecture, provider CLI versions and
  pass/fail. Redact tokens, private paths and identifiers from shared evidence.

A fresh account cannot establish populated older-provider-history migration or
active/queued-work preservation. Those still require genuine older baselines and
the actual signed one-click update/relaunch/coordinator journey in an authorized
isolated environment. Copying this ZIP is not updater acceptance. Never install
hosted-runner origin/trust fixtures on a working Mac or spoof their safeguards.

## Archived 1.0.8-beta.4 manual fresh-account checks

Use a separate new Apple Silicon macOS account with a normal logged-in desktop
session, Node 22.14 or newer, trusted `uv`, and the provider CLIs you intend to
test. Authenticate those providers normally in that test account. No npm account
or publishing/signing credential is needed. Do not copy another account's private
credentials, change `HOME`, use `sudo`, or remove existing history to make an
installation proceed.

The supplied `1.0.8-beta.4` files must have these SHA-256 hashes:

```text
afb66f4a21d0f9bd63297b5b1e39d7084da792b41d244b408ff51c3cfd6c2517  AgentsDock-1.0.8-beta.4-mac-universal.zip
b4a906bd95b7ae5f59d1f337937715f5dd8fc954d520a1a200015097718e1dba  server-1.0.8-beta.4.tgz
```

After comparing `shasum -a 256` output for both Downloads files, install the
exact supplied npm archive. Keep this reproducible check pinned to its exact
bytes rather than relying on a floating registry tag:

```sh
cd "$HOME/Downloads"
AGENTSDOCK_QA_CLI="$(mktemp -d "${TMPDIR:-/tmp}/agentsdock-beta4-cli.XXXXXX")"
npm install --offline --ignore-scripts --no-audit --no-fund \
  --package-lock=false --prefix "$AGENTSDOCK_QA_CLI" \
  "$PWD/server-1.0.8-beta.4.tgz"
node "$AGENTSDOCK_QA_CLI/node_modules/@agentsdock/server/npm/cli.cjs" --version
```

Stop unless the CLI version prints exactly `1.0.8-beta.4`. Then run:

```sh
node "$AGENTSDOCK_QA_CLI/node_modules/@agentsdock/server/npm/cli.cjs" \
  install --port 17850 --bind 127.0.0.1
```

The runtime installer still needs network access. If it refuses an existing
installation or custom root, stop; do not bypass the refusal. Extract the supplied
Mac ZIP and launch that exact app from the test account. Connect to
`http://127.0.0.1:17850` using the installer's token privately. Expect app build
1241 and both app/server version `1.0.8-beta.4`.

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
spoof its safeguards. Manually copying the ZIP is not updater acceptance, and
the preparation receipt does not imply public availability of this candidate.

Both preparation-failure and rollback observations bind the installation root
to its original device/inode/owner. The audited signed installer intentionally
tightens legacy `0755`/`0750` permissions to `0700` under its installation lock;
it does not restore broader permissions after failure. The harness permits
only that exact transition (or retained `0700`), bound to the verified installer
bytes, while keeping the other native preservation checks exact.
