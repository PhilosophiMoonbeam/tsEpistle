import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from '../bun-test.mts'

const runner = fileURLToPath(new URL('../../scripts/run-local-ci.ts', import.meta.url))
const resources = fileURLToPath(new URL('../../scripts/local-ci-resources.ts', import.meta.url))

describe('local CI resource option admission', () => {
  it.each([
    { args: ['--browser-jobs=2'], option: '--browser-jobs' },
    { args: ['--browser-jobs=0'], option: '--browser-jobs' },
    { args: ['--test-jobs=5'], option: '--test-jobs' },
    { args: ['--test-jobs=0'], option: '--test-jobs' },
    { args: ['--test-jobs', '2x'], option: '--test-jobs' },
    { args: ['--browser-jobs', '1', '--browser-jobs', '1'], option: '--browser-jobs' }
  ])('rejects unsafe or ambiguous resource options before preparing a run: $args', ({ args, option }) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tsepistle-ci-options-'))
    try {
      // No external tools are reachable if argument validation regresses: a
      // negative test must never launch Docker or a real qualification run.
      const result = spawnSync(process.execPath, ['--no-env-file', runner, ...args], {
        encoding: 'utf8',
        env: { PATH: '', HOME: directory, XDG_STATE_HOME: directory }
      })
      expect(result.signal).toBeNull()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(option)
      expect(existsSync(path.join(directory, 'tsepistle-ci'))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects an excessive combined phase allocation before ownership lookup or command execution', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tsepistle-ci-budget-'))
    try {
      const result = spawnSync(
        process.execPath,
        ['--no-env-file', resources, 'run', '--name', 'oversized', '--host-gib', '8', '--docker-gib', '2', '--', 'unreachable'],
        { encoding: 'utf8', env: { PATH: '', HOME: directory, XDG_STATE_HOME: directory } }
      )
      expect(result.signal).toBeNull()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('combined host/Docker allocation must not exceed 9 GiB')
      expect(existsSync(path.join(directory, 'tsepistle-ci'))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
