import assert from "node:assert/strict"
import { test } from "node:test"
import type { Zenon } from "znn-typescript-sdk"
import { relay, release, track, type Ctx } from "../flows/lib.js"

const id = "11".repeat(32)
const ctx = {
  zenon: {
    embedded: {
      settlement: {
        isOutboxProcessed: async () => true,
        getReleaseQueue: async () => ({ list: [] }),
        getAssetInfo: async () => ({ totalReleased: 1_009n }),
      },
    },
  } as unknown as Zenon,
} as Ctx

test("release rejects when totalReleased grew by less than the payout", async () => {
  await assert.rejects(release(ctx, "w", id, 10n, 1_000n), /totalReleased grew by less than 10/)
})

test("relay rejects a withdrawal released before the baseline was read", async () => {
  await assert.rejects(relay(ctx, "w", id), /released before the flow read totalReleased/)
})

test("track rejects a bundle field that is not a hex string", async () => {
  const receipts = [
    { tag: "pending", verified: false, batchId: 7, receipt: { status: "ok" } },
    { tag: "latest", verified: true, batchId: 7, receipt: { status: "ok" } },
  ]
  const trackCtx = {
    zenon: {
      embedded: { settlement: { getBatch: async () => ({ daHash: "ab".repeat(32) }) } },
    },
    gateway: {
      verifyReceipt: async () => true,
      getReceipt: async () => receipts.shift() ?? receipts[0],
      getBundle: async () => ({ bundle: { length: 1e12 } }),
    },
  } as unknown as Ctx
  const tracked = track(trackCtx, "send", "cd".repeat(32) as unknown as Parameters<typeof track>[2], () => {})
  await tracked.at("pending")
  await assert.rejects(tracked.at("latest"), /bundle is not hex/)
})
