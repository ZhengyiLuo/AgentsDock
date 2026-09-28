# agentsdock

Install and manage your AgentsDock server with one command name. This is the
public CLI entry point; the desktop app remains a separate signed download.
The same-version `@agentsdock/server` dependency supplies the runtime and the
existing signed update protocol. Existing scoped-package installations remain
supported.

## Install the command

```sh
npm install -g agentsdock
agentsdock --help
agentsdock setup --port 7850
```

For a beta, select `npm install -g agentsdock@beta`. This documentation describes
the package being prepared; commands are available from the registry only after
that package/channel has been published. Do not infer name ownership from an npm
404 response.

`-g` makes the command available outside the current project when npm's global
bin directory is on your PATH. A local `npm install agentsdock` is also supported;
invoke it using `npx agentsdock`, not a bare shell command. No npm install hook
starts or updates a server, changes shell configuration, or logs into a provider.

Use Node >=22.14, `uv`, and Apple silicon macOS with a desktop login or Linux with
a working user systemd session. Run as the server owner without `sudo`. Install
and authenticate your preferred provider CLI separately. `setup` (also `install`)
refuses to overwrite an existing default installation or history.

## Manage servers

```sh
agentsdock servers list
agentsdock status
agentsdock servers new --name work --port 7854 --bind 127.0.0.1
agentsdock status --instance work
agentsdock token --instance work
agentsdock servers restart work
agentsdock servers remove work
```

`instances` is an alias for `servers`. Start/stop/restart/remove require an
explicit instance or the native helper's explicit `--all` selector. Stop/restart
interrupt running work; wait for chats to finish first. Remove retains the
existing confirmation and history-preservation behavior. Tokens are private;
`token` only reads an existing token and does not reinstall or restart a server.
Omitting its selector reads the default instance. Loopback binding is local-only;
choose a reachable bind explicitly if another device needs access.

## Updates and recovery

Prefer the app's update control. `agentsdock update` accepts the same signed
descriptor, identity and token-file arguments as `agentsdock-server update`:

```sh
agentsdock update --server-url https://server.example \
  --server-identity ID --server-instance-id INSTANCE \
  --token-file /private/path/server-token \
  --manifest agents-server-npm-manifest.json \
  --signature agents-server-npm-manifest.sig
```

`agentsdock recover` retains the narrowly scoped existing pre-activation recovery
checks. The CLI does not turn `servers update` or arbitrary installer arguments
into an unsigned update bypass. Updating this npm command does not itself update
an already-running server; managed activation remains independent of npm caches.

## Preparing this package

From the canonical repository root:

```sh
python3 server/scripts/package_agentsdock_cli.py --output dist/agentsdock-cli
```

This stamps the same committed `server/VERSION`, pins the exact scoped dependency,
and produces a tarball and checksum receipt without publishing or installing.
Test the tarball with that exact server package before publication. Release
automation must publish/verify the scoped runtime first, then this CLI, with the
same stable/beta channel and appropriate trusted-publisher ownership. Existing
server manifests, signing keys and previously frozen candidates are unchanged.
