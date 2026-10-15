#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
API_HOST="${LABMONITOR_HOST:-0.0.0.0}"
API_PORT="${LABMONITOR_PORT:-8000}"
WEB_PORT="${LABMONITOR_WEB_PORT:-5173}"

port_available() {
  "$PYTHON_BIN" - "$1" "$2" <<'PY'
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    sock.bind((host, port))
except OSError:
    sys.exit(1)
finally:
    sock.close()
PY
}

next_available_port() {
  local host="$1"
  local candidate="$2"
  while ! port_available "$host" "$candidate"; do
    candidate=$((candidate + 1))
  done
  printf '%s\n' "$candidate"
}

for tool in "$PYTHON_BIN" node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required command not found: $tool" >&2
    exit 1
  fi
done

if [[ ! -x "$ROOT_DIR/backend/.venv/bin/python" ]]; then
  "$PYTHON_BIN" -m venv "$ROOT_DIR/backend/.venv"
fi
"$ROOT_DIR/backend/.venv/bin/python" -m pip install -q -r "$ROOT_DIR/backend/requirements.txt"

if [[ ! -d "$ROOT_DIR/frontend/node_modules" ]]; then
  (cd "$ROOT_DIR/frontend" && npm install --no-audit --no-fund)
fi

if ! port_available "$API_HOST" "$API_PORT"; then
  requested_api_port="$API_PORT"
  API_PORT="$(next_available_port "$API_HOST" "$API_PORT")"
  echo "Port $requested_api_port is busy; using API port $API_PORT."
fi

if ! port_available 0.0.0.0 "$WEB_PORT"; then
  requested_web_port="$WEB_PORT"
  WEB_PORT="$(next_available_port 0.0.0.0 "$WEB_PORT")"
  echo "Port $requested_web_port is busy; using web port $WEB_PORT."
fi

export LABMONITOR_HOST="$API_HOST"
export LABMONITOR_PORT="$API_PORT"
export LABMONITOR_API_TARGET="${LABMONITOR_API_TARGET:-http://127.0.0.1:$API_PORT}"
export LABMONITOR_USE_POLLING="${LABMONITOR_USE_POLLING:-true}"

(cd "$ROOT_DIR/backend" && exec .venv/bin/python run.py) &
API_PID=$!
(cd "$ROOT_DIR/frontend" && exec ./node_modules/.bin/vite --host 0.0.0.0 --port "$WEB_PORT" --logLevel error) &
WEB_PID=$!

cleanup() {
  trap - EXIT INT TERM HUP
  kill "$API_PID" "$WEB_PID" 2>/dev/null || true
  wait "$API_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM HUP

SERVER_IP="${LABMONITOR_SERVER_IP:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
SERVER_IP="${SERVER_IP// /}"
SERVER_IP="${SERVER_IP:-127.0.0.1}"
echo "LabMonitor is starting. Open http://$SERVER_IP:$WEB_PORT"
echo "API endpoint: http://$SERVER_IP:$API_PORT/api/health"
echo "Press Ctrl+C to stop LabMonitor."
wait -n "$API_PID" "$WEB_PID"
