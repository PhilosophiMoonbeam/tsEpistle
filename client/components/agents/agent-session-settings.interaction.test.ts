import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Mock } from 'bun:test'

import { compileStyle, compileTemplate, parse } from '@vue/compiler-sfc'
import { load } from 'cheerio'
import { JSDOM } from 'jsdom'
import * as Vue from 'vue'
import { computed, createSSRApp, defineComponent, h, nextTick, reactive, ref, toRefs, watch } from 'vue'
import type { RenderFunction } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createVuetify } from 'vuetify'
import { VAlert } from 'vuetify/components'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import type { AgentProviderProfileView, AgentSessionView } from '../../../shared/agents/contracts.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

interface SettingsProps {
  session: AgentSessionView
  profiles: readonly AgentProviderProfileView[]
  disabled: boolean
  applyProviderProfile: (profileId: string | null) => Promise<{ readonly success: true } | { readonly success: false; readonly error: string }>
}

interface Ref<T> {
  value: T
}

interface SettingsHarness {
  readonly agents: {
    sessionMutationBusy: boolean
  }
  readonly props: SettingsProps
  readonly setSessionRetention: Mock<(sessionId: string, retention: 'temporary' | 'saved') => Promise<void>>
  readonly state: Record<string, unknown> & {
    agents: {
      sessionMutationBusy: boolean
    }
    applying: Ref<boolean>
    applyProfile: () => Promise<void>
    profileId: Ref<string | null>
    profileError: Ref<string>
    retentionError: Ref<string>
    updatingRetention: Ref<boolean>
    toggleRetention: () => Promise<void>
  }
}

const componentPath = join(process.cwd(), 'client/components/agents/agent-session-settings.vue')
const componentSource = readFileSync(componentPath, 'utf8')
const descriptor = parse(componentSource, { filename: componentPath }).descriptor
const template = descriptor.template?.content
const script = descriptor.scriptSetup?.content
if (!template || !script) throw new Error('agent-session-settings.vue template or script block was not found')

const componentStyleId = 'agent-session-settings-interaction'
const componentScopeId = `data-v-${componentStyleId}`
const componentStyles = descriptor.styles
  .map(style => {
    const compiled = compileStyle({
      source: style.content,
      filename: componentPath,
      id: componentStyleId,
      scoped: style.scoped
    })
    if (compiled.errors.length > 0) {
      throw new Error(`Could not compile agent-session-settings.vue styles: ${compiled.errors.join(', ')}`)
    }
    return compiled.code
  })
  .join('\n')
// JSDOM does not resolve custom properties inside max(), so render with the
// narrow-screen production token value while retaining the compiled cascade.
const renderedComponentStyles = componentStyles.replace(/var\(\s*--wiki-control-height\s*(?:,[^)]+)?\)/g, '2.625rem')

// Function mode cannot generate scoped-template helpers. The component
// __scopeId below applies the matching attribute while rendering instead.
const compiledTemplate = compileTemplate({
  source: template,
  filename: componentPath,
  id: componentStyleId,
  compilerOptions: { mode: 'function' }
})
if (compiledTemplate.errors.length > 0) throw new Error(`Could not compile agent-session-settings.vue: ${compiledTemplate.errors.join(', ')}`)

const render = new Function('Vue', compiledTemplate.code)(Vue) as RenderFunction

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, ''))
const evaluateSettings = new Function(
  'computed',
  'onBeforeUnmount',
  'ref',
  'watch',
  'defineProps',
  'useAgentsStore',
  `${executableScript}\nreturn {
    agents,
    profileId,
    applying,
    updatingRetention,
    profileError,
    retentionError,
    toggleRetention,
    defaultProfile,
    explicitProfile,
    effectiveProfile,
    profileSummary,
    profileItems,
    providerControlsAvailable,
    profileChanged,
    profileBehavior,
    routeProfileName,
    routeModel,
    routeUtilityModel,
    routeDestination,
    retentionIcon,
    retentionTitle,
    retentionSummary,
    resetProfileSelection,
    applyProfile
  }`
) as (...dependencies: unknown[]) => SettingsHarness['state']

const makeSession = (overrides: Partial<AgentSessionView> = {}): AgentSessionView => ({
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Release planning',
  retention: 'temporary',
  folderId: null,
  status: 'active',
  executionMode: 'agent',
  version: 1,
  providerProfileId: null,
  profileResolutionToken: 'profile-token',
  skills: [],
  currentRun: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  lastActivityAt: '2026-09-01T10:00:00.000Z',
  expiresAt: null,
  ...overrides
})

const profile = {
  id: 'profile-1',
  name: 'Local provider',
  model: 'test-model',
  utilityModel: null,
  destinationHost: 'localhost',
  isGlobalDefault: true
} as AgentProviderProfileView

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const loadSettings = (options: { session?: AgentSessionView; profiles?: readonly AgentProviderProfileView[] } = {}): SettingsHarness => {
  const props = reactive<SettingsProps>({
    session: options.session ?? makeSession(),
    profiles: options.profiles ?? [],
    disabled: false,
    applyProviderProfile: vi.fn(async () => ({ success: true as const }))
  })
  const agents = reactive({ sessionMutationBusy: false, setSessionRetention: vi.fn(async () => undefined) })
  const setSessionRetention = agents.setSessionRetention
  const state = evaluateSettings(
    computed,
    () => undefined,
    ref,
    watch,
    () => props,
    () => agents
  )
  return { agents, props, setSessionRetention, state }
}

const slotContainer = defineComponent({
  setup(_props, { slots }) {
    return () => h('div', null, slots.default?.())
  }
})

const buttonStub = defineComponent({
  inheritAttrs: false,
  props: {
    disabled: Boolean,
    loading: Boolean,
    size: String
  },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        'button',
        {
          ...attrs,
          disabled: props.disabled || undefined,
          'data-loading': props.loading ? 'true' : undefined,
          'data-size': props.size
        },
        slots.default?.()
      )
  }
})

const renderSettings = async (harness: SettingsHarness): Promise<string> => {
  const component = Object.assign(
    defineComponent({
      setup: () => ({ ...harness.state, ...toRefs(harness.props) }),
      render
    }),
    { __scopeId: componentScopeId }
  )
  const app = createSSRApp(component)
  app.use(createVuetify())
  for (const name of ['v-expansion-panels', 'v-expansion-panel', 'v-expansion-panel-title', 'v-expansion-panel-text', 'v-chip']) {
    app.component(name, slotContainer)
  }
  app.component('v-alert', VAlert)
  app.component('v-btn', buttonStub)
  app.component('v-icon', defineComponent({ setup: () => () => h('span') }))
  app.component('v-progress-circular', defineComponent({ setup: () => () => h('span') }))
  app.component(
    'v-select',
    defineComponent({
      inheritAttrs: false,
      setup:
        (_props, { attrs }) =>
        () =>
          h('select', attrs)
    })
  )
  return renderToString(app)
}

describe('Agent session retention settings interaction', () => {
  it('disables retention and provider changes while another session mutation owns the store lock', async () => {
    const harness = loadSettings({ profiles: [profile] })
    harness.state.profileId.value = profile.id
    harness.agents.sessionMutationBusy = true

    await Promise.all([harness.state.toggleRetention(), harness.state.applyProfile()])

    expect(harness.setSessionRetention).not.toHaveBeenCalled()
    expect(harness.props.applyProviderProfile).not.toHaveBeenCalled()
    const locked = load(await renderSettings(harness))
    expect(locked('.agent-session-settings__retention-action').attr('disabled')).toBeDefined()
    expect(locked('select').attr('disabled')).toBeDefined()
    expect(
      locked('button')
        .filter((_index, button) => locked(button).text().includes('Apply to session'))
        .attr('disabled')
    ).toBeDefined()

    harness.agents.sessionMutationBusy = false
    const unlocked = load(await renderSettings(harness))
    expect(unlocked('.agent-session-settings__retention-action').attr('disabled')).toBeUndefined()
    expect(unlocked('select').attr('disabled')).toBeUndefined()
    expect(
      unlocked('button')
        .filter((_index, button) => unlocked(button).text().includes('Apply to session'))
        .attr('disabled')
    ).toBeUndefined()

    await Promise.all([harness.state.toggleRetention(), harness.state.applyProfile()])
    expect(harness.setSessionRetention).toHaveBeenCalledTimes(1)
    expect(harness.props.applyProviderProfile).toHaveBeenCalledTimes(1)
  })

  it('announces retention failures beside their retry action without changing provider state', async () => {
    for (const profiles of [[], [profile]] as const) {
      const harness = loadSettings({ profiles })
      harness.setSessionRetention.mockRejectedValueOnce(new Error('Retention service unavailable.'))

      await harness.state.toggleRetention()

      expect(harness.state.retentionError.value).toBe('Retention service unavailable.')
      expect(harness.state.profileError.value).toBe('')
      const $ = load(await renderSettings(harness))
      const retentionActions = $('.agent-session-settings__retention-actions')
      expect(retentionActions.children('[role="alert"]').text()).toContain('Retention service unavailable.')
      expect(retentionActions.children('button').text()).toContain('Keep in Recent')
      expect($('.agent-session-settings__provider')).toHaveLength(profiles.length > 0 ? 1 : 0)
      if (profiles.length > 0) expect($('button').filter((_index, button) => $(button).text().includes('Apply to session'))).toHaveLength(1)

      harness.setSessionRetention.mockResolvedValueOnce(undefined)
      await harness.state.toggleRetention()
      expect(harness.setSessionRetention).toHaveBeenCalledTimes(2)
      expect(harness.state.retentionError.value).toBe('')
    }
  })

  it('does not let a previous session completion or error alter the current retention request', async () => {
    for (const settlePrevious of ['resolve', 'reject'] as const) {
      const previous = deferred<void>()
      const current = deferred<void>()
      const harness = loadSettings()
      harness.setSessionRetention.mockImplementationOnce(() => previous.promise).mockImplementationOnce(() => current.promise)

      const previousMutation = harness.state.toggleRetention()
      harness.props.session = makeSession({ id: '00000000-0000-4000-8000-000000000002', retention: 'saved' })
      await nextTick()
      const currentMutation = harness.state.toggleRetention()
      expect(harness.state.updatingRetention.value).toBe(true)

      if (settlePrevious === 'resolve') previous.resolve(undefined)
      else previous.reject(new Error('Late failure from the previous session.'))
      await previousMutation

      expect(harness.state.updatingRetention.value).toBe(true)
      expect(harness.state.retentionError.value).toBe('')
      expect(harness.setSessionRetention).toHaveBeenNthCalledWith(1, '00000000-0000-4000-8000-000000000001', 'saved')
      expect(harness.setSessionRetention).toHaveBeenNthCalledWith(2, '00000000-0000-4000-8000-000000000002', 'temporary')

      current.reject(new Error('Current session retention failed.'))
      await currentMutation
      expect(harness.state.updatingRetention.value).toBe(false)
      expect(harness.state.retentionError.value).toBe('Current session retention failed.')
    }
  })

  it('renders policy-neutral labels on a readable action with a 44px minimum target', async () => {
    const temporaryHtml = await renderSettings(loadSettings({ session: makeSession({ retention: 'temporary', expiresAt: null }) }))
    const savedHtml = await renderSettings(loadSettings({ session: makeSession({ retention: 'saved' }) }))
    const temporary = load(temporaryHtml)
    const saved = load(savedHtml)

    const temporaryAction = temporary('.agent-session-settings__retention-action')
    const savedAction = saved('.agent-session-settings__retention-action')
    expect(temporaryAction.text().trim()).toBe('Keep in Recent')
    expect(savedAction.text().trim()).toBe('Make temporary')
    expect(temporaryAction.attr('data-size')).toBeUndefined()
    expect(savedAction.attr('data-size')).toBeUndefined()
    expect(temporary.root().text()).not.toContain('90 days')
    expect(temporary.root().text()).not.toContain('24 hours')
    expect(saved.root().text()).not.toContain('90 days')
    expect(saved.root().text()).not.toContain('24 hours')

    const dom = new JSDOM(`<!doctype html><html><head><style>${renderedComponentStyles}</style></head><body>${temporaryHtml}</body></html>`)
    const renderedAction = dom.window.document.querySelector<HTMLElement>('.agent-session-settings__retention-action')
    if (!renderedAction) throw new Error('Rendered retention action was not found')
    expect(renderedAction.hasAttribute(componentScopeId)).toBe(true)

    const minimumTargetHeight = Number.parseFloat(dom.window.getComputedStyle(renderedAction).minHeight)
    expect(minimumTargetHeight).toBeGreaterThanOrEqual(44)
  })
})
