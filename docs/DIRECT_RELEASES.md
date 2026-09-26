# Direct desktop release channels

The canonical source, desktop releases, and update feed are
[ZhengyiLuo/AgentsDock](https://github.com/ZhengyiLuo/AgentsDock/releases).
Signing and publication run in this public repository using separate manually
dispatched preparation and publication workflows. Release jobs check out an
explicit, reviewed source commit. Ordinary source CI has no signing credentials
and does not publish releases.

For normal paired app/server releases, use the
[unified product pipeline](PRODUCT_RELEASES.md). It derives one version from
committed `server/VERSION`, stages signed packages, and separately publishes an
accepted immutable receipt. Its publication gate intentionally remains closed
until the phase-two native acceptance workflow exists and passes. The desktop
workflows described below are reusable components and retained manual
compatibility/emergency paths, not the normal independent release entry points.

The [legacy release feed](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases)
remains available for installed desktop clients and Android. Do not rename,
delete, or redirect it as part of the desktop migration.

## Updates

Direct macOS builds, Linux AppImages, and Windows NSIS installations use
`electron-updater` with the public release feed. The app does not need an
embedded GitHub credential. Stable builds follow stable update metadata.
The opt-in Beta track selects the newest eligible beta **or stable** release;
the final stable release supersedes a beta with the same base version.
Installation still requires the user's action. Changing tracks preserves
connections, settings, and the saved track preference. Normal update checks
do not downgrade; explicitly switching from a prerelease to Stable can offer
the current stable version even when it is older. Portable archives are a
manual-install alternative.

Mac App Store and TestFlight builds have a separate Apple-managed update path.
Do not enable the direct updater in those targets.

## Migration to 1.0

`1.0.0-beta.1` is the migration bridge, not the stable release. Build its
artifacts once with the public AgentsDock feed embedded, then publish those
identical artifacts and updater metadata to both the canonical and legacy
release repositories. Both copies must retain the same source commit and
checksum manifest; publication retries may only resume a matching release.
Never rebuild a different payload under an existing version.

- Existing Beta clients discover the bridge through their legacy feed. After
  installation, they use the public feed and can receive the eventual stable
  `1.0.0` without leaving Beta.
- Existing Stable clients keep their stable feed until a validated `1.0.0`
  is published to both repositories. Installing it moves them to the public
  feed without a separate prerelease installation.
- A release tag in the source repository must point at the exact reviewed
  source commit, not whatever happens to be the default branch when uploaded.
- The website's stable download manifest must keep pointing to a published
  stable release until `1.0.0` is actually available. Beta links are labeled
  separately. Android and Apple-managed releases are not migrated here.
- The bridge adds no faster checking cadence, background Team Network work,
  forced installation, server deployment, or app identity changes.

Before publishing stable `1.0.0`, verify installed legacy Beta → bridge →
public-feed update, legacy Stable → stable `1.0.0`, and bridge → stable
`1.0.0` with production-style packages and isolated user data. Verify offline
and failed checks, rejected invalid signatures/checksums, retained settings,
and explicit installation. Local packages containing `disable-auto-update`
cannot establish upgrade acceptance. The release owner's standing distribution
policy permits unsigned Windows installers for authorized desktop releases.
Do not ask again for each version unless that policy changes. Explicit release
authorization is still required; this policy does not authorize publishing on
its own. Pass `allow_unsigned_windows=true` during both preparation and
publication when using that policy; the signing state remains sealed into the
release identity. Unsigned installers must be clearly labeled and can show
Windows security warnings. This does not relax macOS signing, notarization,
checksum verification, or source identity checks.

The publication workflow accepts a separately pinned public migration
QA commit. Stable `1.0.0` requires that pin and runs two disposable macOS jobs
after the matching signed packages are public: legacy Stable `0.2.12` → stable
`1.0.0`, and bridge `1.0.0-beta.2` → stable `1.0.0` with the Beta subscription
retained. The earlier legacy Beta → bridge acceptance remains a separate
journey; older beta-only updaters are not expected to skip the bridge. Report
post-publication migration acceptance separately from packaging/signing gates.

## Public release automation

`direct-desktop-release-draft.yml` builds and verifies the pinned native assets
before creating a draft. `direct-desktop-release-publish.yml` rechecks the exact
draft, source identity and signatures before publishing the canonical release
and its legacy mirror. Coordinated releases also require the exact npm archive
and matching signed legacy server bridge to be available, with identical runtime
contents and executable permissions.

Both workflows support manual dispatch and calls from the manual product
pipeline, restricted to the canonical repository and reviewed
`main` or `release/*` branches. Jobs using signing credentials or the release
token use the `direct-production` environment with matching branch restrictions.
Fork pull requests do not run these release jobs. The workflow definitions must
exist on the default branch for manual dispatch, while a dispatch can select the
reviewed release branch. Registering the workflows does not replace application
source on a diverged default branch.

The retained desktop workflow reserves `1185 + run_number`, capped at `4999`.
The product workflow has its own counter and reserves `5000 + run_number`, capped
at `9999`; its native build is derived automatically. Never interpret one
workflow's counter as the other's, reuse a reservation, or assign local builds
from the product range. See [product build identity](PRODUCT_RELEASES.md#source-and-native-build-identity).

When macOS signing is performed locally, dispatch the same preparation workflow
with `artifacts_only=true`. It retains the source ancestry, release version,
build reservation, and signed descriptor checks, then uploads verified Linux
x64/arm64 and unsigned Windows artifacts. It skips macOS, release-write access
checks, and draft creation; it does not read Windows signing credentials. Public
release-history reads use the job's read-only GitHub token. Set
`allow_unsigned_windows=true` for the approved unsigned distribution policy.
This mode consumes the same workflow build reservation as a full preparation.

Build macOS locally from the same committed source, version, build number and
signed server descriptor using `scripts/build_electron_release.sh`. It uses the
existing Developer ID keychain identity and App Store Connect key, verifies the
universal notarized ZIP and DMG, and never publishes. Assemble those exact files
with the downloaded platform artifacts and descriptor, then seal the complete
asset set before the normal draft and publication verification. Artifact-only
success does not establish macOS acceptance or authorize publication.

Add the existing credentials directly to the public repository's
[`direct-production` environment](https://github.com/ZhengyiLuo/AgentsDock/settings/environments).
GitHub's secret API returns metadata, not stored secret values, so the originals
must be supplied again. Do not put them in source, chat, release assets or logs.

| Secret | Value |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64 Developer ID Application certificate and private key export |
| `MACOS_CERTIFICATE_PASSWORD` | Password protecting that P12 export |
| `APPLE_API_KEY_P8_BASE64` | Base64 App Store Connect API private key |
| `APPLE_API_KEY_ID` | ID of that API key |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |
| `AGENTSDOCK_RELEASE_TOKEN` | Fine-grained token with Contents write access to AgentsDock and AgentsDock-Releases; the product pipeline also requires AgentsServer |

For file-backed values, the CLI can send encoded bytes directly without printing
them or placing the value in command history:

```sh
base64 < /path/to/developer-id.p12 | gh secret set MACOS_CERTIFICATE_P12_BASE64 --repo ZhengyiLuo/AgentsDock --env direct-production
base64 < /path/to/AuthKey.p8 | gh secret set APPLE_API_KEY_P8_BASE64 --repo ZhengyiLuo/AgentsDock --env direct-production
```

For the other values, use `gh secret set NAME --repo ZhengyiLuo/AgentsDock
--env direct-production` and its interactive prompt, or the environment's secret
editor. The native leaf workflow needs no npm token or server signing key; the
product preparation job has separate [server-signing requirements](PRODUCT_RELEASES.md#required-external-configuration). Optional
Windows signing secrets remain separate; the existing explicitly unsigned
preview policy still applies when they are absent.

Preserve the former private repository's history and artifacts. At the first
public native build, stop dispatching its preparation workflow: concurrency and
build counters are separate between repositories, so the old pipeline could
reuse a build number. Disable the old native workflows as part of cutover and
use only the public publisher thereafter. Do not publish the same candidate
through both pipelines.

## Local verification

From `electron/`, run `pnpm typecheck`, `pnpm test`, and `pnpm build` after
installing dependencies with the checked-in lockfile. Platform packaging needs
the corresponding native toolchain. See [the desktop guide](../electron/README.md).
Local build or verification commands are not permission to upload or deploy.

## Release requirements

- Obtain explicit authorization before any publication, upload, or deployment.
- Build from a committed, reviewed source snapshot and validate each target.
- Keep a beta line's base version fixed and increase its prerelease number.
- Sign and notarize official direct macOS artifacts. State the signing status
  of Windows previews accurately; do not present unsigned previews as signed.
- Verify payload checksums, updater metadata, signing, clean startup, and the
  installed application's core workflows before publication.
- Never overwrite published assets or expose signing keys in source, logs,
  caches, or build artifacts. Use a newly versioned release for corrections.
- Keep app, server, and app-store release approvals separate; a client change
  does not authorize deployment of its standalone server.
- Record accepted, publicly available builds in [DEV_LOG.md](DEV_LOG.md).
