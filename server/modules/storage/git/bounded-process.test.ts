import { describe, expect, it, vi } from '../../../test/bun-test.mts'
import * as childProcess from 'node:child_process'
import { rmSync } from 'node:fs'
import * as fileSystem from 'node:fs/promises'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BoundedProcessError, observeDirectoryTree, runBoundedProcess } from './bounded-process.ts'

const runNode = (script: string, options: Partial<Parameters<typeof runBoundedProcess>[0]> = {}) =>
  runBoundedProcess({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    deadlineMs: 2_000,
    ...options
  })

describe('bounded Git process execution', () => {
  it('observes a nested tree without closing an already exhausted directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-observe-'))
    try {
      await mkdir(path.join(root, 'nested'))
      await writeFile(path.join(root, 'nested', 'page.md'), 'wiki')
      expect(await observeDirectoryTree(root, { maxEntries: 3, maxBytes: 4 })).toEqual({ entries: 2, bytes: 4 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  for (const scenario of [
    { type: 'file', removeAfterStat: 0, stage: 'before its lstat' },
    { type: 'directory', removeAfterStat: 0, stage: 'before its lstat' },
    { type: 'directory', removeAfterStat: 1, stage: 'after the parent stats it' },
    { type: 'directory', removeAfterStat: 2, stage: 'after its own lstat, before opening it' }
  ] as const) {
    it(`observes surviving bytes when a nested ${scenario.type} disappears ${scenario.stage}`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'git-observe-removed-'))
      const transient = path.join(root, 'nested', 'transient')
      await mkdir(path.dirname(transient))
      if (scenario.type === 'directory') {
        await mkdir(transient)
        await writeFile(path.join(transient, 'removed.md'), 'removed')
      } else {
        await writeFile(transient, 'removed')
      }
      await writeFile(path.join(root, 'survivor.md'), 'wiki')
      const realLstat = fileSystem.lstat
      let stats = 0
      let removed = false
      const lstatSpy = vi.spyOn(fileSystem, 'lstat').mockImplementation((async (...args: Parameters<typeof realLstat>) => {
        if (args[0] === transient) {
          stats += 1
          if (!removed && scenario.removeAfterStat === 0) {
            await rm(transient, { recursive: true })
            removed = true
          }
        }
        const result = await realLstat(...args)
        if (args[0] === transient && !removed && stats === scenario.removeAfterStat) {
          await rm(transient, { recursive: true })
          removed = true
        }
        return result
      }) as typeof realLstat)
      try {
        expect(await observeDirectoryTree(root, { maxEntries: 3, maxBytes: 4 })).toEqual({ entries: 3, bytes: 4 })
        await expect(realLstat(transient)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        lstatSpy.mockRestore()
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  it('keeps encountered but removed names inside the entry bound', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-observe-entry-bound-'))
    const transient = path.join(root, 'transient')
    try {
      await writeFile(transient, 'removed')
      await expect(
        observeDirectoryTree(root, {
          maxEntries: 0,
          maxBytes: 0,
          shouldSkip: relativePath => {
            rmSync(path.join(root, relativePath))
            return false
          }
        })
      ).rejects.toMatchObject({ kind: 'monitor', quarantine: true })
      await expect(fileSystem.lstat(transient)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  for (const stage of ['before traversal', 'after root lstat', 'during child traversal'] as const) {
    it(`fails closed when the root disappears ${stage}`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'git-observe-root-'))
      await writeFile(path.join(root, 'child.md'), 'wiki')
      const realLstat = fileSystem.lstat
      let removed = false
      const lstatSpy = vi.spyOn(fileSystem, 'lstat').mockImplementation((async (...args: Parameters<typeof realLstat>) => {
        const result = await realLstat(...args)
        if (args[0] === root && stage === 'after root lstat' && !removed) {
          await rm(root, { recursive: true })
          removed = true
        }
        return result
      }) as typeof realLstat)
      try {
        if (stage === 'before traversal') await rm(root, { recursive: true })
        await expect(
          observeDirectoryTree(root, {
            maxEntries: 1,
            maxBytes: 4,
            shouldSkip: () => {
              if (stage === 'during child traversal' && !removed) {
                rmSync(root, { recursive: true })
                removed = true
              }
              return false
            }
          })
        ).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        lstatSpy.mockRestore()
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  for (const target of ['root file', 'root symlink', 'child symlink'] as const) {
    it(`rejects a ${target} rather than following or accepting it`, async () => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), 'git-observe-type-'))
      const root = path.join(temporary, 'root')
      try {
        if (target === 'root file') {
          await writeFile(root, 'wiki')
        } else {
          await mkdir(path.join(temporary, 'outside'))
          await writeFile(path.join(temporary, 'outside', 'page.md'), 'wiki')
          if (target === 'root symlink') {
            await symlink(path.join(temporary, 'outside'), root)
          } else {
            await mkdir(root)
            await symlink(path.join(temporary, 'outside'), path.join(root, 'linked'))
          }
        }
        await expect(observeDirectoryTree(root, { maxEntries: 2, maxBytes: 4 })).rejects.toMatchObject({ kind: 'monitor', quarantine: true })
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    })
  }

  for (const replacement of [
    { type: 'file', code: 'ENOTDIR' },
    { type: 'dangling symlink', code: 'ENOENT' }
  ] as const) {
    it(`does not mistake a child replaced by a ${replacement.type} for removal`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'git-observe-replaced-'))
      const child = path.join(root, 'child')
      await mkdir(child)
      const realOpendir = fileSystem.opendir
      const opendirSpy = vi.spyOn(fileSystem, 'opendir').mockImplementation((async (...args: Parameters<typeof realOpendir>) => {
        if (args[0] === child) {
          await rm(child, { recursive: true })
          if (replacement.type === 'file') await writeFile(child, 'wiki')
          else await symlink(path.join(root, 'missing-target'), child)
        }
        return await realOpendir(...args)
      }) as typeof realOpendir)
      try {
        await expect(observeDirectoryTree(root, { maxEntries: 1, maxBytes: 4 })).rejects.toMatchObject({ code: replacement.code })
        const remaining = await fileSystem.lstat(child)
        expect(replacement.type === 'file' ? remaining.isFile() : remaining.isSymbolicLink()).toBe(true)
      } finally {
        opendirSpy.mockRestore()
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  for (const operation of ['lstat', 'opendir'] as const) {
    for (const code of ['EACCES', 'EIO'] as const) {
      it(`propagates child ${operation} ${code} failures instead of accepting an incomplete observation`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'git-observe-error-'))
        const child = path.join(root, 'child')
        await mkdir(child)
        const failure = Object.assign(new Error(`filesystem ${code}`), { code })
        const realLstat = fileSystem.lstat
        const realOpendir = fileSystem.opendir
        const failureSpy =
          operation === 'lstat'
            ? vi.spyOn(fileSystem, 'lstat').mockImplementation(((...args: Parameters<typeof realLstat>) => {
                if (args[0] === child) return Promise.reject(failure)
                return realLstat(...args)
              }) as typeof realLstat)
            : vi.spyOn(fileSystem, 'opendir').mockImplementation(((...args: Parameters<typeof realOpendir>) => {
                if (args[0] === child) return Promise.reject(failure)
                return realOpendir(...args)
              }) as typeof realOpendir)
        try {
          await expect(observeDirectoryTree(root, { maxEntries: 1, maxBytes: 0 })).rejects.toBe(failure)
        } finally {
          failureSpy.mockRestore()
          await rm(root, { recursive: true, force: true })
        }
      })
    }
  }

  for (const boundary of [
    { name: 'entry', maxEntries: 1, maxBytes: 4, kind: 'monitor' },
    { name: 'byte', maxEntries: 2, maxBytes: 3, kind: 'monitor' },
    { name: 'deadline', maxEntries: 2, maxBytes: 4, deadlineAt: 0, kind: 'deadline' }
  ] as const) {
    it(`still enforces the ${boundary.name} bound on surviving entries`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'git-observe-bound-'))
      try {
        await mkdir(path.join(root, 'nested'))
        await writeFile(path.join(root, 'nested', 'page.md'), 'wiki')
        await expect(observeDirectoryTree(root, boundary)).rejects.toMatchObject({ kind: boundary.kind, quarantine: true })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  it('quarantines asynchronous spawn failures instead of leaking child errors', async () => {
    let failure: unknown
    try {
      await runBoundedProcess({
        command: '/definitely/not-a-git-executable',
        args: [],
        cwd: process.cwd(),
        deadlineMs: 2_000
      })
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toBeInstanceOf(BoundedProcessError)
    if (!(failure instanceof BoundedProcessError)) return
    expect(failure.kind).toBe('spawn')
    expect(failure.quarantine).toBe(true)
  })

  it('quarantines a native process that exits by signal', async () => {
    let failure: unknown
    try {
      await runNode('process.kill(process.pid, "SIGTERM")')
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toBeInstanceOf(BoundedProcessError)
    if (!(failure instanceof BoundedProcessError)) return
    expect(failure.kind).toBe('exit')
    expect(failure.signal).toBe('SIGTERM')
    expect(failure.quarantine).toBe(true)
  })

  it('awaits a delayed monitor failure before treating child close as success', async () => {
    const enteredMonitor = Promise.withResolvers<void>()
    const releaseMonitor = Promise.withResolvers<void>()
    const childClosed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
    const realSpawn = childProcess.spawn
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation(((...args: Parameters<typeof realSpawn>) => {
      const child = realSpawn(...args)
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => childClosed.resolve({ code, signal }))
      return child
    }) as typeof realSpawn)
    let settled = false
    let failure: unknown
    const completed = runNode('process.exit(0)', {
      monitor: async () => {
        enteredMonitor.resolve()
        await releaseMonitor.promise
        throw new Error('monitor detected a changed tree')
      }
    }).then(
      () => {
        settled = true
      },
      error => {
        settled = true
        failure = error
      }
    )
    try {
      await enteredMonitor.promise
      expect(await childClosed.promise).toEqual({ code: 0, signal: null })
      // Let close/stdio continuations drain without releasing the in-flight monitor.
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
    } finally {
      releaseMonitor.resolve()
      await completed
      spawnSpy.mockRestore()
    }
    expect(failure).toBeInstanceOf(BoundedProcessError)
    if (!(failure instanceof BoundedProcessError)) return
    expect(failure.kind).toBe('monitor')
    expect(failure.quarantine).toBe(true)
  })

  it('refuses a pre-cancelled process before it can write working-copy bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-cancelled-'))
    const controller = new AbortController()
    controller.abort()
    try {
      await expect(
        runBoundedProcess({
          command: process.execPath,
          args: ['-e', 'require("node:fs").writeFileSync("must-not-exist", "mutation")'],
          cwd: root,
          signal: controller.signal
        })
      ).rejects.toThrow('aborted before admission')
      expect(await observeDirectoryTree(root, { maxEntries: 0, maxBytes: 0 })).toEqual({ entries: 0, bytes: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('terminates an admitted native process when its serialization fence is cancelled', async () => {
    const controller = new AbortController()
    await expect(
      runNode('require("node:net").createServer().listen(0, "127.0.0.1", () => process.stdout.write("ready"))', {
        signal: controller.signal,
        onStdoutChunk: async () => {
          controller.abort(new Error('serialization fence lost'))
        }
      })
    ).rejects.toThrow('serialization fence lost')
  })
})
