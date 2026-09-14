import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const pubSub = vi.hoisted(() => ({
  addChannel: vi.fn(async (_channel: string, _callback: (payload: unknown) => void): Promise<void> => {}),
  close: vi.fn(async (): Promise<void> => {}),
  publish: vi.fn(async (_channel: string, _payload: unknown): Promise<void> => {})
}))
const listenerSettings = vi.hoisted(() => ({ calls: [] as unknown[] }))

class MockPGPubSub {
  constructor(settings?: unknown) {
    if (settings !== undefined) listenerSettings.calls.push(settings)
  }
  addChannel = pubSub.addChannel
  close = pubSub.close
  publish = pubSub.publish
}

vi.mockModule('pg-pubsub', import.meta.url, () => ({ default: MockPGPubSub }))

const wiki = {
  INSTANCE_ID: 'instance-a',
  IS_DEBUG: false,
  IS_MASTER: false,
  ROOTPATH: process.cwd(),
  SERVERPATH: process.cwd(),
  auth: { subscribeToEvents: vi.fn() },
  config: {
    db: { host: '', user: '', pass: '', db: '', port: 5432, ssl: false, sslOptions: {}, type: 'postgres' },
    ha: true,
    pool: {}
  },
  configSvc: { subscribeToEvents: vi.fn() },
  events: {
    inbound: { emit: vi.fn(), removeAllListeners: vi.fn() },
    outbound: { offAny: vi.fn(), onAny: vi.fn() }
  },
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  models: {
    listener: null as MockPGPubSub | null,
    pages: { subscribeToEvents: vi.fn() }
  }
}
Reflect.set(globalThis, 'WIKI', wiki)

// db.ts captures WIKI during module evaluation, after the pg-pubsub test double is installed.
const { default: database, createSystemConnectionApplicationName } = await import('../../core/db.ts')

describe('database notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listenerSettings.calls.length = 0
    pubSub.addChannel.mockResolvedValue(undefined)
    pubSub.close.mockResolvedValue(undefined)
    pubSub.publish.mockResolvedValue(undefined)
    database.knex = { client: { connectionSettings: {} } } as never
    database.listener = null
    wiki.models.listener = null
  })

  it('rejects startup and closes the listener when LISTEN activation fails', async () => {
    const activationError = new Error('LISTEN failed')
    pubSub.addChannel.mockRejectedValueOnce(activationError)

    await expect(database.subscribeToNotifications()).rejects.toBe(activationError)

    expect(pubSub.close).toHaveBeenCalledOnce()
    expect(database.listener).toBeNull()
    expect(wiki.events.outbound.onAny).not.toHaveBeenCalled()
    expect(wiki.auth.subscribeToEvents).not.toHaveBeenCalled()
    expect(wiki.configSvc.subscribeToEvents).not.toHaveBeenCalled()
    expect(wiki.models.pages.subscribeToEvents).not.toHaveBeenCalled()
    expect(wiki.logger.info).not.toHaveBeenCalled()
  })

  it('logs a rejected NOTIFY publish exactly once', async () => {
    const listener = new MockPGPubSub()
    wiki.models.listener = listener
    pubSub.publish.mockRejectedValueOnce(new Error('connection lost'))

    database.notifyViaDB('page.updated', { id: 42 })

    await vi.waitFor(() => expect(wiki.logger.error).toHaveBeenCalledOnce())
    expect(wiki.logger.error).toHaveBeenCalledWith({
      message: 'Failed to publish High-Availability notification',
      channel: 'wiki',
      event: 'page.updated',
      error: 'connection lost'
    })
  })
  it('tags the listener without discarding URL-style connection settings', async () => {
    database.knex = {
      client: { connectionSettings: { connectionString: 'postgres://database.example.test/wiki', user: 'wiki' } }
    } as never
    await database.subscribeToNotifications()
    const settings = listenerSettings.calls.at(-1)
    expect(settings).toMatchObject({ connectionString: 'postgres://database.example.test/wiki', user: 'wiki' })
    expect(settings).toMatchObject({ application_name: expect.stringMatching(/^tsEpistle\/v1\/[A-Za-z0-9._~-]+\/listener$/) })
  })
  it('keeps connection application names versioned and within PostgreSQL byte limits', () => {
    const applicationName = createSystemConnectionApplicationName('é'.repeat(100), 'worker')
    expect(Buffer.byteLength(applicationName, 'utf8')).toBeLessThanOrEqual(63)
    expect(applicationName).toMatch(/^tsEpistle\/v1\/[A-Za-z0-9._~-]+\/worker$/)
  })
})
