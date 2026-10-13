# AgentsServer

![AgentsDock in action](assets/agentsdock-preview.png)

**AgentsServer is the self-hosted execution backend for
[AgentsDock](https://agentsdock.net).** AgentsDock provides
the polished desktop and mobile chat experience; AgentsServer runs on the
machine that owns your workspaces and agent CLI installations.
Together they provide persistent agent chats without routing private project
files through a third-party chat service.

The desktop and mobile client is also open source:
[ZhengyiLuo/AgentsDock](https://github.com/ZhengyiLuo/AgentsDock).

## Features

- Run agent chats from desktop and mobile, with persistent history.
- Work with files, images, videos, scheduled jobs, and persistent terminals.
- Use Claude Code, Codex, Cursor, or OpenCode where supported by your server
  release, client, and installed CLI.
- Run independent servers on the same machine.

## Get started

Use a Linux host with a user systemd session or Apple silicon macOS with a
desktop login, plus [Node.js](https://nodejs.org/en/download) 22.14+ (with npm) and
[`uv`](https://docs.astral.sh/uv/getting-started/installation/) installed.
Install and authenticate the agent CLI you want to use on that host.
`tmux` is optional for terminal access and managed updates.

AgentsDock desktop can guide you through **Set up AgentsServer**. Or install the
public CLI as the server owner, without `sudo`:

```bash
npm install -g agentsdock
agentsdock list
agentsdock token
```

The first global install starts the default server, normally on port **7850**.
Use `list` for connection addresses and `token` to select a server with Up/Down
and Enter, then view/copy its token. Add that URL/token pair in AgentsDock.
Existing servers and history are left unchanged on repeat installs.

For a fresh beta installation, use `npm install -g agentsdock@beta` instead.
Stable is currently **1.0.10**; beta is **1.0.11-beta.1**. An existing server
uses the managed update flow below, not an npm reinstall. For custom ports,
setup retries, and the complete command list, see the [CLI guide](npm/agentsdock/README.md).

Developers can still install from a checkout:

```bash
git clone https://github.com/ZhengyiLuo/AgentsDock.git
cd AgentsDock/server
./install.sh
```

For access from another network, connect the server and your device through
Tailscale. Keep access tokens private and do not expose the agent port directly
to the public internet. See the [setup guide](https://agentsdock.net/setup.html)
for detailed instructions.

### Memory at launch

New agent turns require **2 GiB (2048 MiB) of available server RAM** by default;
scheduled jobs require **4 GiB (4096 MiB)**. This is a launch check, not total RAM or a
guarantee that every workload will fit. Low-memory errors show the available
amount, required minimum, and recovery advice. See [memory settings](docs/MEMORY_ADMISSION.md)
for operator overrides.

## Multiple servers on one machine

Add a separate server without replacing your original/default server:

```bash
# Create a server with an automatic name and free port
agentsdock new

# Or choose its name and port
agentsdock new work --port 7851

# List all servers and their connection URLs
agentsdock list

# Uninstall one server (replace work with its name)
agentsdock remove work
```

Removal asks for confirmation and preserves history by default. An omitted
target never selects all servers. The older checkout commands remain available;
unlike `agentsdock remove`, bare `./uninstall.sh` selects all instances.

## Updating

Use **Settings → Updates** in AgentsDock, selecting Stable or Beta for the
matching app/server release. Signed server updates preserve the token and chat
history and wait for the server to become idle. Installing a newer npm CLI does
not upgrade an existing service. `agentsdock update` is an advanced command
requiring signed metadata and server identity; it is not a bare one-word updater.
See [CLI updates and recovery](npm/agentsdock/README.md#updates-and-recovery) or
the [update guide](https://agentsdock.net/update.html).

## Documentation and support

- [Detailed API, configuration, and lifecycle reference](docs/SERVER_REFERENCE.md)

- [Setup and connection help](https://agentsdock.net/setup.html)
- [AgentsDock features](https://agentsdock.net/features.html)
- [Server releases](https://github.com/ZhengyiLuo/AgentsServer/releases)
- [Report an issue](https://github.com/ZhengyiLuo/AgentsDock/issues)
- [Contributing and tests](CONTRIBUTING.md)

Features in this checkout may not yet be in a published release. The maintained server source is this repository's `server/` directory. The
standalone AgentsServer repository remains a compatibility distribution during
the update migration.

## License

AgentsServer's original code and documentation are licensed under the
[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
Third-party components retain their respective copyrights and licenses.
