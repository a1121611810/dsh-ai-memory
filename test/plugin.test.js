import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'

function harness({ token = 'tok', ensureCwd = '/repo', roots = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-'))
  if (token !== null) writeFileSync(join(dir, 'auth-token'), `${token}\n`)
  const received = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')
      return
    }
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
      if (name === 'workingDirectory') {
        return { get: () => '/repo', ensure: async () => ensureCwd }
      }
      if (name === 'agents') return roots === null ? undefined : { roots: () => roots }
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
  assert.match(h.received[0].url, /\/hook\?event=session-start&agent=dsh$/)
  assert.equal(h.received[0].authorization, 'Bearer tok')
  assert.deepEqual(h.received[0].body, {
    session_id: 'session-1',
    transcript_path: '',
    cwd: '/repo',
    hook_event_name: 'SessionStart',
    source: 'startup',
  })
  assert.match(h.received[1].url, /\/hook\?event=session-end&agent=dsh$/)
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

const openSession = (h) => h.handlers.get('session/created')({ id: 'session-x' })

test('prompts stay off by default', async () => {
  const h = harness()
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })
  openSession(h)
  h.handlers.get('agent/inbox/claimed')({
    agent: { id: 'session-x' },
    message: { id: 'm1', content: [{ type: 'text', text: 'secret plan' }] },
  })
  await flush()
  assert.equal(h.received.filter((entry) => entry.url.includes('user-prompt')).length, 0)
  await h.close()
})

test('capturePrompt forwards the prompt text once per message', async () => {
  const h = harness()
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500, capturePrompt: true })
  openSession(h)
  const claimed = { agent: { id: 'session-x' }, message: { id: 'm1', content: [{ type: 'text', text: 'hello there' }] } }
  h.handlers.get('agent/inbox/claimed')(claimed)
  h.handlers.get('agent/inbox/claimed')(claimed)
  await flush()

  const prompts = h.received.filter((entry) => entry.url.includes('user-prompt'))
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].body.prompt, 'hello there')
  assert.equal(prompts[0].body.hook_event_name, 'UserPromptSubmit')
  await h.close()
})

test('tool results are forwarded with a clipped body', async () => {
  const h = harness()
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500, maxToolChars: 40 })
  openSession(h)
  h.handlers.get('tools/result')(
    { agent: { id: 'session-x' }, name: 'bash', arguments: { command: 'echo hello' } },
    { isError: false, content: [{ type: 'text', text: 'x'.repeat(60) }] },
  )
  await flush()

  const tool = h.received.find((entry) => entry.url.includes('post-tool-use'))
  assert.ok(tool)
  assert.equal(tool.body.tool_name, 'bash')
  assert.deepEqual(tool.body.tool_input, { command: 'echo hello' })
  assert.equal(tool.body.tool_response.text, 'x'.repeat(40))
  assert.equal(tool.body.tool_response.text_truncated, true)
  await h.close()
})

test('turn stopping is forwarded as a stop event', async () => {
  const h = harness()
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })
  openSession(h)
  h.handlers.get('agent/turn-stopping')({ agent: { id: 'session-x' }, turn: 1 })
  await flush()

  const stop = h.received.find((entry) => entry.url.includes('event=stop'))
  assert.ok(stop)
  assert.equal(stop.body.hook_event_name, 'Stop')
  await h.close()
})

function promptHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-prompt-'))
  writeFileSync(join(dir, 'auth-token'), 'tok\n')
  const captured = { sections: [] }
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    logger: { info() {}, warn() {}, debug() {} },
    inject(deps, callback) {
      if (!deps.includes('systemPrompt')) return
      callback({
        get: (name) => (name === 'systemPrompt'
          ? {
            section: (section) => { captured.sections.push(section); return () => {} },
            getSectionOrder: () => 100,
          }
          : undefined),
        effect: (fn) => fn(),
      })
    },
  }
  return { dir, ctx, captured }
}

test('the Host publishes a memory-scope note at session start', () => {
  const h = promptHarness()
  apply(h.ctx, { serverUrl: 'http://127.0.0.1:1', dataDir: h.dir })
  assert.equal(h.captured.sections.length, 1)
  const [section] = h.captured.sections
  assert.equal(section.name, 'dsh-ai-memory:scope')
  assert.equal(section.order, 600)
  assert.match(section.text, /global: true/)
  assert.match(section.text, /filed per project/)
})

test('announceScope: false suppresses the note', () => {
  const h = promptHarness()
  apply(h.ctx, { serverUrl: 'http://127.0.0.1:1', dataDir: h.dir, announceScope: false })
  assert.equal(h.captured.sections.length, 0)
})

test('a resumed agent opens the session when creation never announced it', async () => {
  const h = harness()
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })

  h.handlers.get('agent/created')({ agent: { id: 'session-resume' }, source: 'resume' })
  await flush()

  const starts = h.received.filter((entry) => entry.url.includes('session-start'))
  assert.equal(starts.length, 1)
  assert.equal(starts[0].body.session_id, 'session-resume')
  assert.equal(starts[0].body.cwd, '/repo')
  await h.close()
})

test('compaction is not a new session, and subagents are skipped', async () => {
  const h = harness({ roots: [{ id: 'session-root' }] })
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })

  h.handlers.get('agent/created')({ agent: { id: 'session-root' }, source: 'compact' })
  h.handlers.get('agent/created')({ agent: { id: 'session-child' }, source: 'startup' })
  await flush()

  assert.equal(h.received.length, 0)
  await h.close()
})

test('a durability flush registers a session that no creation seam reached', async () => {
  const h = harness()
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })

  h.handlers.get('session/flush')({ id: 'session-flushed' })
  h.handlers.get('session/flush')({ id: 'session-flushed' })
  await flush()

  const starts = h.received.filter((entry) => entry.url.includes('session-start'))
  assert.equal(starts.length, 1)
  assert.equal(starts[0].body.cwd, '/repo')
  await h.close()
})
