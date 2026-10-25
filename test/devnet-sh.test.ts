import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { fileURLToPath } from "node:url"

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "devnet.sh")
const consoleCmd = "node node_modules/vite/bin/vite.js --port 5173 --strictPort"
const hold = "setInterval(() => {}, 1e9)"

// Prefix of every bash script: sources the function part of devnet.sh, then
// points its paths at scratch dirs. Each dummy console is killed at exit only
// while it still runs the command line this test launched.
const prelude = `
source "$FUNCS"
set +e
zeno="$TMP/zeno"; zenon="$TMP/zenon"; console="$zeno/zeno-console"; state="$TMP/state"
mkdir -p "$state"
pids=""
stop_if() { [ "$(ps -ww -p "$1" -o command= 2>/dev/null)" = "$2" ] && kill -TERM "$1" 2>/dev/null; return 0; }
trap 'for p in $pids; do stop_if "$p" "${consoleCmd}"; done' EXIT
dummy() {
  (cd "$console" && exec node node_modules/vite/bin/vite.js --port 5173 --strictPort) &
  d=$!
  pids="$pids $d"
  sleep 1
  echo "$d" >"$state/console.pid"
}
gone() { kill -0 "$1" 2>/dev/null && echo alive || echo gone; }
`

function scratch(t: TestContext): { tmp: string; funcs: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devnet-sh-"))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const src = fs.readFileSync(script, "utf8")
  const cut = src.search(/^case "\$\{1:-\}" in/m)
  assert.ok(cut > 0, "devnet.sh has no command dispatch to cut at")
  const funcs = path.join(tmp, "functions.sh")
  fs.writeFileSync(funcs, src.slice(0, cut))
  return { tmp, funcs }
}

// A zeno-console checkout and install, with vite.js running body.
function makeConsole(tmp: string, viteBody: string): void {
  const c = path.join(tmp, "zeno", "zeno-console")
  fs.mkdirSync(path.join(c, "node_modules", "vite", "bin"), { recursive: true })
  fs.writeFileSync(path.join(c, "node_modules", "vite", "bin", "vite.js"), viteBody + "\n")
  fs.writeFileSync(path.join(c, "node_modules", ".package-lock.json"), "{}\n")
  fs.writeFileSync(path.join(c, "package.json"), "{}\n")
  fs.writeFileSync(path.join(c, "package-lock.json"), "{}\n")
}

function makeCheckouts(tmp: string): void {
  for (const d of ["zenon/go-zenon", "zeno/zeno-executor", "zeno/zeno-contract-sdk-rs"]) {
    fs.mkdirSync(path.join(tmp, d), { recursive: true })
  }
}

function makeGitConsole(tmp: string, viteBody: string): void {
  makeConsole(tmp, viteBody)
  const c = path.join(tmp, "zeno", "zeno-console")
  execFileSync("git", ["init", "-q"], { cwd: c })
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "--allow-empty", "-qm", "init"], { cwd: c })
}

function run(tmp: string, funcs: string, body: string, env: Record<string, string> = {}): string {
  const r = spawnSync("bash", ["-c", prelude.replace("${consoleCmd}", consoleCmd) + body], {
    env: { ...process.env, TMP: tmp, FUNCS: funcs, ...env },
    encoding: "utf8",
    timeout: 60_000,
  })
  assert.equal(r.status, 0, `bash failed: ${r.stderr}`)
  return r.stdout
}

function parse(out: string): Record<string, string> {
  const m: Record<string, string> = {}
  for (const line of out.split("\n")) {
    const i = line.indexOf("=")
    if (i > 0) m[line.slice(0, i)] = line.slice(i + 1)
  }
  return m
}

test("console_pid rejects a process whose command line is not the console's", (t) => {
  const { tmp, funcs } = scratch(t)
  makeConsole(tmp, hold)
  const m = parse(run(tmp, funcs, `
bash -c 'exec -a vite sleep 300' &
sp=$!
sleep 1
echo "$sp" >"$state/console.pid"
console_pid >/dev/null; echo "other=$?"
kill -TERM "$sp"
dummy
out="$(console_pid)"; echo "own=$?"
echo "ownpid=$([ "$out" = "$d" ] && echo same || echo differs)"
`))
  assert.equal(m.other, "1")
  assert.equal(m.own, "0")
  assert.equal(m.ownpid, "same")
})

test("preflight rejects a local console install older than package.json or package-lock.json", (t) => {
  const { tmp, funcs } = scratch(t)
  makeCheckouts(tmp)
  makeConsole(tmp, hold)
  const out = run(tmp, funcs, `
docker() { return 1; }
touch -t 202601010000 "$console/node_modules/.package-lock.json"
msg="$(preflight 2>&1)"; echo "stale=$?"; echo "stalemsg=$msg"
touch "$console/node_modules/.package-lock.json"
msg="$(preflight 2>&1)"; echo "fresh=$?"; echo "freshmsg=$msg"
`, { ZENO_DEVNET_LOCAL: "1" })
  const m = parse(out)
  assert.equal(m.stale, "1")
  assert.match(m.stalemsg ?? "", /zeno-console has no install, or one older than its package.json or package-lock.json/)
  assert.equal(m.fresh, "0")
  assert.equal(m.freshmsg, "")
})

test("preflight installs a stale pinned console with npm ci", (t) => {
  const { tmp, funcs } = scratch(t)
  makeCheckouts(tmp)
  makeConsole(tmp, hold)
  const m = parse(run(tmp, funcs, `
docker() { return 1; }
npm() { echo "npm=$* in $(basename "$PWD")"; touch "$console/node_modules/.package-lock.json"; }
touch -t 202601010000 "$console/node_modules/.package-lock.json"
preflight; echo "status=$?"
`))
  assert.equal(m.npm, "ci in zeno-console")
  assert.equal(m.status, "0")
})

test("fetch_sources fetches each pinned commit once and restores a changed checkout", (t) => {
  const { tmp, funcs } = scratch(t)
  const up = path.join(tmp, "upstream")
  fs.mkdirSync(up)
  const git = (...a: string[]) => execFileSync("git", a, { cwd: up, encoding: "utf8" }).trim()
  git("init", "-q")
  fs.writeFileSync(path.join(up, "file.txt"), "pinned\n")
  git("add", "file.txt")
  git("-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "pinned")
  const commit = git("rev-parse", "HEAD")
  fs.mkdirSync(path.join(tmp, "root"))
  fs.writeFileSync(path.join(tmp, "root", "sources.txt"), `# path url commit\n\nzeno/demo file://${up} ${commit}\n`)
  const m = parse(run(tmp, funcs, `
root="$TMP/root"; src="$TMP/src"
echo "first=$(fetch_sources | tr '\\n' ' ')"
echo "head=$(git -C "$src/zeno/demo" rev-parse HEAD)"
echo "second=$(fetch_sources | tr '\\n' ' ')"
echo changed >"$src/zeno/demo/file.txt"
echo "third=$(fetch_sources | tr '\\n' ' ')"
echo "file=$(cat "$src/zeno/demo/file.txt")"
`))
  assert.equal(m.first, `fetching zeno/demo at ${commit.slice(0, 12)} `)
  assert.equal(m.head, commit)
  assert.equal(m.second, "")
  assert.equal(m.third, `fetching zeno/demo at ${commit.slice(0, 12)} `)
  assert.equal(m.file, "pinned")
})

test("preflight and status fail with a message when lsof is missing", (t) => {
  const { tmp, funcs } = scratch(t)
  makeCheckouts(tmp)
  makeConsole(tmp, hold)
  fs.mkdirSync(path.join(tmp, "empty-bin"))
  const m = parse(run(tmp, funcs, `
docker() { return 1; }
msg="$(PATH="$TMP/empty-bin"; preflight 2>&1)"; echo "pre=$?"; echo "premsg=$msg"
msg="$(PATH="$TMP/empty-bin"; status 2>&1)"; echo "status=$?"; echo "statusmsg=$msg"
`))
  const line = "lsof is not installed; scripts/devnet.sh uses it to find the process listening on port 5173"
  assert.equal(m.pre, "1")
  assert.match(m.premsg ?? "", /lsof is not installed/)
  assert.equal(m.status, "1")
  assert.equal(m.statusmsg, line)
})

test("console_start keeps a console recorded at the current version", (t) => {
  const { tmp, funcs } = scratch(t)
  makeGitConsole(tmp, hold)
  const m = parse(run(tmp, funcs, `
port_listeners() { echo "$$"; }
dummy
console_version >"$state/console.started"
out="$(console_start 2>&1)"; echo "rc=$?"; echo "out=$out"
echo "dummy=$(gone "$d")"
`))
  assert.equal(m.rc, "0")
  assert.equal(m.out, "console already running")
  assert.equal(m.dummy, "alive")
})

test("console_start restarts a console recorded at another version", (t) => {
  const { tmp, funcs } = scratch(t)
  makeGitConsole(tmp, hold)
  const m = parse(run(tmp, funcs, `
port_listeners() { echo "$$"; }
zeros="0000000000000000000000000000000000000000 $(cksum <"$console/node_modules/.package-lock.json")"
dummy
echo "$zeros" >"$state/console.started"
now="$(console_version)"
out="$(console_start 2>&1)"; echo "rc=$?"
echo "restart=$(echo "$out" | grep -c "console (pid $d) was started at zeno-console $zeros; now $now; restarting")"
echo "port=$(echo "$out" | grep -c "port 5173 is in use by pid $$")"
echo "dummy=$(gone "$d")"
echo "files=$([ -e "$state/console.pid" ] || [ -e "$state/console.started" ] && echo present || echo absent)"
`))
  assert.equal(m.rc, "1")
  assert.equal(m.restart, "1")
  assert.equal(m.port, "1")
  assert.equal(m.dummy, "gone")
  assert.equal(m.files, "absent")
})

test("console_start restarts a console whose installed packages changed", (t) => {
  const { tmp, funcs } = scratch(t)
  makeGitConsole(tmp, hold)
  const m = parse(run(tmp, funcs, `
port_listeners() { echo "$$"; }
dummy
console_version >"$state/console.started"
echo '{"changed":1}' >"$console/node_modules/.package-lock.json"
out="$(console_start 2>&1)"; echo "rc=$?"
echo "restart=$(echo "$out" | grep -c restarting)"
echo "dummy=$(gone "$d")"
`))
  assert.equal(m.rc, "1")
  assert.equal(m.restart, "1")
  assert.equal(m.dummy, "gone")
})

test("console_start restarts a console with no recorded version", (t) => {
  const { tmp, funcs } = scratch(t)
  makeGitConsole(tmp, hold)
  const m = parse(run(tmp, funcs, `
port_listeners() { echo "$$"; }
dummy
rm -f "$state/console.started"
out="$(console_start 2>&1)"; echo "rc=$?"
echo "text=$(echo "$out" | grep -c "an unrecorded commit and install")"
echo "dummy=$(gone "$d")"
`))
  assert.equal(m.rc, "1")
  assert.equal(m.text, "1")
  assert.equal(m.dummy, "gone")
})

test("console_start records the version and reports a console that exits", (t) => {
  const { tmp, funcs } = scratch(t)
  makeGitConsole(tmp, "process.exit(0)")
  const m = parse(run(tmp, funcs, `
port_listeners() { :; }
out="$(console_start 2>&1)"; echo "rc=$?"
echo "exited=$(echo "$out" | grep -c "console exited")"
echo "recorded=$([ "$(cat "$state/console.started")" = "$(console_version)" ] && echo yes || echo no)"
`))
  assert.equal(m.rc, "1")
  assert.equal(m.exited, "1")
  assert.equal(m.recorded, "yes")
})
