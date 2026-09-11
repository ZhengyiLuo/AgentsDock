# Contributing

Open pull requests against `main`. Keep changes focused and include regression
tests for bug fixes. Use synthetic names, addresses, paths, and conversations in
tests and screenshots; do not copy private workspace data into fixtures.

## Desktop validation

Use Node.js 24 and the pnpm version declared in `electron/package.json`:

```sh
cd electron
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

These commands compile and test source; they do not publish an application.
Official signing and release publishing are managed separately. Source CI has
read-only repository permissions and no signing or deployment credentials.

## Team Hub validation

```sh
uv sync --project team-hub --dev
uv run --project team-hub python -m unittest discover -s team-hub/tests
```

See the component READMEs for server and mobile development instructions.

## Before submitting

- Keep secrets, certificates, local configuration, logs, and generated build
  output out of Git.
- Do not attach private chats, internal URLs, or real research artifacts to bug
  reports. Redact logs and use a minimal synthetic reproduction.
- Preserve third-party license notices and dependency integrity data.
- Do not turn a build or test into an automatic release or deployment.
