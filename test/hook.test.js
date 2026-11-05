import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildHookPayload, hookUrl, postHook } from '../lib/hook.js'

const id = 'session-abc'
const cwd = '/repo'

test('buildHookPayload emits Claude-shaped envelopes', () => {
  assert.deepEqual(buildHookPayload('session-start', { sessionId: id, cwd }), {
    session_id: id,
    transcript_path: '',
    cwd,
    hook_event_name: 'SessionStart',
    source: 'startup',
  })
  assert.deepEqual(buildHookPayload('session-end', { sessionId: id, cwd }), {
    session_id: id,
    transcript_path: '',
    cwd,
    hook_event_name: 'SessionEnd',
    reason: 'other',
  })
  assert.equal(buildHookPayload('stop', { sessionId: id, cwd }).hook_event_name, 'Stop')
  assert.equal(buildHookPayload('user-prompt', { sessionId: id, cwd }).hook_event_name, 'UserPromptSubmit')
  assert.equal(buildHookPayload('post-tool-use', { sessionId: id, cwd }).hook_event_name, 'PostToolUse')
})

test('buildHookPayload rejects incomplete input', () => {
  assert.throws(() => buildHookPayload('session-start', { cwd }), /sessionId/)
  assert.throws(() => buildHookPayload('session-start', { sessionId: id }), /cwd/)
  assert.throws(() => buildHookPayload('nope', { sessionId: id, cwd }), /unknown event/)
})

test('hookUrl encodes both parameters', () => {
  assert.equal(
    hookUrl('http://127.0.0.1:1', 'session-start', 'claude-code'),
    'http://127.0.0.1:1/hook?event=session-start&agent=claude-code',
  )
  assert.match(hookUrl('http://127.0.0.1:1', 'session-end', 'a b'), /agent=a%20b/)
})

test('postHook sends the bearer token and payload', async () => {
  const calls = []
  const result = await postHook({
    baseUrl: 'http://127.0.0.1:9',
    token: 'tok',
    event: 'session-start',
    payload: { session_id: id },
    agent: 'claude-code',
    timeoutMs: 1000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 202, text: async () => '' }
    },
  })
  assert.deepEqual(result, { ok: true, status: 202 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:9/hook?event=session-start&agent=claude-code')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok')
  assert.equal(calls[0].init.body, JSON.stringify({ session_id: id }))
})

test('postHook omits authorization without a token', async () => {
  let headers
  await postHook({
    baseUrl: 'http://127.0.0.1:9',
    token: null,
    event: 'stop',
    payload: {},
    agent: 'claude-code',
    timeoutMs: 1000,
    fetchImpl: async (_url, init) => {
      headers = init.headers
      return { ok: true, status: 202, text: async () => '' }
    },
  })
  assert.equal(headers.authorization, undefined)
})

test('postHook never throws on failure', async () => {
  const rejected = await postHook({
    baseUrl: 'http://127.0.0.1:9',
    token: null,
    event: 'stop',
    payload: {},
    agent: 'claude-code',
    timeoutMs: 1,
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'nope' }),
  })
  assert.deepEqual(rejected, { ok: false, status: 503 })

  const thrown = await postHook({
    baseUrl: 'http://127.0.0.1:9',
    token: null,
    event: 'stop',
    payload: {},
    agent: 'claude-code',
    timeoutMs: 1,
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  assert.deepEqual(thrown, { ok: false, status: 0 })
})
