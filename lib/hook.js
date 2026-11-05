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

export function buildHookPayload(event, fields = {}) {
  const hookEventName = HOOK_EVENT_NAMES[event]
  if (hookEventName === undefined) throw new Error(`unknown event "${event}"`)
  const { sessionId, cwd } = fields
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
    case 'user-prompt':
      return { ...base, prompt: typeof fields.prompt === 'string' ? fields.prompt : '' }
    case 'post-tool-use':
      return {
        ...base,
        tool_name: typeof fields.toolName === 'string' ? fields.toolName : 'unknown',
        tool_input: fields.toolInput ?? {},
        tool_response: fields.toolResponse ?? {},
      }
    default:
      return base
  }
}

/** Keep one field under a byte budget without losing the fact that it was cut. */
export function clipText(text, max) {
  const value = typeof text === 'string' ? text : ''
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) return { value, clipped: false }
  return { value: value.slice(0, max), clipped: true }
}

export function clipJson(value, max) {
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    return { truncated: true, preview: '[unserializable]' }
  }
  if (typeof serialized !== 'string') return value ?? null
  if (!Number.isFinite(max) || max <= 0 || serialized.length <= max) return JSON.parse(serialized)
  return { truncated: true, preview: serialized.slice(0, max) }
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
