import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type * as BootstrapModule from '../../index.ts'

interface KernelMock {
  init(): Promise<void>
  shutdown(): Promise<void>
}

const EXIT_CODE_SENTINEL = 23

describe('bootstrap lifecycle', () => {
  let previousExitCode: number | undefined
  let previousWiki: unknown

  beforeEach(() => {
    previousExitCode = process.exitCode
    previousWiki = globalThis.WIKI
    process.exitCode = EXIT_CODE_SENTINEL
  })

  afterEach(() => {
    process.exitCode = previousExitCode
    globalThis.WIKI = previousWiki as typeof globalThis.WIKI
    vi.restoreAllMocks()
  })

  const setupModule = async (kernel: KernelMock) => {
    vi.resetModules()
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() }
    const configService = { init: vi.fn() }

    vi.mockModule('../../helpers/error.ts', import.meta.url, () => ({ default: {} }))
    vi.mockModule('../../core/config.ts', import.meta.url, () => ({ default: configService }))
    vi.mockModule('../../core/logger.ts', import.meta.url, () => ({
      default: { init: vi.fn().mockReturnValue(logger) }
    }))
    vi.mockModule('../../core/kernel.ts', import.meta.url, () => ({ default: kernel }))

    const { main } = await vi.importFresh<typeof BootstrapModule>('../../index.ts', import.meta.url)
    return { configService, logger, main }
  }

  it('registers one fatal-listener pair for one promise-owned bootstrap', async () => {
    const unhandledRejections = process.listenerCount('unhandledRejection')
    const uncaughtExceptions = process.listenerCount('uncaughtException')
    const kernel = {
      init: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined)
    }
    const { main } = await setupModule(kernel)

    const first = main()
    const second = main()
    expect(second).toBe(first)
    await first

    expect(kernel.init).toHaveBeenCalledTimes(1)
    expect(process.listenerCount('unhandledRejection')).toBe(unhandledRejections + 1)
    expect(process.listenerCount('uncaughtException')).toBe(uncaughtExceptions + 1)

    const sigterm = process.listeners('SIGTERM').at(-1)
    if (!sigterm) throw new Error('SIGTERM lifecycle handler was not registered')
    sigterm()
    await vi.waitFor(() => {
      expect(kernel.shutdown).toHaveBeenCalledTimes(1)
      expect(process.exitCode).toBe(0)
    })
  })

  it('memoizes concurrent signal and IPC shutdown requests', async () => {
    let finishShutdown!: () => void
    const shutdownPending = new Promise<void>(resolve => {
      finishShutdown = resolve
    })
    const kernel = {
      init: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockReturnValue(shutdownPending)
    }
    const { main } = await setupModule(kernel)

    await main()
    const sigterm = process.listeners('SIGTERM').at(-1)
    const message = process.listeners('message').at(-1)
    if (!sigterm || !message) throw new Error('Lifecycle handlers were not registered')
    sigterm()
    message('shutdown')
    await vi.waitFor(() => expect(kernel.shutdown).toHaveBeenCalledTimes(1))
    expect(process.exitCode).toBe(EXIT_CODE_SENTINEL)

    finishShutdown()
    await vi.waitFor(() => expect(process.exitCode).toBe(0))
    expect(kernel.shutdown).toHaveBeenCalledTimes(1)
  })

  it('awaits teardown before marking a failed bootstrap for exit', async () => {
    let finishShutdown!: () => void
    const shutdownPending = new Promise<void>(resolve => {
      finishShutdown = resolve
    })
    let serving = false
    const kernel = {
      init: vi.fn().mockImplementation(async () => {
        serving = true
        throw new Error('listen failed')
      }),
      shutdown: vi.fn().mockImplementation(async () => {
        await shutdownPending
        serving = false
      })
    }
    const { main } = await setupModule(kernel)

    const bootstrap = main()
    await vi.waitFor(() => expect(kernel.shutdown).toHaveBeenCalledTimes(1))
    expect(process.exitCode).toBe(EXIT_CODE_SENTINEL)
    expect(serving).toBe(true)

    finishShutdown()
    await bootstrap
    expect(serving).toBe(false)
    expect(kernel.shutdown).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBe(1)
  })

  it('does not clean up a kernel that was never acquired', async () => {
    const kernel = {
      init: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined)
    }
    const { configService, main } = await setupModule(kernel)
    configService.init.mockImplementation(() => {
      throw new Error('configuration failed')
    })

    await main()

    expect(kernel.init).not.toHaveBeenCalled()
    expect(kernel.shutdown).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
  it('aborts a pending bootstrap before awaiting teardown', async () => {
    const initialSigtermListeners = process.listenerCount('SIGTERM')
    let setupSignal: AbortSignal | undefined
    const kernel = {
      init: vi.fn(async () => {
        const wiki: unknown = globalThis.WIKI
        if (typeof wiki !== 'object' || wiki === null || !('shutdownSignal' in wiki) || !(wiki.shutdownSignal instanceof AbortSignal)) {
          throw new Error('Bootstrap did not expose a shutdown signal')
        }
        setupSignal = wiki.shutdownSignal
        await new Promise<void>((_resolve, reject) => {
          setupSignal?.addEventListener('abort', () => reject(setupSignal?.reason), { once: true })
        })
      }),
      shutdown: vi.fn().mockResolvedValue(undefined)
    }
    const { main } = await setupModule(kernel)

    const bootstrap = main()
    await vi.waitFor(() => expect(kernel.init).toHaveBeenCalledTimes(1))
    const sigterm = process.listeners('SIGTERM').at(-1)
    if (!sigterm) throw new Error('SIGTERM lifecycle handler was not registered')
    sigterm()

    await bootstrap
    expect(setupSignal?.aborted).toBe(true)
    expect(kernel.shutdown).toHaveBeenCalledTimes(1)
    expect(process.listenerCount('SIGTERM')).toBe(initialSigtermListeners)
    expect(process.exitCode).toBe(0)
  })
})
