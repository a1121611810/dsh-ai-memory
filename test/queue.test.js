import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSender } from '../lib/queue.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('runs tasks and records outcomes', async () => {
  const sender = createSender({ maxInflight: 2, failedThreshold: 2 })
  sender.enqueue(async () => ({ ok: true }))
  sender.enqueue(async () => ({ ok: false, status: 500 }))
  await tick()
  await tick()
  assert.equal(sender.stats.sent, 1)
  assert.equal(sender.stats.failed, 1)
})

test('drops work once the pending queue is full', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const sender = createSender({ maxInflight: 1, maxPending: 1 })
  assert.equal(sender.enqueue(async () => { await gate; return { ok: true } }), true)
  assert.equal(sender.enqueue(async () => ({ ok: true })), true)
  assert.equal(sender.enqueue(async () => ({ ok: true })), false)
  assert.equal(sender.stats.dropped, 1)
  release()
  await tick()
})

test('opens a circuit after repeated failures and recovers after the cooldown', async () => {
  let clock = 0
  const sender = createSender({
    maxInflight: 1,
    failureThreshold: 2,
    cooldownMs: 1000,
    now: () => clock,
  })

  sender.enqueue(async () => ({ ok: false }))
  await tick()
  await tick()
  sender.enqueue(async () => ({ ok: false }))
  await tick()
  await tick()

  assert.equal(sender.blocked, true)
  assert.equal(sender.enqueue(async () => ({ ok: true })), false)

  clock = 1001
  assert.equal(sender.blocked, false)
  assert.equal(sender.enqueue(async () => ({ ok: true })), true)
  await tick()
})

test('a throwing task counts as a failure instead of escaping', async () => {
  const sender = createSender({ maxInflight: 1 })
  sender.enqueue(async () => { throw new Error('boom') })
  await tick()
  assert.equal(sender.stats.failed, 1)
})
