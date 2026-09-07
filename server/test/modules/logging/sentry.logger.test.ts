import { beforeEach, describe, expect, it, vi } from '../../bun-test.mts'
import { LEVEL } from 'triple-beam'

const client = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  close: vi.fn(async (): Promise<boolean> => true),
  init: vi.fn(),
  options: [] as unknown[]
}))
const nodeCore = vi.hoisted(() => ({
  defaultStackParser: vi.fn(),
  makeNodeTransport: vi.fn()
}))

class MockNodeClient {
  constructor(options: unknown) {
    client.options.push(options)
  }

  captureMessage = client.captureMessage
  close = client.close
  init = client.init
}

vi.mockModule('@sentry/node-core', import.meta.url, () => ({ NodeClient: MockNodeClient, ...nodeCore }))

// The module is loaded after its SDK boundary is replaced with an in-process client.
const { SentryLogger } = await import('../../../modules/logging/sentry/logger.ts')
describe('SentryLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    client.options.splice(0)
    client.close.mockResolvedValue(true)
  })

  it('maps Winston canonical levels rather than ANSI-formatted transport levels', () => {
    const transport = new SentryLogger({ key: 'https://public@example.test/1' })
    expect(client.options).toContainEqual(
      expect.objectContaining({
        transport: nodeCore.makeNodeTransport,
        stackParser: nodeCore.defaultStackParser
      })
    )

    transport.log({ level: '\u001b[33mwarn\u001b[39m', message: 'A warning', [LEVEL]: 'warn' } as never, () => {})

    expect(client.captureMessage).toHaveBeenCalledWith('A warning', 'warning', undefined, expect.anything())
  })

  it('closes its owned client once after a bounded flush', async () => {
    const transport = new SentryLogger({ key: 'https://public@example.test/1' })

    await transport.dispose()
    await transport.dispose()

    expect(client.close).toHaveBeenCalledOnce()
    expect(client.close).toHaveBeenCalledWith(2_000)
  })
})
