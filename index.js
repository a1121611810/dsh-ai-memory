/**
 * dsh-ai-memory — Host half.
 *
 * Makes DeepSeek Harness a session-aware ai-memory client: it forwards real
 * session identity (session id + working directory) to ai-memory's ingest
 * endpoint, which the MCP transport cannot carry.
 *
 * Everything here is best-effort. A missing server, an unreachable port, or a
 * malformed session must never disturb the agent loop.
 */
import { appendFileSync } from 'node:fs'

import { normalizeBaseUrl, readToken, resolveDataDir } from './lib/paths.js'
import { buildHookPayload, postHook } from './lib/hook.js'

export const name = 'dsh-ai-memory'

export const DEFAULTS = Object.freeze({
  serverUrl: 'http://127.0.0.1:49374',
  dataDir: '',
  agent: 'claude-code',
  allowRemote: false,
  timeoutMs: 3000,
  captureSession: true,
})

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Env-gated event trace: a support aid that never runs unless asked for. */
function trace(event, sessionId) {
  const file = process.env.DSH_AI_MEMORY_TRACE
  if (typeof file !== 'string' || file === '') return
  try {
    appendFileSync(file, `${new Date().toISOString()} ${event} ${sessionId}\n`)
  } catch {
    // Tracing must never break capture.
  }
}

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(isObject(config) ? config : {}) }
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[dsh-ai-memory] ${message}`)
    } catch {
      // Logger availability is never worth a crash.
    }
  }

  let baseUrl
  try {
    baseUrl = normalizeBaseUrl(settings.serverUrl, { allowRemote: settings.allowRemote === true })
  } catch (error) {
    log('warn', `disabled: ${error.message}`)
    return
  }

  const dataDir = typeof settings.dataDir === 'string' && settings.dataDir.trim() !== ''
    ? settings.dataDir.trim()
    : resolveDataDir()
  const token = readToken(dataDir)
  if (token === null) {
    log('warn', `no readable bearer token under "${dataDir}"; ingest will be rejected unless the server allows it`)
  }

  const stats = { sent: 0, failed: 0, skipped: 0 }
  let warnedFailure = false
  const disposers = []
  // Session id -> cwd, so a session can be closed from an event that only
  // carries the agent. A session is closed at most once.
  const openSessions = new Map()
  const closedSessions = new Set()

  const cwdOf = (session) => {
    try {
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory && typeof workingDirectory.get === 'function') {
        const cwd = workingDirectory.get(session)
        if (typeof cwd === 'string' && cwd !== '') return cwd
      }
    } catch {
      // Fall through to the session header.
    }
    const cwd = session?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : null
  }

  const send = (event, sessionId, cwd) => {
    if (settings.captureSession !== true) return
    let payload
    try {
      payload = buildHookPayload(event, { sessionId, cwd })
    } catch {
      stats.skipped += 1
      return
    }
    trace(event, payload.session_id)
    void postHook({
      baseUrl,
      token,
      event,
      payload,
      agent: settings.agent,
      timeoutMs: settings.timeoutMs,
    }).then((result) => {
      if (result.ok) {
        stats.sent += 1
        return
      }
      stats.failed += 1
      if (!warnedFailure) {
        warnedFailure = true
        log('warn', `ingest failed (status ${result.status || 'unreachable'}); capture continues silently`)
      }
    })
  }

  const opened = (session) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || sessionId === '' || closedSessions.has(sessionId)) return
    const cwd = cwdOf(session)
    if (cwd === null) {
      stats.skipped += 1
      return
    }
    openSessions.set(sessionId, cwd)
    send('session-start', sessionId, cwd)
  }

  const closed = (sessionId, cwd = null) => {
    if (typeof sessionId !== 'string' || sessionId === '' || closedSessions.has(sessionId)) return
    const resolved = cwd ?? openSessions.get(sessionId) ?? null
    if (resolved === null) return
    closedSessions.add(sessionId)
    openSessions.delete(sessionId)
    send('session-end', sessionId, resolved)
  }

  const on = (event, handler) => {
    try {
      const disposer = ctx.on(event, handler)
      if (typeof disposer === 'function') disposers.push(disposer)
    } catch (error) {
      log('warn', `cannot subscribe to ${event}: ${error?.message ?? error}`)
    }
  }

  // DSH closes a session through either seam depending on the app: the desktop
  // app announces `session/disposed`, while a one-shot run only emits
  // `agent/disposed` before exit. Both close the same session exactly once.
  on('session/created', (session) => opened(session))
  on('session/disposed', (session) => closed(session?.id, cwdOf(session)))
  on('agent/disposed', (payload) => closed(payload?.agent?.id))

  log('info', `capturing into ${baseUrl}`)

  return () => {
    for (const disposer of disposers) {
      try {
        disposer()
      } catch {
        // Teardown is best-effort.
      }
    }
  }
}
