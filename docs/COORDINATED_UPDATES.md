# Coordinated app and server updates

Stable **1.0.4 build 1193** has passed the exact packaged upgrade journey from
the published **1.0.3 stable app and server**. The matching npm version on
`latest`, signed standalone bridge and both existing stable desktop feeds are
published and verified. Stable users remain on Stable throughout this migration.

For that journey, the user selects **Update AgentsDock** once in 1.0.3. After
installing and relaunching, 1.0.4 performs the supported server migration and
subsequent npm package updates automatically. Users do not separately install
or select a server version. About still displays the actual app version;
Settings reports server progress and any actionable failure. Existing stable
users need neither a beta-channel change nor npm setup.

Published beta: `1.0.4-beta.12`, desktop build `1189`. The native app, public npm
package and signed standalone server bridge are available. The accepted native
update journey starts with the unchanged published beta.8 desktop and a genuine
beta.9 server: one app-update click replaces and relaunches the app, then its
bundled coordinator migrates the server without a separate server-update action.
Native Linux/macOS migration, populated-data preservation, rollback and
interrupted-activation recovery were also verified. See the accepted release
and test boundaries in [the development log](DEV_LOG.md).

## How existing users reach npm updates

The first coordinated release is itself a bridge. Its app must remain available
through the existing desktop feeds, and its server must remain available as an
old-format signed AgentsServer archive as well as an npm package. An old server
cannot consume the new npm descriptor until the legacy updater has installed
the bridge code.

1. The user selects the existing **Update AgentsDock** action. An older app
   installs the new native app through its existing desktop update channel.
2. On its first launch, the new app reads the bundled signed server descriptor
   and the user's saved server profiles. For a supported legacy server, it
   requests the bridge through the server's existing signed update API.
3. The first server migration waits for current work to finish. The managed
   installer retains the installation's identity, credentials, paths and data.
   The app reconnects and verifies both running server components before
   reporting the update complete.
4. Later app releases request their matching signed npm server package through
   the new managed update endpoint. Users keep using one app-update action.

There is no separate npm login, token, global npm installation or fresh server
installation step for an existing managed server. The server updater downloads
and verifies the pinned package archive directly. The npm `install` command is
for fresh installations and deliberately refuses existing managed state.

| Starting point | Upgrade path and evidence |
| --- | --- |
| Stable desktop 1.0.3 with managed server 1.0.3 | Available with accepted build 1193: one app-update action to stable 1.0.4, followed by automatic stable server migration. |
| Original managed macOS server 0.1.26-beta.29 | Accepted native migration, candidate failure, rollback and same-byte retry to stable 1.0.4 after explicit operator selection of Stable. This does not establish its historical desktop/feed path or automatic beta-to-stable promotion. |
| Desktop beta.8 with managed server beta.9 | Direct update to beta.12; the complete native one-click journey is accepted. |
| Another compatible 1.x app and managed legacy server | Use the existing app feed and signed server bridge; eligibility depends on the server's advertised update capability. The accepted starting pairs are not proof for every historical version. |
| A pre-1.0 desktop with an old feed implementation | Follow the earlier [1.0 feed migration](DIRECT_RELEASES.md#migration-to-10) first when required. Retain those historical bridge releases; do not assume these clients can skip directly to beta.12. |
| Another stable-channel installation | Remain on Stable. The bridge uses both existing stable channels and npm; the accepted 1.0.3 starting pair does not prove every older stable migration. |
| Very old, unmanaged or unsupported remote server | Requires a separately validated legacy upgrade path before automatic coordination. Do not run the fresh npm installer over its existing state. |
| Older macOS service with custom paths | Preserve the original installation, configuration and state directories during the one-time migration; older services may not record all three paths. |

The existing managed update capability is an eligibility check, not proof that
every historical release can migrate. Current code requires update
capability version 2 or later for verified HTTP-loopback connections and version
9 or later, with server/process identity fencing, for remote servers. These are protocol
capability versions, not server release numbers. Later updates from an already
coordinated app also check the signed API compatibility interval before app
activation. An older app without the coordinator cannot perform that preflight:
it installs the new app first, so its starting server must remain compatible
enough for the new app to complete the bridge. The native installer
separately verifies the admitted update and its caller; older runners can lack
that authority information even when their advertised capability passes the
app's check. Do not turn these capability thresholds into a promised minimum
release version without validating that release's full installer path.

The original signed macOS `0.1.26-beta.29` server now passes the native signed
migration, rollback and retry boundary. When its status omits the runner process
ID, the installer proves the actual updater's executable, kernel arguments,
ancestry and tmux ownership, alongside authenticated identity and idle admission.
It retains these checks when rollback leaves a dead candidate receipt. The test
explicitly selects Stable before requesting 1.0.4; app updates do not change a
server's release channel. This native server result does not establish every
historical desktop/feed combination or custom-directory installation. The old
runner's latest-only behavior also remains; requesting a retained intermediate
version through that API is not a supported shortcut.

Keep both desktop feeds and the standalone server bridge available while
supported clients still need them. Publish a bridge on each supported release
channel before exposing a coordinated app there. Do not remove the legacy
server download path merely because the npm package has been published.

Long-running native goals on old servers can retain execution ownership between
replies. Their owner must finish or explicitly pause them before the first
migration can reach idle. A queued update is not a failed update, and it must
not force-stop those agents to complete the transition.

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
Advanced server recovery for enrolled releases. Opening recovery preserves a
failed operation. After a coordinated Retry, an already expanded recovery panel
refreshes authoritative status automatically, without a new release check.
Legacy servers that omit update progress from health are observed through the
app's existing health callbacks while the owned operation is active.

For later updates from an already coordinated desktop, an active server known
to be outside the signed compatibility interval keeps the working app open.
This protection is absent from the first update by an old desktop without the
coordinator; the accepted beta.8/beta.9 and stable 1.0.3 starting pairs have
sufficient API overlap.
Legacy servers within the supported interval can finish queued work while the
app updates. An equal or newer server satisfies a
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

1. Choose an unused version on the intended channel. Keep a beta line's base
   version fixed, and promote it to stable only after validation. Commit and
   verify the source before building. Server `VERSION` and the staged native
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
5. Publish the verified exact tarball and verify npm's archive and channel tag
   (`latest` for stable). Then publish and verify the matching signed standalone
   bridge. Expose the paired app assets on both existing desktop feeds only
   after both server paths are usable. Keep a release manifest recording source
   commits, hashes, versions and compatibility limits.

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

Publication pins the reviewed workflow revision separately from the accepted
product-source revision. `source_sha` identifies the source recorded in the signed
descriptor and accepted packages. Optional `workflow_sha` identifies the reviewed
publishing code and defaults to `source_sha`. The dispatched commit must equal
that workflow pin, on the authorized `source_ref` branch (`main` or `release/*`).
The job checks out `source_sha`, proves it is an ancestor of the reviewed workflow
commit, and proves that workflow commit is an ancestor of the freshly fetched
branch. A workflow correction does not change the accepted product pin or permit
rebuilding the accepted archive.

Only the publish job receives `contents: write` to read its private candidate
draft, together with `id-token: write` for npm trusted publishing. It does not
create or publish GitHub releases. The job verifies the accepted descriptor hash,
existing release-key signature, source pin, package identity, archive hashes and
channel; publishes that exact tarball through npm OIDC; then downloads and verifies
registry bytes. It refuses immutable-version mismatches and backward tag movement.

npm can acknowledge publication before serving the version and archive publicly.
Future runs retry only the unchanged read-only registry verifier, at most 61
attempts with 10-second gaps and an 11-minute step limit. Exhaustion still fails,
and all exact-byte and channel requirements remain enforced. This visibility
wait never retries `npm publish`. A later full job retry first checks the registry;
an already published exact version skips publication and proceeds to verification.

Stable 1.0.4 was published from workflow revision `52ff3e3` with accepted product
source `b3bf411`. Its first attempt published once but failed immediate readback
while npm processed the package. Its second attempt skipped publication and
passed exact public verification. The bounded wait is a subsequent workflow-only
improvement, not part of the accepted packages or that completed publication.
npm provenance identifies the publishing revision; the original signed descriptor
and exact tarball bind the accepted product source.
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
application source. Dispatch on the authorized release branch with the exact
reviewed `workflow_sha`, accepted `source_sha` and signed manifest hash. The
existing package uses trusted publishing; interactive authentication is only a
bootstrap step for a package that has not yet configured its trusted publisher.

The workflow uses GitHub-hosted Node 24 and requires npm 11.5.1 or later. Confirm
OIDC authorization and provenance in its first real run. See the
[npm trusted-publishing requirements](https://docs.npmjs.com/trusted-publishers/).
Account login, source code and dry runs do not establish publication acceptance.

## Acceptance scope and release checks

Build 1193 accepts the exact signed 1.0.4 runtime on native launchd and systemd.
The final candidate starts, encounters an induced activation failure, rolls back
automatically and then succeeds through an explicit retry of the same bytes.
Both platforms preserve populated chats/events, synthetic provider and terminal
credential/configuration files, Hub records and authority, and an established
mutual-TLS peer. Existing peer credentials authenticate saved reads and new
writes. All 107 runtime files and modes match between signed archives and source.
Installed bytes remain exact; installed permissions follow the signed installer,
including Linux `agent_server.py` normalization from mode `0644` to `0755`.

The actual packaged Mac journey starts with unchanged stable 1.0.3 app/server
artifacts. One Update action replaces and automatically relaunches the signed
app, whose coordinator completes the server migration. A separate archive-only
503 leaves the original server PID and boot unchanged: normal health callbacks
observe the failure, recovery opening/reopening preserves it, and one coordinated
Retry succeeds with Advanced recovery continuously open. Both status rows update
without Check or reopening Settings. No separate server-update action is used.

These journeys use isolated HTTPS discovery serving the exact signed packages.
Native app relaunch drops process-only TLS overrides, exposing a fixture
certificate error in the desktop feed check. Native migration and data acceptance
are complete, but private discovery does not establish public feed propagation.
Separate public checks now verify npm's exact archive, the matching standalone
bridge and both stable desktop feeds; private discovery alone establishes none
of those public-delivery results.

Earlier beta.12 acceptance retains its own source scope: real Codex/Claude tools,
subagents and approvals across gateway loss, native process-loss/reboot recovery,
and fresh npm installation including a dependency-timeout retry. The eight tested
execution/provider modules are byte-identical in this release; no new provider
turns are claimed by the synthetic credential-preservation fixtures. Earlier
fresh-install fixtures with preloaded dependencies do not prove online bootstrap.

Continue recording these scenarios at their actual source and platform boundary:

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
