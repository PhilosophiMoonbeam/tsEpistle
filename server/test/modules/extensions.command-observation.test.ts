import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const execFile = vi.hoisted(() => vi.fn())
vi.mockModule('node:child_process', import.meta.url, () => ({ execFile }))

describe('bundled command observation', () => {
  beforeEach(() => {
    execFile.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports only an absent executable as missing and keeps provider failures unknown', async () => {
    const kill = vi.fn()
    execFile.mockImplementation((...args: unknown[]) => {
      const callback = args[3]
      if (typeof callback !== 'function') throw new TypeError('Expected execFile completion callback.')
      callback(Object.assign(new Error('not found'), { code: 'ENOENT' }))
      return { kill }
    })
    const { observeBundledCommand } = await vi.importFresh<typeof import('../../modules/extensions/command-observation.ts')>(
      '../../modules/extensions/command-observation.ts',
      import.meta.url
    )

    await expect(observeBundledCommand('git')).resolves.toBe('missing')
    expect(execFile).toHaveBeenCalledWith('git', ['--version'], expect.objectContaining({ maxBuffer: 1_024, windowsHide: true }), expect.any(Function))

    execFile.mockImplementation((...args: unknown[]) => {
      const callback = args[3]
      if (typeof callback !== 'function') throw new TypeError('Expected execFile completion callback.')
      callback(Object.assign(new Error('failed version check'), { code: 1 }))
      return { kill }
    })
    await expect(observeBundledCommand('pandoc')).resolves.toBe('unknown')
  })

  it('settles at its hard deadline and escalates when a process ignores termination', async () => {
    const kill = vi.fn()
    execFile.mockReturnValue({ kill })
    const { observeBundledCommand } = await vi.importFresh<typeof import('../../modules/extensions/command-observation.ts')>(
      '../../modules/extensions/command-observation.ts',
      import.meta.url
    )

    const observation = observeBundledCommand('git')
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(observation).resolves.toBe('unknown')
    expect(kill).toHaveBeenCalledWith('SIGTERM')

    await vi.advanceTimersByTimeAsync(100)
    expect(kill).toHaveBeenCalledWith('SIGKILL')
  })
})
