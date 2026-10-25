# zeno-devnet

One command brings up a local Zeno devnet: go-zenon's devnet nodes and explorer, the WASM executor and its gateway, and the zeno-console dev server. The bring-up also registers the executor and configures the network, so the devnet is ready to use when the command returns.

## Sources

The devnet runs the commits `sources.txt` pins: go-zenon, zeno-executor, zeno-console and zeno-contract-sdk-rs. Every command fetches each one into `.sources/<path>` when it is missing, at another commit or changed, so a clone of this repository runs on its own.

To run your own checkouts while developing the system, set `ZENO_DEVNET_LOCAL=1` on every command, for example `ZENO_DEVNET_LOCAL=1 scripts/devnet.sh up`. The devnet then uses the checkouts beside this one, in this layout:

```
<root>/zeno/zeno-devnet
<root>/zeno/zeno-executor
<root>/zeno/zeno-console
<root>/zeno/zeno-contract-sdk-rs
<root>/zenon-network/go-zenon          (the settlement branch)
```

To move the devnet to new commits, edit `sources.txt` and run `scripts/devnet.sh up`.

## Prerequisites

- Docker with Compose. Tested with Compose 5.1.4; older releases are unsupported.
- Node `^22.23.0 || ^24.17.0 || >=26.1.0`, git, curl and lsof. Go is not needed on the host. The range is zeno-client's `engines.node`: Node 22.23.0, 24.17.0 and 26.1.0 are the first releases whose bundled undici caps a WebSocket message at 128 MiB by default, which bounds zeno-client's gateway WebSocket transport.
- With `ZENO_DEVNET_LOCAL=1`, `npm install` in your `zeno-console` checkout. Run it again after its `package.json` or `package-lock.json` changes; `up` refuses an older install. With the pinned sources, `up` installs the console itself.
- Port 5173 free: the gateway allows the console on 5173. Stop any other console dev server first.

## Commands

| Command | What it does |
|---|---|
| `scripts/devnet.sh up` | Builds the images, starts the nodes and the explorer, starts the console, configures the network, starts the executor and the gateway, then runs `status`. |
| `scripts/devnet.sh up --no-config` | Same, without configuration or the executor and gateway. Register the executor by hand through the console's Admin area, or run `config` later. |
| `scripts/devnet.sh config` | Sends only the configuration that is missing, starts the executor and gateway, waits for the gateway, then runs `status`. It also creates `executor-b` and `gateway-b` and leaves them stopped. |
| `scripts/devnet.sh status` | One `ok` or `FAIL` line per check: each container, the console, the node, the configuration, the conservation check (counter consistency for domain 1 ZNN and the fee counters, not Settlement's balance) and the gateway. Exits 1 on any `FAIL`. |
| `scripts/devnet.sh down` | Stops the console and the containers. The chain survives, so the next `up` resumes it. |
| `scripts/devnet.sh wipe` | Stops the console, removes the Compose project `zeno-devnet` with its volumes, and deletes `.devnet/`. It keeps `.sources/`. |

`up` and `config` are idempotent: a configured devnet receives no transactions, and an interrupted configuration completes on the next run.

A cold `up` takes about 20 minutes (image builds about 8, node start and console about 3, configuration about 7, the gateway's first sync about 2). A re-run takes a few minutes.

## Configuration the bring-up applies

1. Fuses 10,000 QSR for the admin, executor and user accounts.
2. Registers domain 1 (WASM, execution, attestation, single proposer, delay finality).
3. Registers the executor address for pillar `dev1`.
4. Approves the best-effort DA mode.
5. Sets the ZNN asset limit.
6. Sets the byte prices.

The admin delay is 12 momentums, so the time-challenged items take two sends about 2 minutes apart.

## Topology and endpoints

| Service | Endpoint |
|---|---|
| Node HTTP RPC | `http://127.0.0.1:35997` |
| Node WebSocket | `ws://127.0.0.1:35998` |
| Pillar 1 HTTP RPC | `http://127.0.0.1:35991` |
| Gateway | `http://127.0.0.1:35999` |
| Gateway B | `http://127.0.0.1:36002`, served only while `flow:executor-replacement` runs |
| Console | `http://localhost:5173` |
| Explorer | `http://localhost:36000` |

go-zenon's compose file fixes its container and network names, so one devnet runs at a time. `up` refuses to start while another Compose project owns `znnd-devnet-pillar`. Do not start go-zenon's `sync` profile here: its sync node uses host port 35999, the gateway's port.

`docker-compose.yml` includes go-zenon's compose file and adds `executor` and `gateway`, and `executor-b` and `gateway-b` under the `replacement` profile. The executor runs privileged with a private cgroup so its supervisor can separate worker uids. The gateway runs as uid 9999.

## Direct Compose commands

The `executor_key` and `executor_b_key` secrets come from the environment, so every direct command needs the index 3 seed in `EXECUTOR_KEY` and the index 10 seed in `EXECUTOR_B_KEY`. Without them Compose cannot create the secrets.

```sh
EXECUTOR_KEY=bd2b1f4b42334f923064f466ed5590379498585b2dd4e42152db0e5ddbe2023e \
  EXECUTOR_B_KEY=94b472df6365ac1365b4989d7e37961b4a620eb352d57941140d70bcc10c1804 \
  docker compose -p zeno-devnet -f docker-compose.yml logs executor gateway
```

## Constants

`src/devnet.ts` exports these.

| Name | Value | Reason |
|---|---|---|
| `COMPOSE_PROJECT` | `zeno-devnet` | the only project `wipe` touches |
| `NODE_URL`, `NODE_WS_URL` | `http://127.0.0.1:35997`, `ws://127.0.0.1:35998` | go-zenon devnet public RPC node |
| `PILLAR_URL` | `http://127.0.0.1:35991` | pillar 1 HTTP RPC |
| `GATEWAY_URL` | `http://127.0.0.1:35999` | the gateway's published port |
| `GATEWAY_B_URL` | `http://127.0.0.1:36002` | gateway-b's published port |
| `CONSOLE_URL`, `EXPLORER_URL` | `http://localhost:5173`, `http://localhost:36000` | the dev server and go-zenon's explorer |
| `CHAIN_ID` | `69` | devnet `ChainIdentifier`, also the network id |
| `DOMAIN_ID` | `1` | the WASM domain |
| `STF_SPEC_HASH` | `00…01` (32 bytes) | equals `config/executor.json` |
| `PILLAR_NAME` | `dev1` | genesis pillar 1 |
| `WITHDRAWAL_DELAY` | `30n` | the devnet build's `WithdrawalDelayMin`; a longer delay makes every flow's finality wait impractical |
| `RUNTIME_UPGRADE_DELAY` | `17_280n` (2 days) | the testnet value: at least the withdrawal delay, and equal to `MinAdministratorDelay`; no flow waits on it |
| `MAX_BATCH_WITHDRAWAL` | `100_000_000_000n` (1,000 ZNN) | far above test amounts, inside the 1,000,000 ZNN ceiling |
| `ZNN_PER_BYTE_OF_BYTECODE`, `ZNN_PER_BYTE_OF_STATE` | `1_000n` each | inside the bounds [1, 10^8]; a 256 KiB module costs about 2.6 ZNN |
| `FUSE_QSR` | `1_000_000_000_000n` (10,000 QSR) | covers sends above the PoW plasma limit, such as deploy chunks |
| `CONFIRMATION_DEPTH` | `3` | equals both config files |
| `ADMIN_DELAY` | `12` | devnet `MinAdministratorDelay`; covers the 6-momentum soft delay too |
| `MNEMONIC` | go-zenon `docker/devnet/README.md` | public, devnet only |

## Accounts

The public devnet mnemonic derives these accounts (key indices in `ACCOUNTS`).

| Name | Index | Address | Role |
|---|---|---|---|
| `admin` | 1 | `z1qq6eg8n43g032hanpsfp02qcdmv7zfj3y2lt5d` | network administrator |
| `executor` | 3 | `z1qp3yph55qgresyytz83anynr2f4z39x2z3ej3e` | the executor's submission key |
| `user` | 8 | `z1qpeet8dcjg0m6x6m3tg437wnc42aa2nez2fzth` | funded user, fused |
| `recipient` | 9 | `z1qqcam4ycu0ta8333hx38r5j2z3ry9jjfxkc7t5` | funded recipient |
| `executorB` | 10 | `z1qqp22leuqa32un6vegg8ty40vkdupgf7negvv0` | executor-b's submission key |

Index 3 belongs to the executor and index 10 to executor-b. Nothing here sends from either, and no script should.

## Console

The dev server runs on the host at `http://localhost:5173`, started and stopped through `.devnet/console.pid`. Its log is `.devnet/console.log`. `up` restarts the server when the zeno-console checkout or its install changed since the server started (`.devnet/console.started`).

One-time browser setup:

1. Install the nom-webwallet extension: in the `nom-webwallet` checkout run `npm install` and `npm run build:extension`, then load `dist-extension/` unpacked in Chrome or Edge developer mode.
2. In the wallet, open Settings, then Network. Set chain id 69, network id 69 and node `ws://localhost:35998`.
3. In the console, open the network indicator and set the same chain id, network id and node.
4. The gateway `http://127.0.0.1:35999` and domain 1 are the console defaults. Check them in the network indicator and Settings, because a browser that saved other settings keeps them.
5. Enter the index 1 address under "Administrator address" in Settings to open the Admin area.
6. Import the mnemonic into the wallet to sign. Never send from index 3.

## Attaching scripts

Scripts in this repo import `src/devnet.ts`: the constants, `keyPair`, `connect`, `sendAndWait`, `waitFor`, `waitHeight` and `readConfiguration`. Every value is fixed before run time (endpoints by the compose files, keys by the public mnemonic, the domain id by the registration), so there is no generated record. Run `scripts/devnet.sh status` before acting on a running devnet.

## Flows

Ten end-to-end flows run against the running devnet. Every flow that needs a contract deploys its own vault from `zeno-contract-sdk-rs/examples/vault/artifacts/` in the sources (checked against the hash file there), so a flow passes again on the same chain. Force-inclusion, executor-replacement and pause need none.

| Command | What it checks |
|---|---|
| `npm run flow:deploy-quota` | Chunked deploy and finalize, `BuyStorage`, a deposit refused one byte short of the quota and accepted after the last byte, and verified contract and balance reads. |
| `npm run flow:deposit` | A plain `Deposit`: the `totalDeposited` delta, the `Deposited` event and the verified balance. |
| `npm run flow:call-refund` | A payable `CallL2` that keeps part of the payment and refunds the rest, then relays and releases the refund to L1. Uses the test-hook build, the only one with a payable method. |
| `npm run flow:withdrawal` | An L2 to L1 withdrawal: outbox item, proof, finalization, `RelayMessage` and `ReleaseWithdrawals`. |
| `npm run flow:force-inclusion` | Two deposits that Settlement accepts while the executor is stopped, then executed in canonical order. |
| `npm run flow:worker-crash` | The domain worker is killed, the supervisor restarts it, and the domain keeps finalizing. |
| `npm run flow:crash-recovery` | The executor container is killed with an accepted, unfinalized batch above a finalized one, then recovers and finalizes it. |
| `npm run flow:executor-replacement` | A second executor (account index 10, its own volume and gateway) catches up, takes over domain 1 and finalizes a deposit; the original executor then takes back over, rebuilds executor-b's batches and finalizes a deposit. |
| `npm run flow:pause` | Submit and relay pause and unpause, and what each blocks. |
| `npm run flow:fees` | Deploy and `BuyStorage` fees accrue, the relay pause holds their epoch through an `Update`, the epochs settle (30% burned, 70% credited), and `CollectReward` pays the credit to `admin`, refused while relay-paused. |

`npm run flows` runs all ten as separate processes and stops at the first failure. Each flow takes 6 to 18 minutes, mostly the 30-momentum withdrawal delay, the fee flow takes 15 to 60 minutes, and executor-replacement takes about 25 minutes plus executor-b's first catch-up from genesis on a chain it has not seen. That catch-up has no time limit and fails only when gateway-b reaches no new batch for 10 minutes. All ten take about 2.5 to 3 hours.

Output is one `ok <check>` line per check, including each receipt at `pending`, `latest` and `finalized`, then `PASS <name> in <m>m<s>s` and exit 0, or `FAIL <detail>` and `FAIL <name> after <m>m<s>s` and exit 1. At every tag, zeno-client's `verifyReceipt` binds each receipt to its send, domain and sender through the node's copy of the send block; at `latest` and `finalized` it also checks the receipt against the batch Settlement accepted (receipt root, leaf, input, return data, event and outbox roots, outbox ids, and finality at `finalized`), and the flow checks that the gateway's bundle hashes to the batch's `daHash`. After every step a conservation check requires `totalReleased + pendingWithdrawalReserve <= totalDeposited` for domain 1 and ZNN, the only pair the bring-up configures. The same check requires `totalFeesBurned + totalFeesCredited <= totalFeesCollected` and `totalRewardsCollected <= totalFeesCredited`.

Rules:

1. Run one flow at a time. Send nothing from account index 8 while a flow runs, and send no Settlement input to any domain from any account: the flows assert exact `totalDeposited` deltas, and force-inclusion asserts the exact growth of Settlement's global received-input count.
2. The executor relays and releases finalized withdrawals itself. The flows send `RelayMessage` and `ReleaseWithdrawals` as soon as Settlement allows, usually first. When the executor wins, the line reads "by another sender" and the step still passes.

The executor-control flows act only on the `zeno-devnet` project's executor container, through plain `docker`. Force-inclusion stops it for about a minute, crash-recovery kills it for about 30 seconds, and worker-crash kills only the worker process. Each flow starts the executor again when it ends or fails. Every flow starts an executor it finds stopped, so after Ctrl-C the next flow or `scripts/devnet.sh config` starts it.

The pause flow holds domain 1's batches for about 2 minutes (submit pause) and its relays and releases for about 7 minutes (relay pause). While the relay pause is set, fee-epoch settlement stops for every domain. The flow clears both pauses when it ends or fails. After Ctrl-C, the next `npm run flow:pause` clears a pause left set, and so does the console's Admin view.

The fee flow first waits for the fee epoch queue to empty, up to about 35 minutes after another flow. On a node without the devnet fee-epoch override (`FeeEpochMomentums` 60), this wait times out naming the build when earlier epochs are queued, and otherwise the `fee epoch queued` step fails at once naming the build. It collects dev1's Settlement reward to `admin` (index 1) at the start and end, so nothing else should collect it meanwhile. It sets the relay pause for up to about 15 minutes, then about 1 minute, and clears it when it ends, fails or gets Ctrl-C. A domain 1 relay pause stops domain 1's relays and releases only, while fee settlement and `CollectReward` stop for every domain. After Ctrl-C the flow takes about 30 seconds to clear the pause before exiting. A second Ctrl-C exits at once, and then the next `flow:fees` or `flow:pause` clears the pause.

The executor-replacement flow stops the original executor for about 15 minutes, with executor-b registered for about 10 of them. While executor-b is registered, gateway A on port 35999, and the console with it, reports domain 1 as `SYNCING`; it returns to `OK` once the original executor rebuilds executor-b's batches. On a pass, a failure or the first Ctrl-C the flow restores the original registration, starts the original executor, waits for it to catch up and stops executor-b and gateway-b, which takes up to about 10 minutes. Every flow refuses to start while executor-b runs. After a second Ctrl-C, a kill or a restore failure, run `scripts/devnet.sh config`: it re-registers the original executor, starts it, and stops executor-b and gateway-b. When executor-b halts at its catch-up, its volume holds a batch Settlement did not accept; remove its state with the three commands below, then run the flow again. When the original executor halts rebuilding executor-b's batches, the two builds disagree, which is a defect: `scripts/devnet.sh wipe`, then `up`.

```sh
export EXECUTOR_KEY=bd2b1f4b42334f923064f466ed5590379498585b2dd4e42152db0e5ddbe2023e EXECUTOR_B_KEY=94b472df6365ac1365b4989d7e37961b4a620eb352d57941140d70bcc10c1804
docker compose -p zeno-devnet -f docker-compose.yml --profile replacement rm -sf executor-b gateway-b
docker volume rm zeno-devnet_executor-b-data zeno-devnet_gateway-b-data && scripts/devnet.sh config
```
