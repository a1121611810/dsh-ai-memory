import assert from 'node:assert/strict'
import { test } from 'node:test'

import { REDACTED, redactDeep, redactSecrets } from '../lib/redact.js'

test('redacts common credential shapes', () => {
  assert.equal(redactSecrets('key sk-abcdefghijklmnop1234567890 done'), `key ${REDACTED} done`)
  assert.equal(redactSecrets('token ghp_abcdefghijklmnopqrstuvwxyz0123456789'), `token ${REDACTED}`)
  assert.equal(redactSecrets('aws AKIAIOSFODNN7EXAMPLE'), `aws ${REDACTED}`)
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), `Authorization: ${REDACTED}`)
  assert.match(
    redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----'),
    /^\[redacted\]$/,
  )
})

test('leaves ordinary text alone', () => {
  const text = 'const token = readToken(dataDir)'
  assert.equal(redactSecrets(text), text)
  assert.equal(redactSecrets(''), '')
  assert.equal(redactSecrets(undefined), undefined)
})

test('redactDeep walks nested structures', () => {
  const input = {
    command: 'export KEY=sk-abcdefghijklmnop1234567890',
    nested: [{ note: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }],
    count: 2,
    flag: true,
    missing: null,
  }
  const output = redactDeep(input)
  assert.match(output.command, /\[redacted\]/)
  assert.match(output.nested[0].note, /^\[redacted\]$/)
  assert.equal(output.count, 2)
  assert.equal(output.flag, true)
  assert.equal(output.missing, null)
  assert.match(input.command, /sk-/, 'the input is not mutated')
})
