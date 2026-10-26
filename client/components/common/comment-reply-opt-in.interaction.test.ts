import path from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import createKnex from 'knex'
import i18next from 'i18next'
import type { Component } from 'vue'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { up as upNotificationPreferences } from '../../../server/db/migrations/tsepistle-000058-discussion-notifications.ts'
import type * as NotificationPreferenceOperations from '../../../server/operations/page-watching.ts'
import { browserWindow, document } from '../../test/browser-dom.mts'
import { OFFLINE_SESSION_INVALIDATED_EVENT } from '../../helpers/offline-session.ts'
import type { NotificationPreferences } from '../../../shared/site-notifications.ts'
import type { SiteConfig } from '../../env.d.ts'
import { DEFAULT_THEME_COLORS } from '../../../shared/theme-colors.ts'
import packageMetadata from '../../../package.json'

// Runtime DOM must capture browser-dom's installed document, not a pre-import global.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const { VBtn, VCheckbox } = await import('vuetify/components')
const previousSiteConfig = Object.getOwnPropertyDescriptor(browserWindow, 'siteConfig')
const siteConfig: SiteConfig = {
  title: 'Consent interaction test',
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
const { wikiStore } = await import('../../store/index.ts')
Bun.plugin({
  name: 'comment-reply-consent-sfc',
  setup(builder) {
    builder.onLoad({ filter: /comment-reply-opt-in\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const compiled = compileScript(parsed.descriptor, {
        id: path.basename(filename, '.vue'),
        genDefaultAs: '__component',
        inlineTemplate: true
      })
      return { loader: 'ts', contents: `${compiled.content}\nexport default __component;` }
    })
  }
})
// The SFC must load after the compiler plugin above is registered.
const ReplyOptIn = (await import('./comment-reply-opt-in.vue')).default as Component
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
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
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
const preferences = (): NotificationPreferences => ({
  pageCreated: { inApp: true, email: false },
  pageDeleted: { inApp: false, email: true },
  watchedPageComment: { inApp: true, email: true },
  commentReply: { inApp: false, email: true },
  mention: { inApp: false, email: true }
})
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const reply = (value = preferences(), ownerId = 7) => json({ ownerId, preferences: value })
const settle = async () => {
  // Response.json and the Vue render both complete asynchronously.
  for (let index = 0; index < 12; index++) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}
const mount = async (transport: (url: string, init?: RequestInit) => Promise<Response>) => {
  Object.defineProperty(browserWindow, 'siteConfig', { configurable: true, writable: true, value: siteConfig })
  // Localize presentation without replacing consent logic or the real preference APIs.
  const translation = vi
    .spyOn(i18next, 't')
    .mockImplementation(((key: string, options?: Record<string, unknown>) =>
      typeof options?.defaultValue === 'string' ? options.defaultValue : key) as typeof i18next.t)
  cleanups.push(() => translation.mockRestore())
  Object.assign(wikiStore.user, { id: 7, authenticated: true, authVersion: 3, email: 'reader@example.test' })
  Object.assign(wikiStore, { authRefreshSettled: true, authRefreshOutcome: 'authenticated', authRefreshPending: false })
  wikiStore.page.id = 9
  Object.assign(wikiStore.page.effectivePermissions.comments, { read: true, write: true })
  const fetch = vi.fn(transport)
  browserWindow.fetch = (input, init) => fetch(String(input), init)
  const props = Vue.reactive({ pageId: 9, contributionId: 42, authorized: true })
  const dismiss = vi.fn()
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({ render: () => Vue.h(ReplyOptIn, { ...props, onDismiss: dismiss }) })
  app.use(createVuetify({ components: { VBtn, VCheckbox } }))
  app.mount(host)
  let mounted = true
  const unmount = () => {
    if (mounted) {
      mounted = false
      app.unmount()
      host.remove()
    }
  }
  cleanups.push(unmount)
  await settle()
  const save = () => {
    const button = host.querySelector<HTMLButtonElement>('button[variant], button')
    if (!button) throw new Error('Reply preference Save control is unavailable')
    return button
  }
  const select = async () => {
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (!checkbox) throw new Error('Reply preference choice is unavailable')
    checkbox.click()
    await Vue.nextTick()
  }
  return { host, fetch, props, dismiss, unmount, save, select }
}
const writes = (fetch: { mock: { calls: Array<[string, RequestInit?]> } }) =>
  fetch.mock.calls.filter(([, init]) => init?.method !== undefined && init.method !== 'GET' && init.method !== 'HEAD')

describe('post-contribution reply notification consent', () => {
  it('starts unchecked; unchecked Save, declining, and dismissing never mutate preferences', async () => {
    const view = await mount(async () => reply())
    expect(view.host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
    expect(view.save().disabled).toBe(true)
    view.save().click()
    await settle()
    expect(writes(view.fetch)).toHaveLength(0)
    await view.select()
    expect(writes(view.fetch)).toHaveLength(0)
    const buttons = view.host.querySelectorAll<HTMLButtonElement>('button')
    buttons[buttons.length - 1]!.click()
    expect(view.dismiss).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(writes(view.fetch)).toHaveLength(0)
  })

  it('rereads on explicit Save and preserves profile changes committed after that snapshot', async () => {
    const knex = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { min: 1, max: 1 },
      useNullAsDefault: true
    })
    const previousWiki = Object.getOwnPropertyDescriptor(globalThis, 'WIKI')
    cleanups.push(async () => {
      if (previousWiki) Object.defineProperty(globalThis, 'WIKI', previousWiki)
      else Reflect.deleteProperty(globalThis, 'WIKI')
      await knex.destroy()
    })
    await knex.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable().defaultTo(true)
      table.string('email').notNullable()
    })
    await knex.schema.createTable('pageWatchNotifications', table => {
      table.string('id').primary()
    })
    await upNotificationPreferences(knex)
    const owner = { id: 7, email: 'reader@example.test' }
    await knex('users').insert({ id: owner.id, email: owner.email })
    Reflect.set(globalThis, 'WIKI', { models: { knex } })
    const operations = await vi.importFresh<typeof NotificationPreferenceOperations>(
      '../../../server/operations/page-watching.ts',
      import.meta.url
    )
    await operations.updateNotificationPreferences(owner, { preferences: preferences() })
    const snapshotReady = Promise.withResolvers<void>()
    const releaseSnapshot = Promise.withResolvers<void>()
    const patchCommitted = Promise.withResolvers<void>()
    cleanups.push(() => releaseSnapshot.resolve())
    let reads = 0
    const view = await mount(async (_url, init) => {
      if (init?.method === 'PATCH') {
        const response = await operations.updateNotificationPreferences(owner, JSON.parse(init.body as string))
        patchCommitted.resolve()
        return json(response)
      }
      const snapshot = await operations.getNotificationPreferences(owner)
      if (++reads === 2) {
        snapshotReady.resolve()
        await releaseSnapshot.promise
      }
      return json(snapshot)
    })
    await vi.waitFor(() => expect(view.host.querySelector('input[type="checkbox"]') !== null).toBe(true))
    await operations.updateNotificationPreferences(owner, {
      preferences: { pageCreated: { email: true }, mention: { inApp: true }, commentReply: { email: false } }
    })
    await view.select()
    view.save().click()
    await snapshotReady.promise
    // A profile save commits after the widget's final GET, but before its PATCH.
    await operations.updateNotificationPreferences(owner, {
      preferences: {
        pageDeleted: { inApp: true, email: false },
        watchedPageComment: { email: false },
        commentReply: { email: true },
        mention: { inApp: false, email: false }
      }
    })
    releaseSnapshot.resolve()
    await patchCommitted.promise
    expect((await operations.getNotificationPreferences(owner)).preferences).toEqual({
      pageCreated: { inApp: true, email: true },
      pageDeleted: { inApp: true, email: false },
      watchedPageComment: { inApp: true, email: false },
      commentReply: { inApp: true, email: true },
      mention: { inApp: false, email: false }
    })
    await vi.waitFor(() => expect(view.host.querySelector('input[type="checkbox"]') === null).toBe(true))
    expect(reads).toBe(2)
    expect(writes(view.fetch)).toHaveLength(1)
    const [url, init] = writes(view.fetch)[0]!
    expect(url).toBe('/_api/pages/notifications/preferences')
    expect(new Headers(init!.headers).get('X-Notification-Owner')).toBe('7')
    expect(view.host.querySelector('[role="status"]') !== null).toBe(true)
    expect(view.host.querySelector('[role="alert"]') === null).toBe(true)
  })

  for (const enabledAt of ['preview', 'save'] as const) {
    it(`does not write when reply delivery is already enabled at ${enabledAt}`, async () => {
      let reads = 0
      const view = await mount(async () => {
        const value = preferences()
        value.commentReply.inApp = enabledAt === 'preview' || ++reads > 1
        return reply(value)
      })
      if (enabledAt === 'save') {
        await view.select()
        view.save().click()
        await settle()
      }
      expect(writes(view.fetch)).toHaveLength(0)
      expect(view.host.querySelector('input[type="checkbox"]')).toBeNull()
      expect(view.host.querySelector('[role="status"]')).not.toBeNull()
    })
  }

  const changes: Record<string, (props: { pageId: number; contributionId: number; authorized: boolean }) => void> = {
    owner: () => {
      wikiStore.user.id = 8
    },
    authVersion: () => {
      wikiStore.user.authVersion++
    },
    identityEpoch: () => {
      wikiStore.offlineIdentityEpoch++
    },
    page: () => {
      wikiStore.page.id = 10
    },
    readAcl: () => {
      wikiStore.page.effectivePermissions.comments.read = false
    },
    writeAcl: () => {
      wikiStore.page.effectivePermissions.comments.write = false
    },
    contribution: props => {
      props.contributionId = 43
    },
    pageProp: props => {
      props.pageId = 10
    },
    authorization: props => {
      props.authorized = false
    },
    session: () => {
      browserWindow.dispatchEvent(new browserWindow.Event(OFFLINE_SESSION_INVALIDATED_EVENT))
    }
  }
  for (const [name, change] of Object.entries(changes)) {
    for (const phase of ['preview', 'refresh', 'save'] as const) {
      it(`ignores a late ${phase} response after ${name} changes`, async () => {
        const pending = Promise.withResolvers<Response>()
        let reads = 0
        const view = await mount(async (_url, init) => {
          if (init?.method === 'PATCH') return phase === 'save' ? pending.promise : reply()
          reads++
          if ((phase === 'preview' && reads === 1) || (phase === 'refresh' && reads === 2)) return pending.promise
          // A replacement identity may preview, but never inherit the previous choice.
          return reply(preferences(), wikiStore.user.id)
        })
        if (phase !== 'preview') {
          await view.select()
          view.save().click()
          await settle()
          expect(writes(view.fetch)).toHaveLength(phase === 'save' ? 1 : 0)
        }
        change(view.props)
        await Vue.nextTick()
        pending.resolve(reply({ ...preferences(), commentReply: { inApp: true, email: true } }))
        await settle()
        expect(writes(view.fetch)).toHaveLength(phase === 'save' ? 1 : 0)
        for (const [, init] of writes(view.fetch)) expect(new Headers(init!.headers).get('X-Notification-Owner')).toBe('7')
        expect(view.host.querySelector('[role="status"]')).toBeNull()
        expect(view.host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ?? false).toBe(false)
      })
    }
  }

  for (const failure of ['lost-response', 'wrong-owner', 'unconfirmed-channel'] as const) {
    it(`does not fabricate success or replay a ${failure} save`, async () => {
      const view = await mount(async (_url, init) => {
        if (init?.method !== 'PATCH') return reply()
        if (failure === 'lost-response') throw new TypeError('Connection lost after request')
        return reply(preferences(), failure === 'wrong-owner' ? 8 : 7)
      })
      await view.select()
      view.save().click()
      await settle()
      expect(writes(view.fetch)).toHaveLength(1)
      expect(view.host.querySelector('[role="status"]')).toBeNull()
      expect(view.host.querySelector('[role="alert"]')).not.toBeNull()
      expect(view.host.querySelector('input[type="checkbox"]')).toBeNull()
      expect(view.host.querySelector('a')?.getAttribute('href')).toBe('/p/notifications')
      await settle()
      expect(writes(view.fetch)).toHaveLength(1)
    })
  }
})
