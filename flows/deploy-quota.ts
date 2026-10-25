import assert from "node:assert/strict"
import {
  BALANCE_LEAF_BYTES,
  ONE_ZNN,
  balanceAt,
  buyStorage,
  depositTo,
  deployVault,
  expectDeposited,
  expectRefund,
  expectStatus,
  flow,
  step,
  user,
  verified,
} from "./lib.js"

flow("deploy-quota", async (ctx) => {
  const vault = await deployVault(ctx, "vault")
  await buyStorage(ctx, vault, BALANCE_LEAF_BYTES - 1n)
  await depositTo(ctx, "deposit over quota is refused", vault.contractId, ONE_ZNN, (r) => {
    expectStatus(r, "STORAGE_QUOTA_EXCEEDED")
    assert.equal(r.events.length, 0, "events of the refused deposit")
    expectRefund(r, user.address, ONE_ZNN)
  })
  await buyStorage(ctx, vault, 1n)
  const accepted = await depositTo(ctx, "deposit within quota succeeds", vault.contractId, ONE_ZNN, (r) => {
    expectDeposited(vault, r, ONE_ZNN)
    assert.equal(r.outbox.length, 0, "outbox items")
  })

  for (const tag of ["latest", "finalized"] as const) {
    await accepted.at(tag)
    await step(`contract and balance read at ${tag}`, async () => {
      const read = await ctx.contracts.contract(vault.contractId.toString(), tag)
      verified(read, 5)
      assert.notEqual(read.result.codeHash, null, "codeHash")
      assert.equal(read.result.sourceCodeHash, vault.codeHash, "sourceCodeHash")
      assert.equal(read.result.upgradePolicy, "IMMUTABLE", "upgradePolicy")
      assert.deepEqual(read.result.quota, { purchased: 96, used: 96 }, "quota")
      assert.equal(await balanceAt(ctx, vault, user.address, tag), ONE_ZNN, "balance")
    })
  }
})
