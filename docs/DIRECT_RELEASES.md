# Direct Desktop Releases

AgentsDock has two independent macOS update channels:

- TestFlight / Mac App Store builds are updated only by Apple.
- Developer ID builds downloaded outside the App Store use `electron-updater`
  and the public GitHub Releases feed in `ZhengyiLuo/ZenithBotServer`.

The app never contains a GitHub token. Installed clients only read public
release assets. A separate CI secret can create releases, and only the manual
publish workflow can make a draft visible to clients.

## Safety Contract

1. Never publish from a developer workstation.
2. Never overwrite an existing tag or release asset.
3. Build one universal app, then sign it with Developer ID and notarize it.
4. Verify the updater metadata checksum, bundle version, signature, Gatekeeper
   assessment, and stapled notarization ticket before creating a draft.
5. Install the draft manually on at least one clean Mac and exercise startup,
   connection, chat open/send, media, terminal attach, and normal quit.
6. Publish only through the protected `direct-production` environment.
7. Fix a bad published release with a higher patch version. Downgrades and
   in-place asset replacement are intentionally disabled.

Ordinary app quit never installs a pending direct update. The update downloads
in the background, then the user chooses **Restart**. AgentsDock stops polling,
flushes its event cache, and detaches terminals before requesting the updater
restart. If that request fails synchronously, background services are started
again and the downloaded update remains available for another attempt.

## GitHub Setup

Create these Actions secrets in the private AgentsDock source repository:

| Secret | Purpose |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64-encoded Developer ID Application certificate and private key |
| `MACOS_CERTIFICATE_PASSWORD` | Password used when exporting that P12 |
| `APPLE_API_KEY_P8_BASE64` | Base64-encoded App Store Connect API key |
| `APPLE_API_KEY_ID` | App Store Connect key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |
| `AGENTSDOCK_RELEASE_TOKEN` | Fine-grained token with Releases/Contents write access to `ZenithBotServer` |

Create a GitHub environment named `direct-production`, add required reviewers,
and place `AGENTSDOCK_RELEASE_TOKEN` in that environment if publication should
require a separate credential. Enable immutable releases in the public release
repository before the first production release.

The release repository must stay public unless the product gains a separate
authenticated update service. GitHub's private-repository updater requires a
token on every client, which is not an acceptable desktop distribution model.
Reserve this repository's GitHub Releases for AgentsDock desktop releases;
publishing unrelated releases as `latest` would confuse the updater feed.

## Prepare A Draft

Run the **Prepare direct desktop release** workflow with a new SemVer version
and release notes. It:

1. imports the signing certificate into an ephemeral keychain;
2. stamps the version and monotonic CI build number;
3. runs type checks and the complete Electron regression suite;
4. builds one universal zip and DMG;
5. notarizes and staples the app;
6. verifies `latest-mac.yml` against the zip's SHA-512;
7. verifies code signing, Gatekeeper, and the notarization ticket;
8. writes `SHA256SUMS`; and
9. uploads an immutable GitHub draft without exposing it to clients.

The local equivalent is:

```bash
APPLE_API_KEY=/absolute/path/AuthKey_KEYID.p8 \
APPLE_API_KEY_ID=KEYID \
APPLE_API_ISSUER=ISSUER_UUID \
./scripts/build_electron_release.sh
```

That command requires an installed Developer ID Application identity and never
publishes. Local ad-hoc builds continue to contain `disable-auto-update`, so
they cannot accidentally replace or consume production releases.

## Publish

After manually validating the draft, run **Publish direct desktop release**
with the exact same version. The protected job downloads the draft again,
checks every SHA-256, reruns signature/notarization/update-metadata validation,
publishes it as `latest`, and confirms that the public `latest-mac.yml` resolves
to the expected version.

Existing direct installs check at startup and every four hours. They download
the newer zip automatically and show a visible restart notice. TestFlight/MAS
installs remain on Apple's channel and ignore the GitHub feed.

## Emergency Response

- **Draft is bad:** delete the draft. No installed app has seen it.
- **Published release is bad but not yet installed:** unpublish it, fix the
  issue, and publish a higher patch version immediately.
- **Published release was installed:** publish a higher patch version. Do not
  reuse the tag and do not enable downgrade behavior.
- **Update UI is broken:** users can download the signed DMG from Releases;
  installing it over the existing app preserves server-side chats and the local
  cache under Application Support.

