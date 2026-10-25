import assert from "node:assert/strict"
import { DOMAIN_ID, waitFor } from "../src/devnet.js"
import { BALANCE_LEAF_BYTES, ONE_ZNN, balanceAt, buyStorage, deployVault, depositTo, docker, expectDeposited, flow, step, supervisorLog, user } from "./lib.js"

flow("worker-crash", async (ctx) => {
  const id = ctx.executor
  const vault = await deployVault(ctx, "vault")
  await buyStorage(ctx, vault, BALANCE_LEAF_BYTES)
  const expect = (r: Parameters<typeof expectDeposited>[1]) => {
    expectDeposited(vault, r, ONE_ZNN)
    assert.equal(r.outbox.length, 0, "outbox items")
  }
  const before = await depositTo(ctx, "deposit before the crash", vault.contractId, ONE_ZNN, expect)
  await before.at("pending")

  const { log, old, startedAt } = await step("worker killed", async () => {
    const log = await supervisorLog(id)
    const old = log.runs.at(-1)
    if (old === undefined || old.ended !== undefined) throw new Error(`no running worker in the executor log; check docker logs ${id}`)
    const startedAt = await docker("inspect", "-f", "{{.State.StartedAt}}", id)
    await docker("exec", id, "kill", "-9", String(old.pid))
    return { log, old, startedAt }
  })

  await step("supervisor restarted the worker", async () => {
    const after = await waitFor("the supervisor to restart the worker", 120_000, async () => {
      const now = await supervisorLog(id)
      return now.runs.length > log.runs.length && now.runs.at(-1)?.ended === undefined ? now : undefined
    }).catch(() => {
      throw new Error(
        `the supervisor started no worker after pid ${old.pid} within 120 s; check docker logs ${id} for a "supervisor: domain ${DOMAIN_ID} HALTED" line`,
      )
    })
    const killed = after.runs[log.runs.length - 1]
    assert.equal(killed.pid, old.pid, "killed worker pid")
    assert.ok(killed.ended?.startsWith("worker ended (signal killed); restarting in "), `killed worker ended with "${killed.ended}"`)
    const next = after.runs[after.runs.length - 1]
    assert.ok(next.started.endsWith("limits on"), `replacement worker started with "${next.started}", want limits on`)
    assert.equal(await docker("inspect", "-f", "{{.State.StartedAt}}", id), startedAt, "executor container StartedAt")
    assert.equal(await docker("inspect", "-f", "{{.State.Running}}", id), "true", "executor container running")
    console.log(`ok worker pid ${old.pid} ended (signal killed), supervisor started worker ${next.started}`)
  })

  const after = await depositTo(ctx, "deposit after the crash", vault.contractId, ONE_ZNN, expect)
  for (const tag of ["latest", "finalized"] as const) {
    await before.at(tag)
    await after.at(tag)
  }
  await step("balance read at finalized", async () => {
    assert.equal(await balanceAt(ctx, vault, user.address, "finalized"), 2n * ONE_ZNN, "balance")
  })
})
