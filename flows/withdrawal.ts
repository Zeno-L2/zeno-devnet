import assert from "node:assert/strict"
import { prepareCall } from "zeno-client"
import { DOMAIN_ID, keyPair } from "../src/devnet.js"
import {
  BALANCE_LEAF_BYTES,
  ONE_ZNN,
  PLASMA_LIMIT,
  ZNN_ASSET,
  balanceAt,
  buyStorage,
  depositTo,
  deployVault,
  events,
  expectStatus,
  flow,
  release,
  relay,
  send,
  step,
  track,
  user,
} from "./lib.js"

flow("withdrawal", async (ctx) => {
  const recipient = keyPair("recipient").address
  const amount = (2n * ONE_ZNN) / 5n
  const vault = await deployVault(ctx, "vault")
  await buyStorage(ctx, vault, BALANCE_LEAF_BYTES)
  await depositTo(ctx, "deposit sent", vault.contractId, ONE_ZNN, (r) => expectStatus(r, "SUCCESS"))

  const withdraw = await step("withdraw call sent", async () => {
    const tx = ctx.zenon.embedded.settlement.callL2(
      DOMAIN_ID,
      vault.contractId,
      PLASMA_LIMIT,
      prepareCall(vault.iface, "withdraw", [ZNN_ASSET.getBytes(), amount, recipient.toString()]),
    )
    const { hash } = await send(user, tx)
    return track(ctx, "withdraw", hash, (r) => {
      expectStatus(r, "SUCCESS")
      const [event, ...rest] = events(vault.iface, r)
      assert.ok(event !== undefined && rest.length === 0 && event.name === "Withdrawn", "receipt holds exactly one Withdrawn event")
      assert.equal(event.fields.amount, amount, "Withdrawn amount")
      assert.equal(event.fields.l1_recipient, recipient.toString(), "Withdrawn l1_recipient")
      assert.equal(r.outbox.length, 1, "outbox items")
      const item = r.outbox[0]
      assert.equal(item.kind, "L1_WITHDRAWAL", "outbox kind")
      assert.equal(item.sourceContract, vault.contractId.toString(), "outbox sourceContract")
      assert.equal(item.recipient, recipient.toString(), "outbox recipient")
      assert.equal(item.assetId, ZNN_ASSET.toString(), "outbox assetId")
      assert.equal(item.amount, amount.toString(), "outbox amount")
    })
  })

  const latest = await withdraw.at("latest")
  await step("balance read at latest", async () => {
    assert.equal(await balanceAt(ctx, vault, user.address, "latest"), (3n * ONE_ZNN) / 5n, "balance")
  })
  const id = latest.outbox[0].outboxId
  const releasedBefore = await relay(ctx, "withdrawal", id)
  await release(ctx, "withdrawal", id, amount, releasedBefore)

  await withdraw.at("finalized")
  await step("balance read at finalized", async () => {
    assert.equal(await balanceAt(ctx, vault, user.address, "finalized"), (3n * ONE_ZNN) / 5n, "balance")
  })
})
