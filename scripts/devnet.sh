#!/usr/bin/env bash
# Brings the zeno devnet up and down: go-zenon's devnet nodes, the executor and
# gateway containers, and the zeno-console dev server.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The source root holds each repository at its sources.txt path: .sources/,
# filled with the pinned commits, or with ZENO_DEVNET_LOCAL=1 the folder that
# holds zeno/zeno-devnet, so the devnet runs the checkouts beside this one.
if [ "${ZENO_DEVNET_LOCAL:-}" = 1 ]; then
  src="$(cd "$root/../.." && pwd)"
else
  src="$root/.sources"
fi
export ZENO_DEVNET_SRC="$src"
zeno="$src/zeno"
zenon="$src/zenon-network"
console="$zeno/zeno-console"
state="$root/.devnet"
console_cmd=(node node_modules/vite/bin/vite.js --port 5173 --strictPort)

# bd2b1f4b42334f923064f466ed5590379498585b2dd4e42152db0e5ddbe2023e
# is the public seed of devnet account index 3, for the devnet
# only, never for any other network.
export EXECUTOR_KEY=bd2b1f4b42334f923064f466ed5590379498585b2dd4e42152db0e5ddbe2023e

# 94b472df6365ac1365b4989d7e37961b4a620eb352d57941140d70bcc10c1804
# is the public seed of devnet account index 10, for the devnet
# only, never for any other network.
export EXECUTOR_B_KEY=94b472df6365ac1365b4989d7e37961b4a620eb352d57941140d70bcc10c1804

compose() {
  docker compose -p zeno-devnet -f "$root/docker-compose.yml" "$@"
}

usage() {
  echo "usage: scripts/devnet.sh <up [--no-config]|config|status|down|wipe>" >&2
}

console_pid() {
  local pid
  [ -f "$state/console.pid" ] || return 1
  pid="$(cat "$state/console.pid")"
  [ -n "$pid" ] || return 1
  [ "$(ps -ww -p "$pid" -o command= 2>/dev/null)" = "${console_cmd[*]}" ] || return 1
  echo "$pid"
}

# Prints the PIDs listening on TCP port 5173, on any address.
port_listeners() {
  lsof -nP -iTCP:5173 -sTCP:LISTEN -t 2>/dev/null || true
}

# Fails with a message when lsof, which port_listeners needs, is missing.
require_lsof() {
  command -v lsof >/dev/null 2>&1 || { echo "lsof is not installed; scripts/devnet.sh uses it to find the process listening on port 5173" >&2; return 1; }
}

# True when the console process this repo started is alive and listens on 5173.
console_listening() {
  local pid
  pid="$(console_pid)" || return 1
  port_listeners | grep -qx "$pid"
}

# Puts each repository sources.txt lists at its pinned commit under .sources/,
# fetching only the ones that are missing, at another commit or changed.
fetch_sources() {
  local path url commit dir
  while read -r path url commit; do
    case "$path" in "" | "#"*) continue ;; esac
    dir="$src/$path"
    if [ -d "$dir/.git" ] && [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$commit" ] && [ -z "$(git -C "$dir" status --porcelain)" ]; then
      continue
    fi
    echo "fetching $path at ${commit:0:12}"
    mkdir -p "$dir"
    git -C "$dir" init -q
    git -C "$dir" fetch -q --depth 1 "$url" "$commit"
    git -C "$dir" -c advice.detachedHead=false checkout -q --force FETCH_HEAD
    git -C "$dir" clean -qfd
  done <"$root/sources.txt"
}

# Fetches the pinned sources, unless ZENO_DEVNET_LOCAL=1 selects the local checkouts.
sources() {
  [ "${ZENO_DEVNET_LOCAL:-}" = 1 ] || fetch_sources
}

# True when zeno-console has no install, or one older than its package files.
console_stale() {
  [ ! -f "$console/node_modules/vite/bin/vite.js" ] ||
    [ "$console/package.json" -nt "$console/node_modules/.package-lock.json" ] ||
    [ "$console/package-lock.json" -nt "$console/node_modules/.package-lock.json" ]
}

preflight() {
  require_lsof || return 1
  local p owner
  for p in "$zenon/go-zenon" "$zeno/zeno-executor" "$console" "$zeno/zeno-contract-sdk-rs"; do
    [ -d "$p" ] || { echo "missing checkout: $p" >&2; return 1; }
  done
  if console_stale; then
    if [ "${ZENO_DEVNET_LOCAL:-}" = 1 ]; then
      echo "zeno-console has no install, or one older than its package.json or package-lock.json; run: cd $console && npm install" >&2
      return 1
    fi
    (cd "$console" && npm ci) || return 1
  fi
  owner="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' znnd-devnet-pillar 2>/dev/null || true)"
  if [ -n "$owner" ] && [ "$owner" != "zeno-devnet" ]; then
    echo "container znnd-devnet-pillar belongs to Compose project '$owner'; stop that devnet first" >&2
    return 1
  fi
}

# Prints the zeno-console commit and a checksum of its installed packages.
console_version() {
  echo "$(git -C "$console" rev-parse HEAD) $(cksum <"$console/node_modules/.package-lock.json")"
}

console_start() {
  local pid i other recorded current
  if pid="$(console_pid)"; then
    recorded="$(cat "$state/console.started" 2>/dev/null || true)"
    current="$(console_version)"
    if [ "$recorded" = "$current" ]; then
      echo "console already running"
      return 0
    fi
    echo "console (pid $pid) was started at zeno-console ${recorded:-an unrecorded commit and install}; now $current; restarting"
    console_stop
  fi
  other="$(port_listeners | head -n 1)"
  if [ -n "$other" ]; then
    echo "port 5173 is in use by pid $other ($(ps -p "$other" -o command= | cut -c1-100)); stop it first, the gateway allows only the console on 5173" >&2
    return 1
  fi
  mkdir -p "$state"
  console_version >"$state/console.started"
  (cd "$console" && exec nohup "${console_cmd[@]}") >"$state/console.log" 2>&1 &
  pid=$!
  echo "$pid" >"$state/console.pid"
  for i in $(seq 1 60); do
    if ! kill -0 "$pid" 2>/dev/null; then
      tail -n 20 "$state/console.log" >&2
      echo "console exited; port 5173 may be in use" >&2
      return 1
    fi
    if console_listening && curl -sf -o /dev/null http://localhost:5173/; then
      echo "console running at http://localhost:5173 (pid $pid, log $state/console.log)"
      return 0
    fi
    sleep 1
  done
  echo "console did not answer on http://localhost:5173 within 60 s" >&2
  return 1
}

console_stop() {
  local pid i
  if pid="$(console_pid)"; then
    kill -TERM "$pid" 2>/dev/null || true
    for i in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
  fi
  rm -f "$state/console.pid" "$state/console.started"
}

configure() {
  local body i
  (cd "$root" && npx tsx src/cli.ts configure)
  compose --profile replacement create executor-b gateway-b
  compose --profile replacement stop executor-b gateway-b
  compose up -d executor gateway
  for i in $(seq 1 150); do
    body="$(curl -s -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"zeno_getHead","params":[1]}' http://127.0.0.1:35999 || true)"
    case "$body" in
      *'"status":"OK"'*) echo "gateway OK"; return 0 ;;
    esac
    sleep 2
  done
  echo "gateway not OK after 5 minutes; last body: $body" >&2
  return 1
}

status() {
  require_lsof || return 1
  local failed=0 running svc
  running="$(compose ps --status running --services 2>/dev/null || true)"
  for svc in pillar pillar2 pillar3 rpc observer explorer executor gateway; do
    if printf '%s\n' "$running" | grep -qx "$svc"; then
      echo "ok container $svc"
    else
      echo "FAIL container $svc: not running"
      failed=1
    fi
  done
  if console_listening && [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/ || true)" = 200 ]; then
    echo "ok console"
  else
    echo "FAIL console: the process started by this repo is not running, not listening on 5173 or not answering"
    failed=1
  fi
  (cd "$root" && npx tsx src/cli.ts status) || failed=1
  return "$failed"
}

repo_line() {
  local branch
  branch="$(git -C "$2" branch --show-current)"
  echo "$1: ${branch:-pinned} $(git -C "$2" rev-parse --short HEAD)"
}

up() {
  local config=1
  case "${1:-}" in
    "") ;;
    --no-config) config=0 ;;
    *) usage; return 2 ;;
  esac
  preflight
  echo "sources: $src"
  repo_line go-zenon "$zenon/go-zenon"
  repo_line zeno-executor "$zeno/zeno-executor"
  repo_line zeno-console "$console"
  repo_line zeno-contract-sdk-rs "$zeno/zeno-contract-sdk-rs"
  [ -d "$root/node_modules" ] || (cd "$root" && npm install)
  compose --profile replacement build
  compose up -d pillar pillar2 pillar3 rpc observer explorer
  console_start
  if [ "$config" = 0 ]; then
    echo "configuration skipped; scripts/devnet.sh config registers the executor and starts it with its gateway"
    return 0
  fi
  configure
  status
}

case "${1:-}" in
  up | config | status | down | wipe) sources ;;
esac

case "${1:-}" in
  up) shift; up "$@" ;;
  config) configure; status ;;
  status) status ;;
  down) console_stop; compose --profile sync --profile replacement down ;;
  wipe) console_stop; compose --profile sync --profile replacement down -v; rm -rf "$state" ;;
  *) usage; exit 2 ;;
esac
