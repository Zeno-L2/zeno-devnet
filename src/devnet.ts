import { fileURLToPath } from "node:url"
import {
  Hash,
  KeyStore,
  Zenon,
  ZNN_ZTS,
  settlement,
  type AccountBlockTemplate,
  type KeyPair,
} from "znn-typescript-sdk"

export const COMPOSE_PROJECT = "zeno-devnet"
// The root that holds each repository at its sources.txt path, as
// scripts/devnet.sh chooses it: .sources/, or with ZENO_DEVNET_LOCAL=1 the
// folder that holds zeno/zeno-devnet.
export const SOURCE_ROOT =
  process.env.ZENO_DEVNET_SRC ??
  fileURLToPath(new URL(process.env.ZENO_DEVNET_LOCAL === "1" ? "../../../" : "../.sources/", import.meta.url))
export const NODE_URL = "http://127.0.0.1:35997"
export const NODE_WS_URL = "ws://127.0.0.1:35998"
export const PILLAR_URL = "http://127.0.0.1:35991"
export const GATEWAY_URL = "http://127.0.0.1:35999"
export const GATEWAY_B_URL = "http://127.0.0.1:36002"
export const CONSOLE_URL = "http://localhost:5173"
export const EXPLORER_URL = "http://localhost:36000"
export const CHAIN_ID = 69
export const DOMAIN_ID = 1
export const STF_SPEC_HASH = Hash.parse("00".repeat(31) + "01")
export const PILLAR_NAME = "dev1"
export const WITHDRAWAL_DELAY = 30n
export const RUNTIME_UPGRADE_DELAY = 17_280n
export const MAX_BATCH_WITHDRAWAL = 100_000_000_000n
export const ZNN_PER_BYTE_OF_BYTECODE = 1_000n
export const ZNN_PER_BYTE_OF_STATE = 1_000n
export const FUSE_QSR = 1_000_000_000_000n
export const CONFIRMATION_DEPTH = 3
export const ADMIN_DELAY = 12

// Public devnet mnemonic: never use it on any other network.
export const MNEMONIC =
  "abstract affair idle position alien fluid board ordinary exist afraid chapter wood wood guide sun walnut crew perfect place firm poverty model side million"

export const ACCOUNTS = { admin: 1, executor: 3, user: 8, recipient: 9, executorB: 10 } as const
export type AccountName = keyof typeof ACCOUNTS

export function keyPair(name: AccountName): KeyPair {
  return KeyStore.fromMnemonic(MNEMONIC).getKeyPair(ACCOUNTS[name])
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function waitFor<T>(
  what: string,
  timeoutMs: number,
  poll: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const value = await poll()
      if (value !== undefined) return value
    } catch (e) {
      last = e
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}; last error: ${String(last)}`)
    }
    await sleep(1000)
  }
}

export async function connect(timeoutMs = 120_000): Promise<Zenon> {
  Zenon.setChainID(CHAIN_ID)
  Zenon.setNetworkID(CHAIN_ID)
  const zenon = Zenon.getInstance()
  await waitFor(`the node at ${NODE_URL} to answer with chain id ${CHAIN_ID}`, timeoutMs, async () => {
    await zenon.initialize(NODE_URL)
    const m = await zenon.ledger.getFrontierMomentum()
    return m.chainIdentifier === CHAIN_ID ? m : undefined
  })
  return zenon
}

export async function sendAndWait(
  kp: KeyPair,
  tx: AccountBlockTemplate,
): Promise<{ hash: Hash; receiveHeight: number; accepted: boolean }> {
  const zenon = Zenon.getInstance()
  const prepared = await waitFor("the node to accept the block for preparation", 120_000, () => zenon.prepareBlock(tx, kp))
  const hash = prepared.hash
  // A transport failure repeats the publish; any other error is final unless the node
  // holds the block within 60 s, because a publish whose response was lost has still
  // landed and a repeat of it is refused.
  let fatal: unknown
  await waitFor(`the node at ${NODE_URL} to accept the published block`, 120_000, async () => {
    try {
      await zenon.ledger.publishRawTransaction(prepared)
      return true
    } catch (e) {
      if (!String(e).includes("fetch failed")) {
        fatal = e
        return true
      }
      throw e
    }
  })
  if (fatal !== undefined) {
    try {
      await waitFor(`the node to hold ${hash.toString()}`, 60_000, async () => {
        const block = await zenon.ledger.getAccountBlockByHash(hash)
        return block ?? undefined
      })
    } catch {
      throw fatal
    }
  }
  const receive = await waitFor(`the receive of ${hash.toString()}`, 300_000, async () => {
    const block = await zenon.ledger.getAccountBlockByHash(hash)
    return block?.pairedAccountBlock
  })
  const confirmed = await waitFor(`the confirmation of ${receive.hash.toString()}`, 300_000, async () => {
    const block = await zenon.ledger.getAccountBlockByHash(receive.hash)
    return block?.confirmationDetail ? block : undefined
  })
  // An embedded contract writes 1 as the receive block's data on success and 2 on failure,
  // and a failed receive refunds the sent amount.
  const data = Buffer.from(confirmed.data)
  const accepted = data.length === 8 && data.readBigUInt64BE() === 1n
  return { hash, receiveHeight: confirmed.confirmationDetail!.momentumHeight, accepted }
}

export async function waitHeight(height: number): Promise<void> {
  const zenon = Zenon.getInstance()
  const frontier = (await zenon.ledger.getFrontierMomentum()).height
  const timeoutMs = Math.max(0, height - frontier) * 10_000 + 120_000
  await waitFor(`momentum height ${height}`, timeoutMs, async () => {
    const m = await zenon.ledger.getFrontierMomentum()
    return m.height >= height ? true : undefined
  })
}

export type Item =
  | "fuse:admin"
  | "fuse:executor"
  | "fuse:user"
  | "domain"
  | "domainStatus"
  | "executor"
  | "daModes"
  | "asset"
  | "prices"
export interface Configuration {
  missing: Item[]
  conflicts: string[]
}

export async function readConfiguration(zenon: Zenon): Promise<Configuration> {
  const missing: Item[] = []
  const conflicts: string[] = []

  for (const name of ["admin", "executor", "user"] as const) {
    const info = await zenon.embedded.plasma.get(keyPair(name).address)
    if (info.qsrAmount < FUSE_QSR) missing.push(`fuse:${name}`)
  }

  const domain = await zenon.embedded.settlement.getDomainInfo(DOMAIN_ID)
  if (domain === null) {
    missing.push("domain", "daModes", "asset")
  } else {
    if (domain.runtimeKind !== settlement.RuntimeKind.WASM) {
      conflicts.push(`domain ${DOMAIN_ID} runtimeKind is ${domain.runtimeKind}, want ${settlement.RuntimeKind.WASM}`)
    }
    if (domain.stfSpecHash.toString() !== STF_SPEC_HASH.toString()) {
      conflicts.push(`domain ${DOMAIN_ID} stfSpecHash is ${domain.stfSpecHash.toString()}, want ${STF_SPEC_HASH.toString()}`)
    }
    if (BigInt(domain.withdrawalDelay) !== WITHDRAWAL_DELAY) {
      conflicts.push(`domain ${DOMAIN_ID} withdrawalDelay is ${domain.withdrawalDelay}, want ${WITHDRAWAL_DELAY}`)
    }
    if (BigInt(domain.runtimeUpgradeDelay) !== RUNTIME_UPGRADE_DELAY) {
      conflicts.push(`domain ${DOMAIN_ID} runtimeUpgradeDelay is ${domain.runtimeUpgradeDelay}, want ${RUNTIME_UPGRADE_DELAY}`)
    }
    if (domain.status !== settlement.DomainStatus.ACTIVE) missing.push("domainStatus")
  }

  const executors = await zenon.embedded.settlement.getExecutorSet()
  const executorAddress = keyPair("executor").address.toString()
  const registered = executors.list.some(
    (e) =>
      e.pillarName === PILLAR_NAME &&
      e.executorAddress.toString() === executorAddress &&
      e.status === settlement.ExecutorStatus.ACTIVE,
  )
  if (!registered) missing.push("executor")

  if (domain !== null) {
    const modes = domain.approvedDAModes
    if (modes.length !== 1 || modes[0] !== settlement.DAMode.BEST_EFFORT) missing.push("daModes")
    const asset = await zenon.embedded.settlement.getAssetInfo(DOMAIN_ID, settlement.assetIdFromZts(ZNN_ZTS))
    if (asset === null || asset.maxBatchWithdrawal !== MAX_BATCH_WITHDRAWAL) missing.push("asset")
  }

  const prices = await zenon.embedded.settlement.getPeripheryConfig()
  if (
    prices === null ||
    prices.znnPerByteOfBytecode !== ZNN_PER_BYTE_OF_BYTECODE ||
    prices.znnPerByteOfState !== ZNN_PER_BYTE_OF_STATE
  ) {
    missing.push("prices")
  }

  return { missing, conflicts }
}

// One message per broken inequality for domain DOMAIN_ID and ZNN, plus the
// two fee inequalities; empty when both hold.
export async function conservationFailures(zenon: Zenon): Promise<string[]> {
  const failures: string[] = []
  const info = await zenon.embedded.settlement.getAssetInfo(DOMAIN_ID, settlement.assetIdFromZts(ZNN_ZTS))
  if (info === null) {
    failures.push(`domain ${DOMAIN_ID} ZNN asset info not found`)
  } else if (info.totalReleased + info.pendingWithdrawalReserve > info.totalDeposited) {
    failures.push(
      `domain ${DOMAIN_ID} ZNN totalReleased ${info.totalReleased} + pendingWithdrawalReserve ${info.pendingWithdrawalReserve} > totalDeposited ${info.totalDeposited}`,
    )
  }
  const fees = await zenon.embedded.settlement.getFeeInfo()
  if (fees.totalFeesBurned + fees.totalFeesCredited > fees.totalFeesCollected || fees.totalRewardsCollected > fees.totalFeesCredited) {
    failures.push(
      `fees: totalFeesBurned ${fees.totalFeesBurned} + totalFeesCredited ${fees.totalFeesCredited} must not exceed totalFeesCollected ${fees.totalFeesCollected}, and totalRewardsCollected ${fees.totalRewardsCollected} must not exceed totalFeesCredited`,
    )
  }
  return failures
}
