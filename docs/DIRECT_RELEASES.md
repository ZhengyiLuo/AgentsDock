# Direct desktop release channels

The canonical source, desktop releases, and update feed are
[ZhengyiLuo/AgentsDock](https://github.com/ZhengyiLuo/AgentsDock/releases).
Signing and publication continue in private automation that checks out an
explicit, reviewed commit from this public repository. Public CI verifies
source; it does not have signing credentials or publish releases.

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
cannot establish upgrade acceptance. Stable Windows distribution also needs
the required Authenticode signing; unsigned beta previews must say so.

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
