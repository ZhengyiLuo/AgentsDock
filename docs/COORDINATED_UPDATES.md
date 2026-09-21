# Coordinated app and server updates

Implementation status: source candidate for `1.0.4-beta.12`. Isolated Linux
installer activation, rollback and fresh installation through an offline npm
tarball have been exercised. A native offscreen desktop additionally drives the
real managed Linux updater through signed HTTPS download, activation, failure
and rollback using a disposable registry and signing key. Complete coordinated
migration acceptance, npm publication and the first coordinated native release
have not occurred. Separate disposable macOS VMs also verify real launchd
migration, wrong-API rollback and fresh offline npx installation. Existing
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
If dependency setup fails before creating state or a service, a retry may reuse
only safely owned empty installation folders. It never removes old data to make
a fresh installation proceed.

Older clients retain their existing update/status protocol. Do not delete the
standalone download channel, rotate the release key, change provider homes, or
silently change service names as part of this migration. Independent same-host
services and provider-directory migration require their separate instance design.

Automatic bridging requires a supported managed updater. Legacy remote servers
without identity-fenced update capability need the guided installer; very old
unmanaged installations cannot safely use automatic migration. An older desktop
without coordination support installs the new desktop first; its first launch
then reconciles the saved server profiles from the bundled signed descriptor.

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

The manual `server-npm-publish.yml` workflow has separate `prepare` and `publish`
operations. Preparation produces unsigned artifacts without a signing secret.
During the transition, the standalone repository's existing `server-release.yml`
can prepare both server distributions with `prepare_only=true` and the reviewed
`npm_source_sha`, `npm_source_ref` and matching `npm_version`. Its reusable
`server-npm-candidate.yml` checks canonical ancestry and the existing public key,
then creates and signs the exact npm tarball descriptor with the signing secret
already held by that repository. All server test shards must pass first. The
signer uploads an Actions artifact only; it does not publish either distribution.
This keeps the private key in its existing location. Explicit staging creates
a separate draft `npm-candidate-vVERSION` containing
only `server-VERSION.tgz`, `agents-server-npm-manifest.json` and its `.sig`.
It never publishes npm or a desktop release. Signing is not acceptance.

After acceptance, the public publish operation requires the exact reviewed
workflow/source commit, candidate draft and accepted manifest SHA-256. It verifies
the existing release-key signature, package identity, archive hashes and channel;
publishes that tarball through npm OIDC; then downloads and verifies registry
bytes. It refuses immutable-version mismatches and backward dist-tag movement.
The npm candidate draft is separate from the native desktop draft. Native build
and draft staging validate the signed metadata and packaged resources before
either server distribution needs to be public. Final desktop publication verifies
that npm serves the exact signed tarball and AgentsServer serves the matching
signed legacy bridge, including runtime file contents and executable permissions.
This permits packaged-app acceptance before npm publication while preventing an
app update from reaching users before both server paths work.

The public native publisher also requires an explicit unused native build
number. Check its CI run floor before dispatch; old run-number arithmetic could
reuse numbers already assigned to local desktop builds. A server npm version
must advance the previously installed server version; the old beta.9 QA tarball
is not a releasable migration candidate.

## npm account setup and first publication

The confirmed organization is `agentsdock`, and the package is public
`@agentsdock/server`. Do not send an npm token through chat. The first publication
can use an interactive `npm login` by an authorized organization owner followed
by publishing the accepted exact tarball with public access and the correct
`beta` or `latest` tag. These are release steps after acceptance, not prerequisites
for local implementation or tests.

Before that first interactive publication, run the read-only candidate inspection
against the downloaded signed bundle and its draft metadata:

```sh
node scripts/verify_npm_publication.mjs inspect \
  CANDIDATE_DIRECTORY REVIEWED_SOURCE_SHA ACCEPTED_MANIFEST_SHA256 DRAFT_RELEASE_JSON
```

Publish the inspected archive only after native and migration acceptance. Keep
its exact bytes; do not repack or rebuild between signing and publication.

Once the package exists, configure its trusted publisher with GitHub owner
`ZhengyiLuo`, repository `AgentsDock`, workflow filename `server-npm-publish.yml`,
and environment `npm-release`. Permit the `npm publish` action, since stage-only
permission does not authorize this workflow's direct publication. Configure
allowed `main`/`release/*` branches for that GitHub environment, following the
existing desktop release environment's branch restrictions. The canonical
public publishing job receives neither a signing key
nor an npm token. Transitional signing uses the existing standalone server secret;
moving it is not required for the transitional server signing step. Desktop
signing and publication run in the public AgentsDock repository, as described
in [Direct desktop releases](DIRECT_RELEASES.md).

The workflow file must also exist on the repository's default branch for manual
dispatch to work. If the default and maintained release branches have diverged,
register only the reviewed workflow on the default branch; do not replace its
application source. Dispatch on the reviewed release branch with the matching
source SHA. The first package publication still uses the accepted archive and
interactive npm authentication before trusted publishing can be configured.

The workflow uses GitHub-hosted Node 24 and requires npm 11.5.1 or later. Confirm
OIDC authorization and provenance in its first real run. See the
[npm trusted-publishing requirements](https://docs.npmjs.com/trusted-publishers/).
Account login, source code and dry runs do not establish publication acceptance.

## Required migration acceptance

Local unit and isolated HTTP/UI tests cover protocol behavior. A disposable
Linux VM additionally exercises real systemd activation and rollback with
synthetic preserved files. The desktop-driven managed test verifies actual
detached updater execution, HTTPS archive verification, successful reconnection
and a failed candidate returning to the previous release without automatic retry.
Its registry, signing key and app replacement are controlled test boundaries;
it does not prove active-provider work or the complete published-artifact update
journey. Separate macOS VMs exercise launchd activation and rollback, exact
service-plist restoration, preserved identity/token/synthetic files and fresh
offline npx installation. Their dependencies are preloaded after guest network
failure; online bootstrap is not claimed. A third pristine VM reproduces an
actual first-install dependency timeout and retries using the exact committed
beta.12 npm tarball without removing the leftover folders. It then verifies
that another installation attempt preserves the installed process and state.
Before release,
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

New macOS activation journals bind recorded device coordinates to persistent
volume UUIDs. A real interrupted installer, orderly reboot with device-number
change, installer retry and second reboot verify restoration of the previous
runtime and service with preserved identity/token/synthetic data. Older journals
without saved volume proof remain usable when their device coordinates match;
they require manual recovery if those coordinates changed. Specialized interrupted
Team Hub reactivation has a separate unmigrated journal and remains unsupported
after remount. Do not discard those journals or replace their rollback baseline
to force an update through. These limits are separate from upgrading a healthy
older server to the new installer.
