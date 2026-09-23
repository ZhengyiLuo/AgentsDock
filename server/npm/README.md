# @agentsdock/server

AgentsDock's self-hosted server, distributed with its existing Python runtime
installer. The desktop app remains a separate signed native download.

This package has no installation lifecycle hooks. Installing the npm package
does not start, stop, upgrade, or log into a server. The service runs from its
own versioned installation directory, never from an npm or npx cache.

## First installation

This opt-in beta is for testing fresh installations. It does not enable
automatic app-to-server updates or migrate existing installations. To install:

```sh
npx @agentsdock/server@beta install --port 7850
```

Use an exact package version for reproducible installations. The command needs
the same prerequisites as the source installer: a trusted `uv`, Linux with a
working user systemd session or Apple silicon macOS with a GUI launchd session,
and the desired provider CLIs. It runs as the current user without `sudo`.

The npm entrypoint only permits a fresh default installation. It refuses an
existing managed installation, legacy service, or custom installation roots;
changing directories does not create a second service. Use AgentsDock's managed
update controls for an existing server. Multiple named services are not enabled
by this package.

## Managed updates

The CLI also supports managed updates using a compatible running server and a
separately reviewed, signed release descriptor. Existing-installation migration
and recovery are outside this beta's fresh-install testing scope. The command
binds its request to a known server and its current process instance:

```sh
agentsdock-server update --server-url https://server.example \
  --server-identity ID --server-instance-id INSTANCE \
  --token-file /private/path/server-token \
  --manifest agents-server-npm-manifest.json \
  --signature agents-server-npm-manifest.sig
```

The token file must be a current-user-owned regular file readable only by that
user, containing the server token alone. HTTPS is required except for literal
loopback addresses and localhost. Redirects are refused. The command checks the
authenticated server identity, then submits the signed descriptor to its managed
update endpoint. The server verifies the signature and waits for idle before
activating an update. A pending response means scheduled, not installed. No
registry tag, unsigned descriptor, or local installer bypasses this lifecycle.

## Packaging

The source `server/package.json` is deliberately private. Run
`python3 server/scripts/package_npm_release.py --output dist/npm-server` from
the repository root to stage only the audited runtime allowlist, stamp
`server/VERSION`, and produce the publishable tarball plus its unsigned release
descriptor. The manual preparation workflow signs that descriptor. This command
does not publish to npm. Publish only a reviewed and verified prepared tarball.
