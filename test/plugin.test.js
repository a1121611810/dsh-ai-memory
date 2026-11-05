import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'

function harness({ token = 'tok' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-'))
  if (token !== null) writeFileSync(join(dir, 'auth-token'), `${token}\n`)
  const received = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      received.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(body),
      })
      response.writeHead(202).end('queued')
    })
  })
  const handlers = new Map()
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return { get: () => '/repo' }
      return undefined
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    logger: { info() {}, warn() {}, debug() {} },
  }
  const ready = new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      server.unref()
      resolve()
    })
  })
  const url = async () => {
    await ready
    const address = server.address()
    return `http://127.0.0.1:${address.port}`
  }
  const close = () => new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(resolve)
  })
  return { dir, handlers, ctx, url, close, received }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 50))

test('apply forwards session start and end with the real session identity', async () => {
  const h = harness()
  const baseUrl = await h.url()
  const dispose = apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })

  h.handlers.get('session/created')({ id: 'session-1' })
  await flush()
  h.handlers.get('session/disposed')({ id: 'session-1' })
  await flush()

  assert.equal(h.received.length, 2)
  assert.match(h.received[0].url, /\/hook\?event=session-start&agent=claude-code$/)
  assert.equal(h.received[0].authorization, 'Bearer tok')
  assert.deepEqual(h.received[0].body, {
    session_id: 'session-1',
    transcript_path: '',
    cwd: '/repo',
    hook_event_name: 'SessionStart',
    source: 'startup',
  })
  assert.match(h.received[1].url, /\/hook\?event=session-end&agent=claude-code$/)
  assert.deepEqual(h.received[1].body, {
    session_id: 'session-1',
    transcript_path: '',
    cwd: '/repo',
    hook_event_name: 'SessionEnd',
    reason: 'other',
  })

  dispose()
  await h.close()
})

test('agent disposal closes a session exactly once, even after session disposal', async () => {
  const h = harness()
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })

  h.handlers.get('session/created')({ id: 'session-2' })
  await flush()
  h.handlers.get('session/disposed')({ id: 'session-2' })
  h.handlers.get('agent/disposed')({ agent: { id: 'session-2' } })
  await flush()

  const ends = h.received.filter((entry) => entry.url.includes('session-end'))
  assert.equal(ends.length, 1)
  await h.close()
})

test('a session without a working directory is skipped instead of guessed', async () => {
  const h = harness()
  const baseUrl = await h.url()
  h.ctx.get = () => undefined
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })

  h.handlers.get('session/created')({ id: 'session-3' })
  await flush()

  assert.equal(h.received.length, 0)
  await h.close()
})

test('an unreachable server never throws out of apply or its handlers', async () => {
  const h = harness({ token: null })
  const dispose = apply(h.ctx, { serverUrl: 'http://127.0.0.1:1', dataDir: h.dir, timeoutMs: 100 })
  h.handlers.get('session/created')({ id: 'session-4' })
  h.handlers.get('session/disposed')({ id: 'session-4' })
  await flush()
  dispose()
  assert.ok(true)
})

test('a non-loopback server without allowRemote disables the plugin', async () => {
  const h = harness()
  await h.url()
  const handlers = new Map()
  const ctx = { ...h.ctx, on: (event, handler) => { handlers.set(event, handler); return () => {} } }
  apply(ctx, { serverUrl: 'http://10.1.2.3:49374', dataDir: h.dir })
  assert.equal(handlers.size, 0)
  await h.close()
})
