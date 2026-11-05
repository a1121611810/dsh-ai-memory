/**
 * Bounded send queue.
 *
 * A busy turn can produce dozens of tool results. The queue keeps the number
 * of in-flight requests small, drops work instead of growing without bound,
 * and opens a circuit after repeated failures so a dead server stops costing
 * the session anything.
 */
export function createSender({
  maxInflight = 4,
  maxPending = 64,
  failureThreshold = 5,
  cooldownMs = 30_000,
  now = Date.now,
} = {}) {
  const pending = []
  const stats = { sent: 0, failed: 0, dropped: 0 }
  let inflight = 0
  let consecutiveFailures = 0
  let blockedUntil = 0

  const fail = () => {
    stats.failed += 1
    consecutiveFailures += 1
    if (consecutiveFailures >= failureThreshold) blockedUntil = now() + cooldownMs
  }

  const pump = () => {
    while (inflight < maxInflight && pending.length > 0) {
      const task = pending.shift()
      inflight += 1
      Promise.resolve()
        .then(task)
        .then(
          (result) => {
            if (result?.ok === true) {
              stats.sent += 1
              consecutiveFailures = 0
            } else {
              fail()
            }
          },
          fail,
        )
        .finally(() => {
          inflight -= 1
          pump()
        })
    }
  }

  return {
    enqueue(task) {
      if (now() < blockedUntil) {
        stats.dropped += 1
        return false
      }
      if (pending.length >= maxPending) {
        stats.dropped += 1
        return false
      }
      pending.push(task)
      pump()
      return true
    },
    stats,
    get inflight() {
      return inflight
    },
    get pending() {
      return pending.length
    },
    get blocked() {
      return now() < blockedUntil
    },
  }
}
