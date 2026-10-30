import { afterAll, beforeAll, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { AGENT_MEMORY_CHARACTER_LIMITS } from '../../shared/agents/contracts.ts'
import type { GlossaryPinRequest } from './glossary-runtime.ts'

const previousSiteConfig = Object.getOwnPropertyDescriptor(window, 'siteConfig')
const previousGlobalSiteConfig = Object.getOwnPropertyDescriptor(globalThis, 'siteConfig')
let glossaryMemoryContent: typeof import('./glossary-memory.ts').glossaryMemoryContent
let useGlossaryMemory: typeof import('./glossary-memory.ts').useGlossaryMemory
beforeAll(async () => {
  Object.defineProperty(window, 'siteConfig', {
    configurable: true,
    writable: true,
    value: {
      company: '', contentLicense: '', footerOverride: '', banner: {},
      darkMode: false, tocPosition: 'auto', title: 'Test', logoUrl: '',
      product: { name: 'Test', version: '1.0.0' },
      agentsEnabled: true, agentCsrfToken: 'test-glossary-csrf'
    }
  })
  Object.defineProperty(globalThis, 'siteConfig', {
    configurable: true, writable: true, value: Reflect.get(window, 'siteConfig')
  })
  const helpers = await import('./glossary-memory.ts')
  glossaryMemoryContent = helpers.glossaryMemoryContent
  useGlossaryMemory = helpers.useGlossaryMemory
})
afterAll(() => {
  if (previousGlobalSiteConfig) Object.defineProperty(globalThis, 'siteConfig', previousGlobalSiteConfig)
  else Reflect.deleteProperty(globalThis, 'siteConfig')
  if (previousSiteConfig) Object.defineProperty(window, 'siteConfig', previousSiteConfig)
  else Reflect.deleteProperty(window, 'siteConfig')
})

const request = (definitionHtml: string): GlossaryPinRequest => ({
  id: 1,
  revision: 1,
  key: 'definition-1',
  ownerKey: 'current-owner',
  pageKey: 'en/readable',
  term: 'RAG',
  expansion: 'Retrieval augmented generation',
  locale: 'en',
  definitionHtml,
  definitionText: 'Untrusted precomputed hidden text',
  sourceHref: `${window.location.origin}/en/readable?token=fixture-only#state`,
  glossaryHref: `${window.location.origin}/en/readable?unrelated=fixture-only&glossary=Old#state`
})

describe('deliberate Glossary memory content', () => {
  it('preserves visible definition text without hidden content, link destinations or unrelated URL state', () => {
    const result = glossaryMemoryContent(request('<p>Visible <strong>definition</strong> <a href="https://reference.test/private-reference?token=fixture-only">label</a><span hidden>hidden-draft</span><span aria-hidden="true">hidden-a11y</span></p>'))
    expect(result.error).toBeUndefined()
    const content = result.content!
    expect(content).toContain('Visible definition label')
    expect(content).toContain(`${window.location.origin}/en/readable`)
    expect(content).toContain('?glossary=RAG')
    for (const excluded of ['hidden-draft', 'hidden-a11y', 'Untrusted precomputed', 'private-reference', 'fixture-only', '#state', 'glossary=Old']) {
      expect(content).not.toContain(excluded)
    }
  })

  it('accepts a complete Unicode definition at the user limit and rejects one extra unit without truncation', () => {
    const base = glossaryMemoryContent(request('<p>x</p>')).content!
    const available = AGENT_MEMORY_CHARACTER_LIMITS.user - (base.length - 1)
    const definition = '🧭'.repeat(Math.floor(available / 2)) + 'x'.repeat(available % 2)
    const exact = glossaryMemoryContent(request(`<p>${definition}</p>`))
    expect(exact.error).toBeUndefined()
    expect(exact.content).toHaveLength(AGENT_MEMORY_CHARACTER_LIMITS.user)
    expect(exact.content).toContain(definition)
    expect(glossaryMemoryContent(request(`<p>${definition}x</p>`))).toEqual({ error: 'tooLong' })
  })
})

describe('Glossary recall connection lifetime', () => {
  it('restores an authorized Pin after browser reconnect without dispatching a memory write', async () => {
    const Vue = await import('vue')
    const { createPinia, getActivePinia, setActivePinia } = await import('pinia')
    const { useWikiStore } = await import('../store/index.ts')
    const { glossaryIdentity } = await import('./glossary-session.ts')
    const pwa = await import('./pwa.ts')
    const previousPinia = getActivePinia()
    const onlineDescriptor = Object.getOwnPropertyDescriptor(navigator, 'onLine')
    let online = false
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
    const mode = vi.spyOn(pwa, 'currentPwaMode').mockReturnValue('retirement')
    const fetch = vi.spyOn(window, 'fetch')
    const pinia = createPinia(), store = useWikiStore(pinia)
    Object.assign(store.user, { id: 7, authenticated: true, authVersion: 1, iat: 1, permissions: ['use:agents'] })
    Object.assign(store, { authRefreshPending: false, authRefreshSettled: true, authRefreshOutcome: 'authenticated', offlineIdentityReady: true })
    const selection = { ...request('<p>Visible definition</p>'), ownerKey: glossaryIdentity(store) }
    const controller = new AbortController()
    let memory!: ReturnType<typeof useGlossaryMemory>
    const host = document.createElement('div')
    document.body.append(host)
    const app = Vue.createApp({
      setup() {
        memory = useGlossaryMemory(() => selection.pageKey, () => selection.locale)
        return () => null
      }
    })
    app.use(pinia)
    try {
      app.mount(host)
      memory.selectPin(selection, controller.signal)
      expect(memory.pinState.value.available).toBe(false)
      online = true
      window.dispatchEvent(new window.Event('online'))
      await Vue.nextTick()
      expect(memory.pinState.value.available).toBe(true)
      const memoryWrites = fetch.mock.calls.filter(([input, init]) => {
        const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input), window.location.href)
        const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
        return url.pathname === '/_api/agents/memories' && method !== 'GET'
      })
      expect(memoryWrites).toEqual([])
    } finally {
      app.unmount()
      host.remove()
      controller.abort()
      fetch.mockRestore()
      mode.mockRestore()
      if (onlineDescriptor) Object.defineProperty(navigator, 'onLine', onlineDescriptor)
      else Reflect.deleteProperty(navigator, 'onLine')
      setActivePinia(previousPinia)
    }
  })
})
