import { describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const generator = fileURLToPath(new URL('../../scripts/generate-build-metadata.ts', import.meta.url))
const outsideContents = 'External metadata must not be rewritten.\n'
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('GIT_') && key !== 'WIKI_BUILD_REVISION' && key !== 'WIKI_BUILD_DATE' && key !== 'SOURCE_DATE_EPOCH'
))
environment.GIT_CONFIG_NOSYSTEM = '1'
environment.GIT_CONFIG_GLOBAL = devNull

function withFixture(run: (root: string, outside: string, revision: string) => void): void {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'tsepistle-build-metadata-'))
  try {
    const root = path.join(directory, 'repo')
    const external = path.join(directory, 'external')
    fs.mkdirSync(root)
    fs.mkdirSync(external)
    fs.mkdirSync(path.join(root, 'server'))
    fs.writeFileSync(path.join(root, '.gitignore'), 'server\n')
    fs.writeFileSync(path.join(root, 'input'), 'Committed build input.\n')
    const outside = path.join(external, '.build-metadata.json')
    fs.writeFileSync(outside, outsideContents)
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: environment }).trim()
    git('init', '--quiet')
    git('config', 'user.name', 'Build metadata test')
    git('config', 'user.email', 'build@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('add', '.gitignore', 'input')
    git('commit', '--quiet', '-m', 'Build fixture')
    run(root, outside, git('rev-parse', 'HEAD'))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function generate(root: string) {
  return spawnSync(process.execPath, [generator], { cwd: root, env: environment, encoding: 'utf8', timeout: 10_000 })
}

describe('build metadata output boundaries', () => {
  test('refuses a symlinked output without modifying its target', () => {
    withFixture((root, outside) => {
      fs.symlinkSync(outside, path.join(root, 'server', '.build-metadata.json'))
      const result = generate(root)
      expect(result.status).toBe(1)
      expect(fs.readFileSync(outside, 'utf8')).toBe(outsideContents)
    })
  })

  test('refuses an escaped server directory without writing outside the repository', () => {
    withFixture((root, outside) => {
      fs.rmdirSync(path.join(root, 'server'))
      fs.symlinkSync(path.dirname(outside), path.join(root, 'server'), 'dir')
      const result = generate(root)
      expect(result.status).toBe(1)
      expect(fs.readFileSync(outside, 'utf8')).toBe(outsideContents)
    })
  })

  test('replaces hard-linked output without changing its other link', () => {
    withFixture((root, outside, revision) => {
      const output = path.join(root, 'server', '.build-metadata.json')
      fs.linkSync(outside, output)
      const result = generate(root)
      expect(result.status).toBe(0)
      expect(fs.readFileSync(outside, 'utf8')).toBe(outsideContents)
      expect(JSON.parse(fs.readFileSync(output, 'utf8')).revision).toBe(revision)
    })
  })
})
