/**
 * Platform paths for an ai-memory installation.
 *
 * The plugin never stores a token: it reads the one ai-memory itself writes,
 * from the same directory the server and its hooks use.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0'])

export function resolveDataDir(env = process.env, platform = process.platform, home = homedir()) {
  const override = env.AI_MEMORY_DATA_DIR
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'ai-memory')
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    const base = typeof local === 'string' && local.trim() !== '' ? local : join(home, 'AppData', 'Local')
    return join(base, 'ai-memory')
  }
  const xdg = env.XDG_DATA_HOME
  const base = typeof xdg === 'string' && xdg.trim() !== '' ? xdg : join(home, '.local', 'share')
  return join(base, 'ai-memory')
}

export function readToken(dataDir, readFile = readFileSync) {
  try {
    const token = String(readFile(join(dataDir, 'auth-token'), 'utf8')).trim()
    return token === '' ? null : token
  } catch {
    return null
  }
}

/**
 * Validate and normalize the server base URL.
 * Remote hosts are refused unless explicitly allowed, and never over plaintext.
 */
export function normalizeBaseUrl(input, { allowRemote = false } = {}) {
  let url
  try {
    url = new URL(String(input))
  } catch {
    throw new Error('serverUrl is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('serverUrl must use http or https')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!LOOPBACK.has(host)) {
    if (!allowRemote) throw new Error(`refusing non-loopback host "${host}" without allowRemote`)
    if (url.protocol !== 'https:') throw new Error('a remote serverUrl must use https')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export const __testing = { LOOPBACK }
