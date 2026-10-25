import assert from "node:assert/strict"
import { prepareCall } from "zeno-client"
import { ZNN_ZTS } from "znn-typescript-sdk"
import { DOMAIN_ID } from "../src/devnet.js"
import {
  BALANCE_LEAF_BYTES,
  ONE_ZNN,
  PLASMA_LIMIT,
  balanceAt,
  buyStorage,
  deployVault,
  expectDeposited,
  expectRefund,
  flow,
  release,
  relay,
  send,
  step,
  totalDeposited,
  track,
  user,
} from "./lib.js"

flow("call-refund", async (ctx) => {
  const vault = await deployVault(ctx, "vault-testhook")
  await buyStorage(ctx, vault, BALANCE_LEAF_BYTES)

  const before = await totalDeposited(ctx)
  const call = await step("payable call sent", async () => {
    const tx = ctx.zenon.embedded.settlement.callL2(
      DOMAIN_ID,
      vault.contractId,
      PLASMA_LIMIT,
      prepareCall(vault.iface, "claim_partial", [ONE_ZNN / 2n]),
      ZNN_ZTS,
      2n * ONE_ZNN,
    )
    const { hash } = await send(user, tx)
    assert.equal((await totalDeposited(ctx)) - before, 2n * ONE_ZNN, "totalDeposited growth")
    return track(ctx, "payable call", hash, (r) => {
      expectDeposited(vault, r, ONE_ZNN / 2n)
      expectRefund(r, user.address, (3n * ONE_ZNN) / 2n)
    })
  })

  const latest = await call.at("latest")
  await step("balance read at latest", async () => {
    assert.equal(await balanceAt(ctx, vault, user.address, "latest"), ONE_ZNN / 2n, "balance")
  })
  const id = latest.outbox[0].outboxId
  const releasedBefore = await relay(ctx, "refund", id)
  await release(ctx, "refund", id, (3n * ONE_ZNN) / 2n, releasedBefore)

  await call.at("finalized")
  await step("balance read at finalized", async () => {
    assert.equal(await balanceAt(ctx, vault, user.address, "finalized"), ONE_ZNN / 2n, "balance")
  })
})
