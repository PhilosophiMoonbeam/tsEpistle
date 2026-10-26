import path from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import i18next from 'i18next'
import type { Component } from 'vue'
import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { browserWindow, document } from '../test/browser-dom.mts'
import { translateEnglish } from '../test/english-translate.mts'
import type { PageRatingView } from '../../shared/page-ratings.ts'
import type { SiteConfig } from '../env.d.ts'
import { DEFAULT_THEME_COLORS } from '../../shared/theme-colors.ts'
import packageMetadata from '../../package.json'

// Runtime DOM must capture the shared browser document before components load.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const { VBtn, VIcon, VProgressCircular, VTextarea, VTooltip } = await import('vuetify/components')
const previousSiteConfig = Object.getOwnPropertyDescriptor(browserWindow, 'siteConfig')
const siteConfig: SiteConfig = {
  title: 'Ratings interaction test',
  theme: 'default',
  darkMode: false,
  themeColors: DEFAULT_THEME_COLORS,
  tocPosition: 'left',
  lang: 'en',
  rtl: false,
  company: '',
  contentLicense: '',
  footerOverride: '',
  banner: { isEnabled: false, title: '', content: '' },
  logoUrl: '',
  logoEffect: null,
  product: {
    ...packageMetadata.product,
    independentFork: true,
    description: packageMetadata.description,
    revision: 'a'.repeat(40),
    date: '2026-08-13T00:00:00.000Z',
    upstreamBase: `${packageMetadata.product.upstreamName} ${packageMetadata.product.upstreamVersion}`,
    sourceUrl: `${packageMetadata.product.sourceRepository}/tree/${'a'.repeat(40)}`
  },
  featurePageRatings: true,
  availableEditors: ['markdown'],
  agentsEnabled: false,
  agentProviderEnabled: false,
  agentSkillsEnabled: false,
  agentGoalsEnabled: false,
  agentCsrfToken: ''
}
Object.defineProperty(browserWindow, 'siteConfig', { configurable: true, writable: true, value: siteConfig })
const { wikiStore } = await import('../store/index.ts')
Bun.plugin({
  name: 'rating-feedback-real-sfc',
  setup(builder) {
    builder.onLoad({ filter: /(?:wiki-page-ratings|async-state)\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const id = path.basename(filename, '.vue')
      const script = compileScript(parsed.descriptor, { id, genDefaultAs: '__component' })
      const template = compileTemplate({
        source: parsed.descriptor.template!.content,
        filename,
        id,
        preprocessLang: parsed.descriptor.template!.lang,
        preprocessOptions: { doctype: 'html' },
        compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] }
      })
      if (template.errors.length) throw template.errors[0]
      return { loader: 'ts', contents: `${script.content}\n${template.code}\n__component.render = render;\nexport default __component;` }
    })
  }
})
// Static SFC imports would run before the executable compiler plugin is installed.
const Ratings = (await import('./wiki-page-ratings.vue')).default as Component
const previousFetch = browserWindow.fetch
const previousIdentity = {
  user: { ...wikiStore.user },
  pageId: wikiStore.page.id,
  comments: { ...wikiStore.page.effectivePermissions.comments },
  authRefreshPending: wikiStore.authRefreshPending,
  authRefreshSettled: wikiStore.authRefreshSettled,
  authRefreshOutcome: wikiStore.authRefreshOutcome,
  offlineIdentityEpoch: wikiStore.offlineIdentityEpoch
}
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  browserWindow.fetch = previousFetch
  if (previousSiteConfig) Object.defineProperty(browserWindow, 'siteConfig', previousSiteConfig)
  else Reflect.deleteProperty(browserWindow, 'siteConfig')
  Object.assign(wikiStore.user, previousIdentity.user)
  wikiStore.page.id = previousIdentity.pageId
  Object.assign(wikiStore.page.effectivePermissions.comments, previousIdentity.comments)
  Object.assign(wikiStore, {
    authRefreshPending: previousIdentity.authRefreshPending,
    authRefreshSettled: previousIdentity.authRefreshSettled,
    authRefreshOutcome: previousIdentity.authRefreshOutcome,
    offlineIdentityEpoch: previousIdentity.offlineIdentityEpoch
  })
})
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const thumbs = (ownVote: -1 | 1 | null = null): PageRatingView => ({
  kind: 'thumbs',
  ownVote,
  count: ownVote === null ? 0 : 1,
  score: ownVote,
  distribution: { '-1': ownVote === -1 ? 1 : 0, '1': ownVote === 1 ? 1 : 0 }
})
const settle = async () => {
  for (let index = 0; index < 12; index++) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}
const mount = async (transport: (url: string, init?: RequestInit) => Promise<Response>) => {
  Object.defineProperty(browserWindow, 'siteConfig', { configurable: true, writable: true, value: siteConfig })
  // Localize presentation only; voting, draft state, Markdown and transports remain real.
  const translation = vi.spyOn(i18next, 't').mockImplementation(translateEnglish as typeof i18next.t)
  cleanups.push(() => translation.mockRestore())
  Object.assign(wikiStore.user, { id: 7, authenticated: true, authVersion: 3, email: 'reader@example.test' })
  Object.assign(wikiStore, { authRefreshSettled: true, authRefreshOutcome: 'authenticated', authRefreshPending: false })
  wikiStore.page.id = 9
  Object.assign(wikiStore.page.effectivePermissions.comments, { read: true, write: true })
  const fetch = vi.fn(transport)
  browserWindow.fetch = (input, init) => fetch(String(input), init)
  const props = Vue.reactive({ pageId: 9, discussionEnabled: true })
  const prepare = vi.fn()
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({ render: () => Vue.h(Ratings, { ...props, onPrepareFeedback: prepare }) })
  app.config.globalProperties.$t = translateEnglish
  app.use(createVuetify({ components: { VBtn, VIcon, VProgressCircular, VTextarea, VTooltip } }))
  app.mount(host)
  cleanups.push(() => {
    app.unmount()
    host.remove()
  })
  await settle()
  return { host, fetch, props, prepare }
}
const writes = (fetch: { mock: { calls: Array<[string, RequestInit?]> } }) =>
  fetch.mock.calls.filter(([, init]) => init?.method !== undefined && init.method !== 'GET' && init.method !== 'HEAD')
const action = (host: HTMLElement, key: string): HTMLButtonElement => {
  const label = translateEnglish(`common:pageRatings.${key}`)
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
  if (!button) throw new Error(`Feedback action ${key} is unavailable`)
  return button
}
const voteDown = (host: HTMLElement): HTMLButtonElement => {
  const button = host.querySelector<HTMLButtonElement>('.wiki-page-ratings__choice:nth-child(2)')
  if (!button) throw new Error('Negative rating action is unavailable')
  return button
}

describe('rating-only and optional contextual discussion interactions', () => {
  it('saves a negative vote only; preparing, editing and previewing do not post or subscribe', async () => {
    const view = await mount(async (_url, init) => json(thumbs(init?.method === 'PUT' ? -1 : null)))
    voteDown(view.host).click()
    await settle()
    expect(voteDown(view.host).getAttribute('aria-pressed')).toBe('true')
    expect(writes(view.fetch)).toHaveLength(1)
    expect(writes(view.fetch)[0]![0]).toBe('/_api/page-ratings/9')
    expect(writes(view.fetch)[0]![1]!.method).toBe('PUT')
    expect(JSON.parse(writes(view.fetch)[0]![1]!.body as string)).toEqual({ kind: 'thumbs', value: -1 })
    expect(view.prepare).not.toHaveBeenCalled()
    expect(view.host.querySelector('textarea')).toBeNull()
    action(view.host, 'prepareDiscussion').click()
    await Vue.nextTick()
    const textarea = view.host.querySelector<HTMLTextAreaElement>('textarea')!
    expect(textarea.disabled).toBe(false)
    textarea.value = '**My task**: deploy\n\nExpected: a running service\n\nUnclear passage: <script>private()</script>'
    textarea.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await Vue.nextTick()
    action(view.host, 'previewDiscussion').click()
    await Vue.nextTick()
    const panel = view.host.querySelector('.wiki-page-ratings__discussion')!
    expect(panel.querySelector('strong')?.textContent).toBe('My task')
    expect(panel.querySelector('script')).toBeNull()
    expect(writes(view.fetch)).toHaveLength(1)
    expect(view.prepare).not.toHaveBeenCalled()
    action(view.host, 'useDiscussionDraft').click()
    await Vue.nextTick()
    expect(view.prepare).toHaveBeenCalledTimes(1)
    expect(view.prepare).toHaveBeenCalledWith(textarea.value)
    expect(writes(view.fetch)).toHaveLength(1)
    expect(voteDown(view.host).getAttribute('aria-pressed')).toBe('true')
  })

  for (const prepared of [false, true]) {
    it(`declines optional feedback ${prepared ? 'after editing a draft' : 'without preparing a draft'} without undoing the vote or changing settings`, async () => {
      const view = await mount(async (_url, init) => json(thumbs(init?.method === 'PUT' ? -1 : null)))
      voteDown(view.host).click()
      await settle()
      if (prepared) {
        action(view.host, 'prepareDiscussion').click()
        await Vue.nextTick()
        const textarea = view.host.querySelector<HTMLTextAreaElement>('textarea')!
        textarea.value = 'Unposted explanation'
        textarea.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
      }
      action(view.host, 'declineDiscussion').click()
      await Vue.nextTick()
      expect(view.host.querySelector('.wiki-page-ratings__discussion')).toBeNull()
      expect(view.host.querySelector('textarea')).toBeNull()
      expect(view.prepare).not.toHaveBeenCalled()
      expect(voteDown(view.host).getAttribute('aria-pressed')).toBe('true')
      expect(writes(view.fetch)).toHaveLength(1)
    })
  }

  it('also offers a draft for a low star rating, without publishing its explanation', async () => {
    const view = await mount(async (_url, init) =>
      json({
        kind: 'stars',
        ownVote: init?.method === 'PUT' ? 2 : null,
        count: init?.method === 'PUT' ? 1 : 0,
        score: init?.method === 'PUT' ? 2 : null,
        distribution: { '1': 0, '2': init?.method === 'PUT' ? 1 : 0, '3': 0, '4': 0, '5': 0 }
      })
    )
    view.host.querySelectorAll<HTMLButtonElement>('.wiki-page-ratings__star')[1]!.click()
    await settle()
    expect(view.host.querySelectorAll('.wiki-page-ratings__star')[1]!.getAttribute('aria-pressed')).toBe('true')
    action(view.host, 'prepareDiscussion').click()
    await Vue.nextTick()
    expect(view.host.querySelector('textarea')).not.toBeNull()
    expect(view.prepare).not.toHaveBeenCalled()
    expect(writes(view.fetch)).toHaveLength(1)
    expect(JSON.parse(writes(view.fetch)[0]![1]!.body as string)).toEqual({ kind: 'stars', value: 2 })
  })

  for (const change of ['read-acl', 'write-acl', 'discussion-disabled', 'owner', 'api-role', 'sign-out', 'page'] as const) {
    it(`removes an unposted explanation when ${change} changes and ignores its detached Use action`, async () => {
      const view = await mount(async (_url, init) => json(thumbs(init?.method === 'PUT' ? -1 : null)))
      voteDown(view.host).click()
      await settle()
      action(view.host, 'prepareDiscussion').click()
      await Vue.nextTick()
      const textarea = view.host.querySelector<HTMLTextAreaElement>('textarea')!
      textarea.value = 'Private unposted explanation'
      textarea.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
      await Vue.nextTick()
      const use = action(view.host, 'useDiscussionDraft')
      if (change === 'read-acl') wikiStore.page.effectivePermissions.comments.read = false
      if (change === 'write-acl') wikiStore.page.effectivePermissions.comments.write = false
      if (change === 'discussion-disabled') view.props.discussionEnabled = false
      if (change === 'owner') wikiStore.user.id = 8
      if (change === 'api-role') wikiStore.user.email = 'api@localhost'
      if (change === 'sign-out') wikiStore.user.authenticated = false
      if (change === 'page') {
        view.props.pageId = 10
        wikiStore.page.id = 10
      }
      await settle()
      use.click()
      await settle()
      expect(view.host.querySelector('.wiki-page-ratings__discussion')).toBeNull()
      expect(view.host.querySelector('textarea')).toBeNull()
      expect(view.prepare).not.toHaveBeenCalled()
      expect(writes(view.fetch)).toHaveLength(1)
      // Restoring comment permission cannot revive the discarded private explanation.
      if (change === 'read-acl' || change === 'write-acl') {
        Object.assign(wikiStore.page.effectivePermissions.comments, { read: true, write: true })
        await Vue.nextTick()
        expect(view.host.querySelector('.wiki-page-ratings__discussion')).toBeNull()
      }
    })
  }

  for (const changed of ['owner', 'auth-version', 'identity-epoch', 'page', 'sign-out'] as const) {
    it(`ignores a late negative-vote success after ${changed} changes`, async () => {
      const pending = Promise.withResolvers<Response>()
      const view = await mount(async (_url, init) => (init?.method === 'PUT' ? pending.promise : json(thumbs())))
      voteDown(view.host).click()
      await settle()
      expect(writes(view.fetch)).toHaveLength(1)
      if (changed === 'owner') wikiStore.user.id = 8
      if (changed === 'auth-version') wikiStore.user.authVersion++
      if (changed === 'identity-epoch') wikiStore.offlineIdentityEpoch++
      if (changed === 'page') {
        view.props.pageId = 10
        wikiStore.page.id = 10
      }
      if (changed === 'sign-out') wikiStore.user.authenticated = false
      await settle()
      pending.resolve(json(thumbs(-1)))
      await settle()
      expect(view.host.querySelector('.wiki-page-ratings__discussion')).toBeNull()
      expect(view.host.querySelector('button[aria-pressed="true"]')).toBeNull()
      expect(view.host.querySelector('.wiki-page-ratings__feedback')).toBeNull()
      expect(view.prepare).not.toHaveBeenCalled()
      expect(writes(view.fetch)).toHaveLength(1)
    })
  }
})
