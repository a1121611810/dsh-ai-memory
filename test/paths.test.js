import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { normalizeBaseUrl, readToken, resolveDataDir } from '../lib/paths.js'

test('resolveDataDir follows the platform default', () => {
  assert.equal(
    resolveDataDir({}, 'darwin', '/Users/me'),
    '/Users/me/Library/Application Support/ai-memory',
  )
  assert.equal(resolveDataDir({}, 'linux', '/home/me'), '/home/me/.local/share/ai-memory')
  assert.equal(
    resolveDataDir({ XDG_DATA_HOME: '/xdg' }, 'linux', '/home/me'),
    '/xdg/ai-memory',
  )
  // join() follows the host separator, so the assertion does too.
  assert.equal(
    resolveDataDir({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', 'C:\\Users\\me'),
    join('C:\\Users\\me\\AppData\\Local', 'ai-memory'),
  )
})

test('resolveDataDir prefers AI_MEMORY_DATA_DIR', () => {
  assert.equal(resolveDataDir({ AI_MEMORY_DATA_DIR: '/custom' }, 'darwin', '/Users/me'), '/custom')
  assert.equal(resolveDataDir({ AI_MEMORY_DATA_DIR: '   ' }, 'darwin', '/Users/me'), '/Users/me/Library/Application Support/ai-memory')
})

test('readToken trims the file and tolerates a missing one', () => {
  const seen = []
  const token = readToken('/data', (path, encoding) => {
    seen.push([path, encoding])
    return '  secret-token\n'
  })
  assert.equal(token, 'secret-token')
  assert.deepEqual(seen, [['/data/auth-token', 'utf8']])

  assert.equal(readToken('/data', () => { throw new Error('ENOENT') }), null)
  assert.equal(readToken('/data', () => '   \n'), null)
})

test('normalizeBaseUrl accepts loopback and strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:49374'), 'http://127.0.0.1:49374')
  assert.equal(normalizeBaseUrl('http://127.0.0.1:49374/'), 'http://127.0.0.1:49374')
  assert.equal(normalizeBaseUrl('http://localhost:49374/mcp/'), 'http://localhost:49374/mcp')
  assert.equal(normalizeBaseUrl('http://[::1]:49374'), 'http://[::1]:49374')
  assert.equal(normalizeBaseUrl('https://127.0.0.1:49374'), 'https://127.0.0.1:49374')
})

test('normalizeBaseUrl refuses remote hosts unless allowed, and never in plaintext', () => {
  assert.throws(() => normalizeBaseUrl('http://10.0.0.5:49374'), /non-loopback/)
  assert.throws(() => normalizeBaseUrl('https://memory.example.com'), /non-loopback/)
  assert.throws(
    () => normalizeBaseUrl('http://memory.example.com', { allowRemote: true }),
    /must use https/,
  )
  assert.equal(
    normalizeBaseUrl('https://memory.example.com/', { allowRemote: true }),
    'https://memory.example.com',
  )
})

test('normalizeBaseUrl rejects malformed input', () => {
  assert.throws(() => normalizeBaseUrl('not a url'), /not a valid URL/)
  assert.throws(() => normalizeBaseUrl('ftp://127.0.0.1'), /http or https/)
})
