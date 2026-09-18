import vm from 'node:vm'
import { describe, expect, it, vi } from '../../server/test/bun-test.mts'
type ViteConfigEnvironment = {
  readonly command: 'build'
  readonly mode: string
  readonly isSsrBuild: boolean
  readonly isPreview: boolean
}

type ViteConfigModule = {
  readonly default: (environment: ViteConfigEnvironment) => { plugins?: unknown[] } | Promise<{ plugins?: unknown[] }>
}

type TombstoneClient = {
  id: string
  url: string
  messages: unknown[]
  navigations: string[]
  postMessage(message: unknown): void
  navigate(url: string): Promise<unknown>
}

type HarnessEvent = {
  readonly [key: string]: unknown
  readonly waitUntil?: (promise: Promise<unknown>) => void
}

type RuntimeHarness = {
  readonly self: Record<string, unknown>
  readonly clients: TombstoneClient[]
  readonly events: Map<string, (event: HarnessEvent) => void>
  readonly log: string[]
  dispatch(type: string, values?: Record<string, unknown>): Promise<unknown>
}

const makeClient = (id: string, url: string, log: string[]): TombstoneClient => {
  const client: TombstoneClient = {
    id,
    url,
    messages: [],
    navigations: [],
    postMessage(message: unknown) {
      client.messages.push(message)
    },
    async navigate(target: string) {
      log.push(`navigate:${id}`)
      client.navigations.push(target)
    }
  }
  return client
}

type RuntimeOptions = {
  readonly cacheNames?: readonly string[]
  readonly failCleanup?: boolean
}

const createRuntime = (source: string, options: RuntimeOptions = {}): RuntimeHarness => {
  const events = new Map<string, (event: HarnessEvent) => void>()
  const log: string[] = []
  const safe = makeClient('safe', 'https://wiki.example.test/en/safe', log)
  const unsafe = makeClient('unsafe', 'https://wiki.example.test/en/unsafe', log)
  const outside = makeClient('outside', 'https://other.example.test/en/outside', log)
  const clients = [safe, unsafe, outside]
  const registration = {
    scope: 'https://wiki.example.test/',
    async unregister() {
      log.push('unregister')
      return true
    }
  }
  const caches = {
    async keys(): Promise<string[]> {
      log.push('cache-keys')
      if (options.failCleanup) throw new Error('Cache Storage unavailable during retirement')
      return [...(options.cacheNames ?? [])]
    },
    async delete(name: string): Promise<boolean> {
      log.push(`cache-delete:${name}`)
      return true
    }
  }
  const self: Record<string, unknown> = {
    registration,
    caches,
    clients: {
      async claim() {
        log.push('claim')
      },
      async matchAll(options?: unknown) {
        log.push(`match-all:${JSON.stringify(options)}`)
        return clients
      }
    },
    addEventListener(type: string, listener: (event: HarnessEvent) => void) {
      events.set(type, listener)
    },
    async skipWaiting() {
      log.push('skip-waiting')
    },
    crypto: globalThis.crypto
  }
  vm.runInNewContext(source, {
    self,
    URL,
    Promise,
    Map,
    Array,
    Error,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    crypto: globalThis.crypto
  }, { filename: 'sw-tombstone.generated.js' })
  return {
    self,
    clients,
    events,
    log,
    async dispatch(type, values = {}) {
      const waits: Promise<unknown>[] = []
      const listener = events.get(type)
      if (!listener) throw new Error(`No ${type} listener registered`)
      listener({
        type,
        ...values,
        waitUntil(value: Promise<unknown>) {
          waits.push(Promise.resolve(value))
        }
      })
      return await Promise.all(waits)
    }
  }
}

const generatedTombstone = async (): Promise<string> => {
  const configModule = await vi.importFresh<ViteConfigModule>('../../vite.config.mts', import.meta.url)
  const configFactory = configModule.default
  if (typeof configFactory !== 'function') throw new Error('Vite config did not expose a build config factory')
  const config = await configFactory({ command: 'build', mode: 'test', isSsrBuild: false, isPreview: false })
  const rawPlugins: unknown = config.plugins
  if (!Array.isArray(rawPlugins)) throw new Error('Vite config did not expose a plugin list')
  const plugins = rawPlugins.flat(Infinity).filter(plugin => plugin && typeof plugin === 'object') as Array<{
    name?: string
    generateBundle?: (this: { emitFile(file: unknown): void }, options: unknown, bundle: unknown) => void | Promise<void>
  }>
  const tombstone = plugins.find(plugin => plugin.name === 'tsepistle-pwa-tombstone-artifact')
  if (!tombstone?.generateBundle) throw new Error('Vite tombstone artifact plugin was not registered')
  let artifact: { source?: unknown } | undefined
  await tombstone.generateBundle.call({
    emitFile(file: unknown) {
      const candidate = file as { fileName?: unknown; source?: unknown }
      if (candidate.fileName === 'sw-tombstone.js') artifact = candidate
    }
  }, {}, {})
  if (!artifact || typeof artifact.source !== 'string') throw new Error('Tombstone artifact was not emitted')
  return artifact.source
}

describe('generated PWA tombstone lifecycle', () => {
  it('unregisters before navigating only safe in-scope clients even when cache cleanup fails', async () => {
    const source = await generatedTombstone()
    const harness = createRuntime(source, { failCleanup: true })
    await harness.dispatch('install')
    expect(harness.log).toContain('skip-waiting')

    const activation = harness.dispatch('activate')
    await vi.waitFor(() => {
      const requests = harness.clients.flatMap(client => client.messages).filter(message => (message as { type?: unknown }).type === 'PWA_RELOAD_SAFETY_REQUEST')
      expect(requests).toHaveLength(2)
    })
    const requests = harness.clients.flatMap(client => client.messages).filter(message => (message as {
      type?: unknown
      workerId?: unknown
      release?: unknown
      roundNonce?: unknown
    }).type === 'PWA_RELOAD_SAFETY_REQUEST') as Array<{ workerId: string; release: string; roundNonce: string }>
    const round = requests[0]!
    expect(round.workerId).toBe('retirement')
    expect(round.release).toBe('retirement')
    expect(requests.every(request => request.roundNonce === round.roundNonce)).toBe(true)
    expect(harness.clients[0]?.messages).toContainEqual(expect.objectContaining({ type: 'PWA_RETIREMENT_NOTICE' }))
    expect(harness.clients[1]?.messages).toContainEqual(expect.objectContaining({ type: 'PWA_RETIREMENT_NOTICE' }))

    const messageListener = harness.events.get('message')
    if (!messageListener) throw new Error('Tombstone did not register a message listener')
    messageListener({
      source: harness.clients[0],
      data: { type: 'PWA_RELOAD_SAFETY', workerId: round.workerId, release: round.release, roundNonce: round.roundNonce, safe: true }
    })
    messageListener({
      source: harness.clients[1],
      data: { type: 'PWA_RELOAD_SAFETY', workerId: round.workerId, release: round.release, roundNonce: round.roundNonce, safe: false }
    })
    await activation

    expect(harness.log).toContain('cache-keys')
    expect(harness.log).toContain('unregister')
    expect(harness.log.indexOf('unregister')).toBeLessThan(harness.log.indexOf('navigate:safe'))
    expect(harness.clients[0]?.navigations).toEqual(['https://wiki.example.test/en/safe'])
    expect(harness.clients[1]?.navigations).toEqual([])
    expect(harness.clients[2]?.messages).toEqual([])
    expect(harness.clients[2]?.navigations).toEqual([])
    expect(harness.log.some(entry => entry.startsWith('match-all:{"type":"window"'))).toBe(true)
  })

  it('keeps every IndexedDB-like client document untouched until it reports safety', async () => {
    const source = await generatedTombstone()
    const harness = createRuntime(source)
    const activation = harness.dispatch('activate')
    await vi.waitFor(() => expect(harness.clients[0]?.messages.length).toBeGreaterThan(1))
    const request = harness.clients[0]?.messages.find(message => (message as { type?: unknown }).type === 'PWA_RELOAD_SAFETY_REQUEST') as {
      workerId: string
      release: string
      roundNonce: string
    }
    const messageListener = harness.events.get('message')!
    messageListener({ source: harness.clients[0], data: { type: 'PWA_RELOAD_SAFETY', ...request, safe: false } })
    messageListener({ source: harness.clients[1], data: { type: 'PWA_RELOAD_SAFETY', ...request, safe: false } })
    await activation
    expect(harness.clients[0]?.navigations).toHaveLength(0)
    expect(harness.clients[1]?.navigations).toHaveLength(0)
  })
  it('removes only owned precache and public branding caches during retirement cleanup', async () => {
    const source = await generatedTombstone()
    const ownedOne = 'tsepistle-pwa-precache-v1-0123456789abcdef'
    const ownedTwo = 'tsepistle-pwa-precache-v1-fedcba9876543210'
    const harness = createRuntime(source, { cacheNames: [ownedOne, ownedTwo, 'tsepistle-pwa-branding-v1', 'tsepistle-pwa-branding-v2', 'unrelated-cache'] })
    const activation = harness.dispatch('activate')
    await vi.waitFor(() => expect(harness.clients[0]?.messages.length).toBeGreaterThan(1))
    const request = harness.clients[0]?.messages.find(message => (message as { type?: unknown }).type === 'PWA_RELOAD_SAFETY_REQUEST') as {
      workerId: string
      release: string
      roundNonce: string
    }
    const messageListener = harness.events.get('message')!
    for (const target of harness.clients.slice(0, 2)) {
      messageListener({ source: target, data: { type: 'PWA_RELOAD_SAFETY', ...request, safe: false } })
    }
    await activation
    expect(harness.log).toContain(`cache-delete:${ownedOne}`)
    expect(harness.log).toContain(`cache-delete:${ownedTwo}`)
    expect(harness.log).toContain('cache-delete:tsepistle-pwa-branding-v1')
    expect(harness.log).not.toContain('cache-delete:tsepistle-pwa-branding-v2')
    expect(harness.log).not.toContain('cache-delete:unrelated-cache')
  })
})
