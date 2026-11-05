/**
 * Secret redaction for captured text.
 *
 * ai-memory sanitizes server-side too, but a long-lived memory store is the
 * wrong place to discover a leaked key, so obvious credential shapes are
 * stripped before anything leaves the process.
 */

const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
]

export const REDACTED = '[redacted]'

export function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return text
  let output = text
  for (const pattern of PATTERNS) {
    output = output.replace(pattern, REDACTED)
  }
  return output
}

/** Walk a JSON-like value and redact every string leaf. */
export function redactDeep(value, depth = 0) {
  if (depth > 6) return value
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1))
  if (typeof value === 'object' && value !== null) {
    const output = {}
    for (const [key, item] of Object.entries(value)) output[key] = redactDeep(item, depth + 1)
    return output
  }
  return value
}
