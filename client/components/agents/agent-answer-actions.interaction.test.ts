import path from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import i18next from 'i18next'
import type { Component } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import type { AgentCitation, AgentGoogleSearchGrounding } from '../../../shared/agents/contracts.ts'
import { browserWindow, document, resetBody, setLocation } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import { renderSafeMarkdown } from '../../helpers/safe-markdown.ts'
import { PAGE_CREATION_OWNER_HEADER, type PageCreationCommitted, type PageCreationInventory, type PageCreationStatus } from '../../../shared/page-creation.ts'
import type { PageWriteInput } from '../../helpers/pages-api.ts'

resetBody()
const priorSiteConfig = Object.getOwnPropertyDescriptor(browserWindow, 'siteConfig')
const installSiteConfig = () => {
  Object.defineProperty(browserWindow, 'siteConfig', {
    configurable: true,
    writable: true,
    value: {
      company: '',
      contentLicense: '',
      footerOverride: '',
      banner: { isEnabled: false, title: '', content: '' },
      darkMode: false,
      tocPosition: 'left',
      pageTransitions: true,
      showPageProgress: false,
      title: 'Test Wiki',
      logoUrl: '',
      product: { name: 'Test', version: '1.0.0' },
      lang: 'en',
      agentCsrfToken: 'test-csrf'
    }
  })
}
// Match the root-store fixture before any real SFC imports initialize that store.
installSiteConfig()
// Runtime DOM and Vuetify must load after the shared test document is installed.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const { VAlert, VBtn, VCard, VCardActions, VCardText, VCardTitle, VDialog, VSpacer, VTextarea, VTextField } = await import('vuetify/components')

// Execute the real setup and template, including Markdown's clipboard consumer.
Bun.plugin({
  name: 'agent-answer-copy-sfc-regressions',
  setup(builder) {
    builder.onLoad({ filter: /agent-(?:answer-actions|markdown)\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const compiled = compileScript(parsed.descriptor, {
        id: `answer-copy-${path.basename(filename, '.vue')}`,
        genDefaultAs: '__component',
        inlineTemplate: true
      })
      return { loader: 'ts', contents: `${compiled.content}\nexport default __component;` }
    })
  }
})
// Static SFC imports would load before the executable SFC compiler plugin is registered.
const AgentAnswerActions = (await import('./agent-answer-actions.vue')).default
const AgentMarkdown = (await import('./agent-markdown.vue')).default
// These stores must capture the same post-DOM Vue runtime as the mounted SFCs.
const { wikiStore } = await import('../../store/index.ts')
const { retryServerConnection, reportServerConnectionFailure, PWA_SERVER_PROBE_PATH } = await import('../../helpers/pwa.ts')
const sessionId = '54d74542-1d51-4c39-a975-66796d31e8db'
const messageId = '6c95d46c-394b-4c89-a0f0-a6aff2ba48da'
const emptyInventory: PageCreationInventory = { items: [], hasMore: false, nextCursor: null }
const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
const receipt = (requestId: string, overrides: Partial<PageCreationCommitted> = {}): PageCreationCommitted => ({
  status: 'committed',
  requestId,
  sourceRevision: '3',
  createdAt: '2026-10-22T00:00:00.000Z',
  creationOrigin: { kind: 'agent-answer', sessionId, messageId },
  destination: {
    id: 71,
    sourceRevision: '11',
    locale: 'en',
    path: 'actual/authorized-draft',
    title: 'Current authorized draft',
    visibility: 'private',
    isPublished: false
  },
  ...overrides
})
beforeEach(async () => {
  installSiteConfig()
  wikiStore.$patch({
    user: { id: 1, authenticated: true, authVersion: 1, permissions: ['write:pages'] },
    authRefreshOutcome: 'authenticated',
    offlineIdentityEpoch: 1
  })
  vi.spyOn(browserWindow, 'fetch').mockImplementation(async input => {
    if (String(input) === PWA_SERVER_PROBE_PATH) return jsonResponse({})
    if (String(input).includes('/creation-origins/')) return jsonResponse(emptyInventory)
    throw new Error(`Unexpected creation request: ${String(input)}`)
  })
  await retryServerConnection({ quiet: true })
})

const previousClipboard = Object.getOwnPropertyDescriptor(browserWindow.navigator, 'clipboard')
const previousExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')
const previousLocation = browserWindow.location.href
const mountedApps: Array<() => void> = []
const mount = async (component: Component, props: Record<string, unknown>, translate = translateEnglish): Promise<HTMLElement> => {
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({ render: () => Vue.h(component, props) })
  app.config.globalProperties.$t = translate
  app.use(createVuetify({ components: { VAlert, VBtn, VCard, VCardActions, VCardText, VCardTitle, VDialog, VSpacer, VTextarea, VTextField } }))
  app.mount(host)
  mountedApps.push(() => {
    app.unmount()
    host.remove()
  })
  await Vue.nextTick()
  return host
}
const clickAndSettle = async (button: HTMLButtonElement, completed: () => boolean): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  const observer = new MutationObserver(() => {
    if (completed()) resolve()
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
  mountedApps.push(() => observer.disconnect())
  try {
    button.click()
    if (completed()) resolve()
    await promise
    await Vue.nextTick()
  } finally {
    observer.disconnect()
  }
}

afterEach(() => {
  for (const unmount of mountedApps.splice(0)) unmount()
  if (previousClipboard) Object.defineProperty(browserWindow.navigator, 'clipboard', previousClipboard)
  else Reflect.deleteProperty(browserWindow.navigator, 'clipboard')
  if (previousExecCommand) Object.defineProperty(document, 'execCommand', previousExecCommand)
  else Reflect.deleteProperty(document, 'execCommand')
  setLocation(previousLocation)
  resetBody()
  if (priorSiteConfig) Object.defineProperty(browserWindow, 'siteConfig', priorSiteConfig)
  else Reflect.deleteProperty(browserWindow, 'siteConfig')
  // Dispose the real health probe's retry timer without leaving background reads.
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  reportServerConnectionFailure()
  if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
  else Reflect.deleteProperty(document, 'visibilityState')
  vi.restoreAllMocks()
})

describe('Answer export and clipboard interactions', () => {
  it('derives a plain editable draft title and retains edits when the review is hidden', async () => {
    const host = await mount(AgentAnswerActions, {
      sessionId,
      messageId,
      content: '# **Practical** [guide](https://example.test/guide) and _notes_ [[cite:source]]\n\nKeep the answer body.',
      citations: []
    })
    const openButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button =>
      button.textContent?.includes(translateEnglish('common:agentAnswerActions.saveWikiDraft'))
    )
    if (!openButton) throw new Error('Draft review button was not rendered')
    await clickAndSettle(openButton, () => Boolean(document.querySelector('.agent-answer-draft input')))
    const fields = document.querySelectorAll<HTMLInputElement>('.agent-answer-draft input')
    const titleField = fields[0]
    const pathField = fields[2]
    if (!titleField || !pathField) throw new Error('Editable draft location fields were not rendered')
    expect(titleField.value).toBe('Practical guide and notes')
    expect(pathField.value).toMatch(/^agent-notes\/practical-guide-and-notes-/)
    titleField.value = 'My reviewed title'
    titleField.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await Vue.nextTick()
    const closeButton = document.querySelector<HTMLButtonElement>(
      `.agent-answer-draft button[aria-label="${translateEnglish('common:agentAnswerActions.closeWikiDraftReview')}"]`
    )
    if (!closeButton) throw new Error('Draft review close button was not rendered')
    closeButton.click()
    await Vue.nextTick()
    openButton.click()
    await Vue.nextTick()
    expect(document.querySelector<HTMLInputElement>('.agent-answer-draft input')?.value).toBe('My reviewed title')
  })

  it('exports canonical Wiki numbers through duplicate and unsafe-reference gaps without dropping unused sources or merging Web metadata', async () => {
    setLocation('https://wiki.test/')
    const citations: readonly AgentCitation[] = [
      { evidenceId: 'unused', kind: 'page', label: 'Unused source', href: '/en/unused' },
      { evidenceId: 'unsafe', kind: 'page', label: 'Unsafe source', href: 'javascript:alert(1)' },
      { evidenceId: 'operations', kind: 'page', label: 'Operations [verified]', href: '/en/operations(v2)' },
      { evidenceId: 'operations', kind: 'page', label: 'Incorrect duplicate', href: '/en/forged' },
      { evidenceId: 'guide', kind: 'page', label: 'Guide', href: '/en/guide#installation' },
      { evidenceId: 'relative-network', kind: 'page', label: 'Network source', href: '//external.example/source' },
      { evidenceId: 'control', kind: 'page', label: 'Control source', href: '/en/\ncontrolled' },
      { evidenceId: 'quote', kind: 'page', label: 'Quoted source', href: '/en/"quoted' },
      { evidenceId: 'invalid', kind: 'page', label: 'Invalid source', href: 'http://[' },
      { evidenceId: 'missing', kind: 'page', label: 'Missing link', href: null },
      { evidenceId: 'unsafe', kind: 'page', label: 'Incorrect replacement', href: '/en/replacement' }
    ]
    const googleSearchGrounding: AgentGoogleSearchGrounding = {
      citations: [
        { title: 'Search metadata', url: 'https://search.example/result', startIndex: 0, endIndex: 8 },
        { title: 'Unsafe web link', url: 'data:text/plain,unsafe', startIndex: 0, endIndex: 8 }
      ]
    }
    let copiedText = ''
    Object.defineProperty(browserWindow.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copiedText = text
        }
      }
    })
    const host = await mount(AgentAnswerActions, {
      sessionId,
      messageId,
      content:
        'Operations.[[cite:operations]] Guide.[[cite:guide]] Again.[[cite:operations]] Unknown.[[cite:unknown]] Unsafe.[[cite:unsafe]] Network.[[cite:relative-network]] Control.[[cite:control]] Quoted.[[cite:quote]] Invalid.[[cite:invalid]] Missing.[[cite:missing]]',
      citations,
      googleSearchGrounding
    })
    const copyButton = host.querySelector<HTMLButtonElement>('.agent-answer-actions button')
    if (!copyButton) throw new Error('Copy answer button was not rendered')
    await clickAndSettle(copyButton, () => copiedText !== '')

    const exported = document.createElement('div')
    exported.innerHTML = renderSafeMarkdown(copiedText)
    const bodyLinks = [...(exported.querySelector('p')?.querySelectorAll('a') ?? [])]
    expect(bodyLinks.map(link => link.textContent)).toEqual(['3', '5', '3'])
    expect(bodyLinks.map(link => link.getAttribute('href'))).toEqual([
      'https://wiki.test/en/operations%28v2%29',
      'https://wiki.test/en/guide#installation',
      'https://wiki.test/en/operations%28v2%29'
    ])
    const sections = exported.querySelectorAll('h2')
    const wikiReferences = sections[0]?.nextElementSibling
    const webReferences = sections[1]?.nextElementSibling
    expect([...(wikiReferences?.querySelectorAll('li') ?? [])].map(item => item.textContent)).toEqual([
      '[1] Unused source',
      '[3] Operations [verified]',
      '[5] Guide'
    ])
    expect([...(wikiReferences?.querySelectorAll('a') ?? [])].map(link => link.getAttribute('href'))).toEqual([
      'https://wiki.test/en/unused',
      'https://wiki.test/en/operations%28v2%29',
      'https://wiki.test/en/guide#installation'
    ])
    expect(webReferences?.textContent).toContain('Search metadata')
    expect(webReferences?.querySelector('a')?.getAttribute('href')).toBe('https://search.example/result')
    expect(copiedText).toContain('1. [Search metadata](https://search.example/result)')
    expect(exported.textContent).not.toContain('Incorrect duplicate')
    expect(exported.textContent).not.toContain('Incorrect replacement')
    expect(exported.textContent).not.toContain('Unsafe web link')
    expect(copiedText).not.toContain('[[cite:')
    expect([...exported.querySelectorAll('a')]).toHaveLength(7)
  })

  it('reports legacy answer-copy success and then failure without leaving stale copied feedback or focus', async () => {
    Object.defineProperty(browserWindow.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('Provider secret must not appear')
        }
      }
    })
    let canCopy = true
    let copiedText = ''
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => {
        const helper = document.querySelector('textarea')
        if (!helper) throw new Error('No fallback answer text')
        copiedText = helper.value.slice(helper.selectionStart, helper.selectionEnd)
        helper.focus()
        return canCopy
      }
    })
    const host = await mount(AgentAnswerActions, { sessionId, messageId, content: 'Reviewed answer', citations: [] })
    const copyButton = host.querySelector<HTMLButtonElement>('.agent-answer-actions button')
    if (!copyButton) throw new Error('Copy answer button was not rendered')
    copyButton.focus()
    await clickAndSettle(
      copyButton,
      () => host.querySelector('[role="status"]')?.textContent === translateEnglish('common:agentAnswerActions.answerSourceLinksCopied')
    )

    expect(copiedText).toBe('Reviewed answer')
    expect(host.querySelector('[role="status"]')?.textContent).toBe(translateEnglish('common:agentAnswerActions.answerSourceLinksCopied'))
    expect(copyButton.textContent).toContain(translateEnglish('common:agentAnswerActions.copied'))
    expect(document.activeElement).toBe(copyButton)
    expect(document.querySelector('textarea')).toBeNull()

    canCopy = false
    await clickAndSettle(
      copyButton,
      () => host.querySelector('[role="status"]')?.textContent === translateEnglish('common:agentAnswerActions.copyUnavailableOpenDraft')
    )

    expect(host.querySelector('[role="status"]')?.textContent).toBe(translateEnglish('common:agentAnswerActions.copyUnavailableOpenDraft'))
    expect(copyButton.textContent).toContain(translateEnglish('common:agentAnswerActions.copyAnswer'))
    expect(host.textContent).not.toContain('Provider secret must not appear')
    expect(document.activeElement).toBe(copyButton)
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('refreshes localized Markdown shells without losing focus, scroll, disclosure, or active copy feedback', async () => {
    await i18next.init({
      lng: 'en',
      fallbackLng: 'en',
      ns: ['common'],
      defaultNS: 'common',
      resources: {
        en: JSON.parse(await Bun.file('server/locales/en.json').text()),
        fr: {
          common: {
            actions: { copy: 'Copier « <code> »' },
            agentThread: { opensNewTab: 'ouvre un autre onglet' },
            agentMarkdown: {
              scrollableCode: 'Code défilant {{language}}',
              scrollableTable: 'Tableau défilant',
              mermaidSource: 'Source du diagramme',
              copied: 'Copié pour test'
            }
          }
        }
      },
      interpolation: { escapeValue: false },
      initAsync: false
    })
    try {
      const host = await mount(
        AgentMarkdown,
        {
          content:
            '```ts\nconst source = "wiki"\n```\n\n| Source | Decision |\n| --- | --- |\n| Wiki | Review |\n\n```mermaid\nflowchart LR\nA --> B\n```\n\n[Reference](https://example.test/reference)',
          streaming: true
        },
        (key, options) => i18next.t(key, options) as string
      )
      const code = host.querySelector<HTMLPreElement>('pre')
      const table = host.querySelector<HTMLElement>('.agent-markdown__table-shell')
      const source = host.querySelector<HTMLDetailsElement>('.agent-markdown__diagram-source')
      const copy = host.querySelector<HTMLButtonElement>('[data-copy-code]')
      if (!code || !table || !source || !copy) throw new Error('Markdown reading controls were not rendered')
      expect(code.querySelector('code')?.textContent).toBe('const source = "wiki"\n')
      code.scrollLeft = 37
      table.scrollLeft = 23
      source.open = true
      copy.focus()
      const flushRender = async () => {
        await Vue.nextTick()
        await new Promise<void>(resolve => browserWindow.requestAnimationFrame(() => resolve()))
        await Vue.nextTick()
      }
      await i18next.changeLanguage('fr')
      await flushRender()
      const translatedCopy = host.querySelector<HTMLButtonElement>('[data-copy-code]')
      expect(translatedCopy?.textContent).toBe('Copier « <code> »')
      expect(translatedCopy?.querySelector('code')).toBeNull()
      expect(host.querySelector('pre')?.getAttribute('aria-label')).toBe('Code défilant ts')
      expect(host.querySelector('pre code')?.textContent).toBe('const source = "wiki"\n')
      expect(host.querySelector('.agent-markdown__table-shell')?.getAttribute('aria-label')).toBe('Tableau défilant')
      expect(host.querySelector('pre')?.scrollLeft).toBe(37)
      expect(host.querySelector('.agent-markdown__table-shell')?.scrollLeft).toBe(23)
      expect(host.querySelector<HTMLDetailsElement>('.agent-markdown__diagram-source')?.open).toBe(true)
      expect(document.activeElement).toBe(translatedCopy)
      if (!translatedCopy) throw new Error('Translated copy control disappeared')
      Object.defineProperty(browserWindow.navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } })
      await clickAndSettle(translatedCopy, () => translatedCopy.dataset.copyState === 'success')
      await i18next.changeLanguage('en')
      await flushRender()
      const restoredCopy = host.querySelector<HTMLButtonElement>('[data-copy-code]')
      expect(restoredCopy?.dataset.copyState).toBe('success')
      expect(restoredCopy?.textContent).toBe(translateEnglish('common:agentMarkdown.copied'))
      expect(document.activeElement).toBe(restoredCopy)
      const reference = host.querySelector<HTMLAnchorElement>('a[href="https://example.test/reference"]')
      if (!reference) throw new Error('External reference was not rendered')
      reference.focus()
      await i18next.changeLanguage('fr')
      await flushRender()
      const translatedReference = host.querySelector<HTMLAnchorElement>('a[href="https://example.test/reference"]')
      expect(translatedReference?.textContent).toContain('ouvre un autre onglet')
      expect(document.activeElement).toBe(translatedReference)
    } finally {
      await i18next.changeLanguage('en')
    }
  })

  it('copies only code through the legacy path and keeps success and failure feedback on the focused code button', async () => {
    Object.defineProperty(browserWindow.navigator, 'clipboard', { configurable: true, value: undefined })
    let canCopy = true
    let copiedText = ''
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => {
        const helper = document.querySelector('textarea')
        if (!helper) throw new Error('No fallback code text')
        copiedText = helper.value.slice(helper.selectionStart, helper.selectionEnd)
        helper.focus()
        return canCopy
      }
    })
    const host = await mount(AgentMarkdown, { content: 'Do not copy this prose.\n\n```ts\nconst answer = 42\n```' })
    const copyButton = host.querySelector<HTMLButtonElement>('[data-copy-code]')
    if (!copyButton) throw new Error('Code copy button was not rendered')
    copyButton.focus()
    await clickAndSettle(copyButton, () => copyButton.dataset.copyState === 'success')

    expect(copiedText).toBe('const answer = 42\n')
    expect(copyButton.dataset.copyState).toBe('success')
    expect(copyButton.textContent).toBe(translateEnglish('common:agentMarkdown.copied'))
    expect(document.activeElement).toBe(copyButton)
    expect(document.querySelector('textarea')).toBeNull()

    canCopy = false
    await clickAndSettle(copyButton, () => copyButton.dataset.copyState === 'error')

    expect(copyButton.dataset.copyState).toBe('error')
    expect(copyButton.textContent).toBe(translateEnglish('common:agentMarkdown.copyUnavailable'))
    expect(document.activeElement).toBe(copyButton)
    expect(document.querySelector('textarea')).toBeNull()
  })
})

const settleReview = async () => {
  for (let step = 0; step < 16; step++) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}
const reviewButton = (label: string, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)!
const openReview = async (host: HTMLElement) => {
  reviewButton(translateEnglish('common:agentAnswerActions.saveWikiDraft'), host).click()
  await settleReview()
}
const createReviewedDraft = async () => {
  document.querySelector<HTMLButtonElement>('.agent-answer-draft__create')?.click()
  await settleReview()
}
type ReceiptTransport = {
  create?: (input: PageWriteInput) => Promise<Response>
  status?: (requestId: string) => Promise<PageCreationStatus | Response>
  inventory?: (url: string) => Promise<PageCreationInventory | Response>
}
const installReceiptTransport = (transport: ReceiptTransport = {}) => {
  const writes: PageWriteInput[] = []
  const fetcher = vi.mocked(browserWindow.fetch).mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === PWA_SERVER_PROBE_PATH) return jsonResponse({})
    if (url === '/_api/pages' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as PageWriteInput
      writes.push(body)
      return transport.create ? transport.create(body) : jsonResponse({ page: { id: 71, sourceRevision: 3, updatedAt: '2026-10-22T00:00:00.000Z' } })
    }
    if (url.includes('/creation-origins/agent-answers/')) {
      const result = transport.inventory ? await transport.inventory(url) : emptyInventory
      return result instanceof Response ? result : jsonResponse(result)
    }
    if (url.includes('/creation-requests/')) {
      const requestId = url.split('/').at(-1)!
      const result = transport.status ? await transport.status(requestId) : receipt(requestId)
      return result instanceof Response ? result : jsonResponse(result)
    }
    throw new Error(`Unexpected receipt request: ${url}`)
  })
  return { writes, fetcher }
}
const answerProps = () =>
  Vue.reactive({
    sessionId,
    messageId,
    content: '# Reviewed answer\n\nAnswer text.[[cite:wiki]]',
    citations: [{ evidenceId: 'wiki', kind: 'page', label: 'Wiki source', href: '/en/source' }] as AgentCitation[]
  })

describe('Answer draft creation receipts', () => {
  it('retains edited citation Markdown and reconciles a lost success read-only without replaying the create', async () => {
    setLocation('https://wiki.test/')
    const status = vi.fn(async (requestId: string) => receipt(requestId))
    const { writes, fetcher } = installReceiptTransport({
      create: async () => {
        throw new TypeError('Success response lost')
      },
      status
    })
    const host = await mount(AgentAnswerActions, answerProps())
    await openReview(host)
    expect(writes).toHaveLength(0)
    reviewButton(translateEnglish('common:agentAnswerActions.editMarkdown')).click()
    await settleReview()
    const markdown = document.querySelector<HTMLTextAreaElement>('.agent-answer-draft textarea')!
    expect(markdown.value).toContain('- [1] [Wiki source](https://wiki.test/en/source)')
    markdown.value += '\n\nReviewed local edit'
    markdown.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await createReviewedDraft()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      content: markdown.value,
      visibility: 'private',
      isPublished: false,
      creationOrigin: { kind: 'agent-answer', sessionId, messageId },
      creationRequestId: expect.any(String)
    })
    const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(new Headers(post[1]?.headers).get(PAGE_CREATION_OWNER_HEADER)).toBe('1')
    expect(status).not.toHaveBeenCalled()
    expect(document.querySelector('.agent-answer-draft__create')).toBeNull()
    reviewButton(translateEnglish('common:agentAnswerActions.done')).click()
    await settleReview()
    await openReview(host)
    expect(document.querySelector<HTMLTextAreaElement>('.agent-answer-draft textarea')?.value).toContain('Reviewed local edit')
    expect(document.querySelector('.agent-answer-draft__create')).toBeNull()
    reviewButton('Check creation status').click()
    await settleReview()
    expect(status).toHaveBeenCalledTimes(1)
    expect(status).toHaveBeenCalledWith(writes[0].creationRequestId)
    expect(writes).toHaveLength(1)
    const saved = document.querySelector<HTMLElement>('.agent-answer-draft__receipt')!
    expect(saved.textContent).toContain('Current authorized draft')
    expect(saved.querySelector('strong')?.textContent).toContain('3')
    expect(saved.textContent).toMatch(/Current destination revision\s+11\b/u)
    expect(saved.querySelector('a')?.getAttribute('href')).toBe('/_private/en/actual/authorized-draft')
    expect(document.querySelector('.agent-answer-draft__create')).toBeNull()
  })

  for (const outcome of ['unknown', 'missing', 'malformed'] as const) {
    it(`does not allow another POST after a ${outcome} creation-status response`, async () => {
      const { writes } = installReceiptTransport({
        create: async () => {
          throw new TypeError('Lost response')
        },
        status: async requestId =>
          outcome === 'unknown'
            ? { status: 'unknown', requestId }
            : outcome === 'missing'
              ? jsonResponse({ error: 'Not available' }, 404)
              : jsonResponse({ status: 'committed', requestId })
      })
      const host = await mount(AgentAnswerActions, answerProps())
      await openReview(host)
      await createReviewedDraft()
      reviewButton('Check creation status').click()
      await settleReview()
      await createReviewedDraft()
      expect(writes).toHaveLength(1)
      expect(document.querySelector('.agent-answer-draft__create')).toBeNull()
      expect(reviewButton('Prepare another private draft')).toBeUndefined()
      expect(document.querySelector('.agent-answer-draft__receipt a')).toBeNull()
      reviewButton(translateEnglish('common:agentAnswerActions.editMarkdown')).click()
      await settleReview()
      expect(document.querySelector<HTMLTextAreaElement>('.agent-answer-draft textarea')?.value).toContain('Wiki source')
    })
  }

  it('allows a deliberate corrected attempt only after a parsed rejection and assigns a new request id', async () => {
    let attempts = 0
    const { writes } = installReceiptTransport({
      create: async () =>
        ++attempts === 1
          ? jsonResponse({ error: 'Destination occupied', code: 'PAGE_CONFLICT' }, 409)
          : jsonResponse({ page: { id: 71, sourceRevision: 3, updatedAt: '2026-10-22T00:00:00.000Z' } })
    })
    const host = await mount(AgentAnswerActions, answerProps())
    await openReview(host)
    await createReviewedDraft()
    expect(writes).toHaveLength(1)
    expect(document.querySelector<HTMLButtonElement>('.agent-answer-draft__create')?.disabled).toBe(false)
    const path = document.querySelectorAll<HTMLInputElement>('.agent-answer-draft input')[2]
    path.value = 'review/corrected-draft'
    path.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await createReviewedDraft()
    expect(writes).toHaveLength(2)
    expect(writes[1].creationRequestId).not.toBe(writes[0].creationRequestId)
    expect(writes[1]).toMatchObject({ path: 'review/corrected-draft', content: writes[0].content, creationOrigin: writes[0].creationOrigin })
    expect(document.querySelector('.agent-answer-draft__receipt a')).not.toBeNull()
  })

  it('reconciles PAGE_CREATION_ALREADY_COMMITTED instead of treating the conflict as a new-write opportunity', async () => {
    const status = vi.fn(async (requestId: string) => receipt(requestId, { destination: null }))
    const { writes } = installReceiptTransport({
      create: async () => jsonResponse({ error: 'Already created', code: 'PAGE_CREATION_ALREADY_COMMITTED' }, 409),
      status
    })
    const host = await mount(AgentAnswerActions, answerProps())
    await openReview(host)
    await createReviewedDraft()
    expect(status).toHaveBeenCalledTimes(1)
    expect(status).toHaveBeenCalledWith(writes[0].creationRequestId)
    expect(document.querySelector('.agent-answer-draft__create')).toBeNull()
    expect(document.querySelector('.agent-answer-draft__receipt a')).toBeNull()
    expect(document.querySelector('.agent-answer-draft__receipt')?.textContent).toContain('Creation is confirmed')
    await createReviewedDraft()
    expect(writes).toHaveLength(1)
  })

  it('finds multiple independent drafts by origin on reopen and requires an explicit new publication before another write', async () => {
    const earlier = receipt('1ce8ef11-12c4-4a45-a761-2743761911aa')
    const later = receipt('5f788aa1-a114-4c94-b52e-591e0f17c03a', {
      sourceRevision: '6',
      destination: { ...earlier.destination!, id: 72, sourceRevision: '15', path: 'renamed/second-draft', title: 'Second authorized draft' }
    })
    const inventory = vi.fn(async () => ({ ...emptyInventory, items: [later, earlier] }))
    const { writes } = installReceiptTransport({ inventory })
    const props = answerProps()
    const host = await mount(AgentAnswerActions, props)
    await openReview(host)
    expect(document.querySelectorAll('.agent-answer-draft__receipt')).toHaveLength(2)
    expect([...document.querySelectorAll('.agent-answer-draft__receipt a')].map(link => link.getAttribute('href'))).toEqual([
      '/_private/en/renamed/second-draft',
      '/_private/en/actual/authorized-draft'
    ])
    expect(document.querySelector('.agent-answer-draft__create')).toBeNull()
    reviewButton(translateEnglish('common:agentAnswerActions.done')).click()
    await settleReview()
    await openReview(host)
    expect(inventory).toHaveBeenCalledTimes(2)
    expect(writes).toHaveLength(0)
    reviewButton('Prepare another private draft').click()
    await settleReview()
    await createReviewedDraft()
    expect(writes).toHaveLength(1)
    expect([earlier.requestId, later.requestId]).not.toContain(writes[0].creationRequestId)
    expect(props.content).toBe('# Reviewed answer\n\nAnswer text.[[cite:wiki]]')
    expect(writes[0].content).toContain('Wiki source')
  })

  for (const boundary of ['identity', 'permission', 'source'] as const) {
    it(`clears revoked receipt destinations and ignores a late success after ${boundary} changes, retaining original-owner Markdown`, async () => {
      const pending = Promise.withResolvers<PageCreationStatus>()
      const earlier = receipt('1ce8ef11-12c4-4a45-a761-2743761911aa')
      let hasReceipt = false
      const { writes } = installReceiptTransport({
        inventory: async url => (url.endsWith(messageId) && hasReceipt ? { ...emptyInventory, items: [earlier] } : emptyInventory),
        create: async () => {
          throw new TypeError('Lost response')
        },
        status: () => pending.promise
      })
      const props = answerProps()
      const host = await mount(AgentAnswerActions, props)
      await openReview(host)
      reviewButton(translateEnglish('common:agentAnswerActions.editMarkdown')).click()
      await settleReview()
      const markdown = document.querySelector<HTMLTextAreaElement>('.agent-answer-draft textarea')!
      markdown.value += '\n\nPrivate local review'
      markdown.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
      await createReviewedDraft()
      hasReceipt = true
      reviewButton('Refresh earlier drafts').click()
      await settleReview()
      expect(document.querySelector('.agent-answer-draft__receipt')?.textContent).toContain('Current authorized draft')
      reviewButton('Check creation status').click()
      await settleReview()
      hasReceipt = false
      if (boundary === 'identity') wikiStore.user.id = 2
      else if (boundary === 'permission') wikiStore.user.permissions = []
      else props.messageId = 'b321a3ce-9ad7-4c45-b125-731d606e1a0e'
      await settleReview()
      expect(document.querySelector('.agent-answer-draft__receipt a')).toBeNull()
      pending.resolve(receipt(writes[0].creationRequestId!, { destination: { ...earlier.destination!, title: 'Late private receipt' } }))
      await settleReview()
      expect(document.body.textContent).not.toContain('Late private receipt')
      expect(document.querySelector('.agent-answer-draft__receipt a')).toBeNull()
      if (boundary === 'identity') wikiStore.user.id = 1
      else if (boundary === 'permission') wikiStore.user.permissions = ['write:pages']
      else props.messageId = messageId
      await settleReview()
      expect(document.querySelector<HTMLTextAreaElement>('.agent-answer-draft textarea')?.value).toContain('Private local review')
      await createReviewedDraft()
      expect(writes).toHaveLength(1)
    })
  }
})

for (const boundary of ['identity', 'permission', 'source'] as const) {
  it(`ignores a late POST success after answer ${boundary} loss instead of attaching it to the next actor or source`, async () => {
    const pending = Promise.withResolvers<Response>()
    const status = vi.fn(async (requestId: string) => receipt(requestId))
    const { writes } = installReceiptTransport({ create: () => pending.promise, status })
    const props = answerProps()
    const host = await mount(AgentAnswerActions, props)
    await openReview(host)
    reviewButton(translateEnglish('common:agentAnswerActions.editMarkdown')).click()
    await settleReview()
    const markdown = document.querySelector<HTMLTextAreaElement>('.agent-answer-draft textarea')!
    markdown.value += '\n\nRetained before late write'
    markdown.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await createReviewedDraft()
    expect(writes).toHaveLength(1)
    if (boundary === 'identity') wikiStore.user.id = 2
    else if (boundary === 'permission') wikiStore.user.permissions = []
    else props.messageId = 'b321a3ce-9ad7-4c45-b125-731d606e1a0e'
    await settleReview()
    pending.resolve(jsonResponse({ page: { id: 999, sourceRevision: 23, updatedAt: '2026-10-22T00:00:00.000Z' } }))
    await settleReview()
    expect(status).not.toHaveBeenCalled()
    expect(document.querySelector('.agent-answer-draft__receipt')).toBeNull()
    if (boundary === 'identity') wikiStore.user.id = 1
    else if (boundary === 'permission') wikiStore.user.permissions = ['write:pages']
    else props.messageId = messageId
    await settleReview()
    expect(document.querySelector<HTMLTextAreaElement>('.agent-answer-draft textarea')?.value).toContain('Retained before late write')
    await createReviewedDraft()
    expect(writes).toHaveLength(1)
  })
}

it('keeps a malformed 4xx write response uncertain instead of enabling another answer draft POST', async () => {
  const { writes } = installReceiptTransport({ create: async () => jsonResponse({}, 409) })
  const host = await mount(AgentAnswerActions, answerProps())
  await openReview(host)
  await createReviewedDraft()
  expect(document.querySelector('.agent-answer-draft__create')).toBeNull()
  expect(reviewButton('Check creation status')).toBeDefined()
  await createReviewedDraft()
  expect(writes).toHaveLength(1)
})
