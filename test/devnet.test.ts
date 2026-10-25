import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { Zenon, type AccountBlockTemplate, type KeyPair } from "znn-typescript-sdk"
import { sendAndWait } from "../src/devnet.js"

const H = { toString: () => "aa".repeat(32) }
const R = { toString: () => "bb".repeat(32) }
const kp = {} as KeyPair
const tx = {} as AccountBlockTemplate

function stubZenon(t: TestContext, publish: (calls: number) => void, getBlock: (hash: string, published: boolean) => unknown) {
  let calls = 0
  let published = false
  const zenon = {
    prepareBlock: async () => ({ hash: H }),
    ledger: {
      publishRawTransaction: async () => {
        calls++
        published = true
        publish(calls)
      },
      getAccountBlockByHash: async (hash: { toString(): string }) => getBlock(hash.toString(), published),
    },
  }
  t.mock.method(Zenon, "getInstance", () => zenon)
  return { calls: () => calls }
}

test("sendAndWait resolves when a publish landed but its response was lost", async (t) => {
  const data = Buffer.alloc(8)
  data.writeBigUInt64BE(1n)
  const stub = stubZenon(
    t,
    (calls) => {
      if (calls === 1) throw new Error("fetch failed")
      throw new Error("account-block prevHash exists but it has a cemented block on top of it")
    },
    (hash, published) => {
      if (hash === H.toString()) return published ? { pairedAccountBlock: { hash: R } } : null
      return { confirmationDetail: { momentumHeight: 7 }, data }
    },
  )
  // The first publish lands on the node but its response is lost; the repeat is refused.
  const result = await sendAndWait(kp, tx)
  assert.deepEqual(result, { hash: H, receiveHeight: 7, accepted: true })
  assert.equal(stub.calls(), 2)
})

test("sendAndWait throws the publish error when the node never holds the block", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const stub = stubZenon(
    t,
    () => {
      throw new Error("account-block amount is too big")
    },
    () => null,
  )
  const done = assert.rejects(sendAndWait(kp, tx), { message: "account-block amount is too big" })
  let settled = false
  void done.finally(() => {
    settled = true
  })
  while (!settled) {
    t.mock.timers.tick(1000)
    await new Promise(setImmediate)
  }
  await done
  assert.equal(stub.calls(), 1)
})
