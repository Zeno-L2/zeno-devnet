import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { GatewayClient } from "zeno-client"
import { Hash, ZNN_ZTS, settlement, type Address } from "znn-typescript-sdk"
import { DOMAIN_ID, FUSE_QSR, GATEWAY_B_URL, PILLAR_NAME, keyPair, waitFor, waitHeight } from "../src/devnet.js"
import {
  ONE_ZNN,
  PLASMA_LIMIT,
  compose,
  docker,
  expectRefund,
  expectStatus,
  flow,
  send,
  serviceContainer,
  startExecutor,
  step,
  supervisorLog,
  track,
  user,
  type Ctx,
} from "./lib.js"

const original = keyPair("executor").address
const replacement = keyPair("executorB").address
const admin = keyPair("admin")
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

type Via = <T>(fn: () => Promise<T>) => Promise<T>

let interrupted = false
let queue: Promise<unknown> = Promise.resolve()

// Runs the body's docker and send actions one at a time, so the restore
// never races an action still in flight. Refuses to start after Ctrl-C.
function act<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(() => {
    if (interrupted) throw new Error("interrupted by Ctrl-C")
    return fn()
  })
  queue = run.catch(() => undefined)
  return run
}

const direct: Via = (fn) => fn()

async function isRunning(id: string): Promise<boolean> {
  return (await docker("inspect", "-f", "{{.State.Running}}", id)) === "true"
}

async function stopContainer(id: string, label: string, via: Via): Promise<void> {
  await via(() => docker("stop", id))
  assert.equal(await isRunning(id), false, `${label} running after docker stop`)
  console.log(`ok ${label} stopped`)
}

// Returns the registration height when the executor set holds exactly one
// ACTIVE member and it is this address.
async function registrationHeight(ctx: Ctx, address: Address): Promise<number | undefined> {
  const { list } = await ctx.zenon.embedded.settlement.getExecutorSet()
  if (list.length !== 1) return undefined
  const member = list[0]
  if (
    member.pillarName !== PILLAR_NAME ||
    member.executorAddress.toString() !== address.toString() ||
    member.status !== settlement.ExecutorStatus.ACTIVE
  ) {
    return undefined
  }
  return Number(member.registrationHeight)
}

async function registerExecutor(ctx: Ctx, address: Address, label: string, via: Via): Promise<void> {
  const api = ctx.zenon.embedded.settlement
  await step(`executor set names ${label} (${address})`, async () => {
    if ((await registrationHeight(ctx, address)) !== undefined) {
      console.log("ok already registered")
      return
    }
    // The first send starts a challenge, replaces one for other
    // parameters, applies a due one, or is refused as not yet due.
    await via(() => send(admin, api.registerExecutor(PILLAR_NAME, address), "either"))
    if ((await registrationHeight(ctx, address)) !== undefined) {
      console.log("ok applied a challenge left by an earlier run")
      return
    }
    const challenge = (await api.getTimeChallengesInfo()).list.find((c) => c.methodName === "RegisterExecutor")
    if (challenge === undefined) throw new Error("no RegisterExecutor time challenge after the first send")
    await waitHeight(Number(challenge.dueHeight) + 1)
    await via(() => send(admin, api.registerExecutor(PILLAR_NAME, address)))
    if ((await registrationHeight(ctx, address)) === undefined) {
      throw new Error(`the executor set does not name ${address} after the confirming send`)
    }
  })
}

async function quiesced(ctx: Ctx): Promise<boolean> {
  const info = await ctx.zenon.embedded.settlement.getDomainInfo(DOMAIN_ID)
  return info !== null && info.inputCursor !== null && info.inputCursor.consumedInputCount === info.receivedInputCount
}

async function quiesce(ctx: Ctx, timeoutMs: number): Promise<void> {
  await waitFor(`domain ${DOMAIN_ID} to consume every input Settlement received`, timeoutMs, async () =>
    (await quiesced(ctx)) ? true : undefined,
  )
}

// Waits until the gateway serves Settlement's latest batch. It fails when
// the supervisor halts, the gateway turns INCONSISTENT, or the gateway's
// latest batch id stops rising for stallMs.
async function caughtUp(ctx: Ctx, gateway: GatewayClient, id: string, label: string, stallMs: number): Promise<void> {
  let best: number | undefined
  let since = Date.now()
  const result = await waitFor<{ ended?: string; batchId?: number }>(`${label} to catch up`, Number.POSITIVE_INFINITY, async () => {
    if (Date.now() - since >= stallMs) {
      return { ended: `the gateway's latest batch stayed at ${best ?? -1} for ${stallMs / 60_000} minutes` }
    }
    const runs = (await supervisorLog(id)).runs
    const ended = runs.length > 0 ? runs[runs.length - 1].ended : undefined
    if (ended !== undefined && (ended.startsWith("HALTED") || ended.startsWith("CONFIG_ERROR"))) return { ended }
    const head = await gateway.getHead(DOMAIN_ID)
    if (head.status === "INCONSISTENT") return { ended: `gateway INCONSISTENT at batch ${head.inconsistentAt}` }
    const latest = head.latest?.batchId ?? -1
    if (best === undefined || latest > best) {
      best = latest
      since = Date.now()
    }
    const nextBatchId = (await ctx.zenon.embedded.settlement.getDomainInfo(DOMAIN_ID))?.inputCursor?.nextBatchId
    if (nextBatchId === undefined) return undefined
    if (head.status === "OK" && (nextBatchId === 0 || latest === nextBatchId - 1)) return { batchId: nextBatchId - 1 }
    return undefined
  })
  if (result.ended !== undefined) throw new Error(`${label} stopped catching up: ${result.ended}; check docker logs ${id}`)
  console.log(`ok ${label} at Settlement's batch ${result.batchId}`)
}

async function submittedBy(ctx: Ctx, batchId: number, address: Address, label: string): Promise<void> {
  await step(`batch ${batchId} submitted by ${label}`, async () => {
    const batch = await ctx.zenon.embedded.settlement.getBatch(DOMAIN_ID, batchId)
    assert.ok(batch !== null, `batch ${batchId} has no Settlement entry`)
    const registered = await registrationHeight(ctx, address)
    assert.ok(registered !== undefined, `the executor set does not name ${label}`)
    assert.ok(Number(batch.submittedAtHeight) > registered, `batch ${batchId} submittedAtHeight ${batch.submittedAtHeight} is not above ${label}'s registration height ${registered}`)
  })
}

async function restore(ctx: Ctx, ids: { original: string; executorB: string; gatewayB: string }): Promise<void> {
  await queue
  if ((await registrationHeight(ctx, original)) === undefined) {
    if (await isRunning(ids.executorB)) {
      await quiesce(ctx, 300_000).catch(() =>
        console.log(
          "WARN executor-b stopped with an input unconsumed; if executor-b later halts at its catch-up, remove its volumes as README.md's Flows section describes",
        ),
      )
      await stopContainer(ids.executorB, "executor-b", direct)
    }
    await registerExecutor(ctx, original, "the original executor", direct)
  }
  if ((await isRunning(ids.executorB)) || (await isRunning(ids.gatewayB))) {
    await stopContainer(ids.executorB, "executor-b", direct)
    await stopContainer(ids.gatewayB, "gateway-b", direct)
  }
  if (!(await isRunning(ids.original))) await startExecutor(ids.original)
  await caughtUp(ctx, ctx.gateway, ids.original, "the original executor", 600_000)
  console.log("ok restore: the original executor is registered, running and caught up, executor-b and gateway-b are stopped")
}

flow("executor-replacement", async (ctx) => {
  const api = ctx.zenon.embedded.settlement
  const executorB = await serviceContainer("executor-b")
  const gatewayB = await serviceContainer("gateway-b")
  const contractId = Hash.parse(randomBytes(32).toString("hex"))
  const amount = ONE_ZNN / 10n
  const deposit = () => api.deposit(DOMAIN_ID, contractId, PLASMA_LIMIT, ZNN_ZTS, amount)
  const expect = (r: Parameters<typeof expectStatus>[0]) => {
    expectStatus(r, "VALIDATION_FAILED")
    assert.equal(r.events.length, 0, "events of the refused deposit")
    expectRefund(r, user.address, amount)
  }
  const unconsumed = (who: string) =>
    step(`no input arrived while ${who} stopped`, async () => {
      if (!(await quiesced(ctx))) {
        throw new Error(`Settlement received an input while ${who} stopped; send no Settlement input while a flow runs`)
      }
    })

  const body = async () => {
    await step("executor set names only the original executor, and no input is pending", async () => {
      assert.ok((await registrationHeight(ctx, original)) !== undefined, "the executor set does not name the original executor")
      await quiesce(ctx, 600_000)
    })

    await step("executor-b fused", async () => {
      if ((await ctx.zenon.embedded.plasma.get(replacement)).qsrAmount < FUSE_QSR) {
        await act(() => send(admin, ctx.zenon.embedded.plasma.fuse(replacement, FUSE_QSR)))
        console.log("ok fused 10,000 QSR for executor-b")
      } else {
        console.log("ok executor-b already fused")
      }
    })

    await act(() => compose("start", "executor-b"))
    await act(() => startExecutor(executorB))
    await act(() => docker("start", gatewayB))
    const gwB = await GatewayClient.connect(GATEWAY_B_URL, {
      batches: (d, b) => api.getBatch(d, b),
      sends: (hash) => ctx.zenon.ledger.getAccountBlockByHash(hash),
    })
    const ctxB: Ctx = { ...ctx, gateway: gwB }

    await step("executor-b caught up with Settlement", () => caughtUp(ctx, gwB, executorB, "executor-b", 600_000))
    await step("the original executor holds no unaccepted batch", () => quiesce(ctx, 600_000))
    // An input that arrives after the first check makes executor-b build
    // its own batch, so the stop below happens only while it is in step.
    await step("executor-b still caught up with Settlement", () => caughtUp(ctx, gwB, executorB, "executor-b", 120_000))

    await stopContainer(ctx.executor, "original executor", act)
    await unconsumed("the original executor")
    await registerExecutor(ctx, replacement, "executor-b", act)

    const tB = await step("deposit sent under executor-b", async () =>
      track(ctxB, "deposit under executor-b", (await act(() => send(user, deposit()))).hash, expect),
    )
    const latestB = await tB.at("latest")
    await submittedBy(ctx, latestB.batchId, replacement, "executor-b")
    const finalB = await tB.at("finalized")

    await step("executor-b holds no unaccepted batch", () => quiesce(ctx, 600_000))
    await stopContainer(executorB, "executor-b", act)
    await unconsumed("executor-b")
    await stopContainer(gatewayB, "gateway-b", act)

    await registerExecutor(ctx, original, "the original executor", act)
    await act(() => startExecutor(ctx.executor))

    await step("the original executor rebuilt executor-b's batches", async () => {
      await caughtUp(ctx, ctx.gateway, ctx.executor, "the original executor", 600_000)
      const r = await ctx.gateway.getReceipt(finalB.sendHash)
      assert.equal(r.tag, "finalized", "receipt tag on the original executor's gateway")
      assert.equal(r.verified, true, "receipt verified on the original executor's gateway")
      assert.equal(r.batchId, finalB.batchId, "batch id on the original executor's gateway")
      assert.deepEqual(r.receipt, finalB.receipt, "receipt on the original executor's gateway")
    })

    const tA = await step("deposit sent under the original executor", async () =>
      track(ctx, "deposit under the original executor", (await act(() => send(user, deposit()))).hash, expect),
    )
    const latestA = await tA.at("latest")
    await submittedBy(ctx, latestA.batchId, original, "the original executor")
  }

  let stop!: (e: Error) => void
  const stopped = new Promise<never>((_, reject) => (stop = reject))
  let interruptedAt = 0
  const onSigint = () => {
    if (interrupted) {
      // One Ctrl-C under npm run can arrive twice: from the terminal
      // and again as forwarded by npm and tsx.
      if (Date.now() - interruptedAt < 1000) return
      console.log(
        "FAIL second Ctrl-C: the original executor may be unregistered or stopped, and executor-b may be running; run scripts/devnet.sh config",
      )
      process.exit(130)
    }
    interrupted = true
    interruptedAt = Date.now()
    console.log("Ctrl-C: restoring the original executor before exiting (up to about 10 minutes); press Ctrl-C again to exit at once")
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
    await restore(ctx, { original: ctx.executor, executorB, gatewayB })
  } catch (e) {
    throw new Error(
      failure === undefined
        ? `restoring the original executor failed: ${message(e)}; run scripts/devnet.sh config`
        : `${message(failure.error)}; restoring the original executor also failed: ${message(e)}; run scripts/devnet.sh config`,
    )
  }
  process.off("SIGINT", onSigint)
  if (failure !== undefined) throw failure.error
  if (interrupted) throw new Error("interrupted by Ctrl-C")
})
