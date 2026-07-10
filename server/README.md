# ZenithDock Server

This repository is the source of truth for the ZenithDock agent server.

- Edit `agent_server.py` locally.
- Deploy to your agent host with `./deploy.sh <ssh-host>`.
- The remote runtime copy defaults to `~/Zenithbot/scripts/agent_server.py`.
- The systemd user service is `zenithbot-agent.service`.

Temp files are fine for build artifacts or one-off debugging, but source code
belongs here.

Useful checks:

```bash
ssh <ssh-host> 'systemctl --user status zenithbot-agent.service --no-pager -l'
ssh <ssh-host> 'curl -s http://127.0.0.1:7850/api/health'
```

## Access Token

Set `ZENITHDOCK_AGENT_TOKEN` on the agent host to require a shared bearer token for
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

## Whole-History Search

`GET /api/search?q=<query>&limit=<chat-count>` searches user, assistant, error,
job, reasoning-summary, and file text across every chat. Quoted phrases remain
phrases; unquoted terms use prefix matching for responsive type-ahead search.

The first request incrementally builds `history_search.sqlite3` inside the
agent state directory. Each transcript stores its indexed byte offset, so later
requests ingest only newly appended JSONL records. The index is persistent and
safe across server restarts; a replaced or truncated transcript is rebuilt
automatically. Indexing runs in a worker thread and does not block agent turns.

## Per-Turn Code Diffs

For Git worktrees, the server captures the complete change made by each agent
turn independently of provider tool output. It snapshots the worktree before
and after the turn with an isolated temporary index, so pre-existing dirty or
staged changes are preserved and the real Git index is never modified.

The timeline receives a compact `code_diff` event with file and line-count
metadata. The full patch is stored outside the event log and can be fetched
with the normal token authentication:

```text
GET /api/sessions/{session_id}/diffs/{run_id}
```

The response is an uncapped textual Git patch (`text/x-diff`). Binary changes
are represented by Git's compact binary-file marker rather than embedding the
binary payload in chat history.
