import { Zenon, ZNN_ZTS, settlement, type AccountBlockTemplate } from "znn-typescript-sdk"
import {
  ADMIN_DELAY,
  CHAIN_ID,
  DOMAIN_ID,
  FUSE_QSR,
  GATEWAY_URL,
  MAX_BATCH_WITHDRAWAL,
  PILLAR_NAME,
  RUNTIME_UPGRADE_DELAY,
  STF_SPEC_HASH,
  WITHDRAWAL_DELAY,
  ZNN_PER_BYTE_OF_BYTECODE,
  ZNN_PER_BYTE_OF_STATE,
  connect,
  conservationFailures,
  keyPair,
  readConfiguration,
  sendAndWait,
  waitFor,
  waitHeight,
  type Item,
} from "./devnet.js"

// Retries while the node or its RPC is still starting.
const readWhenReady = (zenon: Zenon) =>
  waitFor("the node at the RPC endpoint to answer configuration reads", 300_000, () => readConfiguration(zenon))

async function configure(): Promise<number> {
  const zenon = await connect()
  const api = zenon.embedded
  await waitFor("the node to sync to the chain frontier", 300_000, async () => {
    const m = await zenon.ledger.getFrontierMomentum()
    return Math.abs(Date.now() / 1000 - m.timestamp) <= 60 ? m : undefined
  })
  // Every node switches to the libp2p transport at momentum 10, the spork's
  // enforcement height, and a block published just before the switch can be lost.
  await waitHeight(11)
  const config = await readWhenReady(zenon)
  if (config.conflicts.length > 0) {
    for (const c of config.conflicts) console.log(c)
    console.log("run scripts/devnet.sh wipe, then up")
    return 1
  }
  if (config.missing.length === 0) {
    console.log("already configured")
    return 0
  }

  const missing = new Set<Item>(config.missing)
  const admin = keyPair("admin")
  const send = async (label: string, kp: typeof admin, tx: AccountBlockTemplate): Promise<number> => {
    const { receiveHeight } = await sendAndWait(kp, tx)
    console.log(`${label} received at momentum ${receiveHeight}`)
    return receiveHeight
  }

  for (const name of ["admin", "executor", "user"] as const) {
    if (!missing.has(`fuse:${name}`)) continue
    const kp = name === "user" ? keyPair("user") : admin
    await send(`fuse ${name}`, kp, api.plasma.fuse(keyPair(name).address, FUSE_QSR))
  }

  if (missing.has("domain") || missing.has("domainStatus")) {
    await send(
      "registerDomain",
      admin,
      api.settlement.registerDomain({
        domainId: DOMAIN_ID,
        domainClass: settlement.DomainClass.EXECUTION,
        runtimeKind: settlement.RuntimeKind.WASM,
        stfSpecHash: STF_SPEC_HASH,
        inputSource: settlement.InputSource.L1_NATIVE,
        execProfile: settlement.ExecProfile.ATTESTATION,
        foreignProfile: settlement.ForeignProfile.NONE,
        profileConfig: new Uint8Array(),
        chainBinding: new Uint8Array(),
        minExecutors: 1,
        proposerPolicy: settlement.ProposerPolicy.SINGLE,
        finalityModel: settlement.FinalityModel.DELAY,
        status: settlement.DomainStatus.ACTIVE,
        withdrawalDelay: WITHDRAWAL_DELAY,
        runtimeUpgradeDelay: RUNTIME_UPGRADE_DELAY,
      }),
    )
  }

  const assetId = settlement.assetIdFromZts(ZNN_ZTS)
  const challenged: Array<[Item, string, () => AccountBlockTemplate]> = [
    ["executor", "registerExecutor", () => api.settlement.registerExecutor(PILLAR_NAME, keyPair("executor").address)],
    ["daModes", "setApprovedDAModes", () => api.settlement.setApprovedDAModes(DOMAIN_ID, [settlement.DAMode.BEST_EFFORT])],
    ["asset", "setAssetConfig", () => api.settlement.setAssetConfig(DOMAIN_ID, assetId, MAX_BATCH_WITHDRAWAL)],
    ["prices", "setPeripheryConfig", () => api.settlement.setPeripheryConfig(ZNN_PER_BYTE_OF_BYTECODE, ZNN_PER_BYTE_OF_STATE)],
  ]
  const first = challenged.filter(([item]) => missing.has(item))
  let highest = 0
  for (const [, label, build] of first) {
    highest = Math.max(highest, await send(label, admin, build()))
  }

  if (first.length > 0) {
    await waitHeight(highest + ADMIN_DELAY + 2)
    const again = new Set((await readWhenReady(zenon)).missing)
    for (const [item, label, build] of first) {
      if (again.has(item)) await send(`${label} (confirm)`, admin, build())
    }
  }

  const left = await waitFor("the configuration to apply", 120_000, async () => {
    const c = await readConfiguration(zenon)
    return c.missing.length === 0 ? c : undefined
  }).then(
    () => [] as Item[],
    async () => (await readWhenReady(zenon)).missing,
  )
  if (left.length > 0) {
    console.error(`still missing: ${left.join(", ")}`)
    return 1
  }
  console.log("configured")
  return 0
}

async function status(): Promise<number> {
  let failed = false
  const line = (ok: boolean, name: string, detail: string) => {
    console.log(ok ? `ok ${name}` : `FAIL ${name}: ${detail}`)
    if (!ok) failed = true
  }

  let zenon: Zenon | undefined
  try {
    zenon = await connect(30_000)
    const m = await zenon.ledger.getFrontierMomentum()
    const age = Math.abs(Date.now() / 1000 - m.timestamp)
    line(m.chainIdentifier === CHAIN_ID && age <= 60, "node", `chain ${m.chainIdentifier}, frontier ${m.height} is ${Math.round(age)} s old`)
  } catch (e) {
    line(false, "node", String(e))
  }

  if (zenon !== undefined) {
    try {
      const c = await readConfiguration(zenon)
      const detail = [...c.conflicts, ...(c.missing.length > 0 ? [`missing ${c.missing.join(", ")}`] : [])].join("; ")
      line(c.conflicts.length === 0 && c.missing.length === 0, "configuration", detail)
    } catch (e) {
      line(false, "configuration", String(e))
    }
  } else {
    line(false, "configuration", "node unreachable")
  }

  if (zenon !== undefined) {
    try {
      const failures = await conservationFailures(zenon)
      if (failures.length === 0) console.log(`ok conservation (domain ${DOMAIN_ID} ZNN and fee counters only)`)
      else line(false, "conservation", failures.join("; "))
    } catch (e) {
      line(false, "conservation", String(e))
    }
  } else {
    line(false, "conservation", "node unreachable")
  }

  try {
    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "zeno_getHead", params: [DOMAIN_ID] }),
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json()) as { result?: { status?: string }; error?: { message?: string } }
    const s = body.result?.status
    line(s === "OK", "gateway", s ?? body.error?.message ?? "no result")
  } catch (e) {
    line(false, "gateway", String(e))
  }

  return failed ? 1 : 0
}

const commands: Record<string, () => Promise<number>> = { configure, status }
const run = commands[process.argv[2] ?? ""]
if (run === undefined) {
  console.error("usage: cli.ts <configure|status>")
  process.exit(2)
}
run().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  },
)
