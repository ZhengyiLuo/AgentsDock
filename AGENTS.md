# Development Rules

- Commit the completed app change before cutting a release build.
- Every completed app change must be uploaded to its corresponding TestFlight target. Mobile React changes ship to iOS/iPadOS; Electron macOS changes ship to macOS.
- Verify the release build before upload and record the accepted build in `docs/DEV_LOG.md`.
- When an app release depends on a server contract change, update, deploy, and push the standalone server in the same release pass.
