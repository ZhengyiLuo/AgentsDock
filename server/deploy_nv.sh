#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_HOST="${ZENITHDOCK_REMOTE_HOST:-nv}"
REMOTE_APP_DIR="${ZENITHDOCK_REMOTE_APP_DIR:-/home/zen/Zenithbot}"
REMOTE_SERVER_PATH="$REMOTE_APP_DIR/scripts/agent_server.py"
SERVICE_NAME="${ZENITHDOCK_AGENT_SERVICE:-zenithbot-agent.service}"

echo "Deploying $SCRIPT_DIR/agent_server.py to $REMOTE_HOST:$REMOTE_SERVER_PATH"
scp "$SCRIPT_DIR/agent_server.py" "$REMOTE_HOST:$REMOTE_SERVER_PATH"

echo "Compiling server on $REMOTE_HOST"
ssh "$REMOTE_HOST" "python3 -m py_compile '$REMOTE_SERVER_PATH'"

echo "Restarting $SERVICE_NAME"
ssh "$REMOTE_HOST" "systemctl --user restart '$SERVICE_NAME'"

echo "Checking health"
if [[ -n "${ZENITHDOCK_AGENT_TOKEN:-}" ]]; then
  ssh "$REMOTE_HOST" "curl -fsS -H 'Authorization: Bearer ${ZENITHDOCK_AGENT_TOKEN}' http://127.0.0.1:7850/api/health"
else
  REMOTE_HEALTH_BODY="/tmp/zenithdock-agent-health.json"
  STATUS="$(ssh "$REMOTE_HOST" "curl -sS -o '$REMOTE_HEALTH_BODY' -w '%{http_code}' http://127.0.0.1:7850/api/health || true")"
  if [[ "$STATUS" == "200" ]]; then
    ssh "$REMOTE_HOST" "cat '$REMOTE_HEALTH_BODY'"
  elif [[ "$STATUS" == "401" ]]; then
    echo "Health endpoint requires a token; service is responding. Set ZENITHDOCK_AGENT_TOKEN to verify authenticated health."
  else
    ssh "$REMOTE_HOST" "cat '$REMOTE_HEALTH_BODY'" || true
    echo "Health check failed with HTTP $STATUS" >&2
    exit 1
  fi
fi
echo
