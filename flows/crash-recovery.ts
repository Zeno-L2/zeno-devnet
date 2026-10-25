import assert from "node:assert/strict"
import { DOMAIN_ID } from "../src/devnet.js"
import { BALANCE_LEAF_BYTES, ONE_ZNN, balanceAt, buyStorage, deployVault, depositTo, executorDown, expectDeposited, flow, step, user } from "./lib.js"

flow("crash-recovery", async (ctx) => {
  const vault = await deployVault(ctx, "vault")
  const storage = await buyStorage(ctx, vault, BALANCE_LEAF_BYTES)
  await storage.at("latest")
  const anchor = (await storage.at("finalized")).batchId
  const expect = (r: Parameters<typeof expectDeposited>[1]) => {
    expectDeposited(vault, r, ONE_ZNN)
    assert.equal(r.outbox.length, 0, "outbox items")
  }

  const first = await depositTo(ctx, "deposit before the crash", vault.contractId, ONE_ZNN, expect)
  const accepted = await first.at("latest")
  await step(`batch ${accepted.batchId} accepted and not finalized, above finalized batch ${anchor}`, async () => {
    assert.ok(accepted.batchId > anchor, `batch ${accepted.batchId} is not above finalized batch ${anchor}`)
    assert.equal((await ctx.zenon.embedded.settlement.getBatch(DOMAIN_ID, accepted.batchId))?.isFinalized, false, "batch finalized")
  })

  const second = await executorDown(ctx.executor, "kill", () =>
    depositTo(ctx, "deposit while the executor is down", vault.contractId, ONE_ZNN, expect),
  )
  const later = await second.at("latest")
  await step(`deposit sent while down landed in batch ${later.batchId}, after batch ${accepted.batchId}`, async () => {
    assert.ok(later.batchId > accepted.batchId, `batch ${later.batchId} is not after batch ${accepted.batchId}`)
  })

  await first.at("finalized")
  await second.at("finalized")
  await step("balance read at finalized", async () => {
    assert.equal(await balanceAt(ctx, vault, user.address, "finalized"), 2n * ONE_ZNN, "balance")
  })
})
