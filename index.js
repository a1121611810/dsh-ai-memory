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
import { accessSync, appendFileSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'

import { buildHookPayload, clipJson, clipText, postHook } from './lib/hook.js'
import { buildOverview, health, search, serverInfo, sessionBinding } from './lib/mcp.js'
import { normalizeBaseUrl, readToken, resolveDataDir } from './lib/paths.js'
import { createSender } from './lib/queue.js'
import { resolveScope } from './lib/scope.js'
import { redactDeep, redactSecrets } from './lib/redact.js'

export const name = 'dsh-ai-memory'

export const DEFAULTS = Object.freeze({
  serverUrl: 'http://127.0.0.1:49374',
  dataDir: '',
  agent: 'auto',
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
  instructionsPath: '',
})

export const Config = z.object({
  serverUrl: z.string().default(DEFAULTS.serverUrl)
    .description('ai-memory base URL. Loopback only unless allowRemote is set.'),
  dataDir: z.string().default(DEFAULTS.dataDir)
    .description('ai-memory data directory; empty means the platform default.'),
  agent: z.string().default(DEFAULTS.agent)
    .description("Agent label ai-memory records. 'auto' picks dsh on ai-memory 3.2.0 or newer and claude-code below it."),
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
  instructionsPath: z.string().default(DEFAULTS.instructionsPath)
    .description('Rules file the install check reads and the write button updates. Empty means ~/.agents/AGENTS.md, else the workspace AGENTS.md.'),
})

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * One short, static note: memory is shared on this machine but filed per
 * project, and DSH's stateless MCP client gets no coordinates from the server,
 * so the model has to pass the scope. A thin result is a scoping signal, not an
 * absence of knowledge.
 */
const SCOPE_NOTE = [
  '## ai-memory scope',
  '',
  'ai-memory is shared by every agent on this machine, but pages are filed per project.',
  '',
  "A client that forwards no session id (DSH does not) gives ai-memory no coordinates, so an unscoped memory call resolves through its active-project pointer — often the shared slot, i.e. whatever project another agent touched last — instead of this session's repository.",
  '',
  '- Pass `workspace` and `project` together on every project-scoped memory call. Take the exact names from the nearest `.ai-memory.toml`; otherwise derive the project from the git origin (`<owner>-<repo>`), else the directory name.',
  '- `memory_query` with `global: true` searches every project at once.',
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
  /** Session id -> the agent label ai-memory already pinned, once discovered. */
  const sessionAgents = new Map()
  /** Session id -> the label switch the server forced, for the panel. */
  const captureNotes = new Map()
  const scopeByCwd = new Map()

  /**
   * ai-memory has no `dsh` agent kind before 3.2.0, and it binds a session to
   * the label it first arrived under: any later event with another label is
   * dropped as a session collision. Resolve one label per process instead of
   * per event, and keep claude-code on older servers so 3.0.0 keeps working.
   */
  const DSH_AGENT = 'dsh'
  const FALLBACK_AGENT = 'claude-code'
  const DSH_AGENT_FLOOR = [3, 2, 0]
  const SUPPORTED_FLOOR = [3, 0, 0]

  const versionAtLeast = (version, floor) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''))
    if (match === null) return false
    const parts = match.slice(1, 4).map(Number)
    for (let index = 0; index < floor.length; index += 1) {
      if (parts[index] !== floor[index]) return parts[index] > floor[index]
    }
    return true
  }

  /** An explicit `agent` wins; `auto` and empty ask the server. */
  const configuredAgent = () => {
    const value = typeof settings.agent === 'string' ? settings.agent.trim() : ''
    return value === '' || value.toLowerCase() === 'auto' ? null : value
  }

  let resolvedAgent = null
  let agentProbe = null
  const resolveAgent = () => {
    const override = configuredAgent()
    if (override !== null) return Promise.resolve(override)
    if (resolvedAgent !== null) return Promise.resolve(resolvedAgent)
    if (agentProbe === null) {
      agentProbe = serverInfo({ baseUrl, token, timeoutMs: Math.min(settings.timeoutMs, 2000) })
        .catch(() => null)
        .then((info) => {
          const version = typeof info?.version === 'string' ? info.version : null
          if (version === null) {
            // Unreachable or unreadable: retry on the next session rather than
            // pinning claude-code for the rest of the process.
            agentProbe = null
            return FALLBACK_AGENT
          }
          if (!versionAtLeast(version, SUPPORTED_FLOOR)) {
            log('warn', `ai-memory ${version} is older than the supported 3.0.0; capture may fail`)
          }
          resolvedAgent = versionAtLeast(version, DSH_AGENT_FLOOR) ? DSH_AGENT : FALLBACK_AGENT
          log('debug', `recording sessions as agent=${resolvedAgent} (ai-memory ${version})`)
          return resolvedAgent
        })
    }
    return agentProbe
  }

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

  /** The label this session is captured under: the pinned one when known. */
  const agentFor = async (sessionId) => sessionAgents.get(sessionId) ?? await resolveAgent()

  const scopeForCwd = (cwd) => {
    const cached = scopeByCwd.get(cwd)
    if (cached !== undefined) return cached
    const scope = resolveScope(cwd)
    // A miss is not cached: a marker added later should heal without a restart.
    if (scope !== null) scopeByCwd.set(cwd, scope)
    return scope
  }

  /**
   * ai-memory pins a session's agent label on first capture and drops every
   * later event that disagrees, so an agent setting change silently loses a
   * live session. Read the pinned label back once and adopt it: the rest of
   * this session is then captured under the label the server already knows.
   */
  const adoptBinding = async (sessionId, cwd) => {
    if (settings.captureSession !== true) return
    const sent = await agentFor(sessionId)
    const scope = scopeForCwd(cwd)
    if (scope === null) return
    const binding = await sessionBinding({
      baseUrl,
      token,
      scope,
      sessionId,
      timeoutMs: Math.min(settings.timeoutMs, 500),
    })
    if (binding === null || binding.agent === sent) return
    sessionAgents.set(sessionId, binding.agent)
    captureNotes.set(sessionId, { sent, bound: binding.agent })
    while (captureNotes.size > 5) captureNotes.delete(captureNotes.keys().next().value)
    log('warn', 'session ' + sessionId + ' is pinned to agent=' + binding.agent + '; capturing under that label instead of ' + sent)
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
        agent: await agentFor(sessionId),
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
    // Learn the pinned label first so the first event is not dropped as a
    // collision. The probe costs one local round trip; the next prompt or tool
    // event is seconds away, so the ordering it could race never materialises.
    void (async () => {
      try {
        await adoptBinding(sessionId, cwd)
      } finally {
        send('session-start', sessionId, cwd)
      }
    })()
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

  const MARKER_START = '<!-- ai-memory:start -->'
  const MARKER_END = '<!-- ai-memory:end -->'

  const instructionTarget = () => {
    const configured = typeof settings.instructionsPath === 'string' ? settings.instructionsPath.trim() : ''
    if (configured !== '') return configured
    try {
      const global = join(homedir(), '.agents')
      accessSync(global)
      return join(global, 'AGENTS.md')
    } catch {
      // No global agents directory: fall back to the workspace.
    }
    try {
      const workspace = ctx.get('workingDirectory')?.defaultDirectory
      return typeof workspace === 'string' && workspace !== '' ? join(workspace, 'AGENTS.md') : null
    } catch {
      return null
    }
  }

  const fallbackBlock = () => [MARKER_START, SCOPE_NOTE, MARKER_END].join('\n')

  /** Replace or append the marker block, never touching anything else. */
  const writeInstructions = async () => {
    const target = instructionTarget()
    if (target === null) return { ok: false, error: 'no rules file could be resolved' }

    let block = fallbackBlock()
    try {
      const data = await mcpCall({
        baseUrl,
        token,
        name: 'memory_install_self_routing',
        args: { compact: true },
        timeoutMs: settings.timeoutMs,
      })
      const candidate = data?.markered_block
      if (typeof candidate === 'string' && candidate.includes(MARKER_START) && candidate.includes(MARKER_END)) {
        block = candidate.trim()
      }
    } catch {
      // The local block is a usable fallback when the server is unreachable.
    }

    let current = ''
    let existed = false
    try {
      current = readFileSync(target, 'utf8')
      existed = true
    } catch {
      current = ''
    }

    const start = current.indexOf(MARKER_START)
    const end = current.indexOf(MARKER_END)
    let next
    let replaced = false
    if (start >= 0 && end > start) {
      next = current.slice(0, start) + block + current.slice(end + MARKER_END.length)
      replaced = true
    } else if (start >= 0 || end >= 0) {
      return { ok: false, error: 'unbalanced ai-memory markers; fix the file by hand' }
    } else {
      next = current.trim() === '' ? `${block}\n` : `${current.trimEnd()}\n\n${block}\n`
    }

    try {
      if (existed) copyFileSync(target, `${target}.bak-ai-memory-${Date.now()}`)
      writeFileSync(target, next)
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
    return { ok: true, path: target, replaced }
  }

  const fileHasMarker = (path) => {
    try {
      return readFileSync(path, 'utf8').includes('ai-memory:start')
    } catch {
      return false
    }
  }

  /**
   * Two required checks and two optional ones. The plugin can run without the
   * optional pair (the scope note is injected at runtime), but a fresh install
   * usually wants all four, so each missing piece gets its own command.
   */
  const setupStatus = async () => {
    const defaults = (() => {
      try {
        return ctx.get('workingDirectory')?.defaultDirectory ?? null
      } catch {
        return null
      }
    })()
    const configured = typeof settings.instructionsPath === 'string' ? settings.instructionsPath.trim() : ''
    const instructionFiles = configured !== ''
      ? [configured]
      : [
        join(homedir(), '.agents', 'AGENTS.md'),
        defaults ? join(defaults, 'AGENTS.md') : null,
        defaults ? join(defaults, 'CLAUDE.md') : null,
      ].filter((path) => typeof path === 'string')

    let reachable = false
    try {
      reachable = (await health({ baseUrl, timeoutMs: Math.min(settings.timeoutMs, 1500) }))?.status === 'ok'
    } catch {
      reachable = false
    }

    let mcp = null
    try {
      const tools = ctx.get('tools')
      const definitions = typeof tools?.definitions === 'function' ? tools.definitions() : null
      if (Array.isArray(definitions)) {
        mcp = definitions.some((tool) => String(tool?.name ?? '').startsWith('mcp__ai-memory__'))
      }
    } catch {
      mcp = null
    }

    const notes = [...captureNotes.values()]
    return {
      token: token !== null,
      reachable,
      mcp,
      instructions: instructionFiles.some(fileHasMarker),
      instructionFiles,
      // A session the server had already pinned to another label: the plugin
      // adopted it, but the panel should say so instead of staying silent.
      capture: notes.length === 0 ? null : notes[notes.length - 1],
      ready: token !== null && reachable,
    }
  }

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
      const [overview, setup] = await Promise.all([
        buildOverview({
          baseUrl,
          token,
          scope: scopeOf(body),
          timeoutMs: settings.timeoutMs,
        }),
        setupStatus().catch(() => null),
      ])
      return jsonResponse({ ...overview, setup })
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error?.message ?? error) })
    }
  }

  const settingsKeys = Object.keys(DEFAULTS)
  // `ctx.fiber.entry` is the documented handle; the editor's own inventory is a
  // tolerant fallback for builds that do not expose it on the plugin context.
  const settingsEntry = () => {
    try {
      if (ctx.fiber?.entry) return ctx.fiber.entry
    } catch {
      // Fall through to the inventory.
    }
    try {
      const rows = ctx.get('configEditor')?.configuration?.() ?? []
      for (const row of rows) {
        const entry = row?.entry
        if (!entry) continue
        const patchId = entry.patch?.id ?? entry.patchId
        if (patchId === 'ai-memory-sync' || entry.name === 'dsh-ai-memory') return entry
      }
    } catch {
      // No editor inventory either.
    }
    return undefined
  }
  const readSettings = () => {
    try {
      const entry = settingsEntry()
      // The row stores only what the user changed; the form shows the effective
      // values, so it must start from the defaults rather than an empty object.
      const config = { ...DEFAULTS, ...(isObject(entry?.config) ? entry.config : {}) }
      return { ok: true, entryId: entry?.id ?? null, config, editable: Boolean(entry) && Boolean(ctx.get('configEditor')) }
    } catch {
      return { ok: true, entryId: null, config: {}, editable: false }
    }
  }
  const saveSettings = async (patch) => {
    const editor = ctx.get('configEditor')
    const entry = settingsEntry()
    if (!editor || !entry) return { ok: false, error: 'configuration cannot be saved in this profile' }
    const candidate = {}
    for (const key of settingsKeys) if (Object.hasOwn(patch, key)) candidate[key] = patch[key]
    try {
      Config({ ...(isObject(entry.config) ? entry.config : {}), ...candidate })
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
    try {
      await editor.edit(entry, (current) => ({ ...current, ...candidate }))
      return { ok: true, saved: candidate }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }
  const installHandler = async () => {
    try {
      return jsonResponse(await writeInstructions())
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error?.message ?? error) })
    }
  }

  const settingsHandler = async (request) => {
    const body = await readJson(request)
    if (isObject(body.patch)) return jsonResponse(await saveSettings(body.patch))
    return jsonResponse(readSettings())
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
      route('/api/dsh-ai-memory/settings', settingsHandler, 'dsh-ai-memory: settings route')
      route('/api/dsh-ai-memory/install-instructions', installHandler, 'dsh-ai-memory: install route')
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
      log('warn', `ai-memory is not reachable at ${baseUrl}; nothing will be captured until it is running`)
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
