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

import z from '@deepseek-ai/schemastery'

import { buildHookPayload, clipJson, clipText, postHook } from './lib/hook.js'
import { buildOverview, search } from './lib/mcp.js'
import { normalizeBaseUrl, readToken, resolveDataDir } from './lib/paths.js'
import { createSender } from './lib/queue.js'
import { redactDeep, redactSecrets } from './lib/redact.js'

export const name = 'dsh-ai-memory'

export const DEFAULTS = Object.freeze({
  serverUrl: 'http://127.0.0.1:49374',
  dataDir: '',
  agent: 'claude-code',
  allowRemote: false,
  timeoutMs: 3000,
  captureSession: true,
  capturePrompt: false,
  captureTools: true,
  captureStop: true,
  maxPromptChars: 4000,
  maxToolChars: 2000,
  maxInflight: 4,
  cooldownMs: 30000,
  announceScope: true,
})

export const Config = z.object({
  serverUrl: z.string().default(DEFAULTS.serverUrl)
    .description('ai-memory base URL. Loopback only unless allowRemote is set.'),
  dataDir: z.string().default(DEFAULTS.dataDir)
    .description('ai-memory data directory; empty means the platform default.'),
  agent: z.string().default(DEFAULTS.agent)
    .description('Agent label ai-memory records for these events.'),
  allowRemote: z.boolean().default(DEFAULTS.allowRemote)
    .description('Permit a non-loopback serverUrl. It must then use https.'),
  timeoutMs: z.number().min(100).max(60000).default(DEFAULTS.timeoutMs)
    .description('Per-request timeout in milliseconds.'),
  captureSession: z.boolean().default(DEFAULTS.captureSession)
    .description('Forward session start and end.'),
  capturePrompt: z.boolean().default(DEFAULTS.capturePrompt)
    .description('Forward user prompt text. Off by default: prompts are the most sensitive input.'),
  captureTools: z.boolean().default(DEFAULTS.captureTools)
    .description('Forward tool results, clipped to maxToolChars.'),
  captureStop: z.boolean().default(DEFAULTS.captureStop)
    .description('Forward a stop event at the end of each turn.'),
  maxPromptChars: z.number().min(0).max(20000).default(DEFAULTS.maxPromptChars)
    .description('Prompt text budget in characters.'),
  maxToolChars: z.number().min(0).max(20000).default(DEFAULTS.maxToolChars)
    .description('Tool input and result budget in characters.'),
  maxInflight: z.number().min(1).max(32).default(DEFAULTS.maxInflight)
    .description('Concurrent ingest requests.'),
  cooldownMs: z.number().min(0).max(600000).default(DEFAULTS.cooldownMs)
    .description('How long to stop sending after repeated failures.'),
  announceScope: z.boolean().default(DEFAULTS.announceScope)
    .description('Tell the model at every session that ai-memory is filed per project and how to search across projects.'),
})

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * One short, static note: memory is shared on this machine but filed per
 * project, so a thin result is a scoping signal, not an absence of knowledge.
 */
const SCOPE_NOTE = [
  '## ai-memory scope',
  '',
  'ai-memory is shared by every agent on this machine, but pages are filed per project (one project per repository, resolved from the working directory).',
  '',
  '- `memory_query` without arguments searches only the current project.',
  '- When the question may span other projects or other agents, search again with `global: true`, or pass explicit `workspace`/`project` scopes.',
  '- A thin or empty result means "not in this project", not "not remembered".',
].join('\n')

/** Join the text blocks of one user message; reasoning and images are ignored. */
function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

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
  let settings
  try {
    settings = Config(isObject(config) ? config : {})
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[dsh-ai-memory] disabled: invalid config (${error?.message ?? error})`)
    } catch {
      // Nothing else to do at this point.
    }
    return
  }

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
    log('warn', `no readable bearer token under "${dataDir}"; ingest will be rejected`)
  }

  const sender = createSender({
    maxInflight: settings.maxInflight,
    cooldownMs: settings.cooldownMs,
  })
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

  const send = (event, sessionId, cwd, fields = {}) => {
    if (settings.captureSession !== true) return
    let payload
    try {
      payload = buildHookPayload(event, { sessionId, cwd, ...fields })
    } catch {
      return
    }
    trace(event, payload.session_id)
    sender.enqueue(async () => {
      const result = await postHook({
        baseUrl,
        token,
        event,
        payload,
        agent: settings.agent,
        timeoutMs: settings.timeoutMs,
      })
      if (!result.ok && !warnedFailure) {
        warnedFailure = true
        log('warn', `ingest failed (status ${result.status || 'unreachable'}); capture continues silently`)
      }
      return result
    })
  }

  const open = (sessionId, cwd) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (cwd === null || closedSessions.has(sessionId) || openSessions.has(sessionId)) return
    openSessions.set(sessionId, cwd)
    send('session-start', sessionId, cwd)
  }

  const opened = (session) => open(session?.id, cwdOf(session))

  /**
   * Some desktop restores reach none of the creation seams, so any activity
   * that carries an agent opens its session first. Every later event for that
   * session then has a working directory to attach to.
   */
  const ensureOpen = async (agent) => {
    const sessionId = agent?.id
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const known = openSessions.get(sessionId)
    if (known !== undefined) return known
    if (closedSessions.has(sessionId)) return null
    let cwd = null
    try {
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory && typeof workingDirectory.ensure === 'function') cwd = await workingDirectory.ensure(agent)
    } catch {
      cwd = null
    }
    if (typeof cwd !== 'string' || cwd === '') return null
    open(sessionId, cwd)
    return openSessions.get(sessionId) ?? null
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
  // A resumed session does not always announce session/created (the desktop
  // app restores it instead), so the agent seam opens it as well.
  on('agent/created', (payload) => {
    const source = payload?.source
    if (source !== 'startup' && source !== 'resume') return
    const agent = payload?.agent
    const sessionId = agent?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (openSessions.has(sessionId) || closedSessions.has(sessionId)) return
    void (async () => {
      let cwd = null
      try {
        const workingDirectory = ctx.get('workingDirectory')
        if (workingDirectory && typeof workingDirectory.ensure === 'function') cwd = await workingDirectory.ensure(agent)
      } catch {
        cwd = null
      }
      open(sessionId, typeof cwd === 'string' && cwd !== '' ? cwd : null)
    })()
  })
  // Durability checkpoints are the last seam: any session that stores anything
  // gets registered even when neither creation seam reached us.
  on('session/flush', (session) => opened(session))
  on('session/disposed', (session) => closed(session?.id, cwdOf(session)))
  on('agent/disposed', (payload) => closed(payload?.agent?.id))

  // Prompt text is off by default: it is the most sensitive thing a session
  // produces, and capture must be an explicit choice.
  const seenPrompts = new Set()
  on('agent/inbox/claimed', (payload) => {
    void (async () => {
      const cwd = await ensureOpen(payload?.agent)
      if (cwd === null || settings.capturePrompt !== true) return
      const sessionId = payload.agent.id
      const text = messageText(payload?.message)
    if (text === '') return
    const promptId = payload?.message?.id
    if (typeof promptId === 'string') {
      if (seenPrompts.has(promptId)) return
      seenPrompts.add(promptId)
      if (seenPrompts.size > 200) seenPrompts.delete(seenPrompts.values().next().value)
    }
      const clipped = clipText(redactSecrets(text), settings.maxPromptChars)
      send('user-prompt', sessionId, cwd, { prompt: clipped.value })
    })()
  })

  on('tools/result', (exec, result) => {
    void (async () => {
      const cwd = await ensureOpen(exec?.agent)
      if (cwd === null || settings.captureTools !== true) return
      const sessionId = exec.agent.id
      const text = Array.isArray(result?.content)
      ? result.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
      : ''
      const clipped = clipText(redactSecrets(text), settings.maxToolChars)
      send('post-tool-use', sessionId, cwd, {
        toolName: typeof exec?.name === 'string' ? exec.name : 'unknown',
        toolInput: redactDeep(clipJson(exec?.arguments, settings.maxToolChars)),
        toolResponse: {
          is_error: result?.isError === true,
          text: clipped.value,
          ...(clipped.clipped ? { text_truncated: true } : {}),
        },
      })
    })()
  })

  on('agent/turn-stopping', (payload) => {
    void (async () => {
      const cwd = await ensureOpen(payload?.agent)
      if (cwd === null || settings.captureStop !== true) return
      send('stop', payload.agent.id, cwd)
    })()
  })

  // Read-only routes behind the sidebar panel. A route keeps the browser half
  // free of tokens: only the Host process talks to ai-memory.
  const jsonResponse = (payload, status = 200) => Response.json(payload, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
  const readJson = async (request) => {
    try {
      const body = await request.json()
      return isObject(body) ? body : {}
    } catch {
      return {}
    }
  }
  const scopeOf = (body) => (typeof body?.project === 'string' && body.project !== ''
    ? { workspace: typeof body.workspace === 'string' && body.workspace !== '' ? body.workspace : 'default', project: body.project }
    : null)

  const overviewHandler = async (request) => {
    try {
      const body = await readJson(request)
      const overview = await buildOverview({
        baseUrl,
        token,
        scope: scopeOf(body),
        timeoutMs: settings.timeoutMs,
      })
      return jsonResponse(overview)
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error?.message ?? error) })
    }
  }

  const searchHandler = async (request) => {
    try {
      const body = await readJson(request)
      const q = typeof body.q === 'string' ? body.q.trim() : ''
      if (q === '') return jsonResponse({ ok: true, hits: [] })
      const hits = await search({
        baseUrl,
        token,
        q,
        scope: scopeOf(body),
        global: body.global === true,
        timeoutMs: Math.max(settings.timeoutMs, 4000),
      })
      return jsonResponse({ ok: true, hits })
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error?.message ?? error) })
    }
  }

  try {
    ctx.inject(['connection'], (scope) => {
      const connection = scope.get('connection')
      const register = connection && connection.fetch && typeof connection.fetch.register === 'function'
        ? connection.fetch.register.bind(connection.fetch)
        : undefined
      if (register === undefined) return
      const route = (path, handler, label) => scope.effect(
        () => register({ path, methods: ['POST'], requestBody: 'buffered', fetch: handler }, label),
      )
      route('/api/dsh-ai-memory/overview', overviewHandler, 'dsh-ai-memory: overview route')
      route('/api/dsh-ai-memory/search', searchHandler, 'dsh-ai-memory: search route')
    })
  } catch (error) {
    log('warn', `overview route unavailable: ${error?.message ?? error}`)
  }

  // Tell the model how memory is scoped. Memory is shared on this machine but
  // filed per project, and the profile layer only reaches a client through
  // lifecycle hooks, which DSH does not have.
  if (settings.announceScope !== false) {
    try {
      ctx.inject(['systemPrompt'], (scope) => {
        const systemPrompt = scope.get('systemPrompt')
        if (!systemPrompt || typeof systemPrompt.section !== 'function') return
        let order = 950
        try {
          const base = systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_SUFFIX')
          if (typeof base === 'number' && Number.isFinite(base)) order = base + 500
        } catch {
          // Fall back to the static order.
        }
        scope.effect(() => systemPrompt.section({
          name: 'dsh-ai-memory:scope',
          order,
          text: SCOPE_NOTE,
        }))
      })
    } catch (error) {
      log('warn', `scope note unavailable: ${error?.message ?? error}`)
    }
  }

  // A reachability probe is best-effort and never blocks activation.
  void (async () => {
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(Math.min(settings.timeoutMs, 1500)),
      })
      if (response.ok) log('debug', `ai-memory reachable at ${baseUrl}`)
      else log('warn', `ai-memory answered ${response.status} at ${baseUrl}`)
    } catch {
      log('debug', `ai-memory is not reachable at ${baseUrl}; capture will be dropped until it is`)
    }
  })()

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
