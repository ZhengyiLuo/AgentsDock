# Matched npm runtime and short CLI releases

`@agentsdock/server` supplies the signed runtime. `agentsdock` supplies the short
command and its reviewed first-global-install hook. Publish both from one clean,
committed source snapshot and one public version; the CLI dependency must be
`"@agentsdock/server": "VERSION"`, never a range or floating tag. The desktop
continues to pin the signed runtime descriptor, not a floating npm channel.

## 1.0.11-beta.2 public completion

Product source `853dcd285ef442176370632149deba21ef732eda` is frozen. The reviewed
orchestrator `197f07b9ca949c1a81441d18b46a048764d6dd2d` changes only release
orchestration/docs, not the packaged application or runtime. Native CLI
[acceptance 39099183063](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/39099183063)
passes on macOS and Linux; the signed macOS app also passes real Gemini
API/CLI conversation, automatic-title and reload acceptance against the exact
packaged server. See the [development log](DEV_LOG.md) for scope and limits.

Attempt 1 of [paired publication 39103091104](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/39103091104)
accepted the runtime upload through OIDC, then exhausted 61 read-only registry
checks before it became public. On 2026-10-18 UTC, attempt 2 verified and skipped
that unchanged runtime, published the accepted short CLI through its own
Trusted Publisher, and verified both exact public archives. Both `beta` tags
now resolve to `1.0.11-beta.2`; both stable `latest` tags remain `1.0.10`.
A fresh isolated scripts-disabled registry installation verifies the matched
versions, exact runtime dependency and CLI help without operating any service.

The signed legacy server bridge, canonical desktop and compatibility mirror
are public. [Desktop publication 39177990728](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/39177990728)
reverified all four native platforms before publishing the unchanged build 1261.
The original product source, accepted archives and checksum manifest remain
frozen; later documentation commits are not new artifact sources. Keep the
documented native UI, clean-quit and upgrade acceptance limits distinct from
successful publication. See the [development log](DEV_LOG.md).

## 1.0.11-beta.1 public completion

On 2026-10-13 UTC, [paired publication 38370285507](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/38370285507)
published and verified both exact packages from source
`e93391294af2cb0c35f5f04fe8e94cce77810458`, with separate package-specific OIDC
trust. Both `beta` tags resolve to `1.0.11-beta.1`; both stable `latest` tags
remain `1.0.10`. An isolated scripts-disabled registry installation confirms
the exact versions, matched runtime dependency and CLI help without operating
existing services.

The signed legacy server bridge, canonical desktop and compatibility mirror
are public. [Desktop publication 38431444310](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/38431444310)
reverified all four platforms and published the unchanged build 1252. Native
macOS/Linux CLI lifecycle checks and import-focused signed macOS app acceptance
passed, including actual Claude/Codex continuation. Full populated-history and
busy-work upgrades, reboot, Windows updater and clean-quit acceptance remain
unverified; the release notes retain these limits. See the
[public development log](DEV_LOG.md#2026-10-13--accept-imports-and-publish-1011-beta1).

The release integrates main through `2b666a9f` into the frozen 1.0.10 line.
Its streaming transcript reader is included in the runtime inventory and its
installer has an exact-version acceptance pin. Historical installer pins and
accepted archives remain unchanged. A later documentation commit is not a new
artifact source; never rebuild this published version.

## 1.0.10 public completion

The earlier stable publication completed on 2026-10-13 UTC. Attempt 2 of
[paired publication 38346314422](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/38346314422)
verified the existing runtime and published the short CLI through its own
Trusted Publisher. [Desktop publication 38362425715](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/38362425715)
published the unchanged build 1251 to both download repositories after native
verification; the signed legacy server bridge is public as well. The previous
pending-publication notes below are historical, not the current release state.

## Stable 1.0.10 preparation

The separately frozen stable candidate is `1.0.10` on `release/1.0.10`, based on the reviewed
beta.6 source plus release-blocking fixes. Build new versioned artifacts from
its final committed source; never relabel or replace beta.6 archives. The older
beta preparation details below are retained as historical context, not the
source/version selection for this stable cut.

Recheck registry state before publishing. On 2026-10-12 the observed runtime
`latest` is `1.0.9`; the short CLI's first publication caused npm to assign
`latest` to `1.0.10-beta.6` as well as `beta`, despite explicit beta publication.
For stable preparation, pin those two distinct observed baselines. The stable
publish intentionally advances both `latest` tags to the new stable version.
Do not pretend the prior CLI baseline was absent or silently change its tag.

The stable candidate's native CLI check includes immediate named stop/start,
with no observer or sleep between the two commands, and requires a fresh,
stable authenticated server epoch. The earlier beta-only exception does not
waive stable native acceptance. The registry verifier permits npm's empty
`directories: {}` normalization but no nonempty mapping or other resolver drift.
Full app/update acceptance and the separate short-package Trusted Publisher
remain required; source tests and an existing-version registry check do not
prove either. No stable publication is recorded by this preparation section.

### 1.0.10 publication attempt

[Paired publication 38346314422](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/38346314422)
accepted the exact runtime upload through OIDC, but exhausted its bounded
read-only registry verification window. At the subsequent 2026-10-13 UTC
check, npm's authenticated lifecycle API reported `validating` and the public
registry did not contain `@agentsdock/server@1.0.10`. The CLI upload had not run;
neither `latest` tag had advanced. This is not a completed matched publication.

The short package's separate GitHub Trusted Publisher is configured for this
repository, `server-npm-publish.yml` and `npm-release`; its first OIDC publication
still needs verification. Do not re-upload while validation is pending. Once
the exact runtime becomes public, rerun the failed job with its unchanged
accepted pins so it verifies and skips the existing runtime before publishing
the CLI. Only proceed to desktop publication after both packages and the signed
legacy server bridge have been verified publicly.

## Historical beta preparation

This document describes release preparation, not a publication receipt. As of
2026-10-07, runtime `latest` is `1.0.9`, runtime `beta` is `1.0.10-beta.4`, and
`agentsdock` is not public. Leave those existing bytes and stable defaults alone.
The selected new matched candidate is `1.0.10-beta.6`; it must preserve stable
`1.0.9` and npm `latest`. Recheck registry/release state before any publication.
Main's development `server/VERSION` is not a release reservation. Do not overwrite
published beta.4 or the frozen private beta.5 candidate, or silently drop fixes
maintained on the release branch.

At the reviewed preparation pins, main `3964cf80` is an ancestor of beta.4 source
`941bc4cd`. Start the next release branch from that frozen release source, then
apply the reviewed pipeline changes without rewriting the old tag. A version
bump on main alone would omit already-shipped pending-update HTTP error handling,
signed-update lock waiting, executable packaging permissions and native build
reservation fixes, among other release-line changes. Review the resulting merge
and run its full source checks before accepting any new package.

The frozen beta.5 source integrated main's reviewed custom-API/OpenCode fixes
and the paired CLI pipeline on that beta.4 release line. Beta.6 starts from the
same reviewed source plus the CLI PATH-persistence fix: temporary npm lifecycle,
npx-cache and node-gyp paths must not become service dependencies. Stable absolute
provider/user/Node path spellings remain intact; existing saved service PATHs are
not rewritten. The installer bytes and signing trust roots are unchanged.

Use `release/1.0.10-beta.6` and its final committed source for every new artifact.
The earlier beta.5 native build reservation is consumed. Recheck the public
preparation counter and all other reservations before assigning beta.6's build;
never reuse another run's allocation or restore main's older build formula.
Do not reuse beta.5 tarballs, signatures, checksums or acceptance receipts for
beta.6. These instructions are not an artifact or acceptance receipt.
## Operating releases from another computer

The operator computer can be a controller, not the signing host. Use a canonical
checkout and authenticated GitHub CLI (or the GitHub Actions UI). GitHub-hosted
jobs consume protected environment secrets; the operator need not download the
Developer ID private key, Apple API key, server signing key or npm OIDC token.
Local source checks additionally need the repository's pinned Node/pnpm and
Python tooling. Local native builds are a separate optional setup, not a
prerequisite for dispatching hosted builds.

Keep the identities and responsibilities separate:

| Responsibility | Required access |
| --- | --- |
| Review/push release source, dispatch jobs, inspect results | Repository write access and any required environment/review approval |
| Canonical desktop and mirror publication from CI | Dedicated `AGENTSDOCK_RELEASE_TOKEN` stored in `direct-production`, with Contents write on both repositories and Workflows write when the target differs in workflow files |
| Configure environment secrets/protection or grant repository access | Repository administrator; do not give the release token secret-administration privileges |
| First short CLI publication and package trust configuration | An authorized npm account, its browser/2FA approval and package settings access; GitHub login is not npm login |
| Routine paired npm publication | Each package's own Trusted Publisher for `server-npm-publish.yml` / `npm-release`; no local npm session or long-lived npm token |

An operator who dispatches the canonical CI workflow does not also need mirror
write access on their personal GitHub login. A local mirror publish helper does.
Keep the existing server trust key in AgentsServer and dispatch its signing
workflow; a source export alone must never publish a second bridge.

After credentials are provisioned, register and run
`release-credentials-preflight.yml` from a reviewed `main` or `release/*` commit,
with `source_sha` equal to the exact dispatched commit. This manual protected
job reads release access metadata, signs/verifies a disposable native probe
with the existing Developer ID, and authenticates a read-only notarization
history request. It creates no release, submits no notarization, publishes no
package, installs no service and uploads no private diagnostics. It reports
missing checks as failures, not an overall readiness pass.

The disposable signing keychain is on the hosted user's search list only while
signing and verifying the probe: `codesign --keychain` selects an identity but
still needs the search list to resolve its certificate chain. The original list
is restored in a `finally` block on success or failure; cleanup verifies it again.
The user's default keychain is never replaced.

The GitHub metadata check does not prove actual release-write permission. The
probe does not establish a full Electron build, notarization submission, public
publication, migration or reboot acceptance. A separately authorized hosted
native build/private draft and exact-artifact verification remain required.
`artifacts_only=true` skips the hosted Mac signing build and a successful
`verification_only=true` run checks existing signed packages, not the secrets
that would build a new one. The desktop workflows now retain the audited
build-number epochs and the canonical draft's verification-only replay; see
[the desktop release procedure](DIRECT_RELEASES.md#public-release-automation).
This does not import all release-line product fixes or the draft unified
product-release pipeline. Review the selected source's actual capabilities.
Never rebuild an existing immutable release just to test credentials. The new
preflight must first be registered on main through review before GitHub can
dispatch it on a selected reviewed branch.

### Completing permanent operator access

A green credential preflight completes only the credential gate. To establish
repeatable release capability from an operator's own computer:

1. Reconcile the intended source and release helpers; choose a new, unused
   version and its audited native build reservation. Do not rebuild a frozen
   candidate or bypass a failed native lifecycle check.
2. With explicit build/upload authorization, prepare and sign the immutable
   runtime/CLI pair and desktop candidate using the existing protected hosted
   workflows. Accept their native installation, lifecycle, update and rollback
   journeys at their actual platform boundaries.
3. With publication authorization, publish/verify the accepted runtime, then
   have the npm account holder bootstrap the short CLI from its accepted exact
   archive. Configure that package's separate Trusted Publisher as described
   below. A successful `npm whoami` is not proof of package ownership.
4. Validate the new trust with a subsequent accepted, authorized new-version CI
   publication. Replaying an already-published version skips `npm publish`, so
   it does not prove OIDC trust or activate a newly configured publisher.
5. Verify desktop publication to both repositories, exact registry downloads,
   public update feeds and a genuine installed update journey. Record source,
   versions, checksums and actual workflow results; do not equate green source
   tests with a completed public release.

After bootstrap and successful trust validation, routine releases use GitHub
dispatch plus the protected credentials. No personal mirror-write permission,
local signing keys or repeated npm login is required. Renew expiring repository
credentials and retain normal review, acceptance and publication approvals.

## Prepare the immutable pair

1. Commit the complete reviewed candidate, including its exact `server/VERSION`.
   Dispatch `server-npm-publish.yml`, `operation=prepare`, with its full
   `source_sha` and reviewed `source_ref` (`main` or `release/*`). Preparation runs
   package tests and produces separate runtime and CLI artifacts without running
   setup hooks, changing services, signing, or publishing.
2. Use the existing authorized server-signing process and current trust key for
   that exact runtime. Compare signed tarball bytes with the prepared runtime;
   this workflow does not create a new key or accept an unsigned descriptor.
3. Keep two separate input directories. The runtime directory contains exactly
   `server-VERSION.tgz`, `agents-server-npm-manifest.json` and its `.sig`. The CLI
   directory contains exactly `agentsdock-VERSION.tgz` and
   `agentsdock-cli-receipt.json`. Record both acceptance hashes. A checksum receipt
   is not a second signing identity: the CLI verifier additionally compares every
   packaged CLI file with the pinned Git source and checks the signed dependency.
4. Use the existing `npm-candidate-release.mjs` helper for the three-file runtime
   draft. The new CLI helper stages only the two-file CLI draft. Both are private
   release drafts, not public releases or public npm packages. Uploading requires
   separate explicit release authorization.

The CLI staging command below uses previously verified absolute paths and pins;
do not copy placeholders as literal values:

```sh
node scripts/agentsdock-cli-candidate-release.mjs stage \
  --assets "$CLI_DIR" --npm-assets "$RUNTIME_DIR" \
  --version "$VERSION" --track beta \
  --source-sha "$SOURCE_SHA" --source-ref "$SOURCE_REF" \
  --accepted-receipt-sha256 "$CLI_RECEIPT_SHA256" \
  --accepted-manifest-sha256 "$RUNTIME_MANIFEST_SHA256" \
  --expected-latest absent
```

`inspect` uses the same arguments and never uploads. Matching draft retries are
idempotent; conflicting tags, identities, inventories or bytes fail without
overwriting anything. CLI files do not get appended to the fixed three-file
runtime bundle or the desktop's sealed asset set.

## Acceptance before publication

Source CI covers command routing, explicit selectors, token privacy, setup
skip/failure/retry behavior, actual offline npm package installation in disposable
prefixes, and publication guards. Fixtures and safe existing-state no-op tests
do not establish fresh native service acceptance.

After these workflows are registered on the default branch, dispatch
`agentsdock-cli-native-acceptance.yml` on the exact prepared source/ref with
`manifest_sha256` and `cli_receipt_sha256`. It downloads the private pair and runs
on disposable GitHub-hosted Apple silicon macOS and Linux. It has no npm publish
or signing operation. Never spoof its runner guards on a developer account.

When main and the release line differ, register only the exact reviewed full
`.github/workflows/agentsdock-cli-native-acceptance.yml` on main through normal
review and CI. Do not merge unrelated runtime changes or substitute a no-op
acceptance workflow. Registration is not execution or acceptance. Dispatch the
full workflow from the frozen `release/1.0.10-beta.6` source, with `source_sha`
equal to that branch's actual workflow SHA and `source_ref` equal to its name.
Its tools must exist in that source, and both immutable candidate drafts must
already pass inspection. An incomplete main checkout or missing inputs must
fail, not produce an acceptance receipt.

The native job exercises actual npm global postinstall, authenticated default
health, installed runtime bytes/modes, repeated-install process/identity/token
retention, list/status/info/token, named creation and lifecycle, removal
confirmation and synthetic state retention, default lifecycle and independence
from the original npm prefix/cache after restart. Finally it stops both default
components, cancels removal while preserving their exact runtime/configuration
and token, then confirms removal. Confirmed uninstall must unregister both
services and remove runtime/configuration/token while preserving the synthetic
state marker and the named instance's retained state. It does not purge history.
Only a report observing this whole boundary removes `default-removal` from its
untested list. Failure receipts retain partial observations and never assert
full product acceptance. Record the actual run,
attempt, source and both hashes; validate the original artifact's API digest and
contents rather than substituting another attempt.

Beta.6 requires this exact-pair native workflow on both hosts, not only the
scoped runtime's direct-install checks. The real offline npm regression uses
inert native/installer doubles; it proves PATH propagation but not live service
health, restart or cache independence. Bounded `failedCheck` identifiers now
distinguish token-file/output, authenticated health, service-path independence
and installed-byte/mode failures without exposing private output.

Remaining release checks:

- Fresh real global setup on both supported native hosts; missing `uv`/service
  prerequisites, occupied port, interrupted setup and explicit retry.
- Correct start/stop/restart/removal of both components of a split default
  installation, including removal after an owned stop. Earlier source had an
  old-layout binding limitation. The harness fails on refusal; do not bypass the
  binding check, stop only one component, or describe it as complete management.
- Interactive setup/pairing and optional dependency decline; native token-menu
  cancellation, bulk controls/exclusions, name reuse and removal/purge behavior.
- Genuine history retention and logout/reboot service survival. A synthetic
  marker and restart do not prove either.
- After authorized publication, fresh registry-backed exact-version install and
  `agentsdock@beta` resolution, before exposing a paired desktop release.
- If a desktop is also released, its normal signed-app, legacy bridge, managed
  update and platform gates still apply. This npm workflow does not waive them.

### Beta.6 scoped desktop/server replay

The existing `ci.yml` now admits exact `candidate-replay-v1.0.10-beta.6` for
the independently pinned `beta1101` baseline, alongside the retained legacy
journeys and both `0755`/`0750` installation-root modes. Historical beta.2 through
beta.5 pins and evidence remain unchanged. This is the beta.1-to-beta.6 journey,
not evidence for a beta.4 or beta.5 baseline. The complete reviewed installer
remains pinned to SHA-256
`51a6ae6f242476ae4f19712b95ecbaba212b2256e3928d389d8f617a6c367ed7`;
if the new source changes that installer, review its behavior and whole-file pin
before creating an accepted candidate rather than weakening the verifier.

Dispatch with that candidate tag, its own accepted `candidate.json` and bundle
hashes, `candidate_replay=true`, `npm_native_validation=false`, and
`candidate_server_rollback=false`; leave npm-only inputs empty. The separate
Linux rollback dispatch uses the same receipt/bundle pins with
`candidate_server_rollback=true` and both other modes false. Never reuse earlier
candidate hashes or relabel their observations. Replays remain
`publicationEligible: false` and `releaseAcceptance: false`; genuine populated
history, active/queued work, reboot, native Windows update and public-feed
acceptance are not supplied by these fixtures. First-global-install and instance
management are covered separately by the paired CLI native workflow.

## First publication and authentication

The scoped runtime's npm trust configuration does not grant rights to
`agentsdock`. A registry 404 is not ownership or authentication evidence. Local
`npm whoami` must succeed for an owner-approved first publication; complete login
and 2FA in npm's own browser/terminal flow, never by pasting tokens in chat.

Once the accepted runtime is public, the owner must bootstrap the exact accepted
CLI tarball (not a rebuilt tarball):

```sh
EXPECTED_NPM_LATEST=1.0.9 node scripts/verify_agentsdock_cli_publication.mjs preflight \
  "$CLI_DIR" "$VERSION" "$SOURCE_SHA" "$CLI_RECEIPT_SHA256" \
  "$RUNTIME_DIR" "$RUNTIME_MANIFEST_SHA256" absent
# Only after acceptance, explicit publication approval and successful owner login:
npm publish "$CLI_DIR/agentsdock-$VERSION.tgz" --ignore-scripts --access public \
  --tag beta --registry https://registry.npmjs.org/
```

Configure the **agentsdock package's own** npm Trusted Publisher:

- GitHub user/organization: `ZhengyiLuo`
- Repository: `AgentsDock`
- Workflow filename: `server-npm-publish.yml` (filename only)
- Environment: `npm-release`
- Allow direct `npm publish`, not only staging. Dist-tag editing is unnecessary.

Create the configuration when its first accepted CI publication is ready:
[npm requires its first successful publish within two days](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry).
If that window expires, delete the expired configuration and recreate it when
ready. Do not publish an unaccepted version to beat the deadline, or assume a
no-op replay of the bootstrap version activates trust. The later successful CI
publication must publish a new, accepted immutable version.

Preserve the existing scoped publisher, server trust key and Apple identities.
No new Apple credential or server key is required for this integration. See
[npm's trusted-publishing instructions](https://docs.npmjs.com/trusted-publishers/).

## Publish and resume without changing accepted bytes

Use the protected `server-npm-publish.yml` workflow with `operation=publish`:

| Input | Accepted value |
| --- | --- |
| `source_sha`, `source_ref` | Exact candidate source and reviewed branch |
| `workflow_sha` | Reviewed publishing workflow SHA; defaults to `source_sha` |
| `candidate_tag` | `npm-candidate-vVERSION` |
| `accepted_manifest_sha256` | Accepted runtime descriptor hash |
| `cli_candidate_tag` | `cli-candidate-vVERSION` |
| `accepted_cli_receipt_sha256` | Accepted CLI receipt hash |
| `expected_runtime_latest` | Observed stable baseline, currently `1.0.9` |
| `expected_cli_latest` | Observed stable baseline, initially `absent` |

The publisher first validates both local candidates, then publishes and downloads
the runtime for verification, then publishes/verifies the CLI. It checks npm
resolution metadata as well as tarball bytes. A beta must leave both `latest`
baselines unchanged; a future authorized stable release intentionally advances
them. The first missing CLI package stops with an explicit partial-release
summary for owner bootstrap. It is not reported as a completed matched release.

Rerun with the same accepted inputs after owner bootstrap or a transient registry
visibility failure. Exact public versions are verified and skipped, never
uploaded twice; conflicting public bytes/tags fail closed. Do not resolve an
error by rebuilding, overwriting or manually moving stable tags.

After both packages verify, retain the publication receipt and perform the fresh
registry installation check. Only then proceed with any separately authorized
legacy bridge and desktop publication. The desktop's existing local publish
helper is unchanged: its runtime/bridge checks alone do **not** prove CLI
publication, so the release operator must also require the paired npm receipt.

Initially advertise:

```sh
npm install -g agentsdock@beta
agentsdock list
```

There is no stable unscoped `latest` on the first beta. Do not advertise untagged
`npm install -g agentsdock` until an approved stable CLI is published. Existing
servers are not upgraded by reinstalling the CLI; use the signed managed-update
path. See the [CLI command guide](../server/npm/agentsdock/README.md).
