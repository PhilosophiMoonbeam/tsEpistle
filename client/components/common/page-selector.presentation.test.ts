import { compileTemplate, parse } from '@vue/compiler-sfc'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, document, resetBody, setLocation } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import type { App, ComponentOptions, PropType, RenderFunction } from 'vue'
import { fetchPageTree as fetchNativePageTree } from '../../helpers/pages-api.ts'
import type { MoveLinkReviewInput, MoveLinkReviewResponse, PageTreeRow } from '../../helpers/pages-api.ts'
import { installVuetifyFixture } from '../../test/vuetify-fixture.mts'

const filename = join(process.cwd(), 'client/components/common/page-selector.vue')
const parsed = parse(readFileSync(filename, 'utf8'), { filename })
if (parsed.errors.length > 0 || !parsed.descriptor.template || !parsed.descriptor.script) {
  throw new Error(`Cannot parse page-selector.vue: ${parsed.errors.join(', ')}`)
}

resetBody()
setLocation('/en/docs/current')

const globals = globalThis as typeof globalThis & {
  siteConfig: { lang: string }
  siteLangs: Array<{ code: string; name: string }>
}
globals.siteConfig = { lang: 'en' }
globals.siteLangs = []

// Vuetify snapshots browser capabilities, so module loading follows the shared DOM harness.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const { VTreeview } = await import('vuetify/components/VTreeview')
const compiled = compileTemplate({
  filename,
  id: 'page-selector-presentation-test',
  source: parsed.descriptor.template.content,
  preprocessLang: parsed.descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
if (compiled.errors.length > 0) throw new Error(`Cannot compile page-selector.vue: ${compiled.errors.join(', ')}`)
const render = new Function('Vue', compiled.code)(Vue) as RenderFunction
const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  parsed.descriptor.script.content.replace(/^import[\s\S]*?from ['"][^'"]+[''];?\s*$/gm, '').replace('export default', 'return')
)

const passthrough = (tag = 'div') =>
  Vue.defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => Vue.h(tag, attrs, [slots.default?.(), slots.append?.()])
    }
  })

const AsyncState = Vue.defineComponent({
  props: {
    state: { type: String, required: true },
    title: { type: String, required: true },
    message: { type: String, default: '' }
  },
  setup(props) {
    return () =>
      Vue.h(
        'div',
        {
          class: ['async-state', `async-state--${props.state}`],
          'data-state': props.state,
          role: 'status'
        },
        [Vue.h('strong', props.title), props.message ? Vue.h('span', props.message) : undefined]
      )
  }
})

const listActivationKey = Symbol('page-selector-list-activation')
const VList = Vue.defineComponent({
  inheritAttrs: false,
  props: {
    activated: { type: Array as PropType<number[]>, default: () => [] }
  },
  emits: ['update:activated'],
  setup(_props, { attrs, emit, slots }) {
    Vue.provide(listActivationKey, (value: number) => emit('update:activated', [value]))
    return () => Vue.h('div', { ...attrs, class: ['v-list', attrs.class] }, slots.default?.())
  }
})
const VListItem = Vue.defineComponent({
  inheritAttrs: false,
  props: { value: { type: Number, required: true } },
  setup(props, { attrs, slots }) {
    const activate = Vue.inject<(value: number) => void>(listActivationKey)
    return () =>
      Vue.h(
        'button',
        {
          ...attrs,
          type: 'button',
          'data-value': props.value,
          onClick: () => activate?.(props.value)
        },
        [slots.prepend?.({}), slots.default?.({})]
      )
  }
})

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
  document.body.replaceChildren()
})

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Vue.nextTick()
  await Promise.resolve()
  await Vue.nextTick()
}

const mountSelector = async (
  initialRows: PageTreeRow[],
  selectorProps: Record<string, unknown> = {},
  options: { realTree?: boolean; treeFetch?: Parameters<typeof fetchNativePageTree>[0] } = {}
) => {
  rows = initialRows
  const treeFetch = options.treeFetch
  const fetchPageTree: typeof fetchNativePageTree = treeFetch ? (_fetchImpl, query) => fetchNativePageTree(treeFetch, query) : async () => rows
  const fetchMoveLinkReview = (_fetchImpl: unknown, pageId: number, input: MoveLinkReviewInput): Promise<MoveLinkReviewResponse> =>
    moveReviewHandler(pageId, input)
  const getErrorMessage = (error: unknown): string => String(error)
  const mountedSelector = new Function(
    'defineComponent',
    'markRaw',
    'useId',
    'fetchPageTree',
    'fetchMoveLinkReview',
    'getErrorMessage',
    'AsyncState',
    'translate',
    executableScript
  )(Vue.defineComponent, Vue.markRaw, Vue.useId, fetchPageTree, fetchMoveLinkReview, getErrorMessage, AsyncState, translateEnglish) as ComponentOptions
  mountedSelector.render = render
  const host = document.createElement('div')
  document.body.append(host)
  app = Vue.createApp(mountedSelector, {
    modelValue: true,
    mode: 'select',
    mustExist: true,
    path: 'docs/current',
    locale: 'en',
    ...selectorProps
  })
  if (options.realTree) app.use(createVuetify({ components: { VTreeview } }))
  for (const name of ['v-card', 'v-col', 'v-icon', 'v-progress-circular', 'v-row', 'v-select', 'v-spacer', 'v-text-field', 'v-toolbar', 'vue-scroll'])
    app.component(name, passthrough())
  app.component('v-alert', passthrough())
  app.component('v-btn', passthrough('button'))
  app.component('v-card-actions', passthrough())
  app.component('v-card-chin', passthrough())
  app.component('v-dialog', passthrough())
  app.component('v-list', VList)
  app.component('v-list-item', VListItem)
  app.component('v-list-item-title', passthrough('span'))
  app.component('v-tooltip', passthrough())
  if (!options.realTree) app.component('v-treeview', passthrough())
  app.config.globalProperties.$t = translateEnglish
  if (!options.realTree) installVuetifyFixture(app)
  const instance = app.mount(host) as unknown as {
    currentLocale: string
    currentPath: string | null
  }
  await settle()
  return { host, instance }
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
  canEdit: true
})

const folder = (id: number, path: string, title: string, parent = 0): PageTreeRow => ({
  id,
  path,
  title,
  isFolder: true,
  pageId: null,
  parent,
  locale: 'en',
  visibility: 'private',
  ownerId: 7,
  canEdit: true
})

const treeResponse = (items: PageTreeRow[]): Response => new Response(JSON.stringify(items), { headers: { 'Content-Type': 'application/json' } })

const treeItem = (host: HTMLElement, title: string): HTMLElement => {
  const item = Array.from(host.querySelectorAll<HTMLElement>('.page-selector__tree [role="treeitem"]')).find(
    candidate => candidate.querySelector('.v-list-item-title')?.textContent === title
  )
  if (!item) throw new Error(`Folder "${title}" did not render`)
  return item
}

describe('Browse page selector presentation', () => {
  test('renders asynchronous native folders without toggling and loads an activated folder through the real tree', async () => {
    const rootReply = Promise.withResolvers<Response>()
    const childReply = Promise.withResolvers<Response>()
    const requests: number[] = []
    let submitted: unknown
    const { host } = await mountSelector(
      [],
      {
        openHandler: (selection: unknown) => {
          submitted = selection
        }
      },
      {
        realTree: true,
        treeFetch: url => {
          const parent = Number(new URL(url, 'http://localhost').searchParams.get('parent'))
          requests.push(parent)
          if (parent === 0) return rootReply.promise
          if (parent === 1) return childReply.promise
          throw new Error(`Unexpected folder request ${parent}`)
        }
      }
    )
    expect(host.querySelector('.page-selector__tree[role="tree"]')).not.toBeNull()
    expect(host.querySelectorAll('.page-selector__tree [role="treeitem"]')).toHaveLength(1)
    expect(requests).toEqual([0])

    rootReply.resolve(treeResponse([folder(1, 'owned-docs', 'Owned documentation'), page(11, 'docs/current', 'Current page')]))
    await vi.waitFor(() => expect(treeItem(host, 'Owned documentation')).not.toBeNull())
    expect(requests).toEqual([0])

    treeItem(host, 'Owned documentation').click()
    await vi.waitFor(() => {
      expect(requests).toEqual([0, 1])
      expect(host.querySelector('.page-selector__pages-pane [data-state="loading"]')).not.toBeNull()
    })
    treeItem(host, 'Owned documentation').querySelector<HTMLButtonElement>('button')!.click()
    await settle()
    treeItem(host, 'Owned documentation').querySelector<HTMLButtonElement>('button')!.click()
    await settle()
    treeItem(host, translateEnglish('common:pageSelector.root')).click()
    await settle()
    treeItem(host, 'Owned documentation').click()
    await settle()
    expect(requests).toEqual([0, 1])

    childReply.resolve(
      treeResponse([
        folder(2, 'owned-docs/nested', 'Nested documentation', 1),
        { ...page(41, 'owned-docs/exact', 'Exact owned page'), pageId: 741, parent: 1, visibility: 'private', ownerId: 7 }
      ])
    )
    await vi.waitFor(() => {
      expect(treeItem(host, 'Nested documentation')).not.toBeNull()
      expect(host.querySelector('.page-selector__pages-list [data-value="41"]')?.textContent).toContain('Exact owned page')
    })
    expect(host.querySelector('.page-selector__pages-list')?.textContent).not.toContain('Current page')
    host.querySelector<HTMLButtonElement>('.page-selector__pages-list [data-value="41"]')!.click()
    await settle()
    expect(host.querySelector('.page-selector__page--selected')?.textContent).toContain('Exact owned page')
    expect(host.querySelector('.page-selector__selection-summary')?.textContent).toContain('/en/owned-docs/exact')
    const select = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.trim() === 'Select')
    expect(select?.disabled).toBe(false)
    select!.click()
    await settle()
    expect(submitted).toEqual({ locale: 'en', path: 'owned-docs/exact', id: 741, visibility: 'private' })
    expect(requests).toEqual([0, 1])
  })

  const mismatchedChildren: Array<[string, Partial<PageTreeRow>]> = [
    ['another canonical branch', { path: 'workspace/private-code' }],
    ['a deeper descendant instead of a direct child', { path: 'owned-docs/nested/exact' }],
    ['another private owner at the same path', { ownerId: 8 }],
    ['another visibility at the same path', { visibility: 'public', ownerId: null }]
  ]
  test.each(mismatchedChildren)('refuses %s from a stale native parent and retries only on explicit request', async (_description, changes) => {
    const firstChild = Promise.withResolvers<Response>()
    const retryChild = Promise.withResolvers<Response>()
    const requests: number[] = []
    let childAttempts = 0
    const exactPage: PageTreeRow = {
      ...page(41, 'owned-docs/exact', 'Exact owned page'),
      pageId: 741,
      parent: 1,
      visibility: 'private',
      ownerId: 7
    }
    const { host } = await mountSelector(
      [],
      {},
      {
        realTree: true,
        treeFetch: url => {
          const parent = Number(new URL(url, 'http://localhost').searchParams.get('parent'))
          requests.push(parent)
          if (parent === 0) return Promise.resolve(treeResponse([folder(1, 'owned-docs', 'Owned documentation')]))
          if (parent !== 1) throw new Error(`Unexpected folder request ${parent}`)
          childAttempts += 1
          if (childAttempts === 1) return firstChild.promise
          if (childAttempts === 2) return retryChild.promise
          throw new Error('The failed folder retried without an explicit request')
        }
      }
    )
    await vi.waitFor(() => expect(treeItem(host, 'Owned documentation')).not.toBeNull())
    treeItem(host, 'Owned documentation').click()
    await vi.waitFor(() => expect(childAttempts).toBe(1))
    firstChild.resolve(treeResponse([{ ...exactPage, ...changes }]))
    await vi.waitFor(() => expect(host.querySelector('.page-selector__pages-pane [data-state="error"]')).not.toBeNull())
    expect(host.querySelector('.page-selector__pages-list')).toBeNull()
    expect(host.querySelector('[data-selection-state="selected"]')).toBeNull()

    treeItem(host, translateEnglish('common:pageSelector.root')).click()
    await settle()
    treeItem(host, 'Owned documentation').click()
    await settle()
    treeItem(host, 'Owned documentation').querySelector<HTMLButtonElement>('button')!.click()
    await settle()
    treeItem(host, 'Owned documentation').querySelector<HTMLButtonElement>('button')!.click()
    await settle()
    expect(requests).toEqual([0, 1])
    expect(host.querySelector('.page-selector__pages-pane [data-state="error"]')).not.toBeNull()

    const retry = host.querySelector<HTMLButtonElement>('.page-selector__folder-error button')
    expect(retry).not.toBeNull()
    retry!.click()
    retry!.click()
    await vi.waitFor(() => expect(requests).toEqual([0, 1, 1]))
    retryChild.resolve(treeResponse([exactPage]))
    await vi.waitFor(() => expect(host.querySelector('.page-selector__pages-list [data-value="41"]')?.textContent).toContain('Exact owned page'))
    expect(host.querySelector('.page-selector__folder-error')).toBeNull()
    expect(host.querySelector('.page-selector__pages-pane [data-state="error"]')).toBeNull()
    expect(requests).toEqual([0, 1, 1])
  })

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

    const other = host.querySelector<HTMLButtonElement>('[data-value="12"]')
    expect(other).not.toBeNull()
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
    expect(host.querySelector('.async-state--empty')?.getAttribute('data-state')).toBe('empty')
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
    const requests: Array<{ pageId: number; input: MoveLinkReviewInput }> = []
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
      updated: [
        { id: 21, sourceRevision: '8' },
        { id: 23, sourceRevision: '13' }
      ],
      projections: 'pending' as const
    }
    const submittedMove: { value: {
      locale: string
      path: string
      sourcePageId?: number
      expectedSourceRevision?: string
      reviewToken?: string
    } | null } = { value: null }
    let acknowledgement: unknown
    const { host, instance } = await mountSelector([page(22, 'docs/other', 'Another page')], {
      mode: 'move',
      mustExist: false,
      path: 'docs/archive',
      locale: 'en',
      sourcePageId: 10,
      sourceSourceRevision: '5',
      sourceVisibility: 'public',
      openHandler: (selection: { locale: string; path: string; sourcePageId?: number; expectedSourceRevision?: string; reviewToken?: string }) => {
        submittedMove.value = {
          locale: selection.locale,
          path: selection.path,
          sourcePageId: selection.sourcePageId,
          expectedSourceRevision: selection.expectedSourceRevision,
          reviewToken: selection.reviewToken
        }
        return selection.reviewToken ? receipt : undefined
      },
      onMoveAcknowledged: (value: unknown) => {
        acknowledgement = value
      }
    })
    const clickButton = async (label: string): Promise<void> => {
      const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(candidate => candidate.textContent?.trim() === label)
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
    const referrerCard = Array.from(host.querySelectorAll('.page-selector__candidate')).find(
      card => card.querySelector('.page-selector__candidate-title')?.textContent === 'Referrer page'
    )
    expect(referrerCard?.querySelector('.page-selector__diff')?.textContent).toContain('[Release notes](/en/docs/current)')
    expect(referrerCard?.querySelector('.page-selector__diff')?.textContent).toContain('[Release notes](/en/docs/archive)')
    const selfLinkCard = Array.from(host.querySelectorAll('.page-selector__candidate')).find(
      card => card.querySelector('.page-selector__candidate-title')?.textContent === 'Moved page'
    )
    expect(selfLinkCard?.querySelector('.page-selector__diff')?.textContent).toContain('[Current](/en/docs/current)')
    expect(selfLinkCard?.querySelector('.page-selector__diff')?.textContent).toContain('[Current](/en/docs/archive)')
    expect(selfLinkCard?.querySelector('input[type="checkbox"]')).toBeNull()

    await clickButton('Review selected changes')
    expect(requests[1]?.input.selectedPageIds).toEqual([21, 23])
    const confirmation = host.querySelector('section.page-selector__link-review')
    const confirmationHeading = confirmation?.querySelector('h3')
    expect(confirmationHeading?.id).toBeTruthy()
    expect(confirmation?.getAttribute('aria-labelledby')).toBe(confirmationHeading?.id)
    const confirmationCards = Array.from(confirmation?.querySelectorAll('.page-selector__candidate') ?? [])
    expect(
      confirmationCards.map(card => ({
        title: card.querySelector('.page-selector__candidate-title')?.textContent,
        location: card.querySelector('.page-selector__candidate-location')?.textContent
      }))
    ).toEqual([
      { title: 'Referrer page', location: 'en / docs/referrer · revision 7' },
      { title: 'Referrer page', location: 'fr / guides/referrer · revision 12' },
      { title: 'Moved page', location: 'en / docs/current · revision 5' }
    ])
    expect(Array.from(confirmation?.querySelectorAll('.page-selector__diff code') ?? [], code => code.textContent)).toEqual([
      '[Release notes](/en/docs/current)',
      '[Release notes](/en/docs/archive)',
      '[Release notes](/en/docs/current)',
      '[Release notes](/en/docs/archive)',
      '[Current](/en/docs/current)',
      '[Current](/en/docs/archive)'
    ])

    await clickButton('Move and update selected links')
    expect(submittedMove.value).toEqual({
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
    expect(host.querySelector('.page-selector__tree')?.hasAttribute('disabled')).toBe(true)
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
      openHandler: async () => {
        throw moveError
      }
    })
    const option = host.querySelector<HTMLInputElement>('.page-selector__repair-toggle input')
    expect(option?.checked).toBe(false)
    const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(candidate => candidate.textContent?.trim() === 'Select')
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
    const submit = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(candidate => candidate.textContent?.trim() === 'Select')
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
    expect(Array.from(host.querySelectorAll('button')).some(button => button.textContent?.trim() === 'Select')).toBe(false)
    expect(
      Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
        .filter(button => !button.disabled)
        .every(button => button.textContent?.trim() === 'Refresh page')
    ).toBe(true)
  })
})
