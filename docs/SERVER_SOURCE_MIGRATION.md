# Server source migration

AgentsDock is the canonical development repository for the client and server.
The server retains its internal root layout under `server/`; its installer,
Python dependency lock, runtime files, and generated web assets stay together.

The import preserves the complete history from AgentsServer commit
`d1b5f4265ec5eb6f46af9f4c27e9beb060b95093`. At import, the `server/` tree equals
`63fe94fbebb49cdac82577e42f5329e5288ac5b5`, and splitting that import with
`git subtree split --prefix=server` reproduces the original server commit.

The former frozen server snapshot was removed. Its only external consumer was
the legacy Swift guardrail executable, which read `agent_server.py` as text.
Those server implementation-string assertions have been retired; client-only
guardrails remain. Current server behavior is covered by the maintained Python
suite, including update, authentication, scheduled-job and provider tests.
Historical source remains available through Git history.

## Compatibility export

Develop server changes in this repository. Before exporting a release:

Run `python3 scripts/prepare_server_export.py --commit <accepted-commit>
--previous <last-standalone-commit>` to validate the export and print its mapping.
This command never pushes or publishes.

1. Split the accepted commit's `server/` subtree using full Git history and
   consistent subtree options.
2. Require the last standalone tip to be an ancestor of that split. Stop on
   divergence; reconcile changes instead of force-pushing.
3. Verify that the split root tree equals the accepted commit's server tree.
4. Record the canonical commit, exported commit, and tree hash together.
5. Push only the explicitly selected compatibility branch when publication is
   authorized. Never use a repository-wide mirror push.

The retained `server/.github/workflows/` files are inactive in the monorepo;
root workflows own monorepo verification and publication. Before exporting to
AgentsServer, gate its legacy workflows so one export cannot publish twice.

## Release transition

Old server installations still discover signed archives in AgentsServer.
Keep that schema-1 archive/manifest/signature channel available for the bridge.
The npm package has a separate schema-2 signed descriptor; do not replace the
legacy manifest with a format its installed updater cannot read.

Coordinated app/server releases use the same public version. Native build
numbers remain platform metadata. A newer compatible server satisfies an older
app requirement without a downgrade. Native app signing and installation remain
separate artifact operations inside one user-facing update journey.

The npm scope is `@agentsdock`, confirmed by its owner. Package creation,
trusted-publisher setup, publication and live migration acceptance remain
explicit release steps; importing source does not claim those steps succeeded.
