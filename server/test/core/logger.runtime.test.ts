import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import TransportStream from 'winston-transport'

const transports = vi.hoisted(() => [] as MockSentryTransport[])

class MockSentryTransport extends TransportStream {
  dispose = vi.fn(async (): Promise<void> => {})

  override log(_info: unknown, callback: () => void): void {
    callback()
  }
}

const sentry = vi.hoisted(() => ({
  init: vi.fn((logger: { add(transport: MockSentryTransport): void }) => {
    const transport = new MockSentryTransport()
    transports.push(transport)
    logger.add(transport)
    return transport
  })
}))

const transportAt = (index: number): MockSentryTransport => {
  const transport = transports[index]
  if (!transport) throw new Error(`Sentry transport ${index} was not initialized`)
  return transport
}

vi.mockModule('../../modules/logging/sentry/logger.ts', import.meta.url, () => ({ default: sentry }))

// The logger reads its global runtime when this mocked transport boundary is loaded.
const { default: loggerService } = await import('../../core/logger.ts')

const configuration = (key: string, isEnabled = true) => ({
  console: { level: 'info' as const, format: 'default' as const },
  destinations: [{ key: 'sentry', isEnabled, level: 'warn' as const, config: { key } }]
})

describe('managed logging runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transports.splice(0)
    Reflect.set(globalThis, 'WIKI', {
      config: { logFormat: 'default', logLevel: 'info', sessionSecret: 'test-session-secret' },
      data: { loggers: [{ key: 'sentry' }] },
      models: { loggers: { getLoggers: vi.fn(async () => []) } }
    })
  })

  it('awaits old Sentry client disposal before publishing disabled or rekeyed runtime state', async () => {
    const logger = loggerService.init('runtime-test')
    await logger.reconcile(configuration('https://public@example.test/1'), 'first')
    const first = transportAt(0)
    const firstDisposalStarted = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    first.dispose.mockImplementationOnce(async () => {
      firstDisposalStarted.resolve()
      await releaseFirst.promise
    })

    const disabled = logger.reconcile(configuration('https://public@example.test/1', false), 'disabled')
    await firstDisposalStarted.promise
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(logger.loggingRuntime().destinations.sentry).toEqual({ state: 'active', message: null })
    releaseFirst.resolve()
    await disabled
    expect(logger.loggingRuntime().destinations.sentry).toEqual({ state: 'inactive', message: null })

    await logger.reconcile(configuration('https://public@example.test/1'), 'second')
    const second = transportAt(1)
    const secondDisposalStarted = Promise.withResolvers<void>()
    const releaseSecond = Promise.withResolvers<void>()
    second.dispose.mockImplementationOnce(async () => {
      secondDisposalStarted.resolve()
      await releaseSecond.promise
    })

    const rekeyed = logger.reconcile(configuration('https://public@example.test/2'), 'third')
    await secondDisposalStarted.promise
    expect(second.dispose).toHaveBeenCalledOnce()
    expect(transports).toHaveLength(2)
    releaseSecond.resolve()
    await rekeyed
    expect(transports).toHaveLength(3)
  })

  it('fails an invalid DSN before the Sentry transport is initialized', async () => {
    const logger = loggerService.init('runtime-test')

    const result = await logger.reconcile(configuration('invalid private dsn'), 'invalid')

    expect(sentry.init).not.toHaveBeenCalled()
    expect(result.destinations.sentry).toEqual({ state: 'failed', message: 'The configured Sentry DSN is invalid.' })
  })
})
