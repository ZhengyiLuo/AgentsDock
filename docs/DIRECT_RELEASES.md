# Direct desktop release channels

Official desktop binaries and update metadata are distributed through
[AgentsDock-Releases](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases).
The source snapshot does not include the private signing or publication
workflows. Its CI is for verification only.

## Updates

Direct macOS builds, Linux AppImages, and Windows NSIS installations use
`electron-updater` with the public release feed. The app does not need an
embedded GitHub credential. Stable builds follow stable update metadata;
opt-in beta builds follow the beta track. Moving back to Stable does not
install an older version. Portable archives are a manual-install alternative.

Mac App Store and TestFlight builds have a separate Apple-managed update path.
Do not enable the direct updater in those targets.

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
