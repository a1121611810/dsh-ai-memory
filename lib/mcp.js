/**
 * Read-only ai-memory queries over its HTTP surface.
 *
 * The MCP endpoint is stateless, so a tools/call needs no handshake. Both the
 * overview route and any future panel data go through here.
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

/**
 * One payload for the sidebar panel: server health, the resolved project,
 * counters, and the most recently updated pages.
 */
export async function buildOverview({ baseUrl, token, timeoutMs = 3000, fetchImpl = fetch }) {
  const [probe, status, recent] = await Promise.all([
    health({ baseUrl, timeoutMs, fetchImpl }).catch(() => null),
    mcpCall({ baseUrl, token, name: 'memory_status', timeoutMs, fetchImpl }),
    mcpCall({
      baseUrl,
      token,
      name: 'memory_recent',
      args: { limit: 8 },
      timeoutMs,
      fetchImpl,
    }).catch(() => ({ hits: [] })),
  ])

  return {
    ok: true,
    server: { url: baseUrl, status: probe?.status ?? 'unknown' },
    scope: status?.scope ?? null,
    counts: status?.counts ?? null,
    recent: Array.isArray(recent?.hits) ? recent.hits : [],
  }
}
