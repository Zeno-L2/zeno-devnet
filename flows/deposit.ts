import assert from "node:assert/strict"
import {
  BALANCE_LEAF_BYTES,
  ONE_ZNN,
  balanceAt,
  buyStorage,
  depositTo,
  deployVault,
  expectDeposited,
  flow,
  step,
  totalDeposited,
  user,
} from "./lib.js"

flow("deposit", async (ctx) => {
  const vault = await deployVault(ctx, "vault")
  await buyStorage(ctx, vault, BALANCE_LEAF_BYTES)
  const before = await totalDeposited(ctx)
  const deposit = await depositTo(ctx, "deposit sent", vault.contractId, ONE_ZNN, (r) => {
    expectDeposited(vault, r, ONE_ZNN)
    assert.equal(r.outbox.length, 0, "outbox items")
  })
  await step("totalDeposited grew by the deposit", async () => {
    assert.equal((await totalDeposited(ctx)) - before, ONE_ZNN, "totalDeposited growth")
  })
  for (const tag of ["latest", "finalized"] as const) {
    await deposit.at(tag)
    await step(`balance read at ${tag}`, async () => {
      assert.equal(await balanceAt(ctx, vault, user.address, tag), ONE_ZNN, "balance")
    })
  }
})
