import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  GatewayClient,
  NotFoundError,
  l1Caller,
  parseInterface,
  prepareDeploy,
  sha3,
  zenoSelectorV1,
  type ContractInterface,
  type ContractsProfile,
  type DecodedEvent,
  type ReceiptResult,
  type Tag,
  type TagName,
  type VerificationReport,
} from "zeno-client"
import {
  Address,
  Hash,
  RPC_MAX_PAGE_SIZE,
  ZNN_ZTS,
  Zenon,
  settlement,
  type AccountBlockTemplate,
  type KeyPair,
} from "znn-typescript-sdk"
import {
  COMPOSE_PROJECT,
  DOMAIN_ID,
  GATEWAY_URL,
  SOURCE_ROOT,
  WITHDRAWAL_DELAY,
  conservationFailures,
  connect,
  keyPair,
  readConfiguration,
  sendAndWait,
  waitFor,
} from "../src/devnet.js"

export const ONE_ZNN = 100_000_000n
export const PLASMA_LIMIT = 10_000_000n // the input gas budget of every Deposit and CallL2
export const ZNN_ASSET = settlement.assetIdFromZts(ZNN_ZTS)
// The quota counts 64 bytes per leaf plus the value length (zeno-executor
// plugins/wasm/quota.go:37-40, plugins/wasm/limits.go:94).
export const BALANCE_LEAF_BYTES = 96n

// The 23-byte version-1 ContractMetadata: u16 version 1, u8 policy
// IMMUTABLE (0), zero owner (zeno-client src/derive.ts:58-62).
const IMMUTABLE_METADATA = Buffer.from("0001" + "00".repeat(21), "hex")

export const user = keyPair("user")

export interface Ctx {
  zenon: Zenon
  gateway: GatewayClient
  contracts: ContractsProfile
  executor: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const duration = (ms: number) => `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`

let current: Ctx
let conservationChecks = 0
const trackers: Tracked[] = []

async function conservation(after: string): Promise<void> {
  const failures = await conservationFailures(current.zenon)
  if (failures.length > 0) throw new Error(`conservation after ${after}: ${failures.join("; ")}`)
  conservationChecks++
}

export function flow(name: string, body: (ctx: Ctx) => Promise<void>): void {
  const start = Date.now()
  const main = async () => {
    const zenon = await connect()
    const config = await readConfiguration(zenon)
    if (config.missing.length > 0 || config.conflicts.length > 0) {
      throw new Error(`${[...config.conflicts, ...config.missing.map((m) => `missing ${m}`)].join("; ")}; run scripts/devnet.sh config`)
    }
    const replacement = await docker(
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
      "--filter",
      "label=com.docker.compose.service=executor-b",
    )
    if (replacement !== "") throw new Error("executor-b is running; run scripts/devnet.sh config")
    const executor = await runningExecutor()
    const gateway = await GatewayClient.connect(GATEWAY_URL, {
      batches: (d, b) => zenon.embedded.settlement.getBatch(d, b),
      sends: (hash) => zenon.ledger.getAccountBlockByHash(hash),
    })
    const head = await gateway.getHead(DOMAIN_ID)
    if (head.status !== "OK") throw new Error(`gateway domain ${DOMAIN_ID} status is ${head.status}; run scripts/devnet.sh config`)
    current = { zenon, gateway, contracts: await gateway.contracts(DOMAIN_ID), executor }
    await conservation("start")
    await body(current)
    for (const t of trackers) await t.at("finalized")
    console.log(`ok conservation held after ${conservationChecks} checks`)
  }
  main().then(
    () => {
      console.log(`PASS ${name} in ${duration(Date.now() - start)}`)
      process.exit(0)
    },
    (e) => {
      console.log(`FAIL ${message(e)}`)
      console.log(`FAIL ${name} after ${duration(Date.now() - start)}`)
      process.exit(1)
    },
  )
}

export async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let value: T
  try {
    value = await fn()
  } catch (e) {
    throw new Error(`${label}: ${message(e)}`)
  }
  await conservation(label)
  console.log(`ok ${label}`)
  return value
}

export async function send(
  kp: KeyPair,
  tx: AccountBlockTemplate,
  want: boolean | "either" = true,
): Promise<{ hash: Hash; receiveHeight: number; accepted: boolean }> {
  const result = await sendAndWait(kp, tx)
  if (want === true && !result.accepted) throw new Error(`Settlement rejected send ${result.hash}`)
  if (want === false && result.accepted) throw new Error(`Settlement accepted send ${result.hash}, want a rejection`)
  return result
}

export function expectStatus(r: ReceiptResult, status: string): void {
  assert.equal(r.receipt.status, status, `receipt status of ${r.sendHash}`)
}

export async function totalDeposited(ctx: Ctx): Promise<bigint> {
  const info = await ctx.zenon.embedded.settlement.getAssetInfo(DOMAIN_ID, ZNN_ASSET)
  if (info === null) throw new Error(`domain ${DOMAIN_ID} ZNN asset info not found`)
  return info.totalDeposited
}

const execFileAsync = promisify(execFile)

async function execDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("docker", args, { maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr?.trim()
    throw new Error(`docker ${args.join(" ")}: ${stderr ? stderr : message(e)}`)
  }
}

export async function docker(...args: string[]): Promise<string> {
  return (await execDocker(args)).stdout.trim()
}

// Compose places environment secrets when it starts a container, so a
// container that holds a secret must start through Compose, not docker.
export async function compose(...args: string[]): Promise<string> {
  const seed = (name: "executor" | "executorB") => keyPair(name).getPrivateKey().toString("hex").slice(0, 64)
  const file = fileURLToPath(new URL("../docker-compose.yml", import.meta.url))
  try {
    const { stdout } = await execFileAsync("docker", ["compose", "-p", COMPOSE_PROJECT, "-f", file, "--profile", "replacement", ...args], {
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ZENO_DEVNET_SRC: SOURCE_ROOT, EXECUTOR_KEY: seed("executor"), EXECUTOR_B_KEY: seed("executorB") },
    })
    return stdout.trim()
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr?.trim()
    throw new Error(`docker compose ${args.join(" ")}: ${stderr ? stderr : message(e)}`)
  }
}

export interface WorkerRun {
  pid: number
  started: string
  ended: string | undefined
}
export interface SupervisorLog {
  enforcement: string | undefined
  runs: WorkerRun[]
}

export async function supervisorLog(id: string): Promise<SupervisorLog> {
  const startedAt = await docker("inspect", "-f", "{{.State.StartedAt}}", id)
  const { stderr } = await execDocker(["logs", "--since", startedAt, id])
  const started = new RegExp(`supervisor: domain ${DOMAIN_ID} worker started: (pid (\\d+), uid \\d+, limits (?:on|off))$`)
  const ended = new RegExp(`supervisor: domain ${DOMAIN_ID} (worker ended \\(.*\\); restarting in .*|HALTED: .*|CONFIG_ERROR: .*)$`)
  const log: SupervisorLog = { enforcement: undefined, runs: [] }
  for (const line of stderr.split("\n")) {
    const enforcement = /supervisor: enforcement: (.*)$/.exec(line)
    const start = started.exec(line)
    const end = ended.exec(line)
    if (enforcement) log.enforcement = enforcement[1]
    else if (start) log.runs.push({ pid: Number(start[2]), started: start[1], ended: undefined })
    else if (end && log.runs.length > 0) log.runs[log.runs.length - 1].ended = end[1]
  }
  return log
}

export async function startExecutor(id: string): Promise<void> {
  await docker("start", id)
  const log = await waitFor("the executor worker to start", 120_000, async () => {
    const now = await supervisorLog(id)
    return now.runs.length > 0 && now.runs[now.runs.length - 1].ended === undefined ? now : undefined
  }).catch(() => {
    throw new Error(
      `the executor container started no worker within 120 s; check docker logs ${id} for a "supervisor: domain ${DOMAIN_ID} HALTED" line, then run scripts/devnet.sh config`,
    )
  })
  if (log.enforcement !== "limits on, uids on") {
    throw new Error(`executor enforcement is "${log.enforcement}", want limits on, uids on; check docker logs ${id}`)
  }
  const run = log.runs[log.runs.length - 1]
  if (!run.started.endsWith("limits on")) throw new Error(`executor worker started with "${run.started}", want limits on`)
  console.log(`ok executor started: worker ${run.started}`)
}

export async function serviceContainer(service: string): Promise<string> {
  const ids = (
    await docker(
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
      "--filter",
      `label=com.docker.compose.service=${service}`,
    )
  )
    .split("\n")
    .filter((l) => l !== "")
  if (ids.length !== 1) {
    throw new Error(`found ${ids.length} ${service} containers in Compose project ${COMPOSE_PROJECT}, want 1; run scripts/devnet.sh up`)
  }
  return ids[0]
}

async function runningExecutor(): Promise<string> {
  const id = await serviceContainer("executor")
  if ((await docker("inspect", "-f", "{{.State.Running}}", id)) === "false") {
    await startExecutor(id)
    console.log("ok started the executor container left stopped by an earlier run")
  }
  return id
}

export async function executorDown<T>(id: string, how: "stop" | "kill", body: () => Promise<T>): Promise<T> {
  let value: T | undefined
  let failure: { error: unknown } | undefined
  try {
    await step(how === "stop" ? "executor stopped" : "executor killed", async () => {
      await docker(how, id)
      assert.equal(await docker("inspect", "-f", "{{.State.Running}}", id), "false", `executor running after docker ${how}`)
    })
    value = await body()
  } catch (error) {
    failure = { error }
  }
  try {
    await startExecutor(id)
  } catch (e) {
    throw new Error(failure === undefined ? message(e) : `${message(failure.error)}; starting the executor also failed: ${message(e)}`)
  }
  if (failure !== undefined) throw failure.error
  return value as T
}

export interface Tracked {
  at(tag: TagName): Promise<ReceiptResult>
}

const TAGS: TagName[] = ["pending", "latest", "finalized"]

export function track(ctx: Ctx, label: string, sendHash: Hash, expect: (r: ReceiptResult) => void): Tracked {
  const slots = TAGS.map(() => {
    let resolve!: (r: ReceiptResult) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<ReceiptResult>((res, rej) => {
      resolve = res
      reject = rej
    })
    // Without a caller waiting yet, a rejection must not raise unhandledRejection.
    promise.catch(() => {})
    return { promise, resolve, reject }
  })

  const check = async (r: ReceiptResult, seenAtLatest: number | undefined): Promise<void> => {
    if (r.tag === "pending") assert.equal(r.verified, false, `${label} receipt at pending is verified`)
    else assert.equal(r.verified, true, `${label} receipt at ${r.tag} is not verified`)
    try {
      await ctx.gateway.verifyReceipt(sendHash.toString(), r)
    } catch (e) {
      throw new Error(`${label} receipt at ${r.tag}: ${message(e)}`)
    }
    if (r.tag === "finalized") assert.equal(r.batchId, seenAtLatest, `${label} batch id changed between latest and finalized`)
    if (r.tag !== "pending") {
      const where = `${label} receipt at ${r.tag}: batch ${r.batchId}`
      const entry = await ctx.zenon.embedded.settlement.getBatch(DOMAIN_ID, r.batchId)
      assert.ok(entry !== null, `${where} has no Settlement entry`)
      const daHash = entry.daHash.toString()
      const hexBundle: unknown = (await ctx.gateway.getBundle(daHash)).bundle
      assert.ok(typeof hexBundle === "string" && /^(?:[0-9a-fA-F]{2})*$/.test(hexBundle), `${where} bundle is not hex`)
      const bundle = Buffer.from(hexBundle, "hex")
      assert.equal(Buffer.from(sha3(bundle)).toString("hex"), daHash, `${where} bundle hash`)
    }
    expect(r)
  }

  const poll = async () => {
    let seen = -1
    let latestBatch: number | undefined
    try {
      for (;;) {
        let r: ReceiptResult | undefined
        try {
          r = await ctx.gateway.getReceipt(sendHash.toString())
        } catch (e) {
          if (!(e instanceof NotFoundError)) throw e
        }
        if (r !== undefined) {
          const index = TAGS.indexOf(r.tag)
          const was = seen < 0 ? "not seen" : TAGS[seen]
          if (index < seen) throw new Error(`${label} receipt went back from ${was} to ${r.tag}`)
          if (index > seen) {
            if (index !== seen + 1) throw new Error(`${label} receipt went from ${was} to ${r.tag}`)
            await check(r, latestBatch)
            if (r.tag === "latest") latestBatch = r.batchId
            seen = index
            console.log(`ok ${label} receipt at ${r.tag}: ${r.receipt.status}, batch ${r.batchId}`)
            slots[index].resolve(r)
            if (r.tag === "finalized") return
          }
        }
        await sleep(2000)
      }
    } catch (e) {
      for (const slot of slots) slot.reject(e)
    }
  }
  void poll()

  const timeouts: Record<TagName, number> = {
    pending: 180_000,
    latest: 300_000,
    finalized: Number(WITHDRAWAL_DELAY) * 10_000 + 180_000,
  }
  const tracked: Tracked = {
    at(tag) {
      let timer: NodeJS.Timeout
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} receipt at ${tag}: timed out after ${timeouts[tag] / 1000} s`)),
          timeouts[tag],
        )
      })
      return Promise.race([slots[TAGS.indexOf(tag)].promise, timeout]).finally(() => clearTimeout(timer))
    },
  }
  trackers.push(tracked)
  return tracked
}

export function depositTo(ctx: Ctx, label: string, contractId: Hash, amount: bigint, expect: (r: ReceiptResult) => void): Promise<Tracked> {
  return step(label, async () => {
    const tx = ctx.zenon.embedded.settlement.deposit(DOMAIN_ID, contractId, PLASMA_LIMIT, ZNN_ZTS, amount)
    return track(ctx, label, (await send(user, tx)).hash, expect)
  })
}

export type Variant = "vault" | "vault-testhook"
export interface Vault {
  iface: ContractInterface
  codeHash: string
  contractId: Hash
  deployFee: bigint // the ZNN the finalize send attaches
}

export async function deployVault(ctx: Ctx, variant: Variant): Promise<Vault> {
  const settlementApi = ctx.zenon.embedded.settlement
  const dir = path.join(SOURCE_ROOT, "zeno/zeno-contract-sdk-rs/examples/vault/artifacts")
  const read = (suffix: string) =>
    readFile(path.join(dir, `${variant}.${suffix}`)).catch(() => {
      throw new Error(`vault artifacts not found at ${dir}; run scripts/devnet.sh up first`)
    })
  const prices = await settlementApi.getPeripheryConfig()
  if (prices === null) throw new Error("periphery prices not set; run scripts/devnet.sh config")

  const module = await read("wasm")
  const hashes = JSON.parse((await read("hashes.json")).toString())
  const iface = parseInterface(JSON.parse((await read("interface.json")).toString()))
  const codeHash = Buffer.from(sha3(module)).toString("hex")
  assert.equal(codeHash, hashes.code_hash, `${variant} module hash differs from ${variant}.hashes.json`)
  await step(`${variant} artifacts verified (code hash ${codeHash})`, async () => {
    prepareDeploy(module, iface, { interfaceEncodings: ctx.contracts.interfaceEncodings })
  })

  const plan = settlement.planDeploy(module, IMMUTABLE_METADATA, { znnPerByteOfBytecode: prices.znnPerByteOfBytecode }, 0)
  const live = async () => {
    const record = await settlementApi.getDeployRecord(DOMAIN_ID, user.address, plan.codeHash)
    return record !== null && !record.isExpired ? record : null
  }
  const resuming = (await live()) !== null

  await step(`${variant} deploy started`, async () => {
    if (resuming) {
      console.log(`ok resuming the live deploy record for ${plan.codeHash}`)
      return
    }
    const { hash } = await send(
      user,
      settlementApi.deployContractStart(DOMAIN_ID, plan.codeHash, plan.metadataHash, plan.totalSize, plan.chunkCount, IMMUTABLE_METADATA),
    )
    track(ctx, "deploy start", hash, (r) => expectStatus(r, "SUCCESS"))
  })

  await step(`${variant} sent ${plan.chunkCount} chunks`, async () => {
    for (const chunk of plan.chunks) {
      const { hash, accepted } = await send(
        user,
        settlementApi.deployContractChunk(DOMAIN_ID, plan.codeHash, chunk.index, chunk.chunkHash, chunk.data),
        resuming ? "either" : true,
      )
      if (accepted) track(ctx, `deploy chunk ${chunk.index}`, hash, (r) => expectStatus(r, "SUCCESS"))
    }
  })

  await step(`all ${plan.chunkCount} chunks held by Settlement`, async () => {
    const record = await live()
    assert.ok(record !== null, "no live deploy record")
    assert.equal(record.receivedCount, plan.chunkCount, "chunks held by Settlement")
  })

  const { hash } = await step(`${variant} finalize sent`, () =>
    send(user, settlementApi.deployContractFinalize(DOMAIN_ID, plan.codeHash, plan.fee)),
  )
  const finalize = track(ctx, "deploy finalize", hash, (r) => {
    expectStatus(r, "SUCCESS")
    assert.notEqual(r.receipt.contractId, "00".repeat(32), "deploy contractId")
  })
  const contractId = Hash.parse((await finalize.at("pending")).receipt.contractId)
  await step(`deployed ${variant} as ${contractId}`, async () => {
    assert.equal(await settlementApi.getDeployRecord(DOMAIN_ID, user.address, plan.codeHash), null, "deploy record after finalize")
  })
  return { iface, codeHash, contractId, deployFee: plan.fee }
}

export async function buyStorage(ctx: Ctx, vault: Vault, bytes: bigint): Promise<Tracked> {
  const api = ctx.zenon.embedded.settlement
  return step(`buy ${bytes} bytes of storage`, async () => {
    const prices = await api.getPeripheryConfig()
    if (prices === null) throw new Error("periphery prices not set; run scripts/devnet.sh config")
    const { hash } = await send(user, api.buyStorage(DOMAIN_ID, vault.contractId, bytes, bytes * prices.znnPerByteOfState))
    return track(ctx, `buy ${bytes} bytes`, hash, (r) => {
      expectStatus(r, "SUCCESS")
      assert.equal(r.receipt.contractId, vault.contractId.toString(), "buyStorage contractId")
    })
  })
}

export async function balanceAt(ctx: Ctx, vault: Vault, account: Address, tag: Tag): Promise<bigint | null> {
  const key = zenoSelectorV1.storageKey(vault.iface, "balances", [l1Caller(account).getBytes(), ZNN_ASSET.getBytes()])
  const read = await ctx.contracts.storage(vault.contractId.toString(), Buffer.from(key).toString("hex"), tag)
  verified(read, 1)
  if (!read.result.present || read.result.value === null) return null
  return zenoSelectorV1.decodeStorageValue(vault.iface, "balances", Buffer.from(read.result.value, "hex")) as bigint
}

export function verified(read: { check: VerificationReport }, proofs: number): void {
  const { check } = read
  assert.ok(
    check.proofs === proofs && check.pathsChecked && check.rootChecked,
    `read not verified: proofs ${check.proofs} (want ${proofs}), pathsChecked ${check.pathsChecked}, rootChecked ${check.rootChecked}`,
  )
}

export function events(iface: ContractInterface, r: ReceiptResult): DecodedEvent[] {
  return r.events.map((e) => {
    const event = zenoSelectorV1.decodeEvent(iface, e.topics, Buffer.from(e.data, "hex"))
    if (event === null) throw new Error(`unknown event with topic ${e.topics[0]} in receipt of ${r.sendHash}`)
    return event
  })
}

export function expectDeposited(vault: Vault, r: ReceiptResult, amount: bigint): void {
  expectStatus(r, "SUCCESS")
  const [event, ...rest] = events(vault.iface, r)
  assert.ok(event !== undefined && rest.length === 0 && event.name === "Deposited", "receipt holds exactly one Deposited event")
  assert.equal(event.fields.amount, amount, "Deposited amount")
  assert.equal(event.fields.account, l1Caller(user.address).toString(), "Deposited account")
}

export function expectRefund(r: ReceiptResult, recipient: Address, amount: bigint): void {
  assert.equal(r.outbox.length, 1, `outbox items of ${r.sendHash}`)
  const item = r.outbox[0]
  assert.equal(item.kind, "L1_WITHDRAWAL", "refund kind")
  assert.equal(item.sourceContract, "00".repeat(32), "refund sourceContract")
  assert.equal(item.recipient, recipient.toString(), "refund recipient")
  assert.equal(item.assetId, ZNN_ASSET.toString(), "refund assetId")
  assert.equal(item.amount, amount.toString(), "refund amount")
}

export type WithdrawalState = "unprocessed" | "queued" | "released"

export async function withdrawalState(ctx: Ctx, outboxId: string): Promise<WithdrawalState> {
  const api = ctx.zenon.embedded.settlement
  if (!(await api.isOutboxProcessed(Hash.parse(outboxId)))) return "unprocessed"
  for (let page = 0; ; page++) {
    const queue = await api.getReleaseQueue(DOMAIN_ID, page, RPC_MAX_PAGE_SIZE)
    if (queue.list.some((e) => e.outboxId.toString() === outboxId)) return "queued"
    if (queue.list.length < RPC_MAX_PAGE_SIZE) return "released"
  }
}

export async function relayTemplate(ctx: Ctx, outboxId: string): Promise<{ tx: AccountBlockTemplate; batchId: number }> {
  const proof = await ctx.gateway.getOutboxProof(outboxId)
  assert.equal(proof.decoded.kind, "L1_WITHDRAWAL", "outbox item kind")
  const message = Buffer.from(proof.message, "hex")
  const inclusionProof = Buffer.from(proof.inclusionProof, "hex")
  settlement.decodeOutboxWithdrawal(message)
  const rebuiltId = settlement.outboxId(DOMAIN_ID, BigInt(proof.batchId), BigInt(proof.decoded.inputIndex), proof.decoded.outboxIndex)
  assert.equal(rebuiltId.toString(), outboxId, "outbox id rebuilt from the message")
  const root = settlement.outboxProofRoot(message, inclusionProof).toString()
  assert.equal(root, proof.outboxRoot, "outbox root rebuilt from the proof")
  const batch = await ctx.zenon.embedded.settlement.getBatch(DOMAIN_ID, proof.batchId)
  assert.equal(root, batch?.outboxRoot.toString(), `outbox root Settlement holds for batch ${proof.batchId}`)
  return {
    tx: ctx.zenon.embedded.settlement.relayMessage(DOMAIN_ID, BigInt(proof.batchId), message, inclusionProof),
    batchId: proof.batchId,
  }
}

// Returns totalReleased read while the withdrawal was not yet released.
export async function relay(ctx: Ctx, label: string, outboxId: string): Promise<bigint> {
  const api = ctx.zenon.embedded.settlement
  const info = await api.getAssetInfo(DOMAIN_ID, ZNN_ASSET)
  if (info === null) throw new Error(`domain ${DOMAIN_ID} ZNN asset info not found`)
  if ((await withdrawalState(ctx, outboxId)) === "released") {
    throw new Error(`${label}: withdrawal ${outboxId} was released before the flow read totalReleased; re-run the flow`)
  }
  const { tx, batchId } = await step(`${label}: outbox proof matches Settlement's outbox root`, () => relayTemplate(ctx, outboxId))
  await step(`${label}: batch ${batchId} finalized on Settlement`, () =>
    waitFor(`batch ${batchId} to finalize on Settlement`, Number(WITHDRAWAL_DELAY) * 10_000 + 300_000, async () =>
      (await api.getBatch(DOMAIN_ID, batchId))?.isFinalized ? true : undefined,
    ),
  )
  if (await api.isOutboxProcessed(Hash.parse(outboxId))) {
    console.log(`ok ${label}: registered by another sender`)
  } else {
    const { accepted } = await send(user, tx, "either")
    if (accepted) {
      console.log(`ok ${label}: registered by this flow`)
    } else if (await api.isOutboxProcessed(Hash.parse(outboxId))) {
      console.log(`ok ${label}: registered by another sender`)
    } else {
      throw new Error(`${label}: RelayMessage was rejected and the outbox ${outboxId} is not processed`)
    }
  }
  await conservation(`${label} relay`)
  return info.totalReleased
}

export async function release(ctx: Ctx, label: string, outboxId: string, amount: bigint, releasedBefore: bigint): Promise<void> {
  const api = ctx.zenon.embedded.settlement
  const first = await withdrawalState(ctx, outboxId)
  if (first === "unprocessed") throw new Error(`${label}: withdrawal is ${first}, want queued or released`)
  let accepted = false
  if (first === "queued") {
    accepted = (await send(user, api.releaseWithdrawals(DOMAIN_ID), "either")).accepted
    await waitFor(`withdrawal ${outboxId} to be released`, 180_000, async () =>
      (await withdrawalState(ctx, outboxId)) === "released" ? true : undefined,
    )
  }
  const after = await api.getAssetInfo(DOMAIN_ID, ZNN_ASSET)
  assert.ok(
    after !== null && after.totalReleased >= releasedBefore + amount,
    `${label}: totalReleased grew by less than ${amount}`,
  )
  console.log(`ok ${label}: released by ${accepted ? "this flow" : "another sender"}`)
  await conservation(`${label} release`)
}
