import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'

const STATUS = {
  counts: { pages_latest: 3, sessions: 4, observations: 5, evidence_rows: 0 },
  scope: { workspace: 'default', project: 'acme-api', resolved_by: 'shared_slot' },
}
const RECENT = { hits: [{ path: 'notes/a.md', title: 'A note' }] }

function fakeAiMemory() {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')
      return
    }
    if (request.method === 'POST' && request.url === '/mcp') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        const call = JSON.parse(body)
        const value = call.params.name === 'memory_status' ? STATUS : RECENT
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
  let registration
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    logger: { info() {}, warn() {}, debug() {} },
    inject(deps, callback) {
      callback({
        get: (name) => (name === 'connection'
          ? { fetch: { register: (route) => { registration = route; return () => {} } } }
          : undefined),
        effect: (fn) => fn(),
      })
    },
  }
  const dispose = apply(ctx, { serverUrl: baseUrl, dataDir: dir, timeoutMs: 1000 })
  return { registration: () => registration, dispose }
}

test('the Host registers one read-only overview route', async () => {
  const server = fakeAiMemory()
  const baseUrl = await server.url()
  const h = harness(baseUrl)

  const route = h.registration()
  assert.ok(route, 'route registered')
  assert.equal(route.path, '/api/dsh-ai-memory/overview')
  assert.deepEqual(route.methods, ['POST'])

  const response = await route.fetch()
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.server.status, 'ok')
  assert.equal(body.scope.project, 'acme-api')
  assert.equal(body.counts.sessions, 4)
  assert.equal(body.recent.length, 1)
  assert.equal(body.recent[0].path, 'notes/a.md')

  h.dispose()
  await server.close()
})

test('the overview route reports a failure instead of throwing', async () => {
  const server = fakeAiMemory()
  const baseUrl = await server.url()
  const h = harness(baseUrl)
  const route = h.registration()
  await server.close()

  const response = await route.fetch()
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(typeof body.error, 'string')

  h.dispose()
})
