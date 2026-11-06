/**
 * Resolve the ai-memory project a working directory belongs to.
 *
 * ai-memory files pages per (workspace, project) and resolves a project from
 * the working directory: the nearest .ai-memory.toml wins, else the git
 * remote (upstream, then origin), else the directory name. The plugin only
 * needs this to read a session's recorded agent back, so a wrong guess costs
 * one skipped probe — never a dropped event.
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const MARKER = '.ai-memory.toml'
const FIELD = /^\s*(workspace|project)\s*=\s*["']([^"']+)["']\s*$/

const readText = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The marker that governs a directory, walking up; null when there is none. */
export function markerScope(dir) {
  let current = resolve(dir)
  for (;;) {
    const text = readText(join(current, MARKER))
    if (text !== null) {
      const fields = {}
      for (const line of text.split('\n')) {
        const match = FIELD.exec(line)
        if (match !== null) fields[match[1]] = match[2]
      }
      if (typeof fields.project === 'string' && fields.project !== '') {
        return {
          workspace: typeof fields.workspace === 'string' && fields.workspace !== '' ? fields.workspace : 'default',
          project: fields.project,
        }
      }
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** https://github.com/owner/repo.git and friends -> owner-repo. */
export function projectFromRemote(url) {
  const text = String(url ?? '').trim()
  if (text === '') return null
  const clean = text.replace(/\/+$/, '').replace(/\.git$/, '')
  let path = null
  if (clean.includes('://')) {
    // host/owner/repo: the authority is dropped with the scheme.
    path = clean.slice(clean.indexOf('://') + 3).replace(/^[^/]*\//, '')
  } else if (/^[^/@]+@[^:]+:/.test(clean)) {
    // scp form: git@host:owner/repo
    path = clean.slice(clean.indexOf(':') + 1)
  } else if (clean.startsWith('/')) {
    // A local path remote names the checkout, not an owner.
    return basename(clean) || null
  } else {
    return null
  }
  const segments = path.split('/').filter((part) => part !== '')
  if (segments.length === 0) return null
  return (segments.length >= 2 ? segments.slice(-2) : segments).join('-')
}

/** The config file of the repository containing a directory, worktrees included. */
export function repoConfigPath(dir) {
  let current = resolve(dir)
  for (;;) {
    const git = join(current, '.git')
    let stat = null
    try {
      stat = statSync(git)
    } catch {
      stat = null
    }
    if (stat !== null) {
      if (stat.isDirectory()) return join(git, 'config')
      const pointer = /^gitdir:\s*(.+)$/m.exec(readText(git) ?? '')
      if (pointer === null) return null
      const gitdir = resolve(current, pointer[1].trim())
      return join(gitdir, '..', '..', 'config')
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** One remote's URL out of a git config file. */
export function remoteUrl(config, name) {
  if (typeof config !== 'string') return null
  const section = new RegExp('\\[remote\\s+"' + name + '"\\][^\\[]*', 'i').exec(config)
  if (section === null) return null
  const url = /^\s*url\s*=\s*(.+)$/m.exec(section[0])
  return url === null ? null : url[1].trim()
}

/** The workspace and project for a working directory, or null when unresolvable. */
export function resolveScope(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null
  const marker = markerScope(cwd)
  if (marker !== null) return marker
  const config = readText(repoConfigPath(cwd) ?? '')
  if (config !== null) {
    for (const name of ['upstream', 'origin']) {
      const project = projectFromRemote(remoteUrl(config, name))
      if (project !== null) return { workspace: 'default', project }
    }
  }
  const name = basename(resolve(cwd))
  return name === '' ? null : { workspace: 'default', project: name }
}
