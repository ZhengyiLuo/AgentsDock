# Matched npm runtime and short CLI releases

`@agentsdock/server` supplies the signed runtime. `agentsdock` supplies the short
command and its reviewed first-global-install hook. Publish both from one clean,
committed source snapshot and one public version; the CLI dependency must be
`"@agentsdock/server": "VERSION"`, never a range or floating tag. The desktop
continues to pin the signed runtime descriptor, not a floating npm channel.

This document describes release preparation, not a publication receipt. As of
2026-10-07, runtime `latest` is `1.0.9`, runtime `beta` is `1.0.10-beta.4`, and
`agentsdock` is not public. Leave those existing bytes and stable defaults alone.
Choose the next unused `1.0.10-beta.N` only after reconciling the reviewed release
source with main; main's development `server/VERSION` is not a release reservation.
Do not overwrite beta.4 or silently drop fixes maintained on its release branch.

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

The native job exercises actual npm global postinstall, authenticated default
health, installed runtime bytes/modes, repeated-install process/identity/token
retention, list/status/info/token, named creation and lifecycle, removal
confirmation and synthetic state retention, default lifecycle and independence
from the original npm prefix/cache after restart. Failure receipts retain partial
observations and never assert full product acceptance. Record the actual run,
attempt, source and both hashes; validate the original artifact's API digest and
contents rather than substituting another attempt.

Remaining release checks:

- Fresh real global setup on both supported native hosts; missing `uv`/service
  prerequisites, occupied port, interrupted setup and explicit retry.
- Correct start/stop/restart/removal of both components of a split default
  installation. The current instance manager has a known old-layout binding
  limitation. The harness deliberately fails on refusal; do not bypass the
  binding check, stop only one component, or describe it as complete management.
- Interactive setup/pairing and optional dependency decline; native token-menu
  cancellation, bulk controls/exclusions, name reuse and removal/purge behavior.
- Genuine history retention and logout/reboot service survival. A synthetic
  marker and restart do not prove either.
- After authorized publication, fresh registry-backed exact-version install and
  `agentsdock@beta` resolution, before exposing a paired desktop release.
- If a desktop is also released, its normal signed-app, legacy bridge, managed
  update and platform gates still apply. This npm workflow does not waive them.

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
