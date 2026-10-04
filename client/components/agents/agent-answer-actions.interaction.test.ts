import path from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import i18next from 'i18next'
import type { Component } from 'vue'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import type { AgentCitation, AgentGoogleSearchGrounding } from '../../../shared/agents/contracts.ts'
import { browserWindow, document, resetBody, setLocation } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import { renderSafeMarkdown } from '../../helpers/safe-markdown.ts'

resetBody()
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
})

describe('Answer export and clipboard interactions', () => {
  it('derives a plain editable draft title and retains edits when the review is hidden', async () => {
    const host = await mount(AgentAnswerActions, {
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
    const host = await mount(AgentAnswerActions, { content: 'Reviewed answer', citations: [] })
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
