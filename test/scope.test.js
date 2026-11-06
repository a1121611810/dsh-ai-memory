import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { markerScope, projectFromRemote, remoteUrl, resolveScope } from '../lib/scope.js'

const scratch = () => mkdtempSync(join(tmpdir(), 'aim-scope-'))

const gitRepo = (root, remotes) => {
  mkdirSync(join(root, '.git'), { recursive: true })
  const body = ['[core]', '\tbare = false']
  for (const [name, url] of Object.entries(remotes)) {
    body.push('[remote "' + name + '"]', '\turl = ' + url, '\tfetch = +refs/heads/*:refs/remotes/' + name + '/*')
  }
  writeFileSync(join(root, '.git', 'config'), body.join('\n') + '\n')
}

test('a marker file names the project, and it governs nested directories', () => {
  const root = scratch()
  writeFileSync(join(root, '.ai-memory.toml'), '# pin\nworkspace = "team"\nproject = "shop"\n')
  mkdirSync(join(root, 'packages', 'app'), { recursive: true })
  assert.deepEqual(markerScope(root), { workspace: 'team', project: 'shop' })
  assert.deepEqual(resolveScope(join(root, 'packages', 'app')), { workspace: 'team', project: 'shop' })
})

test('a marker without workspace still names the project', () => {
  const root = scratch()
  writeFileSync(join(root, '.ai-memory.toml'), 'project = "shop"\n')
  assert.deepEqual(resolveScope(root), { workspace: 'default', project: 'shop' })
})

test('the marker wins over the git remote', () => {
  const root = scratch()
  gitRepo(root, { origin: 'https://github.com/acme/shop.git' })
  writeFileSync(join(root, '.ai-memory.toml'), 'project = "pinned"\n')
  assert.equal(resolveScope(root).project, 'pinned')
})

test('without a marker the git origin names the project like ai-memory', () => {
  const root = scratch()
  gitRepo(root, { origin: 'https://github.com/acme/shop.git' })
  assert.deepEqual(resolveScope(root), { workspace: 'default', project: 'acme-shop' })
})

test('upstream wins over origin', () => {
  const root = scratch()
  gitRepo(root, { origin: 'https://github.com/me/shop.git', upstream: 'https://github.com/acme/shop.git' })
  assert.equal(resolveScope(root).project, 'acme-shop')
})

test('a worktree pointer resolves through the main repository config', () => {
  const main = scratch()
  gitRepo(main, { origin: 'https://github.com/acme/shop.git' })
  mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true })
  const worktree = scratch()
  writeFileSync(join(worktree, '.git'), 'gitdir: ' + join(main, '.git', 'worktrees', 'wt') + '\n')
  assert.equal(resolveScope(worktree).project, 'acme-shop')
})

test('a repository with no remote falls back to the directory name', () => {
  const root = scratch()
  mkdirSync(join(root, '.git'))
  assert.deepEqual(resolveScope(root), { workspace: 'default', project: root.split('/').pop() })
})

test('remote forms all collapse to owner-repo', () => {
  assert.equal(projectFromRemote('https://github.com/acme/shop.git'), 'acme-shop')
  assert.equal(projectFromRemote('https://github.com/acme/shop'), 'acme-shop')
  assert.equal(projectFromRemote('git@github.com:acme/shop.git'), 'acme-shop')
  assert.equal(projectFromRemote('ssh://git@github.com/acme/shop.git'), 'acme-shop')
  assert.equal(projectFromRemote('https://gitlab.example.com/group/sub/shop.git'), 'sub-shop')
  assert.equal(projectFromRemote('/Users/me/repos/shop'), 'shop')
  assert.equal(projectFromRemote(''), null)
})

test('remoteUrl reads only the named section', () => {
  const config = '[remote "origin"]\n\turl = https://github.com/me/shop.git\n[remote "upstream"]\n\turl = https://github.com/acme/shop.git\n'
  assert.equal(remoteUrl(config, 'origin'), 'https://github.com/me/shop.git')
  assert.equal(remoteUrl(config, 'upstream'), 'https://github.com/acme/shop.git')
  assert.equal(remoteUrl(config, 'missing'), null)
})
