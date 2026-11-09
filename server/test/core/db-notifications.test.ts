import { createRequire } from 'node:module'
import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (settings: unknown) => { connectionParameters: Record<string, unknown> }
}

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
    expect(wiki.logger.error).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'wiki',
      event: 'page.updated',
      error: 'connection lost'
    }))
  })
  it('composes listener policy with effective URL credentials and startup options', async () => {
    database.knex = {
      client: { connectionSettings: {
        connectionString: 'postgres://url-user:url-secret@database.example.test/wiki?application_name=uri-name&options=-c%20statement_timeout%3D7000%20-c%20search_path%3Dtenant%2Cpublic%20-c%20timezone%3DAsia%2FTokyo',
        user: 'fallback-user', options: '-c statement_timeout=3000'
      } }
    } as never
    await database.subscribeToNotifications()
    // The installed pg constructor resolves URL/object precedence without connect().
    const client = new Client(listenerSettings.calls.at(-1))
    expect(client.connectionParameters).toMatchObject({
      host: 'database.example.test', database: 'wiki', user: 'url-user', password: 'url-secret',
      application_name: expect.stringMatching(/^tsEpistle\/v1\/[A-Za-z0-9._~-]+\/listener$/),
      options: '-c statement_timeout=7000 -c search_path=tenant,public -c timezone=Asia/Tokyo -c timezone=UTC'
    })
  })
  it('retains non-enumerable credential descriptors and configured SSL on the listener', async () => {
    const ssl = { rejectUnauthorized: true, ca: 'synthetic-ca' }
    const settings = { host: 'database.example.test', user: 'wiki', database: 'wiki', ssl, options: '-c search_path=tenant,public' }
    Object.defineProperty(settings, 'password', { configurable: true, enumerable: false, value: 'hidden-secret' })
    database.knex = { client: { connectionSettings: settings } } as never
    await database.subscribeToNotifications()
    const effective = listenerSettings.calls.at(-1)
    expect(Object.getOwnPropertyDescriptor(effective, 'password')).toMatchObject({ enumerable: false, value: 'hidden-secret' })
    const client = new Client(effective)
    expect(client.connectionParameters).toMatchObject({
      password: 'hidden-secret', ssl, options: '-c search_path=tenant,public -c timezone=UTC'
    })
  })
  it('keeps connection application names versioned and within PostgreSQL byte limits', () => {
    const applicationName = createSystemConnectionApplicationName('é'.repeat(100), 'worker')
    expect(Buffer.byteLength(applicationName, 'utf8')).toBeLessThanOrEqual(63)
    expect(applicationName).toMatch(/^tsEpistle\/v1\/[A-Za-z0-9._~-]+\/worker$/)
  })
})
