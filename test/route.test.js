import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'

const STATUS = {
  counts: { pages_latest: 6, sessions: 21, observations: 112, evidence_rows: 0 },
  scope: { workspace: 'default', project: 'acme-api', resolved_by: 'shared_slot' },
}
const BRIEFING = {
  counts: STATUS.counts,
  activity_7d: { days: 7, sessions: 3, observations: 9, pages_updated: 2 },
  last_observation_at: '2026-11-05T16:00:00Z',
  pending_handoff_count: 1,
  pending_message_count: 0,
  rules: [],
  recent_pages: [{ path: 'notes/a.md', title: 'A note', kind: 'note' }],
  scope: { workspace: 'default', project: 'acme-api', resolved_by: 'explicit' },
}
const QUERY = {
  hits: [{ path: 'notes/a.md', title: 'A note', snippet: 'about <mark>cache</mark>', project: 'acme-api' }],
}
const PROJECTS = [
  { workspace_name: 'default', project_name: 'acme-api', page_count: 6, last_updated: '2026-11-05T16:00:00Z' },
  { workspace_name: 'default', project_name: 'empty', page_count: 0, last_updated: '2026-11-05T15:00:00Z' },
]

function fakeAiMemory({ briefing = BRIEFING } = {}) {
  const calls = []
  const readPageCalls = []
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const json = (payload) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))

    if (request.method === 'GET' && url.pathname === '/healthz') return json({ status: 'ok' })
    if (request.method === 'GET' && url.pathname === '/api/v1/projects') return json(PROJECTS)
    if (request.method === 'GET' && url.pathname === '/api/v1/search') {
      calls.push({ search: url.searchParams.get('q'), project: url.searchParams.get('project') })
      return json(QUERY.hits)
    }
    if (request.method === 'GET' && url.pathname === '/admin/status') {
      return json({
        version: '3.0.0',
        data_dir: '/data/ai-memory',
        bind: '127.0.0.1:49374',
        counts: STATUS.counts,
        providers: { llm: { status: 'disabled' }, embedding: { status: 'disabled' } },
        ingest: { stored: 9, dropped_collision: 2, last_persisted_ms: 1 },
      })
    }
    if (request.method === 'GET' && url.pathname === '/admin/sessions/by-agent') {
      return json({ by_agent: [{ agent: 'claude-code', sessions: 18 }, { agent: 'other', sessions: 3 }] })
    }
    if (request.method === 'GET' && url.pathname === '/admin/read-page') {
      readPageCalls.push(url.searchParams.get('path'))
      return json({ path: url.searchParams.get('path'), frontmatter: { agent: 'claude-code' } })
    }
    if (request.method === 'POST' && url.pathname === '/mcp') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        const call = JSON.parse(body)
        calls.push(call)
        const value = call.params.name === 'memory_status'
          ? STATUS
          : call.params.name === 'memory_briefing'
            ? briefing
            : QUERY
        json({ jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } })
      })
      return
    }
    response.writeHead(404).end('not found')
  })
  const ready = new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { server.unref(); resolve() })
  })
  return {
    calls,
    readPageCalls,
    ready,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
    url: async () => {
      await ready
      return `http://127.0.0.1:${server.address().port}`
    },
  }
}

function harness(baseUrl, { editor = null, mcp = true, instructions = false, overrides = {}, connection = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-route-'))
  writeFileSync(join(dir, 'auth-token'), 'tok\n')
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-ws-'))
  if (instructions) {
    mkdirSync(join(workspace, '.keep'), { recursive: true })
    writeFileSync(join(workspace, 'AGENTS.md'), '<!-- ai-memory:start -->\nrules\n<!-- ai-memory:end -->\n')
  }
  const routes = new Map()
  const ctx = {
    get: (name) => {
      if (name === 'configEditor') return editor ?? undefined
      if (name === 'tools') return { definitions: () => (mcp ? [{ name: 'mcp__ai-memory__memory_status' }] : []) }
      if (name === 'workingDirectory') return { defaultDirectory: workspace }
      return undefined
    },
    on: () => () => {},
    logger: { info() {}, warn() {}, debug() {} },
    fiber: { entry: { id: 'ai-memory-sync', config: { serverUrl: baseUrl, capturePrompt: false } } },
    inject: (deps, callback) => {
      if (!connection) return
      callback({
        get: (name) => (name === 'connection'
          ? { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
          : ctx.get(name)),
        effect: (fn) => fn(),
      })
    },
  }
  const dispose = apply(ctx, { serverUrl: baseUrl, dataDir: dir, timeoutMs: 1000, ...overrides })
  return { routes, dispose, ctx, workspace }
}

const request = (body) => ({ json: async () => body })

test('the Host registers the panel routes', async () => {
  const server = fakeAiMemory()
  const h = harness(await server.url())

  assert.deepEqual([...h.routes.keys()].sort(), [
    '/api/dsh-ai-memory/install-instructions',
    '/api/dsh-ai-memory/overview',
    '/api/dsh-ai-memory/search',
    '/api/dsh-ai-memory/settings',
  ])
  for (const route of h.routes.values()) assert.deepEqual(route.methods, ['POST'])

  h.dispose()
  await server.close()
})

test('overview returns health, scope, projects, briefing, agents and page agents', async () => {
  const server = fakeAiMemory()
  const h = harness(await server.url())

  const body = await (await h.routes.get('/api/dsh-ai-memory/overview').fetch(request({}))).json()

  assert.equal(body.ok, true)
  assert.equal(body.server.status, 'ok')
  assert.equal(body.server.version, '3.0.0')
  assert.equal(body.server.providers.llm, 'disabled')
  assert.equal(body.server.ingest.dropped, 2)
  assert.equal(body.current.project, 'acme-api')
  assert.deepEqual(body.projects.map((entry) => entry.project), ['acme-api'])
  assert.equal(body.briefing.handoffs, 1)
  assert.deepEqual(body.agents.map((entry) => entry.agent), ['claude-code', 'other'])
  assert.equal(body.pageAgents['notes/a.md'], 'claude-code')
  assert.equal(body.setup.token, true)
  assert.equal(body.setup.reachable, true)
  assert.equal(body.setup.mcp, true)
  assert.equal(body.setup.ready, true)

  h.dispose()
  await server.close()
})

test('search scopes by project and keeps the owning project on each hit', async () => {
  const server = fakeAiMemory()
  const h = harness(await server.url())
  const search = h.routes.get('/api/dsh-ai-memory/search')

  const scoped = await (await search.fetch(request({ q: 'cache', workspace: 'default', project: 'acme-api' }))).json()
  assert.equal(scoped.hits.length, 1)
  assert.equal(scoped.hits[0].snippet, 'about cache')
  assert.equal(scoped.hits[0].project, 'acme-api')
  assert.equal(server.calls.at(-1).project, 'acme-api')

  await (await search.fetch(request({ q: 'cache', global: true }))).json()
  assert.equal(server.calls.at(-1).project, null)

  const empty = await (await search.fetch(request({ q: '   ' }))).json()
  assert.deepEqual(empty.hits, [])

  h.dispose()
  await server.close()
})

test('settings reads the row config and refuses to save without an editor', async () => {
  const server = fakeAiMemory()
  const h = harness(await server.url())
  const settings = h.routes.get('/api/dsh-ai-memory/settings')

  const read = await (await settings.fetch(request({}))).json()
  assert.equal(read.entryId, 'ai-memory-sync')
  assert.equal(read.config.capturePrompt, false)
  // The form shows effective values: defaults must be merged in, not only the
  // explicit row config.
  assert.equal(read.config.captureTools, true)
  assert.equal(read.config.maxToolChars, 2000)
  assert.equal(read.config.announceScope, true)
  assert.equal(read.editable, false)

  const save = await (await settings.fetch(request({ patch: { capturePrompt: true } }))).json()
  assert.equal(save.ok, false)

  h.dispose()
  await server.close()
})

test('settings saves through the config editor after validation', async () => {
  const server = fakeAiMemory()
  const edits = []
  const editor = {
    edit: async (entry, change) => { edits.push(change(entry.config)) },
  }
  const h = harness(await server.url(), { editor })
  const settings = h.routes.get('/api/dsh-ai-memory/settings')

  const ok = await (await settings.fetch(request({ patch: { capturePrompt: true, timeoutMs: 5000 } }))).json()
  assert.equal(ok.ok, true)
  assert.equal(edits.length, 1)
  assert.equal(edits[0].capturePrompt, true)
  assert.equal(edits[0].timeoutMs, 5000)

  const bad = await (await settings.fetch(request({ patch: { timeoutMs: 5 } }))).json()
  assert.equal(bad.ok, false)
  assert.equal(edits.length, 1)

  h.dispose()
  await server.close()
})

test('a broken server is reported, not thrown', async () => {
  const server = fakeAiMemory()
  const h = harness(await server.url())
  await server.close()

  const body = await (await h.routes.get('/api/dsh-ai-memory/overview').fetch(request({}))).json()
  assert.equal(body.ok, true)
  assert.equal(body.server.status, 'unknown')
  assert.equal(body.current, null)
  assert.deepEqual(body.projects, [])
  assert.deepEqual(body.agents, [])

  h.dispose()
})

test('setup reports the missing pieces of a fresh install', async () => {
  const server = fakeAiMemory()
  // Keep the check off the real home directory: ~/.agents/AGENTS.md may already
  // carry the marker on this machine.
  const missing = join(mkdtempSync(join(tmpdir(), 'dsh-ai-memory-rules-')), 'AGENTS.md')
  const h = harness(await server.url(), { mcp: false, overrides: { instructionsPath: missing } })

  const body = await (await h.routes.get('/api/dsh-ai-memory/overview').fetch(request({}))).json()
  assert.equal(body.setup.mcp, false)
  assert.equal(body.setup.instructions, false)
  assert.equal(body.setup.ready, true)
  assert.ok(body.setup.instructionFiles.some((path) => path.endsWith('AGENTS.md')))

  h.dispose()
  await server.close()
})

test('setup finds the marker when the rules file was written', async () => {
  const server = fakeAiMemory()
  const h = harness(await server.url(), { instructions: true })

  const body = await (await h.routes.get('/api/dsh-ai-memory/overview').fetch(request({}))).json()
  assert.equal(body.setup.instructions, true)

  h.dispose()
  await server.close()
})

test('setup reports a broken server as not ready', async () => {
  const server = fakeAiMemory()
  const h = harness(await server.url())
  await server.close()

  const body = await (await h.routes.get('/api/dsh-ai-memory/overview').fetch(request({}))).json()
  assert.equal(body.setup.reachable, false)
  assert.equal(body.setup.ready, false)

  h.dispose()
})

test('the install route appends the marker block without touching the rest', async () => {
  const server = fakeAiMemory()
  const target = join(mkdtempSync(join(tmpdir(), 'dsh-ai-memory-rules-')), 'AGENTS.md')
  writeFileSync(target, '# House rules\n\nbe nice\n')
  const h = harness(await server.url(), { overrides: { instructionsPath: target } })
  const route = h.routes.get('/api/dsh-ai-memory/install-instructions')

  const first = await (await route.fetch(request({}))).json()
  assert.equal(first.ok, true)
  assert.equal(first.replaced, false)
  assert.equal(first.path, target)

  const text = readFileSync(target, 'utf8')
  assert.match(text, /^# House rules/)
  assert.match(text, /be nice/)
  assert.equal(text.split('<!-- ai-memory:start -->').length, 2)

  const second = await (await route.fetch(request({}))).json()
  assert.equal(second.ok, true)
  assert.equal(second.replaced, true)
  const again = readFileSync(target, 'utf8')
  assert.equal(again.split('<!-- ai-memory:start -->').length, 2, 'still one block')

  h.dispose()
  await server.close()
})

test('the install route refuses an unbalanced marker pair', async () => {
  const server = fakeAiMemory()
  const target = join(mkdtempSync(join(tmpdir(), 'dsh-ai-memory-rules-')), 'AGENTS.md')
  writeFileSync(target, '<!-- ai-memory:start -->\nno end\n')
  const h = harness(await server.url(), { overrides: { instructionsPath: target } })

  const body = await (await h.routes.get('/api/dsh-ai-memory/install-instructions').fetch(request({}))).json()
  assert.equal(body.ok, false)
  assert.match(body.error, /unbalanced/)
  assert.match(readFileSync(target, 'utf8'), /no end/, 'file untouched')

  h.dispose()
  await server.close()
})

test('the install check follows the configured rules file', async () => {
  const server = fakeAiMemory()
  const target = join(mkdtempSync(join(tmpdir(), 'dsh-ai-memory-rules-')), 'AGENTS.md')
  writeFileSync(target, '<!-- ai-memory:start -->\nrules\n<!-- ai-memory:end -->\n')
  const h = harness(await server.url(), { overrides: { instructionsPath: target } })

  const body = await (await h.routes.get('/api/dsh-ai-memory/overview').fetch(request({}))).json()
  assert.equal(body.setup.instructions, true)
  assert.deepEqual(body.setup.instructionFiles, [target])

  h.dispose()
  await server.close()
})

test('without a connection service no route is registered at all', async () => {
  const server = fakeAiMemory()
  const h = harness(await server.url(), { connection: false })

  assert.equal(h.routes.size, 0, 'fail closed: no endpoint to reach unauthenticated')

  h.dispose()
  await server.close()
})

const sessionPages = (count) => Array.from({ length: count }, (_, index) => ({
  path: `sessions/10000000-0000-4000-8000-${String(index).padStart(12, '0')}.md`,
  title: `Session ${index}`,
  kind: 'session',
}))
const sessionIdOf = (page) => page.path.slice('sessions/'.length, -'.md'.length)

test('every visible session page gets its agent, not just the first eight', async () => {
  const pages = sessionPages(12)
  const recentSessions = pages.slice(0, 10).map((page, index) => ({
    session_id: sessionIdOf(page),
    agent_kind: index === 9 ? 'kimi-code' : 'pi',
  }))
  const server = fakeAiMemory({ briefing: { ...BRIEFING, recent_pages: pages, recent_sessions: recentSessions } })
  const h = harness(await server.url())

  const body = await (await h.routes.get('/api/dsh-ai-memory/overview').fetch(request({}))).json()

  assert.equal(Object.keys(body.pageAgents).length, 12)
  assert.equal(body.pageAgents[pages[7].path], 'pi')
  assert.equal(body.pageAgents[pages[9].path], 'kimi-code')
  // Only the two sessions missing from recent_sessions need a frontmatter read.
  assert.deepEqual(server.readPageCalls.sort(), [pages[10].path, pages[11].path].sort())

  const briefCall = server.calls.find((call) => call?.params?.name === 'memory_briefing')
  assert.equal(briefCall.params.arguments.recent_sessions_limit, 50)

  h.dispose()
  await server.close()
})

test('ai-memory 3.0.0 without recent_sessions still labels every visible page', async () => {
  const pages = sessionPages(12)
  const server = fakeAiMemory({ briefing: { ...BRIEFING, recent_pages: pages } })
  const h = harness(await server.url())

  const body = await (await h.routes.get('/api/dsh-ai-memory/overview').fetch(request({}))).json()

  assert.equal(server.readPageCalls.length, 12)
  assert.equal(body.pageAgents[pages[11].path], 'claude-code')

  h.dispose()
  await server.close()
})
