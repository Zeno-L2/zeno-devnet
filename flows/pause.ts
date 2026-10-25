import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { Hash, settlement } from "znn-typescript-sdk"
import { CONFIRMATION_DEPTH, DOMAIN_ID, WITHDRAWAL_DELAY, keyPair, waitFor, waitHeight } from "../src/devnet.js"
import { ONE_ZNN, depositTo, expectRefund, expectStatus, flow, release, relay, relayTemplate, send, step, user, withdrawalState } from "./lib.js"

type Scope = "submit" | "relay"
const SCOPES: Record<Scope, number> = {
  submit: settlement.PauseScope.PAUSE_SUBMIT,
  relay: settlement.PauseScope.PAUSE_RELAY,
}

flow("pause", async (ctx) => {
  const api = ctx.zenon.embedded.settlement
  const admin = keyPair("admin")
  const flags = async (): Promise<Record<Scope, boolean>> => {
    const domain = (await api.getPauseState()).domains.find((d) => d.domainId === DOMAIN_ID)
    return { submit: domain?.submitPaused ?? false, relay: domain?.relayPaused ?? false }
  }
  const expected = { submit: false, relay: false }
  const setPause = (scope: Scope, active: boolean) =>
    step(`${scope} pause ${active ? "on" : "off"}`, async () => {
      await send(admin, api.pause(DOMAIN_ID, false, SCOPES[scope], active))
      expected[scope] = active
      assert.deepEqual(await flags(), expected, "pause state of the domain")
    })

  try {
    const left = await flags()
    for (const scope of ["submit", "relay"] as const) {
      if (!left[scope]) continue
      await send(admin, api.pause(DOMAIN_ID, false, SCOPES[scope], false))
      console.log(`ok cleared a ${scope} pause left from an earlier run`)
    }

    await setPause("submit", true)
    const nextBatchId = (await api.getDomainInfo(DOMAIN_ID))?.inputCursor?.nextBatchId
    assert.equal(typeof nextBatchId, "number", "nextBatchId before the hold")

    const refund = await depositTo(ctx, "deposit to a missing contract", Hash.parse(randomBytes(32).toString("hex")), ONE_ZNN / 10n, (r) => {
      expectStatus(r, "VALIDATION_FAILED")
      assert.equal(r.events.length, 0, "events of the refused deposit")
      expectRefund(r, user.address, ONE_ZNN / 10n)
    })
    const pending = await refund.at("pending")
    const height = (await ctx.zenon.ledger.getFrontierMomentum()).height
    await waitHeight(height + CONFIRMATION_DEPTH + 6)
    await step("submit pause holds the batch", async () => {
      assert.equal((await ctx.gateway.getReceipt(pending.sendHash)).tag, "pending", "receipt tag")
      assert.equal((await api.getDomainInfo(DOMAIN_ID))?.inputCursor?.nextBatchId, nextBatchId, "nextBatchId")
    })

    await setPause("relay", true)
    await setPause("submit", false)
    const latest = await refund.at("latest")
    await waitFor(`batch ${latest.batchId} to finalize on Settlement`, Number(WITHDRAWAL_DELAY) * 10_000 + 300_000, async () =>
      (await api.getBatch(DOMAIN_ID, latest.batchId))?.isFinalized ? true : undefined,
    )

    const id = latest.outbox[0].outboxId
    await step("relay pause blocks RelayMessage", async () => {
      await send(user, (await relayTemplate(ctx, id)).tx, false)
      assert.equal(await withdrawalState(ctx, id), "unprocessed", "withdrawal state")
    })

    await setPause("relay", false)
    const releasedBefore = await relay(ctx, "refund", id)
    await setPause("relay", true)
    const state = await withdrawalState(ctx, id)
    if (state === "released") throw new Error("the executor released the withdrawal before the relay pause applied; re-run the flow")
    assert.equal(state, "queued", "withdrawal state after the relay pause")

    await step("relay pause blocks ReleaseWithdrawals", async () => {
      await send(user, api.releaseWithdrawals(DOMAIN_ID), false)
      assert.equal(await withdrawalState(ctx, id), "queued", "withdrawal state")
    })

    await setPause("relay", false)
    await release(ctx, "refund", id, ONE_ZNN / 10n, releasedBefore)
  } finally {
    const now = await flags()
    for (const scope of ["submit", "relay"] as const) {
      if (!now[scope]) continue
      await send(admin, api.pause(DOMAIN_ID, false, SCOPES[scope], false))
      console.log(`ok cleanup: ${scope} pause cleared`)
    }
  }
})
