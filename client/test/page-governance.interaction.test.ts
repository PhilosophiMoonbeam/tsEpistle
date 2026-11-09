import path from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import type { Component } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { browserWindow, document, setLocation } from './browser-dom.mts'
import type { FeedbackBoard, FeedbackIdea, FeedbackList } from '../../shared/page-feedback.ts'
import type { PageReviewView } from '../../shared/page-review-routing.ts'
const previousGlobals = ['siteConfig', 'siteLangs'].flatMap(name => [globalThis, browserWindow].map(target => ({ target, name, descriptor: Object.getOwnPropertyDescriptor(target, name) })))
function installBrowserConfig() {
  for (const target of [globalThis, browserWindow]) {
    Object.defineProperty(target, 'siteConfig', { configurable: true, writable: true, value: { title: 'Governance test', lang: 'en', product: { name: 'tsEpistle', version: '0.1.0-test' }, agentCsrfToken: 'governance-test-csrf' } })
    Object.defineProperty(target, 'siteLangs', { configurable: true, writable: true, value: [{ code: 'en', name: 'English' }] })
  }
}
// The browser document supplies configuration before application/store modules evaluate.
installBrowserConfig()
beforeEach(installBrowserConfig)
// Vue must load after the shared browser DOM; SFC imports must load after the executable compiler plugin.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
Bun.plugin({ name: 'governance-mounted-native-sfc', setup(builder) {
  builder.onLoad({ filter: /(?:feedback-board|feedback-submit|feedback-triage|feedback-board-settings|page-governance|page-review-routing|page-lifecycle|page-selector|async-state|v-card-chin)\.vue$/ }, async ({ path: filename }) => {
    const parsed = parse(await Bun.file(filename).text(), { filename })
    if (parsed.errors.length) throw parsed.errors[0]
    const id = path.basename(filename, '.vue')
    const script = parsed.descriptor.script?.content.trim() || parsed.descriptor.scriptSetup?.content.trim()
      ? compileScript(parsed.descriptor, { id, genDefaultAs: '__component' })
      : { content: 'const __component = {};', bindings: {} }
    const template = compileTemplate({ source: parsed.descriptor.template!.content, filename, id, preprocessLang: parsed.descriptor.template!.lang, preprocessOptions: { doctype: 'html' }, compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } })
    if (template.errors.length) throw template.errors[0]
    return { loader: 'ts', contents: `${script.content}\n${template.code}\n__component.render = render;\nexport default __component;` }
  })
} })
const Board = (await import('../components/feedback/feedback-board.vue')).default as Component
// The SFC compiler plugin above must be installed before loading this real form.
const Submit = (await import('../components/feedback/feedback-submit.vue')).default as Component
const Routing = (await import('../components/page-review-routing.vue')).default as Component
const Lifecycle = (await import('../components/page-lifecycle.vue')).default as Component
const Governance = (await import('../components/page-governance.vue')).default as Component
const CardChin = (await import('../components/common/v-card-chin.vue')).default as Component
const { pinia, wikiStore } = await import('../store/index.ts')
const ownerKey = JSON.stringify([5, 4, wikiStore.offlineIdentityEpoch, 'authenticated', false, wikiStore.user.permissions])
const boardId = '11111111-1111-4111-8111-111111111111', ideaId = '22222222-2222-4222-8222-222222222222', ruleId = '33333333-3333-4333-8333-333333333333', token = '44444444-4444-4444-8444-444444444444'
const board: FeedbackBoard = { id: boardId, boardPageId: 7, name: 'Reader proposals', enabled: true, boardRevision: '2', canManage: true, canSubmit: true, categories: [] }
const idea: FeedbackIdea = { id: ideaId, boardId, pageId: 9, title: 'A permitted proposal', path: 'ideas/proposal', locale: 'en', visibility: 'public', state: 'proposed', ideaRevision: '3', sourceRevision: '8', categoryId: null, categoryLabel: null, submittedAt: '2026-11-08T00:00:00.000Z', withdrawnAt: null, voteCount: 0, trendingCount: 0, voted: false, subscribed: false, canModerate: true, canWithdraw: true, canRestore: false, canEditSource: false }
function listing(items: FeedbackIdea[] = [idea], state: FeedbackList['state'] = 'ready'): FeedbackList { return { schemaVersion: 1, board, query: { q: undefined, statuses: undefined, categoryIds: undefined, sort: 'top', limit: 20 }, asOf: '2026-11-08T00:00:00.000Z', items, total: items.length, permittedTotal: items.length, facets: { statuses: {}, categories: {} }, nextCursor: null, state } }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const cleanups: Array<() => void> = [], previousFetch = browserWindow.fetch, previousUser = { ...wikiStore.user }, previousAuth = { authRefreshSettled: wikiStore.authRefreshSettled, authRefreshPending: wikiStore.authRefreshPending, authRefreshOutcome: wikiStore.authRefreshOutcome }
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  browserWindow.fetch = previousFetch
  Object.assign(wikiStore.user, previousUser)
  Object.assign(wikiStore, previousAuth)
  for (const { target, name, descriptor } of previousGlobals) {
    if (descriptor) Object.defineProperty(target, name, descriptor)
    else Reflect.deleteProperty(target, name)
  }
  setLocation('/')
})
async function settle() { for (let count = 0; count < 16; count++) { await Promise.resolve(); await Vue.nextTick() } }
async function mount(component: Component, initialProps: Record<string, unknown>, transport: (url: string, init?: RequestInit) => Promise<Response>) {
  Object.assign(wikiStore.user, { id: 5, authenticated: true, authVersion: 4 })
  Object.assign(wikiStore, { authRefreshSettled: true, authRefreshPending: false, authRefreshOutcome: 'authenticated' })
  const fetch = vi.fn(transport); browserWindow.fetch = (input, init) => fetch(String(input), init)
  const props = Vue.reactive(initialProps), host = document.createElement('div'); document.body.append(host)
  const app = Vue.createApp({ render: () => Vue.h(component, props) })
  app.use(pinia)
  app.use(createVuetify({ components: vuetifyComponents }))
  app.component('v-card-chin', CardChin)
  // Only viewport layout is supplied by the harness; the native selector, controls and transports are real.
  app.component('vue-scroll', Vue.defineComponent({ setup(_props, { slots }) { return () => Vue.h('div', slots.default?.()) } }))
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  cleanups.push(() => { app.unmount(); host.remove() }); await settle(); return { host, props, fetch }
}
function button(host: HTMLElement, label: string): HTMLButtonElement { const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label); if (!result) throw new Error(`Missing action ${label}`); return result }
function input(host: HTMLElement, label: string): HTMLInputElement { const result = [...host.querySelectorAll('label')].find(item => item.textContent?.includes(label))?.querySelector('input'); if (!result) throw new Error(`Missing input ${label}`); return result }
function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) { element.value = value; element.dispatchEvent(new browserWindow.Event(element instanceof browserWindow.HTMLSelectElement ? 'change' : 'input', { bubbles: true })) }
function submit(form: HTMLFormElement) { form.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true })) }
const boardProps = { board, locale: 'en', ready: true, authenticated: true, authorityKey: ownerKey }
const writes = (fetch: { mock: { calls: Array<[string, RequestInit?]> } }) => fetch.mock.calls.filter(([, init]) => init?.method !== undefined && init.method !== 'GET')
describe('mounted governed board journeys', () => {
  it('suppresses board metadata after a current access refusal and exposes explicit recovery without implying a vote committed', async () => {
    const view = await mount(Governance, { pageId: 7, sourceRevision: '8', locale: 'en', path: 'board', ready: true, writer: false, manage: false, attestationHref: '/en/board' }, async (url, init) => {
      expect(new Headers(init?.headers).get('X-Wiki-Governance-Owner')).toBe('5:4')
      if (url.endsWith('/boards')) return json([board])
      if (url.endsWith('/vote')) return json({ error: 'Current idea access is unavailable', code: 'FORBIDDEN' },403)
      return json(listing())
    })
    button(view.host, 'I would prioritize this proposal').click(); await settle()
    expect(view.host.querySelector('.feedback-board')).toBeNull()
    expect(view.host.textContent).not.toContain('A permitted proposal')
    expect(button(view.host, 'Retry current feedback access')).toBeDefined()
    expect(writes(view.fetch)).toHaveLength(1)
  })
  it('does not admit warm identity or late old-account board discovery into the normal reader mount', async () => {
    const oldDirectory = Promise.withResolvers<Response>()
    const view = await mount(Governance, { pageId: 7, sourceRevision: '8', locale: 'en', path: 'board', ready: true, writer: false, manage: false, attestationHref: '/en/board' }, async url => url.endsWith('/boards') ? oldDirectory.promise : json(listing()))
    Object.assign(wikiStore, { authRefreshPending: true, authRefreshSettled: false })
    await settle()
    oldDirectory.resolve(json([board]))
    await settle()
    expect(view.host.textContent).not.toContain('Reader proposals')
    expect(writes(view.fetch)).toHaveLength(0)
    Object.assign(wikiStore.user, { id: 6, authVersion: 1 })
    Object.assign(wikiStore, { authRefreshPending: false, authRefreshSettled: true, authRefreshOutcome: 'unavailable' })
    await settle()
    expect(view.host.querySelector('.feedback-board')).toBeNull()
  })
  it('preserves explicit status URL/history across sort and search clear, distinguishes empty from no-match, and retires late query responses', async () => {
    setLocation('/en/board?statuses=closed,planned&q=old')
    const oldRequest = Promise.withResolvers<Response>()
    const view = await mount(Board, { ...boardProps }, async url => url.includes('q=old') ? oldRequest.promise : json(listing([], new URL(url, 'http://localhost').searchParams.has('q') ? 'no-matches' : 'empty')))
    const sort = view.host.querySelector('select')!; change(sort, 'trending'); await settle()
    expect(browserWindow.location.search).toContain('statuses=closed%2Cplanned')
    const search = view.host.querySelector<HTMLInputElement>('input[type=search]')!; change(search, 'missing'); submit(view.host.querySelector('form')!); await settle()
    expect(view.host.textContent).toContain('No permitted proposals match')
    oldRequest.resolve(json(listing())); await settle(); expect(view.host.textContent).not.toContain('A permitted proposal')
    button(view.host, 'Clear search and filters').click(); await settle(); expect(browserWindow.location.search).toBe(''); expect(view.host.textContent).toContain('no currently visible proposals')
    browserWindow.history.replaceState(null, '', '/en/board?statuses=closed&sort=newest')
    browserWindow.dispatchEvent(new browserWindow.PopStateEvent('popstate')); await settle()
    expect((view.host.querySelector('select') as HTMLSelectElement).value).toBe('newest')
    expect([...view.host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(item => item.value === 'closed')?.checked).toBe(true)
  })
  it('requires separate deliberate priority-vote and subscription actions; detached identity actions cannot mutate', async () => {
    let voted = false, subscribed = false
    const view = await mount(Board, { ...boardProps }, async (url, init) => {
      if (url.endsWith('/vote')) { voted = JSON.parse(String(init?.body)).voted; return json({ voted, ideaRevision: '3' }) }
      if (url.endsWith('/subscription')) { subscribed = JSON.parse(String(init?.body)).subscribed; return json({ subscribed }) }
      return json(listing([{ ...idea, voted, subscribed, voteCount: voted ? 1 : 0 }]))
    })
    expect(writes(view.fetch)).toHaveLength(0)
    const priority = button(view.host, 'I would prioritize this proposal'); priority.focus(); expect(document.activeElement).toBe(priority); priority.click(); await settle()
    expect(voted).toBe(true); expect(subscribed).toBe(false); expect(writes(view.fetch)).toHaveLength(1)
    input(view.host, 'Notify me of status changes').click(); await settle(); expect(subscribed).toBe(true); expect(writes(view.fetch)).toHaveLength(2)
    const detached = button(view.host, 'Retract my priority vote')
    Object.assign(wikiStore.user, { id: 6, authVersion: 1 })
    // Before Vue propagates new props or replaces DOM, an old account's visible action is already inert.
    detached.click()
    expect(writes(view.fetch)).toHaveLength(2)
    view.props.ready = false; view.props.authorityKey = 'account-6'; await settle(); detached.click(); await settle(); expect(writes(view.fetch)).toHaveLength(2)
  })
  it('keeps an explicitly unsent native comment draft after atomic status refusal and offers receipt inspection instead of repost', async () => {
    const view = await mount(Board, { ...boardProps }, async (url, init) => {
      if (url.endsWith('/transition')) { const body = JSON.parse(String(init?.body)); expect(body.comment.content).toBe('My deliberate native discussion draft'); expect(body.expectedSourceRevision).toBe('8'); return json({ error: 'Native comments unavailable: no status change committed', code: 'COMMENTS_UNAVAILABLE' }, 409) }
      if (url.includes('/receipts/')) return json(null)
      if (url.includes('/ideas/')) return json({ idea, history: [] })
      return json(listing())
    })
    const triage = view.host.querySelector<HTMLDetailsElement>('.feedback-triage')!; triage.open = true; triage.dispatchEvent(new browserWindow.Event('toggle')); await settle()
    const form = triage.querySelector('form')!, target = form.querySelector('select')!; change(target, 'planned'); change(form.querySelector('textarea')!, 'Explain this planned transition')
    input(triage, 'Also post a native discussion comment').click(); await settle(); const draft = [...form.querySelectorAll('textarea')][1]!; change(draft, 'My deliberate native discussion draft'); submit(form); await settle()
    expect(view.host.textContent).toContain('no status change committed'); expect(draft.value).toBe('My deliberate native discussion draft'); expect(writes(view.fetch)).toHaveLength(1)
    button(triage, 'Inspect transition receipt').click(); await settle(); expect(writes(view.fetch)).toHaveLength(1)
  })
  it('keeps optional duplicate suggestions independent and ignores an older title response without voting or creating source', async () => {
    const oldSuggestion = Promise.withResolvers<Response>()
    const view = await mount(Board, { ...boardProps }, async url => {
      if (url.includes('/duplicates?q=Old')) return oldSuggestion.promise
      if (url.includes('/duplicates?')) return json([{ ...idea, id: ruleId, title: 'Current permitted match', visibility: 'private' }])
      return json(listing())
    })
    const title = input(view.host, 'Proposed title for optional duplicate discovery')
    change(title, 'Old title'); await settle()
    change(title, 'Current title'); await settle()
    oldSuggestion.resolve(json([{ ...idea, title: 'Obsolete suggestion' }]))
    await settle()
    expect(view.host.textContent).toContain('Current permitted match')
    expect(view.host.textContent).not.toContain('Obsolete suggestion')
    const match = [...view.host.querySelectorAll('a')].find(anchor => anchor.textContent === 'Current permitted match')
    expect(match?.getAttribute('href')).toBe('/_private/en/ideas/proposal')
    expect(button(view.host, 'Choose location and open full editor').disabled).toBe(true)
    expect(writes(view.fetch)).toHaveLength(0)
  })
  it('retains proposal and existing-page admission drafts through fresh same-board search, sort and filter responses, including a retired query', async () => {
    const oldRequest = Promise.withResolvers<Response>()
    let oldSignal: AbortSignal | null | undefined, revision = 2
    const view = await mount(Board, { ...boardProps }, async (url, init) => {
      if (url.includes('/duplicates?')) return json([])
      if (new URL(url, 'http://localhost').searchParams.get('q') === 'superseded') { oldSignal = init?.signal; return oldRequest.promise }
      return json({ ...listing([], 'no-matches'), board: { ...board, boardRevision: String(++revision) } })
    })
    change(input(view.host, 'Proposed title for optional duplicate discovery'), 'Unsent proposal')
    input(view.host, 'Explicitly attach the page I create').click()
    change(input(view.host, 'Canonical page ID'), '19')
    change(input(view.host, 'Current source revision'), '12')
    input(view.host, 'I deliberately attach this existing canonical page').click()
    await settle()
    const assertDraft = () => {
      expect(input(view.host, 'Proposed title for optional duplicate discovery').value).toBe('Unsent proposal')
      expect(input(view.host, 'Canonical page ID').value).toBe('19')
      expect(input(view.host, 'Current source revision').value).toBe('12')
      expect(input(view.host, 'Explicitly attach the page I create').checked).toBe(true)
      expect(input(view.host, 'I deliberately attach this existing canonical page').checked).toBe(true)
    }
    change(input(view.host, 'Search permitted proposals'), 'superseded'); submit(view.host.querySelector('form')!); await settle()
    assertDraft()
    change(input(view.host, 'Search permitted proposals'), 'Editor'); submit(view.host.querySelector('form')!); await settle()
    expect(oldSignal?.aborted).toBe(true)
    assertDraft()
    change(view.host.querySelector('select')!, 'trending'); await settle()
    assertDraft()
    const planned = [...view.host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(item => item.value === 'planned')!
    planned.click(); await settle()
    assertDraft()
    oldRequest.resolve(json(listing([{ ...idea, title: 'Late superseded result' }]))); await settle()
    expect(view.host.textContent).not.toContain('Late superseded result')
    assertDraft()
    expect(writes(view.fetch)).toHaveLength(0)
  })
  for (const boundary of ['board', 'owner', 'session generation'] as const) {
    it(`retires admission drafts and late suggestion/submission results on a verified ${boundary} transition`, async () => {
      const duplicate = Promise.withResolvers<Response>(), attachment = Promise.withResolvers<Response>(), submitted = vi.fn()
      let signal: AbortSignal | null | undefined
      const view = await mount(Submit, { ...boardProps, onSubmitted: submitted }, async (url, init) => {
        if (url.includes('/duplicates?')) { signal = init?.signal; return duplicate.promise }
        if (url.endsWith('/submit')) return attachment.promise
        throw new Error(`Unexpected request ${url}`)
      })
      change(input(view.host, 'Proposed title for optional duplicate discovery'), 'Old owner draft')
      input(view.host, 'Explicitly attach the page I create').click()
      change(input(view.host, 'Canonical page ID'), '19')
      change(input(view.host, 'Current source revision'), '12')
      input(view.host, 'I deliberately attach this existing canonical page').click()
      submit(input(view.host, 'Canonical page ID').closest('form')!); await settle()
      expect(writes(view.fetch)).toHaveLength(1)
      view.props.board = { ...board, boardRevision: '3' }; await settle()
      expect(input(view.host, 'Proposed title for optional duplicate discovery').value).toBe('Old owner draft')
      expect(input(view.host, 'Canonical page ID').closest('fieldset')?.disabled).toBe(true)
      if (boundary === 'board') view.props.board = { ...board, id: ruleId }
      else {
        if (boundary === 'owner') wikiStore.user.id = 6
        else wikiStore.user.authVersion = 5
        view.props.authorityKey = JSON.stringify([wikiStore.user.id, wikiStore.user.authVersion, wikiStore.offlineIdentityEpoch, 'authenticated', false, wikiStore.user.permissions])
      }
      await settle()
      expect(signal?.aborted).toBe(true)
      expect(input(view.host, 'Proposed title for optional duplicate discovery').value).toBe('')
      expect(input(view.host, 'Canonical page ID').value).toBe('')
      expect(input(view.host, 'Current source revision').value).toBe('')
      expect(input(view.host, 'Explicitly attach the page I create').checked).toBe(false)
      expect(input(view.host, 'I deliberately attach this existing canonical page').checked).toBe(false)
      expect(input(view.host, 'Canonical page ID').closest('fieldset')?.disabled).toBe(false)
      input(view.host, 'I deliberately attach this existing canonical page').click()
      duplicate.resolve(json([{ ...idea, title: 'Retired duplicate suggestion' }]))
      attachment.resolve(json({ ideaId, ideaRevision: '4' })); await settle()
      expect(view.host.textContent).not.toContain('Retired duplicate suggestion')
      expect(view.host.querySelector('[role=alert]')).toBeNull()
      expect(input(view.host, 'I deliberately attach this existing canonical page').checked).toBe(true)
      expect(submitted).not.toHaveBeenCalled()
    })
  }
  it('lets an admitted author restore withdrawn membership without treating authorship as source editing authority', async () => {
    setLocation('/en/board?statuses=withdrawn')
    const ownWithdrawn = { ...idea, state: 'withdrawn' as const, canModerate: false, canWithdraw: false, canRestore: true, canEditSource: false }
    const view = await mount(Board, { ...boardProps }, async (url, init) => {
      if (url.endsWith('/transition')) {
        const body = JSON.parse(String(init?.body))
        expect(body.targetState).toBe('proposed')
        expect(body.expectedSourceRevision).toBe('8')
        expect(body.comment).toBeUndefined()
        return json({ requestId: body.requestId, boardId, ideaId, ideaRevision: '4', state: 'proposed', rootTransitionEventId: ruleId, commentId: null })
      }
      if (url.includes('/ideas/')) return json({ idea: ownWithdrawn, history: [] })
      return json(listing([ownWithdrawn]))
    })
    const triage = view.host.querySelector<HTMLDetailsElement>('.feedback-triage')!
    const form = triage.querySelector('form')!
    expect(form.querySelector('select')?.value).toBe('proposed')
    expect([...triage.querySelectorAll('a')].some(anchor => anchor.textContent?.includes('Edit in canonical editor'))).toBe(false)
    change(form.querySelector('textarea')!, 'Restore my permitted proposal')
    submit(form); await settle()
    expect(writes(view.fetch)).toHaveLength(1)
  })
})
const routing: PageReviewView = { pageId: 7, sourceRevision: '8', routingRevision: '2', mode: 'users', enabled: false, schedule: { mode: 'accuracy-age' }, scheduleGeneration: '1', members: [{ id: 5, name: 'Current writer', unavailable: false }], recipients: [], deliveries: [], diagnostic: 'disabled', nextDueAt: null, currentDueAt: null, currentMilestone: null, currentCycleId: null, asOf: '2026-11-08T00:00:00.000Z', accuracyUnaffected: true }
describe('mounted writer governance', () => {
  it('removes restricted recipient metadata after a current writer-access refusal instead of keeping a stale preview', async () => {
    const view = await mount(Routing, { pageId: 7, sourceRevision: '8', ready: true, authorityKey: ownerKey, attestationHref: '/en/board' }, async url => url.endsWith('/preview') ? json({ error: 'Current writer authority was revoked', code: 'FORBIDDEN' },403) : json(routing))
    expect(view.host.textContent).toContain('Current writer')
    button(view.host, 'Explicit Reset to existing contacts — preview').click(); await settle()
    expect(view.host.textContent).toContain('Current writer authority was revoked')
    expect(view.host.querySelector('li')).toBeNull()
    expect([...view.host.querySelectorAll('button')].some(item => item.textContent?.includes('Save this previewed change'))).toBe(false)
    expect(writes(view.fetch)).toHaveLength(1)
  })
  it('previews explicit Reset before writing, preserves schedule semantics, and rejects a late preview after owner change', async () => {
    const previews = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()]
    let nextPreview = 0
    const view = await mount(Routing, { pageId: 7, sourceRevision: '8', ready: true, authorityKey: ownerKey, attestationHref: '/en/board' }, async (url, init) => {
      if (url.endsWith('/preview')) return previews[nextPreview++]!.promise
      if (init?.method === 'PUT') { expect(JSON.parse(String(init.body))).toEqual({ command: 'reset', mode: 'contacts', expectedSourceRevision: '8', expectedRoutingRevision: '2' }); return json({ ...routing, mode: 'contacts', routingRevision: '3', members: [] }) }
      return json(routing)
    })
    button(view.host, 'Explicit Reset to existing contacts — preview').click(); await settle(); expect(writes(view.fetch)).toHaveLength(1)
    previews[0]!.resolve(json({ ...routing, mode: 'contacts', members: [] })); await settle(); expect(view.host.textContent).toContain('preserve schedule, due time, accuracy and preferences')
    button(view.host, 'Save this previewed change').click(); await settle(); expect(writes(view.fetch)).toHaveLength(2)
    button(view.host, 'Explicit Reset to existing contacts — preview').click(); await settle(); view.props.authorityKey = 'writer-6'; await settle(); previews[1]!.resolve(json({ ...routing, mode: 'contacts', members: [] })); await settle(); expect(view.host.textContent).not.toContain('Save this previewed change')
    expect(view.host.querySelector('a')?.getAttribute('href')).toBe('/en/board')
  })
  it('requires explicit independent-clock accuracy acknowledgement before previewing an anchored cadence', async () => {
    const view = await mount(Routing, { pageId: 7, sourceRevision: '8', ready: true, authorityKey: ownerKey, attestationHref: '/en/board' }, async () => json(routing))
    const form = view.host.querySelectorAll('form')[1]!, select = form.querySelector('select')!; change(select, 'independent'); await settle(); change(input(form, 'Anchor'), '2026-11-08T12:00:00.000Z'); submit(form); await settle(); expect(writes(view.fetch)).toHaveLength(0)
    input(form, 'These independent due dates').click(); submit(form); await settle(); expect(writes(view.fetch)).toHaveLength(1)
    const body = JSON.parse(String(writes(view.fetch)[0]?.[1]?.body)); expect(body.schedule).toEqual({ mode: 'independent', anchorAt: '2026-11-08T12:00:00.000Z', intervalDays: 30, acknowledgeIndependentAccuracy: true })
  })
  it('previews finite effects without inferred clocks or baseline consent, requires save consent, and renders truthful partial receipts', async () => {
    const definition = { version: 1, selector: { kind: 'ids', pageIds: [7, 9] }, condition: { kind: 'body-inactive', days: 90 }, effects: [{ kind: 'set-notice', text: 'Review this documentation' }, { kind: 'propose-move', destinationRootPath: 'archive', destinationLocale: 'same', template: 'original-relative-path' }], terminalPolicy: 'keep' }
    const view = await mount(Lifecycle, { pageId: 7, pageLocale: 'en', pagePath: 'board', ready: true, authorityKey: ownerKey }, async (url, init) => {
      if (url.endsWith('/preview')) {
        const body = JSON.parse(String(init?.body))
        expect(body.startObserving).toBe(false)
        expect(body.definition).toEqual(definition)
        return json({ previewToken: token, expiresAt: '2099-11-08T00:00:00.000Z', fingerprint: 'f', ruleId: null, expectedRevision: null, startObserving: false, runAgain: false, warning: null, pages: [
          { pageId: 7, sourceRevision: '8', path: 'board', localeCode: 'en', protected: false, clock: 'unknown', anchorAt: null, historicalAgeUnknown: true, due: { state: 'unknown-clock' }, effects: [{ kind: 'set-notice', mode: 'unattended' }, { kind: 'propose-move', mode: 'human-review', destinationPath: 'archive/board' }] },
          { pageId: 9, sourceRevision: '8', path: 'ideas/proposal', localeCode: 'en', protected: false, clock: 'known-change', anchorAt: '2026-01-01T00:00:00.000Z', historicalAgeUnknown: false, due: { state: 'due', conditionKey: 'body-inactive:known-epoch', epoch: ideaId, cycleNo: null, dueAt: '2026-04-01T00:00:00.000Z' }, effects: [{ kind: 'set-notice', mode: 'unattended' }, { kind: 'propose-move', mode: 'human-review', destinationPath: 'archive/ideas/proposal' }] }
        ] })
      }
      if (url.endsWith('/rules') && init?.method === 'POST') { const body = JSON.parse(String(init.body)); expect(body.unattendedConsent).toBe(true); expect(body.enabled).toBe(true); return json({ ruleId, revision: 1, status: 'enabled' }) }
      if (url.includes(`/rules/${ruleId}`)) return json({ rule: { id: ruleId, revision: 1, definition, status: 'needs-attention', reason: 'partial-stale' }, pages: [], cycles: [{ id: token, pageId: 9, status: 'partial', reason: 'external-source-change', receipts: [{ effectIndex: 0, kind: 'set-notice', state: 'applied', reason: null, proposalId: null }, { effectIndex: 1, kind: 'propose-move', state: 'blocked', reason: 'stale', proposalId: null }] }], hasMore: false, nextCursor: null })
      return json({ rules: [], hasMore: false, nextCursor: null })
    })
    expect(input(view.host, 'Deliberately enable this rule').checked).toBe(false)
    change(input(view.host, 'Canonical page IDs'), '7, 9')
    input(view.host, 'Set an escaped rule-owned reader notice').click()
    input(view.host, 'Propose a move for a current human').click()
    input(view.host, 'Deliberately enable this rule').click()
    await settle()
    change(view.host.querySelector('textarea')!, 'Review this documentation')
    change(input(view.host, 'Literal destination root'), 'archive')
    submit(view.host.querySelector('form')!); await settle()
    expect(view.host.textContent).toContain('Historical activity age unknown')
    const save = button(view.host, 'Save exactly this preview'); expect(save.disabled).toBe(true); expect(writes(view.fetch)).toHaveLength(1)
    input(view.host, 'I explicitly consent').click(); await settle(); save.click(); await settle()
    expect(view.host.textContent).toContain('Actual rule state: needs-attention'); expect(view.host.textContent).toContain('set-notice — applied'); expect(view.host.textContent).toContain('propose-move — blocked'); expect(view.host.textContent).not.toContain('Move is fulfilled')
    expect(writes(view.fetch)).toHaveLength(2)
  })
  it('hands a move proposal to the existing native dialog and includes its receipt identity only on an explicit human move', async () => {
    const definition = { version: 1, selector: { kind: 'ids', pageIds: [7] }, condition: { kind: 'body-inactive', days: 90 }, effects: [{ kind: 'propose-move', destinationRootPath: 'archive', destinationLocale: 'same', template: 'original-relative-path' }], terminalPolicy: 'keep' }
    const rule = { id: ruleId, revision: 1, definition, status: 'enabled', reason: null }
    let moved = false
    const view = await mount(Lifecycle, { pageId: 7, pageLocale: 'en', pagePath: 'board', ready: true, authorityKey: ownerKey }, async (url, init) => {
      if (url.startsWith('/_api/pages/tree?')) return json([])
      if (url === '/_api/pages/7/move') {
        expect(new Headers(init?.headers).get('X-Wiki-Governance-Owner')).toBe('5:4')
        expect(JSON.parse(String(init?.body))).toEqual({ destinationLocale: 'en', destinationPath: 'archive/board', expectedSourceRevision: '8', lifecycleProposalId: token })
        moved = true
        return json({ message: 'Page has been moved.' })
      }
      if (url.endsWith(`/proposals/${token}`)) return json({ id: token, pageId: 7, sourcePath: 'board', sourceLocale: 'en', destinationPath: 'archive/board', destinationLocale: 'en', sourceRevision: '8', currentSourceRevision: moved ? '9' : '8', requiresNewPreview: moved, status: moved ? 'fulfilled' : 'awaiting-human', expiresAt: '2099-11-08T00:00:00.000Z', humanMoveInput: { id: 7, destinationPath: 'archive/board', destinationLocale: 'en', expectedSourceRevision: '8', lifecycleProposalId: token } })
      if (url.includes(`/rules/${ruleId}`)) return json({ rule, pages: [], cycles: [{ id: ideaId, pageId: 7, status: 'needs-review', reason: 'awaiting-human', receipts: [{ effectIndex: 0, kind: 'propose-move', state: 'proposed', reason: 'awaiting-human', proposalId: token }] }], hasMore: false, nextCursor: null })
      return json({ rules: [rule], hasMore: false, nextCursor: null })
    })
    button(view.host, `${ruleId} — enabled`).click(); await settle()
    button(view.host, 'Inspect human move proposal').click(); await settle()
    expect(moved).toBe(false)
    expect(view.host.textContent).toContain('Move is awaiting-human')
    button(view.host, 'Open native move and fresh optional incoming-link review').click(); await settle()
    expect(moved).toBe(false)
    const nativeSelect = button(document.body, 'common:actions.select')
    nativeSelect.focus()
    expect(document.activeElement).toBe(nativeSelect)
    nativeSelect.click(); await settle()
    expect(moved).toBe(true)
    expect(view.host.textContent).toContain('Move is fulfilled')
    expect(writes(view.fetch)).toHaveLength(1)
  })
})
