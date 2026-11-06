/**
 * Read-only ai-memory queries over its HTTP surface.
 *
 * The MCP endpoint is stateless, so a tools/call needs no handshake. Both the
 * panel routes and any future view go through here; the bearer token never
 * leaves the Host process.
 */
function headers(token) {
  const base = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  return token === null ? base : { ...base, authorization: `Bearer ${token}` }
}

export async function mcpCall({ baseUrl, token, name, args = {}, timeoutMs = 3000, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`ai-memory ${name}: HTTP ${response.status}`)
  const body = await response.json()
  if (body?.error) throw new Error(body.error.message ?? `ai-memory ${name} failed`)
  const text = body?.result?.content?.find((block) => block?.type === 'text')?.text
  if (typeof text !== 'string') throw new Error(`ai-memory ${name}: empty result`)
  return JSON.parse(text)
}

export async function health({ baseUrl, timeoutMs = 1500, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl}/healthz`, {
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`healthz: HTTP ${response.status}`)
  return response.json()
}

const scopeArgs = (scope) => (scope && scope.project
  ? { workspace: scope.workspace, project: scope.project }
  : {})

/** Projects that hold at least one page, newest first. */
export async function listProjects({ baseUrl, token, timeoutMs = 3000, fetchImpl = fetch, limit = 80 }) {
  const response = await fetchImpl(`${baseUrl}/api/v1/projects`, {
    headers: headers(token),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`projects: HTTP ${response.status}`)
  const rows = await response.json()
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row) => Number(row?.page_count) > 0)
    .map((row) => ({
      workspace: row.workspace_name ?? 'default',
      project: row.project_name ?? '?',
      pages: Number(row.page_count) || 0,
      updated: row.last_updated ?? null,
    }))
    .sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')))
    .slice(0, limit)
}

/** One project's snapshot: counters, 7-day activity, rules, recent pages. */
export async function briefing({ baseUrl, token, scope, limit = 20, sessionsLimit = 50, timeoutMs = 3000, fetchImpl = fetch }) {
  const data = await mcpCall({
    baseUrl,
    token,
    name: 'memory_briefing',
    // 3.0.0 ignores recent_sessions_limit; 3.2.0+ answers with recent_sessions.
    args: { ...scopeArgs(scope), recent_pages_limit: limit, recent_sessions_limit: sessionsLimit },
    timeoutMs,
    fetchImpl,
  })
  return {
    counts: data?.counts ?? null,
    activity7d: data?.activity_7d ?? null,
    lastObservationAt: data?.last_observation_at ?? null,
    handoffs: Number(data?.pending_handoff_count) || 0,
    messages: Number(data?.pending_message_count) || 0,
    rules: Array.isArray(data?.rules) ? data.rules : [],
    recent: Array.isArray(data?.recent_pages) ? data.recent_pages : [],
    recentSessions: Array.isArray(data?.recent_sessions) ? data.recent_sessions : [],
    scope: data?.scope ?? null,
  }
}

/** Full-text search with the owning project on every hit. */
export async function search({ baseUrl, token, q, scope, global = false, limit = 12, timeoutMs = 4000, fetchImpl = fetch }) {
  const params = new URLSearchParams({ q, limit: String(limit) })
  if (!global && scope?.project) {
    params.set('workspace', scope.workspace)
    params.set('project', scope.project)
  }
  const response = await fetchImpl(`${baseUrl}/api/v1/search?${params}`, {
    headers: headers(token),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`search: HTTP ${response.status}`)
  const rows = await response.json()
  if (!Array.isArray(rows)) return []
  return rows.map((hit) => ({
    path: hit.path,
    title: hit.title ?? hit.path,
    kind: hit.kind ?? null,
    snippet: String(hit.snippet ?? '').replace(/<\/?mark>/g, ''),
    project: hit.project ?? null,
    workspace: hit.workspace ?? null,
  }))
}

/** Session counts per agent for one project: who actually wrote here. */
export async function agentsByProject({ baseUrl, token, scope, timeoutMs = 3000, fetchImpl = fetch }) {
  if (!scope?.project) return []
  const params = new URLSearchParams({ workspace: scope.workspace, project: scope.project })
  const response = await fetchImpl(`${baseUrl}/admin/sessions/by-agent?${params}`, {
    headers: headers(token),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) return []
  const body = await response.json()
  return Array.isArray(body?.by_agent) ? body.by_agent : []
}

/** Server facts worth showing: version, paths, providers, ingest health. */
export async function serverInfo({ baseUrl, token, timeoutMs = 3000, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl}/admin/status`, {
    headers: headers(token),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`status: HTTP ${response.status}`)
  const body = await response.json()
  return {
    version: body?.version ?? null,
    dataDir: body?.data_dir ?? null,
    bind: body?.bind ?? null,
    providers: {
      llm: body?.providers?.llm?.status ?? null,
      embedding: body?.providers?.embedding?.status ?? null,
    },
    ingest: {
      stored: body?.ingest?.stored ?? 0,
      dropped: (body?.ingest?.dropped_collision ?? 0) + (body?.ingest?.dropped_invalid ?? 0)
        + (body?.ingest?.dropped_unauthorized ?? 0) + (body?.ingest?.dropped_by_policy ?? 0),
      lastPersistedMs: body?.ingest?.last_persisted_ms ?? null,
    },
    counts: body?.counts ?? null,
  }
}

/** The `agent` recorded in one page's frontmatter, if it has one. */
export async function pageAgent({ baseUrl, token, workspace, project, path, timeoutMs = 3000, fetchImpl = fetch }) {
  if (!workspace || !project || !path) return null
  const params = new URLSearchParams({ workspace, project, path })
  const response = await fetchImpl(`${baseUrl}/admin/read-page?${params}`, {
    headers: headers(token),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) return null
  const body = await response.json()
  const agent = body?.frontmatter?.agent
  return typeof agent === 'string' && agent !== '' ? agent : null
}

/**
 * The agent label ai-memory pinned to a session on its first capture, plus the
 * observation count. Null when the session is unknown or the read fails: the
 * caller must not treat that as "the binding matches".
 */
export async function sessionBinding({ baseUrl, token, scope, sessionId, timeoutMs = 3000, fetchImpl = fetch }) {
  if (!scope?.project || typeof sessionId !== 'string' || sessionId === '') return null
  let data
  try {
    data = await mcpCall({
      baseUrl,
      token,
      name: 'memory_read_session_observations',
      args: { workspace: scope.workspace, project: scope.project, session_id: sessionId, limit: 1 },
      timeoutMs,
      fetchImpl,
    })
  } catch {
    return null
  }
  const session = data?.session
  if (!session || typeof session.agent_kind !== 'string' || session.agent_kind === '') return null
  return {
    agent: session.agent_kind,
    observations: Number(session.observation_count) || 0,
  }
}

/**
 * Everything the panel shows in one round trip: server health, the scope the
 * session resolves to, the project directory, and one project's briefing.
 */
export async function buildOverview({ baseUrl, token, scope = null, timeoutMs = 3000, fetchImpl = fetch }) {
  const [probe, status, projects, brief, facts] = await Promise.all([
    health({ baseUrl, timeoutMs, fetchImpl }).catch(() => null),
    mcpCall({ baseUrl, token, name: 'memory_status', timeoutMs, fetchImpl }).catch(() => null),
    listProjects({ baseUrl, token, timeoutMs, fetchImpl }).catch(() => []),
    briefing({ baseUrl, token, scope, timeoutMs, fetchImpl }).catch(() => null),
    serverInfo({ baseUrl, token, timeoutMs, fetchImpl }).catch(() => null),
  ])

  const effective = scope && scope.project
    ? { workspace: scope.workspace, project: scope.project }
    : (brief?.scope ? { workspace: brief.scope.workspace, project: brief.scope.project } : null)

  const agents = await agentsByProject({ baseUrl, token, scope: effective, timeoutMs, fetchImpl }).catch(() => [])

  // Session summaries are the only pages carrying an `agent`. ai-memory 3.2.0+
  // lists recent sessions with their agent, so every visible session page is
  // covered in the briefing round trip; older servers need a frontmatter read
  // per visible page. Reading only the first few left the rest unlabelled.
  const recent = brief?.recent ?? []
  const sessionAgents = new Map((brief?.recentSessions ?? [])
    .filter((entry) => typeof entry?.session_id === 'string' && typeof entry?.agent_kind === 'string')
    .map((entry) => [entry.session_id, entry.agent_kind]))
  const pageAgents = {}
  const unresolved = []
  for (const page of recent) {
    if (typeof page?.path !== 'string') continue
    const session = /^sessions\/(.+)\.md$/.exec(page.path)
    const agent = session === null ? undefined : sessionAgents.get(session[1])
    if (agent !== undefined) pageAgents[page.path] = agent
    else if (session !== null || sessionAgents.size === 0) unresolved.push(page.path)
  }
  await Promise.all(unresolved.map(async (path) => {
    const agent = await pageAgent({
      baseUrl, token, workspace: effective?.workspace, project: effective?.project, path, timeoutMs, fetchImpl,
    }).catch(() => null)
    if (agent) pageAgents[path] = agent
  }))

  return {
    ok: true,
    server: { url: baseUrl, status: probe?.status ?? 'unknown', ...facts },
    current: status?.scope ?? null,
    counts: status?.counts ?? null,
    projects,
    briefing: brief,
    agents,
    pageAgents,
  }
}
