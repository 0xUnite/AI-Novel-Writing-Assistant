#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/.run/two-hour-focus-watch.log"
CONSOLE_LOG="$ROOT/.run/two-hour-focus-watch.console.log"
ROUNDS="${FOCUS_WATCH_ROUNDS:-9}"
INTERVAL_SEC="${FOCUS_WATCH_INTERVAL_SEC:-900}"

mkdir -p "$ROOT/.run"

session_exists() {
  local name="$1"
  screen -list 2>/dev/null | grep -Fq ".${name}"
}

restart_dual_watchdog_if_needed() {
  if session_exists "dual-novel-progress-watchdog"; then
    return 0
  fi
  echo "watchdog=missing; restarting"
  screen -dmS dual-novel-progress-watchdog bash -lc "cd \"$ROOT\" && exec node scripts/dual-novel-progress-watchdog.cjs >> \"$ROOT/.run/dual-novel-progress-watchdog.console.log\" 2>&1"
  sleep 2
}

snapshot_progress() {
  local novel_id="$1"
  curl -fsS "http://127.0.0.1:3000/api/novels/${novel_id}/continuity-progress" \
    | jq -c '.data | {
      status,
      lastPassedOrder,
      resumeOrder,
      nextBatchStartOrder,
      nextBatchEndOrder,
      blockedOrders: ((.blockedChapters // []) | map(.chapterOrder))
    }'
}

snapshot_job() {
  local novel_id="$1"
  curl -fsS "http://127.0.0.1:3000/api/novels/${novel_id}/review-batch-jobs?limit=1" \
    | jq -c '.data[0] | {
      id,
      jobType,
      status,
      currentStage,
      currentItemLabel,
      progress,
      updatedAt
    }'
}

cd "$ROOT"

for i in $(seq 1 "$ROUNDS"); do
  ts="$(TZ=Asia/Seoul date '+%Y-%m-%d %H:%M:%S KST')"
  {
    echo "[$ts] round=$i"
    restart_dual_watchdog_if_needed
    echo "rebirth=$(snapshot_progress cmnvhbpjb004zt4jui6ac85tn)"
    echo "cyber=$(snapshot_progress cmniz64mp0001an3v59x2sfal)"
    echo "rebirth_job=$(snapshot_job cmnvhbpjb004zt4jui6ac85tn)"
    echo "cyber_job=$(snapshot_job cmniz64mp0001an3v59x2sfal)"
    echo
  } >> "$LOG" 2>> "$CONSOLE_LOG"

  if [ "$i" -lt "$ROUNDS" ]; then
    sleep "$INTERVAL_SEC"
  fi
done

ts="$(TZ=Asia/Seoul date '+%Y-%m-%d %H:%M:%S KST')"
echo "[$ts] two-hour-focus-watch completed" >> "$LOG"
