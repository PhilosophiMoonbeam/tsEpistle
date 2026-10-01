import { describe, expect, it, vi } from '../../../test/bun-test.mts'
import * as childProcess from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  BoundedProcessError,
  observeDirectoryTree,
  runBoundedProcess
} from './bounded-process.ts'

const runNode = (script: string, options: Partial<Parameters<typeof runBoundedProcess>[0]> = {}) => runBoundedProcess({
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
      () => { settled = true },
      error => { settled = true; failure = error }
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
})
