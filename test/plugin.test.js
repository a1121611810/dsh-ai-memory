import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'

function harness({ token = 'tok', ensureCwd = '/repo', roots = null, version = '3.0.0' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-'))
  if (token !== null) writeFileSync(join(dir, 'auth-token'), `${token}\n`)
  const received = []
  const state = { version, probes: 0 }
  const logs = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      if (String(request.url).startsWith('/admin/status')) state.probes += 1
      const payload = String(request.url).startsWith('/admin/status') ? { version: state.version } : { status: 'ok' }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
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
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      debug: (message) => logs.push(['debug', message]),
    },
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
  return { dir, handlers, ctx, url, close, received, state, logs }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 50))

// Capture is async (version probe + POST), so wait for the events instead of
// guessing a delay: a loaded machine made the fixed sleeps flaky.
const settle = async (h, count) => {
  for (let attempt = 0; attempt < 100 && h.received.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(h.received.length >= count, `expected ${count} events, got ${h.received.length}`)
}

test('apply forwards session start and end with the real session identity', async () => {
  const h = harness()
  const baseUrl = await h.url()
  const dispose = apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })

  h.handlers.get('session/created')({ id: 'session-1' })
  await settle(h, 1)
  h.handlers.get('session/disposed')({ id: 'session-1' })
  await settle(h, 2)

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
  await settle(h, 2)

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
  await settle(h, 2)

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
  await settle(h, 2)

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
  await settle(h, 2)

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
  // DSH's MCP client forwards no session id, so unscoped calls hit the shared
  // slot; the note has to tell the model to pass the scope itself.
  assert.match(section.text, /no session id/)
  assert.match(section.text, /`workspace` and `project` together/)
  assert.match(section.text, /\.ai-memory\.toml/)
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
  await settle(h, 1)

  const starts = h.received.filter((entry) => entry.url.includes('session-start'))
  assert.equal(starts.length, 1)
  assert.equal(starts[0].body.session_id, 'session-resume')
  assert.equal(starts[0].body.cwd, '/repo')
  await h.close()
})

test('compaction is not a new session', async () => {
  const h = harness()
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })

  h.handlers.get('agent/created')({ agent: { id: 'session-root' }, source: 'compact' })
  await flush()

  assert.equal(h.received.length, 0)
  await h.close()
})

test('any agent activity opens a session that the creation seams missed', async () => {
  const h = harness()
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })

  h.handlers.get('agent/turn-stopping')({ agent: { id: 'session-late' }, turn: 1 })
  await settle(h, 2)

  // Both are enqueued at once, so arrival order is the transport's, not ours.
  assert.equal(h.received.length, 2)
  assert.equal(h.received.filter((entry) => entry.url.includes('event=session-start')).length, 1)
  assert.equal(h.received.filter((entry) => entry.url.includes('event=stop')).length, 1)
  await h.close()
})

test('a durability flush registers a session that no creation seam reached', async () => {
  const h = harness()
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })

  h.handlers.get('session/flush')({ id: 'session-flushed' })
  h.handlers.get('session/flush')({ id: 'session-flushed' })
  await settle(h, 1)

  const starts = h.received.filter((entry) => entry.url.includes('session-start'))
  assert.equal(starts.length, 1)
  assert.equal(starts[0].body.cwd, '/repo')
  await h.close()
})

test('ai-memory 3.2.0 and newer record the dsh agent label', async () => {
  const h = harness({ version: '3.4.2' })
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })

  h.handlers.get('session/created')({ id: 'session-dsh' })
  await settle(h, 1)

  assert.equal(h.state.probes, 1)
  assert.match(h.received[0].url, /event=session-start&agent=dsh$/)
  await h.close()
})

test('ai-memory 3.0.0 keeps the claude-code label', async () => {
  const h = harness({ version: '3.0.0' })
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })

  h.handlers.get('session/created')({ id: 'session-old' })
  await settle(h, 1)

  assert.match(h.received[0].url, /event=session-start&agent=claude-code$/)
  await h.close()
})

test('an explicit agent skips version detection', async () => {
  const h = harness({ version: '3.4.2' })
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500, agent: 'pi' })

  h.handlers.get('session/created')({ id: 'session-fixed' })
  await settle(h, 1)

  assert.equal(h.state.probes, 0)
  assert.match(h.received[0].url, /event=session-start&agent=pi$/)
  await h.close()
})

test('a mid-session version change does not relabel the session', async () => {
  const h = harness({ version: '3.4.2' })
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })

  h.handlers.get('session/created')({ id: 'session-pinned' })
  await settle(h, 1)
  h.state.version = '3.0.0'
  h.handlers.get('session/disposed')({ id: 'session-pinned' })
  await settle(h, 2)

  assert.equal(h.state.probes, 1)
  for (const entry of h.received) assert.match(entry.url, /agent=dsh$/)
  await h.close()
})

test('a server older than 3.0.0 is reported once and still captured', async () => {
  const h = harness({ version: '2.9.0' })
  const baseUrl = await h.url()
  apply(h.ctx, { serverUrl: baseUrl, dataDir: h.dir, timeoutMs: 500 })

  h.handlers.get('session/created')({ id: 'session-ancient' })
  await settle(h, 1)

  assert.match(h.received[0].url, /agent=claude-code$/)
  assert.ok(h.logs.some(([level, message]) => level === 'warn' && message.includes('older than the supported 3.0.0')))
  await h.close()
})
