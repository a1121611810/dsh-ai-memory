/**
 * ai-memory HTTP ingest: Claude-shaped hook payloads posted to /hook.
 *
 * We deliberately do not shell out to the ai-memory CLI: DSH runs command
 * hooks inside a sandbox that cannot write ai-memory's own spool directory,
 * so the CLI would drop every event. A plain HTTP POST from the Host process
 * has no such restriction.
 */

const HOOK_EVENT_NAMES = {
  'session-start': 'SessionStart',
  'session-end': 'SessionEnd',
  'user-prompt': 'UserPromptSubmit',
  'post-tool-use': 'PostToolUse',
  'stop': 'Stop',
}

export function buildHookPayload(event, { sessionId, cwd }) {
  const hookEventName = HOOK_EVENT_NAMES[event]
  if (hookEventName === undefined) throw new Error(`unknown event "${event}"`)
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId is required')
  if (typeof cwd !== 'string' || cwd === '') throw new Error('cwd is required')

  const base = { session_id: sessionId, transcript_path: '', cwd, hook_event_name: hookEventName }
  switch (event) {
    case 'session-start':
      return { ...base, source: 'startup' }
    case 'session-end':
      return { ...base, reason: 'other' }
    case 'stop':
      return { ...base, stop_hook_active: false }
    default:
      return base
  }
}

export function hookUrl(baseUrl, event, agent) {
  return `${baseUrl}/hook?event=${encodeURIComponent(event)}&agent=${encodeURIComponent(agent)}`
}

/**
 * POST one event. Resolves to true when the server accepted it.
 * Never throws: capture is best-effort and must not affect the session.
 */
export async function postHook({ baseUrl, token, event, payload, agent, timeoutMs, fetchImpl = fetch }) {
  const headers = { 'content-type': 'application/json' }
  if (token !== null) headers.authorization = `Bearer ${token}`
  try {
    const response = await fetchImpl(hookUrl(baseUrl, event, agent), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) return { ok: true, status: response.status }
    await response.text().catch(() => '')
    return { ok: false, status: response.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

export { HOOK_EVENT_NAMES }
