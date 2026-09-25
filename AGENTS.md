# Development rules

- Preserve user work and keep changes scoped to the requested task.
- Match each provider's native user-facing behavior: Codex chats must match
  Codex, and Claude chats must match Claude. Verify the exposed thinking text,
  live updates, chronological placement, and retention after completion or
  interruption against the corresponding native client. Do not infer Claude
  parity from Codex tests, or equate visibility improvements with content parity.
- Read the relevant package documentation before changing its code. Use the
  package's type checks and targeted tests, then validate the affected build.
- Follow `docs/APP_DEV_OPERATIONS.md` for every app feature and bug fix.
  Personally exercise the changed workflow in the actual app, through its real
  client/server boundary when applicable. Mocked tests and screenshots alone
  are not end-to-end acceptance. Record what was exercised and any untested
  boundary; never call a feature ready when required real-app checks are blocked.
- A request to change, build, test, or install does not authorize publishing a
  release, uploading artifacts, deploying a server, or submitting to an app
  store. Those external actions require an explicit user request.
- Commit completed changes before an explicitly authorized release build.
- Electron releases use the direct desktop channel unless the user explicitly
  requests a Mac App Store or TestFlight build.
- Within one beta release line, keep the base version fixed and increment only
  the prerelease number. Promote to stable only after validation.
- Mobile changes require a separately scoped mobile task. Do not perform mobile
  builds or uploads as an incidental part of desktop or server work.
- The `server/` directory is the maintained AgentsServer source, imported with
  its history. Keep server-only installation self-contained. The standalone
  repository remains a compatibility export and legacy download destination;
  do not develop independent changes there. Deployment still requires explicit
  authorization, and update tests must use isolated state and services.
- Coordinated desktop/server releases share a public version and pin signed
  server package metadata. Preserve the legacy signed update path until the
  migration bridge has been validated against supported old installations.
- Record public-facing changes and accepted releases in `docs/DEV_LOG.md`.
  Never add private transcripts, credentials, host inventories, local paths,
  or internal incident reports. Review screenshots and recordings before inclusion.
- Preserve third-party license and attribution notices.
