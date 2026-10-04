import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, document, resetBody, setLocation } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
globalThis.translate = translateEnglish
;globalThis.useTranslate = () => translateEnglish
import type { App } from 'vue'
import type { MoveLinkReviewInput, MoveLinkReviewResponse, PageTreeRow } from '../../helpers/pages-api.ts'
import type { wikiStore as WikiStoreInstance } from '../../store/index.ts'


resetBody()
setLocation('/en/docs/current')

const globals = globalThis as typeof globalThis & {
  siteConfig: { lang: string }
  siteLangs: Array<{ code: string; name: string }>
}
globals.siteConfig = { lang: 'en' }
globals.siteLangs = []
// The actual store reads window.siteConfig during module initialization.
// Static import would execute before this supported application fixture exists.
const importConfig = Object.getOwnPropertyDescriptor(browserWindow, 'siteConfig')
Object.defineProperty(browserWindow, 'siteConfig', {
  configurable: true,
  value: {
    company: '', contentLicense: '', footerOverride: '', banner: {}, darkMode: false,
    tocPosition: 'left', title: 'Page selector verification', logoUrl: '',
    product: { name: 'tsEpistle', version: 'test' }
  }
})
let wikiStore: typeof WikiStoreInstance
try {
  ;({ wikiStore } = await import('../../store/index.ts'))
} finally {
  if (importConfig) Object.defineProperty(browserWindow, 'siteConfig', importConfig)
  else Reflect.deleteProperty(browserWindow, 'siteConfig')
}

const Vue = await import('vue')
// Vuetify captures browser capabilities; load it only after the test DOM exists.
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')
Bun.plugin({
  name: 'page-selector-real-sfc',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, ({ path: filename }) => ({ path: path.join(process.cwd(), 'client', filename.slice(2)) }))
    builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const script = compileScript(parsed.descriptor, {
        id: 'page-selector-presentation-test',
        genDefaultAs: '__component',
        inlineTemplate: Boolean(parsed.descriptor.scriptSetup)
      })
      if (parsed.descriptor.scriptSetup) return { loader: 'ts', contents: `${script.content}\nexport default __component;` }
      if (!parsed.descriptor.template) throw new Error(`Missing template in ${filename}`)
      const template = compileTemplate({
        filename,
        id: 'page-selector-presentation-test',
        source: parsed.descriptor.template.content,
        preprocessLang: parsed.descriptor.template.lang,
        preprocessOptions: { doctype: 'html' },
        compilerOptions: { bindingMetadata: script.bindings }
      })
      if (template.errors.length) throw template.errors[0]
      return { loader: 'ts', contents: `${script.content}\n${template.code}\n__component.render = render;\nexport default __component;` }
    })
  }
})
// The SFC loader must be registered before the actual selector and child load.
const PageSelector = (await import('./page-selector.vue')).default

let app: App | undefined
let rows: PageTreeRow[] = []
let moveReviewHandler: (pageId: number, input: MoveLinkReviewInput) => Promise<MoveLinkReviewResponse> = async () => ({
  schemaVersion: 1,
  items: [],
  nextCursor: null,
  coverageNotice: 'Only currently source-readable candidates are listed.'
})
afterEach(() => {
  app?.unmount()
  app = undefined
  moveReviewHandler = async () => ({
    schemaVersion: 1,
    items: [],
    nextCursor: null,
    coverageNotice: 'Only currently source-readable candidates are listed.'
  })
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}

const mountSelector = async (initialRows: PageTreeRow[], selectorProps: Record<string, unknown> = {}) => {
  rows = initialRows
  wikiStore.page.title = 'Current page'
  wikiStore.page.path = 'docs/current'
  wikiStore.page.locale = 'en'
  vi.spyOn(browserWindow, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), browserWindow.location.href)
    if (url.pathname === '/_api/pages/tree') return Response.json(rows)
    const review = /^\/_api\/pages\/(\d+)\/move\/review$/.exec(url.pathname)
    if (review && init?.method === 'POST') {
      return Response.json(await moveReviewHandler(Number(review[1]), JSON.parse(String(init.body)) as MoveLinkReviewInput))
    }
    throw new Error(`Unexpected page-selector request: ${init?.method ?? 'GET'} ${url.pathname}`)
  })
  const host = document.createElement('div')
  document.body.append(host)
  app = Vue.createApp(PageSelector, {
    modelValue: true,
    mode: 'select',
    mustExist: true,
    path: 'docs/current',
    locale: 'en',
    ...selectorProps
  })
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.config.globalProperties.$t = translateEnglish
  const instance = app.mount(host) as unknown as {
    currentLocale: string
    currentPath: string | null
  }
  await settle()
  await vi.waitFor(() => expect(document.querySelector('.page-selector')).not.toBeNull())
  await settle()
  return { host: document.body, instance }
}

const page = (id: number, path: string, title: string): PageTreeRow => ({
  id,
  path,
  title,
  isFolder: false,
  pageId: id,
  parent: 0,
  locale: 'en',
  visibility: 'public',
  ownerId: null,
  canEdit: true,
})

describe('Browse page selector presentation', () => {
  test('keeps current and selected pages distinct and gives an empty folder a visible state', async () => {
    const { host, instance } = await mountSelector([page(11, 'docs/current', 'Current page'), page(12, 'docs/other', 'Another page')])
    const foldersHeading = host.querySelector<HTMLElement>('.page-selector__folders-label')
    const foldersRegion = host.querySelector<HTMLElement>('.page-selector__tree-pane [role="region"]')
    const pagesHeading = host.querySelector<HTMLElement>('.page-selector__pages-pane h3')
    const pagesRegion = host.querySelector<HTMLElement>('.page-selector__pages-pane [role="region"]')
    expect(foldersHeading?.id).toBeTruthy()
    expect(foldersRegion?.getAttribute('aria-labelledby')).toBe(foldersHeading?.id)
    expect(host.querySelector('.page-selector__tree')?.getAttribute('aria-labelledby')).toBe(foldersHeading?.id)
    expect(pagesHeading?.id).toBeTruthy()
    expect(pagesRegion?.getAttribute('aria-labelledby')).toBe(pagesHeading?.id)
    expect(host.querySelector('.page-selector__pages-list')?.getAttribute('aria-labelledby')).toBe(pagesHeading?.id)

    const current = host.querySelector<HTMLElement>('.page-selector__page--current')
    expect(current?.textContent).toContain('Current page')
    expect(current?.getAttribute('aria-current')).toBe('page')
    expect(host.querySelector('.page-selector__page--selected')).toBeNull()
    expect(host.querySelector('[data-selection-state="none"]')).not.toBeNull()

    const other = Array.from(host.querySelectorAll<HTMLElement>('.page-selector__pages-list .v-list-item')).find(item => item.textContent?.includes('Another page'))
    expect(other).toBeDefined()
    other!.click()
    await settle()

    const selected = host.querySelector<HTMLElement>('.page-selector__page--selected')
    expect(selected?.textContent).toContain('Another page')
    expect(selected?.getAttribute('aria-current')).toBeNull()
    expect(host.querySelector('.page-selector__page--current')?.textContent).toContain('Current page')
    expect(host.querySelector('[data-selection-state="selected"]')).not.toBeNull()

    rows = []
    instance.currentLocale = 'fr'
    await settle()
    await vi.waitFor(() => expect(host.querySelector('.async-state--empty')).not.toBeNull())
    const emptyState = host.querySelector('.async-state--empty')
    expect(emptyState?.getAttribute('role')).toBe('status')
    expect(emptyState?.getAttribute('aria-live')).toBe('polite')
    expect(emptyState?.querySelector('.async-state__title')?.textContent).toBe(translateEnglish('common:pageSelector.folderEmptyWarning'))
    expect(host.querySelector('[data-selection-state]')).toBeNull()
  })
  test('reviews selected source diffs before moving and keeps the committed receipt until acknowledged', async () => {
    const item = {
      id: 21,
      title: 'Referrer page',
      locale: 'en',
      path: 'docs/referrer',
      sourceRevision: '7',
      eligible: true,
      changes: [{ before: '[Release notes](/en/docs/current)', after: '[Release notes](/en/docs/archive)' }]
    }
    const sameTitleItem = {
      ...item,
      id: 23,
      locale: 'fr',
      path: 'guides/referrer',
      sourceRevision: '12'
    }
    const selfLink = {
      id: 10,
      title: 'Moved page',
      locale: 'en',
      path: 'docs/current',
      sourceRevision: '5',
      eligible: true,
      reason: 'Automatically included with the moved page.',
      changes: [{ before: '[Current](/en/docs/current)', after: '[Current](/en/docs/archive)' }]
    }
    const requests: Array<{ pageId: number, input: MoveLinkReviewInput }> = []
    moveReviewHandler = async (pageId, input) => {
      requests.push({ pageId, input })
      return {
        schemaVersion: 1,
        items: input.selectedPageIds === undefined ? [selfLink, item, sameTitleItem] : [item, sameTitleItem, selfLink],
        nextCursor: null,
        coverageNotice: 'Only currently source-readable candidates are listed.',
        ...(input.selectedPageIds === undefined ? {} : { reviewToken: 'signed-review-token' })
      }
    }
    const receipt = {
      message: 'Page has been moved.' as const,
      pageId: 10,
      sourceRevision: '6',
      updated: [{ id: 21, sourceRevision: '8' }, { id: 23, sourceRevision: '13' }],
      projections: 'pending' as const
    }
    let submittedMove: {
      locale: string
      path: string
      sourcePageId?: number
      expectedSourceRevision?: string
      reviewToken?: string
    } | null = null
    let acknowledgement: unknown
    const { host, instance } = await mountSelector([page(22, 'docs/other', 'Another page')], {
      mode: 'move',
      mustExist: false,
      path: 'docs/archive',
      locale: 'en',
      sourcePageId: 10,
      sourceSourceRevision: '5',
      sourceVisibility: 'public',
      openHandler: (selection: {
        locale: string
        path: string
        sourcePageId?: number
        expectedSourceRevision?: string
        reviewToken?: string
      }) => {
        submittedMove = {
          locale: selection.locale,
          path: selection.path,
          sourcePageId: selection.sourcePageId,
          expectedSourceRevision: selection.expectedSourceRevision,
          reviewToken: selection.reviewToken
        }
        return selection.reviewToken ? receipt : undefined
      },
      onMoveAcknowledged: (value: unknown) => { acknowledgement = value }
    })
    const clickButton = async (label: string): Promise<void> => {
      const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
        .find(candidate => candidate.textContent?.trim() === label)
      if (!button) throw new Error(`Button "${label}" did not render`)
      button.click()
      await settle()
    }
    const option = host.querySelector<HTMLInputElement>('.page-selector__repair-toggle input')
    expect(option?.checked).toBe(false)
    expect(option?.getAttribute('aria-describedby')).toBeTruthy()
    option!.checked = true
    option!.dispatchEvent(new browserWindow.Event('change', { bubbles: true }))
    await settle()

    await clickButton('Find incoming links')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.pageId).toBe(10)
    expect(requests[0]?.input).toEqual({
      destinationLocale: 'en',
      destinationPath: 'docs/archive',
      expectedSourceRevision: '5'
    })
    const candidates = host.querySelectorAll<HTMLInputElement>('.page-selector__candidate input[aria-label^="Select Referrer page"]')
    expect(candidates).toHaveLength(2)
    for (const candidate of candidates) {
      candidate.checked = true
      candidate.dispatchEvent(new browserWindow.Event('change', { bubbles: true }))
    }
    await settle()
    const referrerCard = Array.from(host.querySelectorAll('.page-selector__candidate'))
      .find(card => card.querySelector('.page-selector__candidate-title')?.textContent === 'Referrer page')
    expect(referrerCard?.querySelector('.page-selector__diff')?.textContent).toContain('[Release notes](/en/docs/current)')
    expect(referrerCard?.querySelector('.page-selector__diff')?.textContent).toContain('[Release notes](/en/docs/archive)')
    const selfLinkCard = Array.from(host.querySelectorAll('.page-selector__candidate'))
      .find(card => card.querySelector('.page-selector__candidate-title')?.textContent === 'Moved page')
    expect(selfLinkCard?.querySelector('.page-selector__diff')?.textContent).toContain('[Current](/en/docs/current)')
    expect(selfLinkCard?.querySelector('.page-selector__diff')?.textContent).toContain('[Current](/en/docs/archive)')
    expect(selfLinkCard?.querySelector('input[type="checkbox"]')).toBeNull()

    await clickButton('Review selected changes')
    expect(requests[1]?.input.selectedPageIds?.toSorted()).toEqual([21, 23])
    const confirmation = host.querySelector('section.page-selector__link-review')
    const confirmationHeading = confirmation?.querySelector('h3')
    expect(confirmationHeading?.id).toBeTruthy()
    expect(confirmation?.getAttribute('aria-labelledby')).toBe(confirmationHeading?.id)
    const confirmationCards = Array.from(confirmation?.querySelectorAll('.page-selector__candidate') ?? [])
    expect(confirmationCards).toHaveLength(3)
    for (const expected of [item, sameTitleItem, selfLink]) {
      const card = confirmationCards.find(candidate => candidate.querySelector('.page-selector__candidate-location')?.textContent?.includes(`${expected.locale} / ${expected.path}`))
      expect(card).toBeDefined()
      expect(card?.querySelector('.page-selector__candidate-title')?.textContent).toBe(expected.title)
      expect(card?.querySelector('.page-selector__candidate-location')?.textContent).toContain(`revision ${expected.sourceRevision}`)
      const diff = Array.from(card?.querySelectorAll('.page-selector__diff code') ?? [], code => code.textContent)
      expect(diff).toHaveLength(expected.changes.length * 2)
      expect(diff).toEqual(expect.arrayContaining(expected.changes.flatMap(change => [change.before, change.after])))
    }

    await clickButton('Move and update selected links')
    expect(submittedMove).toEqual({
      locale: 'en',
      path: 'docs/archive',
      sourcePageId: 10,
      expectedSourceRevision: '5',
      reviewToken: 'signed-review-token'
    })
    expect(host.querySelector('.page-selector__move-result')?.textContent).toContain('source revision 6')
    expect(host.querySelector('.page-selector__projection-notice')?.textContent).toContain('pending')
    expect(acknowledgement).toBeUndefined()
    instance.currentLocale = 'fr'
    instance.currentPath = 'docs/another-destination'
    await settle()
    expect(instance.currentLocale).toBe('en')
    expect(instance.currentPath).toBe('docs/archive')
    expect(host.querySelector<HTMLInputElement>('.page-selector__options input[aria-label="Page path"]')?.disabled).toBe(true)
    expect(host.querySelector('.page-selector__move-result')?.textContent).toContain('source revision 6')

    await clickButton('Done')
    expect(acknowledgement).toEqual({
      locale: 'en',
      path: 'docs/archive',
      receipt
    })
  })

  test('shows a rejected ordinary move as an error instead of closing as if it succeeded', async () => {
    const moveError = Object.assign(new Error('Move conflict'), { status: 409 })
    const { host } = await mountSelector([], {
      mode: 'move',
      mustExist: false,
      path: 'docs/archive',
      locale: 'en',
      sourcePageId: 10,
      sourceSourceRevision: '5',
      sourceVisibility: 'public',
      openHandler: async () => { throw moveError }
    })
    const option = host.querySelector<HTMLInputElement>('.page-selector__repair-toggle input')
    expect(option?.checked).toBe(false)
    const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find(candidate => candidate.textContent?.trim() === translateEnglish('common:header.move'))
    expect(button).not.toBeNull()
    button!.click()
    await settle()

    expect(host.querySelector('.page-selector__submission-error')?.textContent).toContain('Move conflict')
    expect(host.querySelector('.page-selector__move-result')).toBeNull()
    expect(host.querySelector('.page-selector')).not.toBeNull()
  })

  test('requires a refresh after an uncertain move and does not retry automatically', async () => {
    let submissions = 0
    const { host } = await mountSelector([], {
      mode: 'move',
      mustExist: false,
      path: 'docs/archive',
      locale: 'en',
      sourcePageId: 10,
      sourceSourceRevision: '5',
      sourceVisibility: 'public',
      openHandler: async () => {
        submissions += 1
        throw new Error('Connection lost')
      }
    })
    const submit = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find(candidate => candidate.textContent?.trim() === translateEnglish('common:header.move'))
    if (!submit) throw new Error('Move action did not render')
    submit.click()
    await settle()

    expect(submissions).toBe(1)
    const uncertainAlert = host.querySelector('section.page-selector__link-review[role="alert"]')
    const uncertainHeading = uncertainAlert?.querySelector('h3')
    expect(uncertainAlert).not.toBeNull()
    expect(uncertainHeading?.id).toBeTruthy()
    expect(uncertainAlert?.getAttribute('aria-labelledby')).toBe(uncertainHeading?.id)
    expect(Array.from(uncertainAlert?.querySelectorAll('button') ?? [], button => button.textContent?.trim())).toEqual(['Refresh page'])
    expect(host.querySelector('.page-selector__move-result')).toBeNull()
    expect(Array.from(host.querySelectorAll('button')).some(button => button.textContent?.trim() === 'Refresh page')).toBe(true)
    expect(Array.from(host.querySelectorAll('button')).some(button => button.textContent?.trim() === translateEnglish('common:header.move'))).toBe(false)
    const moveActions = host.querySelector('.page-selector__chin')
    expect(moveActions).not.toBeNull()
    expect(Array.from(moveActions!.querySelectorAll<HTMLButtonElement>('button'))
      .filter(button => !button.disabled)
      .every(button => button.textContent?.trim() === 'Refresh page')).toBe(true)
    expect(submissions).toBe(1)
  })
})
