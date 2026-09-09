import { describe, expect, it } from '../../../test/bun-test.mts'

import {
  BoundedProcessError,
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
    let monitorStarted = false
    const run = runNode('process.exit(0)', {
      monitor: async () => {
        monitorStarted = true
        const delayed = Promise.withResolvers<void>()
        // A real delay is required so the spawned child's close event wins; fake timers do not control that child.
        setTimeout(delayed.resolve, 100)
        await delayed.promise
        throw new Error('monitor detected a changed tree')
      }
    })
    let failure: unknown
    try {
      await run
    } catch (error: unknown) {
      failure = error
    }
    expect(monitorStarted).toBe(true)
    expect(failure).toBeInstanceOf(BoundedProcessError)
    if (!(failure instanceof BoundedProcessError)) return
    expect(failure.kind).toBe('monitor')
    expect(failure.quarantine).toBe(true)
  })
})
