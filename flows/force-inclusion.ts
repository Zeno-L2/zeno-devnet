import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { Hash, ZNN_ZTS } from "znn-typescript-sdk"
import { DOMAIN_ID, keyPair } from "../src/devnet.js"
import { ONE_ZNN, PLASMA_LIMIT, executorDown, expectRefund, expectStatus, flow, send, step, track, user } from "./lib.js"

flow("force-inclusion", async (ctx) => {
  const api = ctx.zenon.embedded.settlement
  const admin = keyPair("admin")
  const contractId = Hash.parse(randomBytes(32).toString("hex"))
  const amount = ONE_ZNN / 10n
  const counts = async () => {
    const info = await api.getDomainInfo(DOMAIN_ID)
    assert.ok(info !== null && info.inputCursor !== null, `domain ${DOMAIN_ID} info`)
    return { received: info.receivedInputCount, consumed: info.inputCursor.consumedInputCount }
  }

  const senders = [
    { name: "user", kp: user },
    { name: "admin", kp: admin },
  ]
  const trackers = await executorDown(ctx.executor, "stop", async () => {
    const before = await counts()
    const sent = await step("two deposits sent in parallel while the executor is stopped", () =>
      Promise.all(
        senders.map(async ({ kp }) => {
          const { hash } = await send(kp, api.deposit(DOMAIN_ID, contractId, PLASMA_LIMIT, ZNN_ZTS, amount))
          return track(ctx, `deposit from ${kp.address}`, hash, (r) => {
            expectStatus(r, "VALIDATION_FAILED")
            assert.equal(r.events.length, 0, "events of the refused deposit")
            expectRefund(r, kp.address, amount)
          })
        }),
      ),
    )
    await step("Settlement accepted both inputs and consumed none", async () => {
      const after = await counts()
      assert.equal(after.received - before.received, 2, "receivedInputCount growth")
      assert.equal(after.consumed, before.consumed, "consumedInputCount")
    })
    return sent
  })

  const receipts = await Promise.all(trackers.map((t) => t.at("latest")))
  await step("inputs executed in canonical order", async () => {
    const keys = await Promise.all(
      receipts.map(async (r) => {
        const block = await ctx.zenon.ledger.getAccountBlockByHash(Hash.parse(r.sendHash))
        assert.ok(block?.confirmationDetail != null, `send ${r.sendHash} confirmation`)
        const height = BigInt(block.confirmationDetail.momentumHeight)
        const heightBytes = Buffer.alloc(8)
        heightBytes.writeBigUInt64BE(BigInt(block.height))
        return { height, key: Buffer.concat([block.address.getBytes(), heightBytes, block.hash.getBytes()]) }
      }),
    )
    const order = [0, 1].sort((a, b) =>
      keys[a].height === keys[b].height ? Buffer.compare(keys[a].key, keys[b].key) : keys[a].height < keys[b].height ? -1 : 1,
    )
    const [first, second] = order
    assert.ok(receipts[first].globalInputIndex < receipts[second].globalInputIndex, "the smaller canonical key has the smaller globalInputIndex")
    const heights = keys[first].height === keys[second].height ? `momentum ${keys[first].height}` : `momenta ${keys[first].height} and ${keys[second].height}`
    console.log(`ok canonical order: ${senders[first].name} then ${senders[second].name}, ${heights}`)
  })
})
