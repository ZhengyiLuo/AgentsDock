# ZenithDock Server

This directory is the local source of truth for the ZenithDock agent server.

- Edit `server/agent_server.py` locally.
- Deploy to Zen-nv with `./server/deploy_nv.sh`.
- The remote runtime copy is `/home/zen/Zenithbot/scripts/agent_server.py`.
- The systemd user service is `zenithbot-agent.service`.

Do not use `/private/tmp` as the development copy. Temp files are fine for
build artifacts or one-off debugging, but source code belongs here.

Useful checks:

```bash
ssh nv 'systemctl --user status zenithbot-agent.service --no-pager -l'
ssh nv 'curl -s http://127.0.0.1:7850/api/health'
```

## Access Token

Set `ZENITHDOCK_AGENT_TOKEN` on Zen-nv to require a shared bearer token for
all API calls, uploads, file/video fetches, and websocket event streams.

```bash
systemctl --user edit zenithbot-agent.service
```

Add:

```ini
[Service]
Environment=ZENITHDOCK_AGENT_TOKEN=replace-with-a-long-random-token
```

Then restart:

```bash
systemctl --user daemon-reload
systemctl --user restart zenithbot-agent.service
curl -H 'Authorization: Bearer replace-with-a-long-random-token' \
  http://127.0.0.1:7850/api/health
```

Leave the variable unset for open local development.
