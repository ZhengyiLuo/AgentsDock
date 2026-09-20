# Coordinated app and server updates

Implementation status: source candidate. Isolated Linux installer activation
and rollback have been exercised; complete coordinated migration acceptance,
npm publication and the first coordinated native release have not occurred. Existing
installations continue using the existing release channel until that release is
accepted and published.

## User experience

The desktop app offers one **Update AgentsDock** action. A public release version
identifies the native app and `@agentsdock/server`; native build numbers remain
separate platform metadata. npm distributes the Python server and its explicit
installation CLI, not the desktop app or a replacement JavaScript server.

The app persists the exact signed server release before activation. Each saved
server profile reconciles independently using its own credentials, stable server
identity and current process identity. A busy server queues the update until
idle; a disconnected server resumes reconciliation when it reconnects. Settings
shows progress per server. Scheduling or downloading never means installed.
An owned update that fails or is canceled stays paused across app restarts.
Retry is explicit and scoped to the selected server. Legacy controls live under
Advanced server recovery for enrolled releases.

An active server known to be outside the signed compatibility interval keeps
the working desktop app open. Legacy servers within the supported interval can
finish queued work while the app updates. An equal or newer server satisfies a
release only with the supported API contract; reconciliation never downgrades a
server. An app update does not change a server's stable/beta channel.

## Existing installations

Legacy installed updaters continue reading the original signed schema-1
manifest and archive from the standalone AgentsServer release channel. Keep
publishing a compatible bridge there during the transition. The bridge retains
the existing install paths, token, stable server identity, provider configuration,
chat data, Team Hub state and rollback machinery, and adds the authenticated
`POST /api/admin/update/ensure` endpoint.

After the bridge is running, the app submits the exact schema-2 descriptor and
signature paired with its release. The server verifies the publisher's existing
Ed25519 trust root, release channel, npm package identity, immutable version,
registry URL, archive size, SHA-256 and npm SHA-512 integrity. It persists signed
bytes privately and verifies them again after restart and in the detached
updater. The installer validates the candidate's identity, exact version and
signed API contract before committing activation.

The archive is extracted into the existing managed versioned release layout.
The running service never points into an npm global directory or disposable npx
cache. The npm package has no install hooks. Fresh `install` refuses existing
state and services, with a repeated check under the installer lock. Existing
servers use the managed updater, rather than rerunning fresh installation.

Older clients retain their existing update/status protocol. Do not delete the
standalone download channel, rotate the release key, change provider homes, or
silently change service names as part of this migration. Independent same-host
services and provider-directory migration require their separate instance design.

## Release artifacts and ordering

1. Choose the next unused release version within the current beta line. Commit
   and verify the source before building. Server `VERSION` and the staged native
   app's public version must match.
2. Use `server/scripts/package_npm_release.py` to create the exact npm tarball
   and descriptor. Sign the original descriptor bytes with the existing server
   release key; verify with `server/release-public-key.pem`.
3. Pass that descriptor and signature into native artifact staging. Enrollment
   is explicit; ordinary builds without the paired assets retain the old flow.
   The staged app bundles both files under `Resources/coordinated-release/`.
   Attach the identical files to its public release as
   `agents-server-npm-manifest.json` and `agents-server-npm-manifest.sig`.
   Existing desktop build scripts accept the absolute file paths through
   `AGENTSDOCK_COORDINATED_MANIFEST` and `AGENTSDOCK_COORDINATED_SIGNATURE`;
   both are required together. Source package metadata remains untouched by
   the enrollment helper.
4. Accept migration and rollback on disposable real service hosts. Verify the
   staged native app and its actual update interaction, signing and updater feed.
5. Publish the verified exact tarball, verify it from npm, and make the signed
   legacy bridge available before exposing the app update. Publish the paired
   app assets only after both server paths are usable. Keep a release manifest
   recording source commits, hashes, versions and compatibility limits.

The current manual `server-npm-publish.yml` workflow **prepares and signs** the
package; it does not publish. The private native publisher must also accept the
two extra descriptor assets before this release can be exposed. Its existing
fixed asset allowlist is not satisfied by adding files only to a local build.

## npm account setup and first publication

The confirmed organization is `agentsdock`, and the package is public
`@agentsdock/server`. Do not send an npm token through chat. The first publication
can use an interactive `npm login` by an authorized organization owner followed
by publishing the accepted exact tarball with public access and the correct
`beta` or `latest` tag. These are release steps after acceptance, not prerequisites
for local implementation or tests.

Once the package exists, configure its trusted publisher for the actual GitHub
repository, publishing workflow filename and protected npm release environment.
Enable an explicit publish job using a compatible Node/npm version and GitHub
OIDC rather than storing a long-lived npm token. Confirm organization permissions
and provenance in that first workflow run. A private signing job may prepare
artifacts separately; only reviewed, verified bytes reach the public publisher.

## Required migration acceptance

Local unit and isolated HTTP/UI tests cover protocol behavior. A disposable
Linux VM additionally exercises real systemd activation and rollback with
synthetic preserved files; this does not prove active-provider or macOS launchd
recovery, or the complete published-artifact update journey. Before release,
record results for these scenarios on disposable macOS and Linux accounts/hosts:

| Scenario | Required result |
| --- | --- |
| Fresh exact-version npm install | Independent managed runtime, no npm lifecycle side effects |
| Current legacy install to bridge to npm release | Same identity, token, history, provider configuration and service |
| Older supported client with upgraded server | Connect, read history, send and finish a turn |
| Active chat during update | Queue until idle; no interruption, loss or duplicate turn |
| Two clients request same/newer versions | Join existing work; never downgrade or cancel another reservation |
| Server offline or app restarted | Persist intent and reconcile on reconnect |
| Server identity or selected profile changes | Stop stale mutation; never reuse another profile's token |
| Corrupt package or descriptor, wrong key/channel/API | Reject before activation; keep working release |
| Candidate health failure or interrupted activation | Restore prior release, service configuration and preserved data |
| Disk/dependency/service-manager failure | Actionable failure with recoverable prior installation |
| Multiple saved servers | Independent progress; active incompatible server blocks app activation |

Platform acceptance, npm registry round-trip verification and native publication
remain release gates even when source tests pass.
