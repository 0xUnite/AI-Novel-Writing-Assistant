#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"
SERVER_SESSION="ai-novel-server"
CLIENT_SESSION="ai-novel-client"
SERVER_LOG="$RUN_DIR/server.log"
CLIENT_LOG="$RUN_DIR/client.log"
SERVER_PORT=3000
CLIENT_PORT=5173
CLIENT_URL="http://localhost:${CLIENT_PORT}/"
SERVER_HEALTH_URL="http://localhost:${SERVER_PORT}/api/health"
SERVER_CMD="/opt/homebrew/bin/node dist/app.js"
CLIENT_EXEC='/opt/homebrew/opt/node@20/bin/node node_modules/vite/bin/vite.js --host 0.0.0.0 --port 5173'

mkdir -p "$RUN_DIR"

session_exists() {
  local name="$1"
  screen -list "$name" 2>/dev/null | grep -Fq ".${name}"
}

port_pids() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

pid_command() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null || true
}

pid_is_project_owned() {
  local pid="$1"
  local cmd
  cmd="$(pid_command "$pid")"
  [[ "$cmd" == *"$ROOT"* || "$cmd" == *"node_modules/vite/bin/vite.js"* || "$cmd" == *"dist/app.js"* ]]
}

kill_project_port_if_needed() {
  local port="$1"
  local pids pid
  pids="$(port_pids "$port")"
  [ -n "$pids" ] || return 0

  for pid in $pids; do
    if ! pid_is_project_owned "$pid"; then
      echo "Port $port is occupied by a non-project process:" >&2
      echo "  $(pid_command "$pid")" >&2
      exit 1
    fi
  done

  for pid in $pids; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  pids="$(port_pids "$port")"
  if [ -n "$pids" ]; then
    for pid in $pids; do
      kill -KILL "$pid" 2>/dev/null || true
    done
    sleep 1
  fi
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-20}"
  local i
  for i in $(seq 1 "$attempts"); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

backend_health_ok() {
  local node_bin="/opt/homebrew/bin/node"
  if [ ! -x "$node_bin" ]; then
    node_bin="node"
  fi
  curl -fsS --max-time 3 "$SERVER_HEALTH_URL" 2>/dev/null | "$node_bin" -e '
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(body);
    if (parsed?.success === true && parsed?.data?.status === "ok" && parsed?.message === "服务运行正常。") {
      process.exit(0);
    }
  } catch {
    // fall through
  }
  process.exit(1);
});
'
}

wait_for_backend() {
  local attempts="${1:-20}"
  local i
  for i in $(seq 1 "$attempts"); do
    if backend_health_ok; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_html() {
  local url="$1"
  local attempts="${2:-20}"
  local i
  for i in $(seq 1 "$attempts"); do
    if curl -I -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_server() {
  if session_exists "$SERVER_SESSION"; then
    return 0
  fi
  kill_project_port_if_needed "$SERVER_PORT"
  screen -dmS "$SERVER_SESSION" bash -lc "cd \"$ROOT/server\" && exec $SERVER_CMD >> \"$SERVER_LOG\" 2>&1"
}

start_client() {
  if session_exists "$CLIENT_SESSION"; then
    return 0
  fi
  kill_project_port_if_needed "$CLIENT_PORT"
  screen -dmS "$CLIENT_SESSION" bash -lc "cd \"$ROOT/client\" && export PATH=\"/opt/homebrew/opt/node@20/bin:\$PATH\" && exec $CLIENT_EXEC >> \"$CLIENT_LOG\" 2>&1"
}

stop_session() {
  local name="$1"
  if session_exists "$name"; then
    screen -S "$name" -X quit || true
  fi
}

show_status() {
  echo "Project: $ROOT"
  echo
  local server_pids client_pids
  server_pids="$(port_pids "$SERVER_PORT")"
  client_pids="$(port_pids "$CLIENT_PORT")"
  echo "runtime:"
  if [ -n "$server_pids" ]; then
    echo "  server: running"
  else
    echo "  server: stopped"
  fi
  if [ -n "$client_pids" ]; then
    echo "  client: running"
  else
    echo "  client: stopped"
  fi
  echo
  echo "ports:"
  echo "  3000: ${server_pids:-closed}"
  echo "  5173: ${client_pids:-closed}"
  echo
  echo "health:"
  if backend_health_ok; then
    echo "  backend: ok"
  elif [ -n "$server_pids" ]; then
    echo "  backend: wrong service or unhealthy"
  else
    echo "  backend: down"
  fi
  if curl -I -fsS --max-time 3 "$CLIENT_URL" >/dev/null 2>&1; then
    echo "  frontend: ok"
  else
    echo "  frontend: down"
  fi
  echo
  echo "logs:"
  echo "  $SERVER_LOG"
  echo "  $CLIENT_LOG"
}

open_browser() {
  osascript -e 'tell application "Google Chrome" to activate' -e "tell application \"Google Chrome\" to open location \"$CLIENT_URL\"" >/dev/null 2>&1 || true
}

case "${1:-}" in
  start)
    start_server
    start_client
    wait_for_backend 30
    wait_for_html "$CLIENT_URL" 30
    open_browser
    echo "UI started."
    echo "  Frontend: $CLIENT_URL"
    echo "  Backend:  $SERVER_HEALTH_URL"
    ;;
  stop)
    stop_session "$CLIENT_SESSION"
    stop_session "$SERVER_SESSION"
    kill_project_port_if_needed "$CLIENT_PORT" || true
    kill_project_port_if_needed "$SERVER_PORT" || true
    echo "UI stopped."
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    show_status
    ;;
  logs)
    echo "--- server ---"
    tail -n 80 "$SERVER_LOG" 2>/dev/null || true
    echo
    echo "--- client ---"
    tail -n 80 "$CLIENT_LOG" 2>/dev/null || true
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}" >&2
    exit 1
    ;;
esac
