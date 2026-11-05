import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
  hits: [{ path: 'notes/a.md', title: 'A note', snippet: 'about <mark>cache</mark>' }],
}
const PROJECTS = [
  { workspace_name: 'default', project_name: 'acme-api', page_count: 6, last_updated: '2026-11-05T16:00:00Z' },
  { workspace_name: 'default', project_name: 'empty', page_count: 0, last_updated: '2026-11-05T15:00:00Z' },
]

function fakeAiMemory() {
  const calls = []
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')
      return
    }
    if (request.method === 'GET' && request.url === '/api/v1/projects') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(PROJECTS))
      return
    }
    if (request.method === 'POST' && request.url === '/mcp') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        const call = JSON.parse(body)
        calls.push(call)
        const value = call.params.name === 'memory_status'
          ? STATUS
          : call.params.name === 'memory_briefing'
            ? BRIEFING
            : QUERY
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0',
          id: call.id,
          result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
        }))
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
    ready,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
    url: async () => {
      await ready
      return `http://127.0.0.1:${server.address().port}`
    },
  }
}

function harness(baseUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-route-'))
  writeFileSync(join(dir, 'auth-token'), 'tok\n')
  const routes = new Map()
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    logger: { info() {}, warn() {}, debug() {} },
    inject(deps, callback) {
      callback({
        get: (name) => (name === 'connection'
          ? { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }
          : undefined),
        effect: (fn) => fn(),
      })
    },
  }
  const dispose = apply(ctx, { serverUrl: baseUrl, dataDir: dir, timeoutMs: 1000 })
  return { routes, dispose }
}

const request = (body) => ({ json: async () => body })

test('the Host registers the panel routes', async () => {
  const server = fakeAiMemory()
  const baseUrl = await server.url()
  const h = harness(baseUrl)

  assert.deepEqual([...h.routes.keys()].sort(), ['/api/dsh-ai-memory/overview', '/api/dsh-ai-memory/search'])
  for (const route of h.routes.values()) assert.deepEqual(route.methods, ['POST'])

  h.dispose()
  await server.close()
})

test('overview returns health, scope, projects and one briefing', async () => {
  const server = fakeAiMemory()
  const baseUrl = await server.url()
  const h = harness(baseUrl)

  const response = await h.routes.get('/api/dsh-ai-memory/overview').fetch(request({}))
  const body = await response.json()

  assert.equal(body.ok, true)
  assert.equal(body.server.status, 'ok')
  assert.equal(body.current.project, 'acme-api')
  assert.equal(body.counts.sessions, 21)
  assert.deepEqual(body.projects.map((entry) => entry.project), ['acme-api'])
  assert.equal(body.briefing.handoffs, 1)
  assert.equal(body.briefing.recent[0].path, 'notes/a.md')

  h.dispose()
  await server.close()
})

test('search strips snippet markup and honours the global switch', async () => {
  const server = fakeAiMemory()
  const baseUrl = await server.url()
  const h = harness(baseUrl)
  const search = h.routes.get('/api/dsh-ai-memory/search')

  const scoped = await (await search.fetch(request({ q: 'cache', workspace: 'default', project: 'acme-api' }))).json()
  assert.equal(scoped.hits.length, 1)
  assert.equal(scoped.hits[0].snippet, 'about cache')

  await (await search.fetch(request({ q: 'cache', global: true }))).json()
  const args = server.calls.at(-1).params.arguments
  assert.equal(args.global, true)
  assert.equal(args.project, undefined)

  const empty = await (await search.fetch(request({ q: '   ' }))).json()
  assert.deepEqual(empty.hits, [])

  h.dispose()
  await server.close()
})

test('a broken server is reported, not thrown', async () => {
  const server = fakeAiMemory()
  const baseUrl = await server.url()
  const h = harness(baseUrl)
  await server.close()

  const body = await (await h.routes.get('/api/dsh-ai-memory/overview').fetch(request({}))).json()
  assert.equal(body.ok, true)
  assert.equal(body.server.status, 'unknown')
  assert.equal(body.current, null)

  h.dispose()
})
