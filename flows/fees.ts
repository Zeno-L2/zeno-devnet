import assert from "node:assert/strict"
import { BlockTypeEnum, SETTLEMENT_ADDRESS, ZNN_ZTS, settlement, type AccountBlockTemplate } from "znn-typescript-sdk"
import { DOMAIN_ID, ZNN_PER_BYTE_OF_STATE, keyPair, waitFor } from "../src/devnet.js"
import { BALANCE_LEAF_BYTES, buyStorage, deployVault, flow, send, step, type Ctx } from "./lib.js"

const FEE_EPOCH = 60 // the devnet build's FeeEpochMomentums
const UPDATE_INTERVAL = 30 // the devnet build's UpdateMinNumMomentums
const DRAIN_MOMENTA = FEE_EPOCH + 4 * (UPDATE_INTERVAL + 5)
const MOMENTUM_MS = 10_000

const admin = keyPair("admin")
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const frontierHeight = async (ctx: Ctx) => (await ctx.zenon.ledger.getFrontierMomentum()).height

let interrupted = false
let adminQueue: Promise<unknown> = Promise.resolve()
// Set when a pause-on send rejected: the block may be published and its
// receive may still land after the rejection.
let pauseSendRejected = false

// Runs admin's sends one at a time, so the cleanup's unpause never
// races an admin send still in flight. Refuses to start after Ctrl-C.
function adminSend(tx: AccountBlockTemplate, want: boolean | "either" = true): ReturnType<typeof send> {
  const run = adminQueue.then(() => {
    if (interrupted) throw new Error("interrupted by Ctrl-C")
    return send(admin, tx, want)
  })
  adminQueue = run.catch(() => undefined)
  return run
}

// Waits until the fee epoch queue is empty.
async function drain(ctx: Ctx): Promise<void> {
  let epoch: number | undefined
  await waitFor("the fee epoch queue to drain", DRAIN_MOMENTA * MOMENTUM_MS + 120_000, async () => {
    const head = (await ctx.zenon.embedded.settlement.getFeeInfo()).pendingEpochHead
    epoch = head?.epoch
    return head === null ? true : undefined
  }).catch((e) => {
    throw new Error(
      `fee epoch ${epoch} did not settle within ${DRAIN_MOMENTA} momenta; check the node runs the devnet build (FeeEpochMomentums 60) and that the pillars send Settlement Update; ${message(e)}`,
    )
  })
}

// Waits for an accepted Settlement Update whose receive acknowledges a
// momentum at or above height; returns that acknowledged height.
async function updateAt(ctx: Ctx, height: number): Promise<number> {
  const updateData = ctx.zenon.embedded.settlement.update().data
  const wait = (Math.max(0, height - (await frontierHeight(ctx))) + UPDATE_INTERVAL + 10) * MOMENTUM_MS + 120_000
  return waitFor(`a Settlement Update acknowledging momentum ${height}`, wait, async () => {
    const { list } = await ctx.zenon.ledger.getAccountBlocksByPage(SETTLEMENT_ADDRESS, 0, 50)
    for (const block of list) {
      if (block.blockType !== BlockTypeEnum.ContractReceive || block.momentumAcknowledged.height < height) continue
      const data = Buffer.from(block.data)
      if (data.length !== 8 || data.readBigUInt64BE() !== 1n) continue
      if (block.pairedAccountBlock !== undefined && Buffer.from(block.pairedAccountBlock.data).equals(Buffer.from(updateData))) {
        return block.momentumAcknowledged.height
      }
    }
    return undefined
  })
}

// Sends Pause(DOMAIN_ID, false, PAUSE_RELAY, active) and returns the
// height of the momentum that holds its receive.
function setRelayPause(ctx: Ctx, active: boolean): Promise<number> {
  const api = ctx.zenon.embedded.settlement
  return step(`relay pause ${active ? "on" : "off"}`, async () => {
    const { receiveHeight } = await adminSend(api.pause(DOMAIN_ID, false, settlement.PauseScope.PAUSE_RELAY, active)).catch((e) => {
      if (active) pauseSendRejected = true
      throw e
    })
    assert.equal(await domainRelayPaused(ctx), active, "relay pause of the domain")
    return receiveHeight
  })
}

async function domainRelayPaused(ctx: Ctx): Promise<boolean> {
  const state = await ctx.zenon.embedded.settlement.getPauseState()
  return state.domains.find((d) => d.domainId === DOMAIN_ID)?.relayPaused ?? false
}

// Clears domain 1's relay pause after any admin send in flight has
// landed. The global flag and other domains stay untouched. After a
// rejected pause-on send the unpause is sent without reading the state,
// because the pause receive may still be pending; admin's account chain
// orders the unpause receive after it.
async function clearRelayPause(ctx: Ctx): Promise<void> {
  await adminQueue
  if (!pauseSendRejected && !(await domainRelayPaused(ctx))) return
  await send(admin, ctx.zenon.embedded.settlement.pause(DOMAIN_ID, false, settlement.PauseScope.PAUSE_RELAY, false), "either")
  console.log("ok cleanup: relay pause cleared")
}

flow("fees", async (ctx) => {
  const api = ctx.zenon.embedded.settlement

  const body = async () => {
    await step("no relay pause outside domain 1", async () => {
      const state = await api.getPauseState()
      if (state.global?.relayPaused) {
        throw new Error("the global relay pause is set, which holds fee settlement for every domain; clear it from the console's Admin view")
      }
      const other = state.domains.find((d) => d.domainId !== DOMAIN_ID && d.relayPaused)
      if (other !== undefined) {
        throw new Error(`domain ${other.domainId} is relay-paused, which holds fee settlement for every domain; clear it from the console's Admin view`)
      }
      if (await domainRelayPaused(ctx)) {
        await adminSend(api.pause(DOMAIN_ID, false, settlement.PauseScope.PAUSE_RELAY, false))
        console.log("ok cleared a relay pause left from an earlier run")
      }
    })

    await step("fee epoch queue drained", () => drain(ctx))

    const { before, start } = await step("admin's Settlement reward deposit emptied", async () => {
      const { accepted } = await adminSend(api.collectReward(), "either")
      console.log(accepted ? "ok admin's deposit paid out" : "ok admin's deposit was already empty")
      return { before: await api.getFeeInfo(), start: await frontierHeight(ctx) }
    })

    const vault = await deployVault(ctx, "vault")
    const buy = await buyStorage(ctx, vault, BALANCE_LEAF_BYTES)
    const latest = await buy.at("latest")
    const fees = vault.deployFee + BALANCE_LEAF_BYTES * ZNN_PER_BYTE_OF_STATE
    const burn = (fees * 30n) / 100n
    const credit = fees - burn

    await step(`fees collected: ${fees}`, async () => {
      assert.equal((await api.getFeeInfo()).totalFeesCollected - before.totalFeesCollected, fees, "totalFeesCollected growth")
    })

    const pausedAt = await setRelayPause(ctx, true)
    const { head, held } = await step("fee epoch queued", async () => {
      const info = await api.getFeeInfo()
      assert.ok(info.pendingEpochHead !== null, "no fee epoch queued")
      const batch = await api.getBatch(DOMAIN_ID, latest.batchId)
      assert.ok(batch !== null, `batch ${latest.batchId} not found`)
      const { epoch } = info.pendingEpochHead
      assert.ok(
        Math.floor(start / FEE_EPOCH) <= epoch && epoch <= Math.floor(batch.submittedAtHeight / FEE_EPOCH),
        `queued fee epoch ${epoch} is outside the flow's epochs; check the node runs the devnet build (FeeEpochMomentums 60)`,
      )
      return { head: info.pendingEpochHead, held: info }
    })

    const settleable = Math.max((head.epoch + 1) * FEE_EPOCH, head.finalityHeight)
    const updated = await updateAt(ctx, Math.max(settleable, pausedAt))
    await step(`relay pause holds fee epoch ${head.epoch} through an Update at height ${updated}`, async () => {
      const info = await api.getFeeInfo()
      assert.equal(info.pendingEpochHead?.epoch, head.epoch, "head fee epoch")
      assert.equal(info.totalFeesBurned, held.totalFeesBurned, "totalFeesBurned")
      assert.equal(info.totalFeesCredited, held.totalFeesCredited, "totalFeesCredited")
    })

    await setRelayPause(ctx, false)
    await step(`fee epochs settled: burned ${burn}, credited ${credit}`, async () => {
      await drain(ctx)
      const info = await api.getFeeInfo()
      assert.equal(info.totalFeesCollected - before.totalFeesCollected, fees, "totalFeesCollected growth")
      assert.equal(info.totalFeesBurned - before.totalFeesBurned, burn, "totalFeesBurned growth")
      assert.equal(info.totalFeesCredited - before.totalFeesCredited, credit, "totalFeesCredited growth")
    })

    await setRelayPause(ctx, true)
    await step("relay pause blocks CollectReward", async () => {
      const rewards = (await api.getFeeInfo()).totalRewardsCollected
      await adminSend(api.collectReward(), false)
      assert.equal((await api.getFeeInfo()).totalRewardsCollected, rewards, "totalRewardsCollected")
    })

    await setRelayPause(ctx, false)
    await step(`CollectReward paid ${credit} to admin`, async () => {
      const rewards = (await api.getFeeInfo()).totalRewardsCollected
      const { hash } = await adminSend(api.collectReward())
      assert.equal((await api.getFeeInfo()).totalRewardsCollected - rewards, credit, "totalRewardsCollected growth")
      const sent = await ctx.zenon.ledger.getAccountBlockByHash(hash)
      const receive = sent?.pairedAccountBlock
      assert.ok(receive !== undefined, "receive block of the CollectReward")
      const full = await ctx.zenon.ledger.getAccountBlockByHash(receive.hash)
      assert.equal(full?.descendantBlocks.length, 1, "descendant blocks of the receive")
      const payout = full!.descendantBlocks[0]
      assert.equal(payout.toAddress.toString(), admin.address.toString(), "payout address")
      assert.equal(payout.tokenStandard.toString(), ZNN_ZTS.toString(), "payout token")
      assert.equal(BigInt(payout.amount.toString()), credit, "payout amount")
    })
  }

  let stop!: (e: Error) => void
  const stopped = new Promise<never>((_, reject) => (stop = reject))
  let interruptedAt = 0
  const onSigint = () => {
    if (interrupted) {
      // One Ctrl-C under npm run can arrive twice: from the terminal
      // and again as forwarded by npm and tsx.
      if (Date.now() - interruptedAt < 1000) return
      console.log("FAIL second Ctrl-C: domain 1 may still be relay-paused; the next flow:fees or flow:pause clears it")
      process.exit(130)
    }
    interrupted = true
    interruptedAt = Date.now()
    console.log("Ctrl-C: clearing the relay pause before exiting; press Ctrl-C again to exit at once")
    stop(new Error("interrupted by Ctrl-C"))
  }
  process.on("SIGINT", onSigint)

  let failure: { error: unknown } | undefined
  try {
    await Promise.race([body(), stopped])
  } catch (error) {
    failure = { error }
  }
  try {
    await clearRelayPause(ctx)
  } catch (e) {
    throw new Error(failure === undefined ? message(e) : `${message(failure.error)}; clearing the relay pause also failed: ${message(e)}`)
  }
  process.off("SIGINT", onSigint)
  if (failure !== undefined) throw failure.error
  if (interrupted) throw new Error("interrupted by Ctrl-C")
})
