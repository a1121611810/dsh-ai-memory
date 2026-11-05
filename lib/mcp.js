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
export async function briefing({ baseUrl, token, scope, limit = 20, timeoutMs = 3000, fetchImpl = fetch }) {
  const data = await mcpCall({
    baseUrl,
    token,
    name: 'memory_briefing',
    args: { ...scopeArgs(scope), recent_pages_limit: limit },
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
    scope: data?.scope ?? null,
  }
}

export async function search({ baseUrl, token, q, scope, global = false, limit = 12, timeoutMs = 4000, fetchImpl = fetch }) {
  const args = global || !scope?.project
    ? { query: q, limit, ...(global ? { global: true } : {}) }
    : { query: q, limit, ...scopeArgs(scope) }
  const data = await mcpCall({ baseUrl, token, name: 'memory_query', args, timeoutMs, fetchImpl })
  const hits = Array.isArray(data?.hits) ? data.hits : []
  const globalHits = Array.isArray(data?.global_hits) ? data.global_hits : []
  return [...hits, ...globalHits].map((hit) => ({
    path: hit.path,
    title: hit.title ?? hit.path,
    snippet: String(hit.snippet ?? '').replace(/<\/?mark>/g, ''),
    project: hit.project_name ?? null,
  }))
}

/**
 * Everything the panel shows in one round trip: server health, the scope the
 * session resolves to, the project directory, and one project's briefing.
 */
export async function buildOverview({ baseUrl, token, scope = null, timeoutMs = 3000, fetchImpl = fetch }) {
  const [probe, status, projects, brief] = await Promise.all([
    health({ baseUrl, timeoutMs, fetchImpl }).catch(() => null),
    mcpCall({ baseUrl, token, name: 'memory_status', timeoutMs, fetchImpl }).catch(() => null),
    listProjects({ baseUrl, token, timeoutMs, fetchImpl }).catch(() => []),
    briefing({ baseUrl, token, scope, timeoutMs, fetchImpl }).catch(() => null),
  ])

  return {
    ok: true,
    server: { url: baseUrl, status: probe?.status ?? 'unknown' },
    current: status?.scope ?? null,
    counts: status?.counts ?? null,
    projects,
    briefing: brief,
  }
}
