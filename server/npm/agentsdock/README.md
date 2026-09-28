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
agentsdock list
agentsdock status
agentsdock new work --port 7854 --bind 127.0.0.1
agentsdock status work
agentsdock token work
agentsdock restart work
agentsdock remove work
```

Flat commands are the primary interface. `servers ACTION` and `instances ACTION`
remain aliases, as do `new --name NAME` and `token/status --instance NAME`.
Start/stop/restart/remove require an
explicit instance or the native helper's explicit `--all` selector. Stop/restart
interrupt running work; wait for chats to finish first. Remove retains the
existing confirmation and history-preservation behavior. Tokens are private;
`token` only reads an existing token and does not reinstall or restart a server.
Omitting its selector reads the default instance. Loopback binding is local-only;
choose a reachable bind explicitly if another device needs access.

## Complete public command comparison

`work` is an example instance name; `default` selects the original instance.
These are server installation/administration commands, not the run-bound
mailbox/jobs/team tools supplied to agents inside an authorized chat.

| Purpose | Previous entry point | Short entry point |
| --- | --- | --- |
| Install the npm command | `npm install -g @agentsdock/server` | `npm install -g agentsdock` |
| Fresh default server | `agentsdock-server install` / first `./install.sh` | `agentsdock setup` or `agentsdock install` |
| All instances and connection addresses | `./instances.sh list` | `agentsdock list` |
| All instance statuses | `./instances.sh list` | `agentsdock status` (same listing) |
| One instance's details | `./instances.sh info work` | `agentsdock info work` or `agentsdock status work` |
| New automatic name/free port | `./instances.sh new` | `agentsdock new` |
| New named instance | `./instances.sh new --name work --port 7854` | `agentsdock new work --port 7854` |
| Start one | `./instances.sh start work` | `agentsdock start work` |
| Stop one | `./instances.sh stop work` | `agentsdock stop work` |
| Restart one | `./instances.sh restart work` | `agentsdock restart work` |
| Read default token | `./install.sh --show-token` | `agentsdock token` |
| Read named token | `./install.sh --instance work --show-token` | `agentsdock token work` |
| Uninstall one, preserve history | `./uninstall.sh --instance work` / `./instances.sh remove work` | `agentsdock remove work` or `agentsdock uninstall work` |
| Explicitly purge instance state | `./uninstall.sh --instance work --purge-state` | `agentsdock remove work --purge-state` |
| Start/stop/restart all | `./instances.sh restart --all` (or start/stop) | `agentsdock restart --all` (or start/stop) |
| Exclude an instance from a bulk action | `./instances.sh restart --all --exclude default` | `agentsdock restart --all --exclude default` |
| Uninstall all with confirmation | `./instances.sh remove --all` / bare `./uninstall.sh` | `agentsdock remove --all` |
| Submit a signed managed update | `agentsdock-server update` plus required descriptor/identity arguments | `agentsdock update` with the same arguments |
| Guarded pre-activation recovery | `agentsdock-server recover` | `agentsdock recover` |
| Installed CLI/package version | `agentsdock-server --version` | `agentsdock version` or `agentsdock --version` |
| CLI help | `agentsdock-server --help` | `agentsdock help` / `agentsdock --help` / `agentsdock -h` |

Supported options retain their native meanings:

- `setup`/`install`: `--port`, `--bind`, `--non-interactive`, `--dry-run`.
- `new`: optional positional name or `--name`, `--port`, `--bind`.
- `start`/`stop`/`restart`/`remove`: positional name or `--instance NAME`, or
  explicit `--all`; repeat `--exclude NAME` only with `--all`.
- `remove`/`uninstall`: also `--yes` and `--purge-state`. Purge retains the native
  interactive confirmation and cannot be made unattended with `--yes`.
- `token`/`status`: positional name or `--instance NAME`, never both.
- `update`: the six required arguments in the example below. Bare `update` or
  `update work` does not select a registry tag or silently restart a server.

Differences from the old source scripts:

- `setup`/`install` is fresh-default-only. Re-running `./install.sh` on an
  installed service could reinstall it; the public CLI instead refuses that
  path and keeps signed managed updates separate.
- Bare `remove`/`uninstall` refuses an omitted target. Unlike bare
  `./uninstall.sh`, it never implies removing all instances.
- `version` is the installed CLI/package version, not a remote or already-running
  server's health/version result. `info` reads the selected instance's metadata.
- Source-only operations are **not yet exposed** as short commands: rebinding or
  changing the port of an existing installation; manifest-based bulk creation
  (`./instances.sh install --manifest ...`); Team Hub configuration/reactivation;
  foreground development `python agent_server.py serve`. There are no implemented
  `agentsdock configure`, `agentsdock logs`, `agentsdock login`, or `agentsdock serve`
  commands in this package.
- Direct checkout reinstalls (`./instances.sh update`, installer's version or
  custom-root overrides) are not aliases for the signed `update` command. Split
  runtime preparation/activation and internal recovery flags remain under the
  managed updater, rather than arbitrary public pass-through arguments.
- Provider login remains in each provider's native CLI. Existing source scripts
  and the `agentsdock-server` command remain available for their original uses.

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
