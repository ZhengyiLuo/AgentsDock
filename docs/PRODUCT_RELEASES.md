# Unified product releases

The normal release entry point is the manually dispatched
[`product-release.yml`](../.github/workflows/product-release.yml) workflow in
`ZhengyiLuo/AgentsDock`. One committed `server/VERSION` supplies the public version
for the native desktop app, `@agentsdock/server`, and the signed legacy server
archive. The version determines Stable or Beta; a beta iteration changes only
its prerelease number. npm distributes the Python server and installation CLI,
not the desktop application.

## Current implementation boundary

This is release-pipeline work, not a change to the installed app or server's
runtime update behavior. It has not established production CI, signing,
registry publication, or native end-to-end acceptance.

**Publication is intentionally blocked pending phase-two native acceptance.**
The required `product-release-acceptance.yml` workflow does not yet exist.
Successful packaging, a signed descriptor, or a manually written acceptance
file cannot satisfy that missing workflow. Do not bypass the gate with the
older manual publishers to treat this implementation as an accepted product
release.

Release coordination must not become a runtime version-equality lock. The
desktop app must still be able to install when a saved server is busy, offline,
on another channel, unsupported, or has failed its own update. The intended
one-click journey installs/relaunches the app first, then reconciles each saved
server independently. A newer compatible server is not downgraded. Phase two
must prove that journey with the exact prepared packages; this pipeline alone
does not prove it. See [coordinated updates](COORDINATED_UPDATES.md).

## Prepare, accept, then publish

Both operations require explicit release authorization. A source change or
local test does not authorize dispatching either operation. Preparation is not
read-only: it signs packages, uploads artifacts, creates GitHub drafts, and
pushes a new compatibility source-export branch. Neither operation deploys to
an existing server installation, and neither builds or uploads TestFlight/App
Store targets.

1. Commit and review the intended product source, including `server/VERSION`.
   Dispatch `prepare` on its reviewed `main` or `release/*` branch with the full
   `source_sha`, matching `source_ref`, release notes, and the explicit Windows
   signing policy. Version and track are derived, not separately entered.
2. Preparation runs the server test shards, packages the exact npm and legacy
   archives once from the clean source, signs both original descriptors with
   the existing Ed25519 key, and verifies runtime contents and executable modes.
   It stages `npm-candidate-vVERSION` in AgentsDock and `vVERSION` in AgentsServer
   as separate three-asset drafts. It then builds/verifies the native targets
   with the identical npm descriptor and signature bundled inside them, and
   stages the canonical and legacy desktop drafts.
3. The successful run uploads `product-release-PREPARE_RUN_ID`. It contains
   `release.json` and the signed server bundle. The receipt binds version,
   channel, canonical source and workflow SHAs, source branch, export SHA,
   native build number, Windows signing state, preparation run identity, and
   the desktop checksum-manifest, npm descriptor, legacy descriptor, and server
   bundle hashes. Independently review and retain the exact `release.json`
   SHA-256 reported by the run. The artifact retention period is 30 days; do
   not assume an expired artifact can be reconstructed under its old receipt.
4. Phase two must run the real native acceptance workflow on disposable
   installations using those exact bytes. It must produce an
   `AgentsDock-VERSION-acceptance` artifact containing `acceptance.json`, bound
   to the product receipt hash and successful canonical acceptance run. This
   workflow and its real-use harness remain to be implemented.
5. Only after acceptance and separate publication approval, dispatch `publish`
   with the same `source_sha`/`source_ref`, `prepare_run_id`, independently
   reviewed `accepted_receipt_sha256`, and `acceptance_run_id`. Preserve the
   explicit unsigned-Windows approval when applicable. The publisher downloads
   the original bundle, verifies the receipt, successful preparation run and
   native acceptance evidence, and replays the native draft verifiers before
   any registry or release publication.

Server preparation derives reproducible archive timestamps from the pinned
commit, not the runner's clock or an ambient environment variable. Repeating
that preparation with the same source, tooling and key must produce identical
signed assets. Native installers are not promised to be reproducible: resume
failed jobs using retained platform artifacts, and never replace an already
sealed native package with a rebuild. A mismatching or incomplete existing
draft requires operator review, not automatic deletion or asset replacement.

The required acceptance checks are `native-app-update`, `fresh-server-install`,
`legacy-server-upgrade`, `busy-server-drain`, `offline-server-reconnect`,
`interrupted-update-recovery`, `rollback-data-preservation`, `multiple-clients`,
and `stable-beta-channels`. Every check must have one passed result. The run
must be successful in the canonical repository, identify
`.github/workflows/product-release-acceptance.yml`, and run at the exact product
source SHA. These are evidence requirements, not permission to manufacture
passing records or substitute source tests for native behavior.

Publication order is:

```text
accepted receipt + native draft replay
  → exact npm tarball and registry readback
  → signed legacy server bridge and public runtime-parity readback
  → canonical desktop release and byte-identical desktop compatibility feed
  → public Stable/Beta discovery and every platform's updater metadata verified
```

This is ordered, resumable publication, not an atomic transaction across npm
and GitHub. If a later step fails, earlier public artifacts can remain public.
Retry with the same preparation run, receipt and accepted bytes. Existing exact
versions are verified instead of republished; conflicting identity, assets,
hashes or tags fail closed. Never repair a partial release by overwriting assets,
moving an existing source tag, rebuilding an immutable npm version, or silently
changing the receipt. A changed payload needs a new product version and acceptance.

## Source and native build identity

The canonical `source_sha` must be an ancestor of the dispatched workflow SHA;
the workflow SHA must belong to the freshly fetched reviewed branch. Reusable
workflows are selected from the same workflow revision. An orchestration-only
correction does not change the source pin or authorize rebuilding accepted
packages. Pinned source checkouts must contain the release helpers they execute.

AgentsServer remains a compatibility export, not a second development source.
Preparation derives its commit with `git subtree split --prefix=server`, checks
that its root tree equals the canonical commit's `server/` tree, and creates
`exports/vVERSION` in AgentsServer only if absent. An existing branch must match
exactly; preparation does not update that repository's development branch.
The legacy release tag targets this real export SHA. Its signed descriptor and
release metadata retain the canonical source SHA. The legacy helper checks the
public export's tree and canonical branch ancestry before creating or publishing
a release; it never invents a standalone tag target from a monorepo SHA.

The product workflow reserves native builds as `5000 + github.run_number`, with
a maximum of `9999`. The old desktop workflow uses its separate counter,
`1185 + run_number`, capped at `4999`. These disjoint ranges prevent a new
workflow counter from reusing old reservations. A rerun retains its reservation;
publication uses the prepared build and does not allocate another one. Run
number gaps are expected. Exhaustion requires a reviewed range change, not a
clamp or reused number. Do not allocate local builds from the product range.

## Required external configuration

Configuration and credential changes require their own authorization. This
implementation does not provision secrets, change npm settings, or repair tags.

- Restrict `direct-production` and `npm-release` to reviewed `main`/`release/*`
  branches and retain the release-approval protections. The workflows must be
  registered on the default branch before manual dispatch is available.
- In AgentsDock's `direct-production` environment, provide the existing native
  signing/notarization credentials listed in [direct releases](DIRECT_RELEASES.md).
  `AGENTSDOCK_RELEASE_TOKEN` also needs Contents write access to AgentsDock,
  AgentsDock-Releases, and AgentsServer: the latter is required for the exact
  source-export branch and compatibility draft/publication. No release token
  belongs inside the app or a release artifact.
- Provision `AGENTS_SERVER_RELEASE_PRIVATE_KEY_B64` in that protected canonical
  environment through an authorized secret-management path. It must be the
  existing Ed25519 server release key matching committed
  `server/release-public-key.pem`; do not rotate the trust root or retire the
  legacy signed download path as part of this migration. A secret stored only
  in the standalone repository is not automatically available here. Never copy
  private key material into source, chat, workflow outputs, or logs.
- Configure the public `@agentsdock/server` package's npm trusted publisher for
  owner `ZhengyiLuo`, repository `AgentsDock`, **caller workflow
  `product-release.yml`**, environment `npm-release`, and permission for direct
  `npm publish`. npm validates the calling workflow for reusable workflows;
  the old `server-npm-publish.yml` entry alone is insufficient. Both caller and
  publishing job require `id-token: write`; the publishing job also needs
  Contents write to read the accepted private candidate draft. Keep OIDC; no npm
  token is introduced. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

The read-only registry audit on 2026-09-25 found both `latest` and `beta` selecting
`1.0.7-beta.5`. That is not a valid stable default. The new npm preflight rejects
`latest` pointing at a prerelease, so the observed state needs an explicit
operator-reviewed repair before publication. Review current registry state and
whether an accepted stable package actually exists; do not relabel a beta as
stable or select an unverified substitute automatically. No repair was performed
as part of this implementation.

Beta publishing explicitly uses `beta`; stable publishing explicitly uses
`latest`. The verifier snapshots both channel tags, verifies the non-target tag
is unchanged, rejects backward movement, and downloads the exact published
tarball. Readback retries do not retry `npm publish` or move a tag.

## Compatibility and emergency paths

The existing desktop and standalone npm manual entry points remain for reviewed
compatibility and explicitly scoped emergency operations, not routine independent
version lines or a bypass around pending product acceptance. The normal product
entry point always pairs the signed server descriptor with the desktop build.
An app-only emergency release remains a separate decision with its own scope
and acceptance; this pipeline does not change installed apps' runtime behavior.

Preserve both desktop feeds and the signed schema-1 server bridge while supported
installations need them. Record actual accepted public releases in
`docs/DEV_LOG.md` after verification, distinguishing source tests, native
acceptance, and public-delivery results.
