# AGENTS.md

One-command local devnet for Zeno: go-zenon's devnet nodes, the executor and gateway containers, and the zeno-console dev server. See README.md for setup and the constants.

## Commands

- `scripts/devnet.sh up [--no-config]`, `config`, `status`, `down`, `wipe`.
- `npm run typecheck`: type-check `src/`, `flows/` and `test/`.
- `npm test`: the unit tests in `test/` (Node's test runner through tsx).
- `npm run flow:<deploy-quota|deposit|call-refund|withdrawal|force-inclusion|worker-crash|crash-recovery|executor-replacement|pause|fees>`: one end-to-end flow against the running devnet (6 to 25 minutes each, fees up to 60). `npm run flows` runs all ten in order and stops at the first failure.
- `npx tsx src/cli.ts <configure|status>`: the configuration and the status checks that `devnet.sh` calls.

## Layout

- `docker-compose.yml`: project `zeno-devnet`; includes go-zenon's compose file and adds `executor` and `gateway`, and `executor-b` and `gateway-b` under the `replacement` profile.
- `config/executor.json`, `config/executor-b.json`, `config/gateway.json`: mounted into the containers; gateway-b mounts `config/gateway.json`.
- `scripts/devnet.sh`: bring-up, console process, teardown.
- `src/devnet.ts`: constants, accounts and helpers; the interface scripts attach with.
- `src/cli.ts`: `configure` and `status`.
- `flows/`: the end-to-end flows; `lib.ts` holds the shared runner, receipt tracker and withdrawal helpers.
- `sources.txt`: the pinned commits of the repositories the devnet runs, fetched into `.sources/`. `ZENO_DEVNET_LOCAL=1` uses the sibling checkouts instead (see README.md); there are no submodules.

## Rules

1. Every key here is a public devnet key. It never runs on another network.
2. `wipe` only ever targets Compose project `zeno-devnet`.
3. The console process is stopped only through `.devnet/console.pid`, never by port or name.
4. `src/devnet.ts` is the attach interface. Its `STF_SPEC_HASH`, `CONFIRMATION_DEPTH` and executor addresses (`executor`, `executorB`) match `config/*.json`.
5. Index 3 belongs to the executor and index 10 to executor-b. Nothing else sends from either.

## Gotchas

- A direct `docker compose` command needs `EXECUTOR_KEY=<index 3 seed>` and `EXECUTOR_B_KEY=<index 10 seed>` in its environment, or Compose cannot create the secrets.
- go-zenon's compose fixes container and network names, so another Compose project owning `znnd-devnet-*` (even stopped) blocks `up`.
- A cold `rpc` node stays at height 1 until the pillars pass the libp2p spork height; `config` waits for it to reach the frontier.
- Run one flow at a time and send nothing from index 8 meanwhile: two writers on one account chain collide. Also send no Settlement input to any domain from any account: the flows assert exact `totalDeposited` deltas, and force-inclusion asserts the exact growth of Settlement's global received-input count.
- Ctrl-C while an executor-control flow has the executor down leaves it stopped and `scripts/devnet.sh status` prints `FAIL container executor`; the next flow or `scripts/devnet.sh config` starts it.
- `flow:fees` clears its relay pause on Ctrl-C, but a second Ctrl-C or a kill can leave domain 1 relay-paused, which stops fee settlement and `CollectReward` for every domain; the next `flow:fees` or `flow:pause` clears it.
- Every flow refuses to start while executor-b runs; `flow:executor-replacement` restores the original executor on a pass, a failure or Ctrl-C. After a second Ctrl-C or a kill, `scripts/devnet.sh config` restores it, and README.md's Flows section covers a halted executor-b.
