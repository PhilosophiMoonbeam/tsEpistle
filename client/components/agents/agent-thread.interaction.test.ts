import fs from 'node:fs'
import path from 'node:path'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import type { i18n } from 'i18next'
import i18next from 'i18next'
import type { RenderFunction } from 'vue'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import type {
  AgentArtifactView,
  AgentMediaView,
  AgentMessageView,
  AgentRunView,
  AgentSessionView,
  AgentThreadState,
  AgentToolCallView
} from '../../../shared/agents/contracts.ts'
import { wikiSourceSelectorFromHref } from '../../../shared/wiki-source.ts'
import { agentMediaContentUrl } from '../../helpers/agents-api.ts'
import type { Translate } from '../../helpers/use-translate.ts'
import { resolveUserPicture, type UserPicture } from '../../helpers/user-picture.ts'
import { agentLiveAnnouncement, buildAgentThreadPresentation, placeAgentArtifacts } from './agent-thread-presentation.ts'

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-thread.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const parsedSfc = parse(componentSource, { filename: componentPath })
if (parsedSfc.errors.length > 0) throw new Error(`Could not parse agent-thread.vue: ${parsedSfc.errors.join(', ')}`)
if (!parsedSfc.descriptor.template || !parsedSfc.descriptor.scriptSetup) throw new Error('AgentThread template and setup script are required')

import { browserWindow, resetBody, setLocation } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'

globalThis.useTranslate = () => translateEnglish
setLocation('https://wiki.test/')

resetBody()

// Vue must load after JSDOM so runtime-dom captures the test document.
const Vue = await import('vue')
const compiledTemplate = compileTemplate({
  source: parsedSfc.descriptor.template.content,
  filename: componentPath,
  id: 'agent-thread-interaction-test',
  compilerOptions: { mode: 'function' }
})
const renderAgentThread = new Function('Vue', compiledTemplate.code)(Vue) as RenderFunction

// Load real children only after registering the SFC loader; static imports bypass this test boundary.
Bun.plugin({
  name: 'agent-thread-real-children',
  setup(builder) {
    builder.onLoad({ filter: /(?:agent-artifact-grid|status-indicator)\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const script = compileScript(parsed.descriptor, { id: 'agent-thread-real-artifact-grid', genDefaultAs: '__component', inlineTemplate: true })
      return { loader: 'ts', contents: `${script.content}\nexport default __component;` }
    })
  }
})
const AgentArtifactGrid = (await import('./agent-artifact-grid.vue')).default
// The test loader must be installed before this known module is imported.
const StatusIndicator = (await import('../common/status-indicator.vue')).default

const scriptWithoutImports = parsedSfc.descriptor.scriptSetup.content.replace(/import[\s\S]*?from\s+['"][^'"]+['"]\s*/g, '')
const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(scriptWithoutImports)
const evaluateAgentThread = new Function(
  'computed',
  'ref',
  'watch',
  'onUnmounted',
  'i18next',
  'useTranslate',
  'defineProps',
  'defineEmits',
  'wikiSourceSelectorFromHref',
  'agentLiveAnnouncement',
  'buildAgentThreadPresentation',
  'agentMediaContentUrl',
  'placeAgentArtifacts',
  `${executableScript}
return { artifactPlacement, artifactTimeLabel, temporalMetadataFor, emit, forwardDecision, liveSummary, liveSummaryRevision, previewSelector, previewCitation, activityOpen, markActivityToggle, handleActivityToggle, threadPresentation, threadProjection, toolStateColor, toolStateIcon, toolStateLabel, reattachConfirmId, requestReattach, cancelReattach, confirmReattach, agentMediaContentUrl }`
) as (...dependencies: unknown[]) => Record<string, unknown>

const NullStub = Vue.defineComponent({
  inheritAttrs: false,
  setup: () => () => null
})
const AvatarStub = Vue.defineComponent({
  inheritAttrs: false,
  props: {
    size: { type: [Number, String], default: 28 },
    color: String,
    variant: String
  },
  setup(props, { attrs, slots }) {
    return () =>
      Vue.h(
        'div',
        {
          ...attrs,
          class: ['v-avatar', attrs.class],
          'data-size': props.size,
          style: { height: `${props.size}px`, width: `${props.size}px` }
        },
        slots.default?.()
      )
  }
})
const ImageStub = Vue.defineComponent({
  inheritAttrs: false,
  props: {
    src: { type: String, required: true },
    alt: { type: String, default: '' },
    cover: Boolean
  },
  setup(props, { attrs }) {
    return () => Vue.h('img', { ...attrs, class: ['v-img', attrs.class], src: props.src, alt: props.alt })
  }
})
const IconStub = Vue.defineComponent({
  inheritAttrs: false,
  props: { icon: String, size: [Number, String], color: String },
  setup(props, { attrs }) {
    return () => Vue.h('i', { ...attrs, class: ['v-icon', attrs.class], 'data-icon': props.icon, 'data-color': props.color })
  }
})
const BeamStub = Vue.defineComponent({
  inheritAttrs: false,
  props: { enabled: Boolean, phaseOffsetMs: Number },
  setup(props) {
    return () =>
      props.enabled
        ? Vue.h('svg', {
            class: 'control-border-beam',
            'aria-hidden': 'true',
            focusable: 'false',
            tabindex: '-1',
            role: 'presentation',
            'data-phase-offset-ms': props.phaseOffsetMs
          })
        : null
  }
})
const ButtonStub = Vue.defineComponent({
  inheritAttrs: false,
  props: { disabled: Boolean },
  emits: ['click'],
  setup(props, { attrs, emit, slots }) {
    return () => Vue.h('button', { ...attrs, disabled: props.disabled, onClick: (event: MouseEvent) => emit('click', event) }, slots.default?.())
  }
})
const PreviewStub = Vue.defineComponent({
  props: { selector: { type: Object, required: true } },
  setup(props) {
    return () => Vue.h('div', { class: 'wiki-source-preview', 'data-selector': JSON.stringify(props.selector) })
  }
})

const makeSession = (id: string): AgentSessionView => ({
  id,
  title: 'Release planning',
  retention: 'saved',
  folderId: null,
  status: 'active',
  executionMode: 'agent',
  version: 1,
  providerProfileId: null,
  profileResolutionToken: 'profile-token',
  mediaCapabilities: null,
  skills: [],
  currentRun: null,
  createdAt: '2026-09-03T10:00:00.000Z',
  updatedAt: '2026-09-03T10:00:00.000Z',
  lastActivityAt: '2026-09-03T10:00:00.000Z',
  expiresAt: null
})

const makeCurrentRun = (sessionId: string, id = 'run-1'): AgentRunView => ({
  id,
  sessionId,
  status: 'running',
  attempt: 1,
  eventSequence: 1,
  canCancel: true,
  createdAt: '2026-09-03T10:00:00.000Z',
  startedAt: '2026-09-03T10:00:00.000Z',
  completedAt: null,
  errorCode: null,
  errorMessage: null
})

const makeMessage = (overrides: Partial<AgentMessageView> = {}): AgentMessageView => ({
  id: 'assistant-1',
  runId: 'run-1',
  ordinal: 1,
  role: 'assistant',
  status: 'streaming',
  content: '',
  citations: [],
  createdAt: '2026-09-03T10:00:00.000Z',
  updatedAt: '2026-09-03T10:00:00.000Z',
  ...overrides
})

const makeMedia = (overrides: Partial<AgentMediaView> = {}): AgentMediaView => ({
  id: 'media-1',
  kind: 'attachment',
  filename: 'report.pdf',
  mimeType: 'application/pdf',
  byteLength: 2048,
  available: true,
  detached: false,
  ...overrides
})

const makeTool = (overrides: Partial<AgentToolCallView> = {}): AgentToolCallView => ({
  id: 'tool-1',
  runId: 'run-1',
  actionName: 'pages.preparePatch',
  title: 'Prepare page patch',
  state: 'awaitingApproval',
  risk: 'proposal',
  summary: null,
  proposalId: 'proposal-1',
  startedAt: '2026-09-03T10:00:01.000Z',
  completedAt: null,
  ...overrides
})

const makeThread = (sessionId: string, overrides: Partial<AgentThreadState> = {}): AgentThreadState => ({
  session: makeSession(sessionId),
  messages: [],
  tools: [],
  tasks: [],
  goal: null,
  proposals: [],
  artifacts: [],
  routingDecisions: [],
  specialistInvocations: [],
  suggestions: [],
  historyWindow: { messageLimit: 100, hasOlderMessages: false, runLimit: 25, hasOlderRuns: false },
  ...overrides
})

interface PresentedMessage {
  readonly message: AgentMessageView
  readonly run: { readonly pageLinks: readonly unknown[] } | null
  readonly citationGroups: readonly { readonly sections: readonly unknown[] }[]
  readonly googleSearchCitations: readonly unknown[]
  readonly statusLabel: string
  readonly temporal: { readonly time: string; readonly timestamp: string }
}

interface MountedThread {
  readonly host: HTMLElement
  readonly thread: { value: AgentThreadState }
  readonly connection: { value: string }
  readonly userPicture: { value: UserPicture }
  readonly emittedReattachments: unknown[][]
  readonly emittedSuggestions: unknown[][]
  readonly projection: { readonly value: { readonly orderedMessages: readonly PresentedMessage[] } }
  readonly unmount: () => void
}

const mountedApps: Array<() => void> = []
const settle = async (): Promise<void> => {
  await Vue.nextTick()
  await Vue.nextTick()
}

const mountThread = async (
  initialThread: AgentThreadState,
  initialConnection = 'connected',
  initialUserPicture: UserPicture = resolveUserPicture({ id: 42, name: 'Ada Lovelace', pictureUrl: '' }),
  localization: { readonly translate: Translate; readonly engine: i18n } = { translate: translateEnglish, engine: i18next }
): Promise<MountedThread> => {
  const host = document.createElement('div')
  document.body.append(host)
  const thread = Vue.shallowRef(initialThread)
  const userPicture = Vue.shallowRef(initialUserPicture)
  const connection = Vue.ref(initialConnection)
  const emittedReattachments: unknown[][] = []
  const emittedSuggestions: unknown[][] = []
  let projection: MountedThread['projection']
  const agentThread = Vue.defineComponent({
    name: 'AgentThreadInteractionHarness',
    props: {
      thread: { type: Object, required: true },
      connection: { type: String, required: true },
      userPicture: { type: Object, required: true },
      decidingApprovalId: { type: String, default: null },
      canSubmit: { type: Boolean, default: true },
      networkBlocked: { type: Boolean, default: false }
    },
    emits: ['askSource', 'suggest', 'decision', 'reattach'],
    setup(props, { emit }) {
      const setup = evaluateAgentThread(
        Vue.computed,
        Vue.ref,
        Vue.watch,
        Vue.onUnmounted,
        localization.engine,
        () => localization.translate,
        () => props,
        () => emit,
        wikiSourceSelectorFromHref,
        agentLiveAnnouncement,
        buildAgentThreadPresentation,
        agentMediaContentUrl,
        placeAgentArtifacts
      )
      projection = setup.threadProjection as MountedThread['projection']
      return setup
    },
    render: renderAgentThread
  })
  const harness = Vue.defineComponent({
    setup: () => ({ thread, connection, userPicture }),
    render: () =>
      Vue.h(agentThread, {
        thread: thread.value,
        connection: connection.value,
        userPicture: userPicture.value,
        onReattach: (...args: unknown[]) => emittedReattachments.push(args),
        onSuggest: (...args: unknown[]) => emittedSuggestions.push(args)
      })
  })
  const app = Vue.createApp(harness)
  app.config.globalProperties.$t = localization.translate
  for (const name of ['AgentAnswerActions', 'AgentMarkdown', 'AgentTaskProgress', 'AgentToolCard']) app.component(name, NullStub)
  app.component('StatusIndicator', StatusIndicator)
  app.component('v-avatar', AvatarStub)
  app.component('v-icon', IconStub)
  app.component('v-img', ImageStub)
  app.component('ControlBorderBeam', BeamStub)
  app.component('v-btn', ButtonStub)
  app.component('WikiSourcePreview', PreviewStub)
  app.component('AgentArtifactGrid', AgentArtifactGrid)
  app.mount(host)
  await settle()
  const unmount = (): void => {
    app.unmount()
    host.remove()
  }
  mountedApps.push(unmount)
  return { host, thread, connection, userPicture, projection: projection!, emittedReattachments, emittedSuggestions, unmount }
}

afterEach(() => {
  for (const unmount of mountedApps.splice(0)) unmount()
  document.body.replaceChildren()
})

describe('AgentThread identity presentation', () => {
  it('keeps the assistant mark decorative and updates the user avatar when the account picture changes', async () => {
    const mounted = await mountThread(
      makeThread('session-identities', {
        messages: [
          makeMessage({ id: 'assistant-identity', status: 'complete' }),
          makeMessage({ id: 'user-identity', role: 'user', status: 'failed', ordinal: 2, content: 'An account update' })
        ]
      })
    )

    const assistantIdentity = mounted.host.querySelector<HTMLElement>('.agent-message--assistant .agent-message__identity')
    expect(assistantIdentity?.getAttribute('aria-hidden')).toBe('true')
    expect(assistantIdentity?.querySelectorAll('button, a, input, [tabindex="0"]')).toHaveLength(0)

    const userIdentity = mounted.host.querySelector<HTMLElement>('.agent-message--user .agent-message__identity--user')
    const userDetails = userIdentity?.querySelector<HTMLElement>('.agent-message__user-details')
    const userAvatar = userIdentity?.querySelector<HTMLElement>('.agent-message__user-avatar')
    expect(userDetails?.querySelector('.agent-message__role')?.textContent).toBe('You')
    expect(userDetails?.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-03T10:00:00.000Z')
    expect(userDetails?.querySelector('.agent-message__status')?.textContent).toContain('Send failed')
    expect(userAvatar?.getAttribute('aria-hidden')).toBe('true')
    expect(userAvatar?.textContent?.trim()).toBe('AL')

    mounted.userPicture.value = resolveUserPicture({ id: 42, name: 'Ada Lovelace', pictureUrl: 'internal' })
    await settle()
    const internalImage = userIdentity?.querySelector<HTMLImageElement>('.agent-message__user-avatar img')
    expect(internalImage?.getAttribute('src')).toBe('/_userav/42')
    expect(internalImage?.getAttribute('alt')).toBe('')

    mounted.userPicture.value = resolveUserPicture({ id: 42, name: 'Ada Lovelace', pictureUrl: '/uploads/ada.webp' })
    await settle()
    expect(userIdentity?.querySelector<HTMLImageElement>('.agent-message__user-avatar img')?.getAttribute('src')).toBe('/uploads/ada.webp')

    mounted.userPicture.value = resolveUserPicture({ id: 43, name: 'Grace Hopper', pictureUrl: '' })
    await settle()
    expect(userIdentity?.querySelector('.agent-message__user-avatar img')).toBeNull()
    expect(userIdentity?.querySelector('.agent-message__user-avatar')?.textContent?.trim()).toBe('GH')
    expect(userIdentity?.querySelectorAll('button, a, input, [tabindex="0"]')).toHaveLength(0)
  })
})

describe('AgentThread live status and interaction behavior', () => {
  it('keeps historical task status and reports useful while hiding routing and specialist provider details', async () => {
    const receipt: AgentThreadState['specialistInvocations'][number] = {
      id: '00000000-0000-4000-8000-000000000041',
      contextId: '00000000-0000-4000-8000-000000000042',
      rootRunId: '00000000-0000-4000-8000-000000000043',
      profileVersionId: '00000000-0000-4000-8000-000000000044',
      model: 'private-specialist-model',
      taskClass: 'analysis',
      status: 'running',
      reused: true,
      contextVersion: 7,
      report: null,
      errorCode: null,
      startedAt: '2026-09-03T10:00:00.000Z',
      completedAt: null
    }
    const routing: AgentThreadState['routingDecisions'][number] = {
      runId: receipt.rootRunId,
      strategy: 'delegate',
      rootProfileVersionId: '00000000-0000-4000-8000-000000000045',
      specialistProfileVersionId: receipt.profileVersionId,
      reason: 'private routing reason',
      costs: { stayMicros: 123456789, coldSwapMicros: 234567891, delegateMicros: 345678912 }
    }
    const mounted = await mountThread(
      makeThread('historical-session', {
        specialistInvocations: [receipt],
        routingDecisions: [routing]
      })
    )
    const expectPrivateDetailsHidden = (): void => {
      for (const detail of [
        receipt.model,
        receipt.contextId,
        receipt.rootRunId,
        receipt.profileVersionId,
        routing.rootProfileVersionId,
        routing.reason,
        'PRIVATE_PROVIDER_FAILURE',
        '123456789',
        '234567891',
        '345678912'
      ])
        expect(mounted.host.innerHTML).not.toContain(detail)
    }
    const activity = mounted.host.querySelector<HTMLElement>('[aria-label="Agent task activity"]')
    if (!activity) throw new Error('Historical task activity did not render')
    expect(activity.querySelector('summary')?.textContent).toContain('analysis')
    expect(activity.querySelector('summary')?.textContent).toContain('Agent working')
    expect(activity.querySelector<HTMLDetailsElement>('details')?.open).toBe(true)
    expect(activity.querySelector('p')?.textContent?.trim()).not.toBe('')
    expect(activity.textContent).toContain('report pending')
    expectPrivateDetailsHidden()
    mounted.thread.value = {
      ...mounted.thread.value,
      specialistInvocations: [
        { ...receipt, status: 'completed', report: 'The release checklist is ready for review.', completedAt: '2026-09-03T10:01:00.000Z' }
      ]
    }
    await settle()
    expect(activity.querySelector('summary')?.textContent).toContain('Task complete')
    expect(activity.textContent).toContain('Task report')
    expect(activity.textContent).toContain('The release checklist is ready for review.')
    expectPrivateDetailsHidden()
    mounted.thread.value = {
      ...mounted.thread.value,
      specialistInvocations: [{ ...receipt, status: 'failed', errorCode: 'PRIVATE_PROVIDER_FAILURE', completedAt: '2026-09-03T10:01:00.000Z' }]
    }
    await settle()
    expect(activity.querySelector('summary')?.textContent).toContain('Task failed')
    expect(activity.querySelector('[role="status"]')?.textContent).toContain('could not complete this task')
    expect(activity.textContent).toContain('No report returned.')
    expectPrivateDetailsHidden()
  })

  it('explains matching public failures without leaking provider details or borrowing a different run failure', async () => {
    const session = makeSession('session-recovery')
    const runOutcome = { status: 'failed' as const, errorCode: 'AGENT_QUOTA_EXHAUSTED' }
    const mounted = await mountThread(
      makeThread(session.id, {
        session,
        messages: [
          makeMessage({ id: 'user-request', role: 'user', ordinal: 0, status: 'complete', content: 'Summarize the release' }),
          makeMessage({ status: 'failed', content: '', runOutcome })
        ]
      })
    )
    const recovery = (): HTMLElement => mounted.host.querySelector('.agent-message__recovery') as HTMLElement
    expect(recovery().getAttribute('role')).toBe('region')
    expect(recovery().getAttribute('aria-label')).toBeTruthy()
    expect(recovery().textContent).toContain('quota')
    expect(recovery().hasAttribute('aria-live')).toBe(false)
    expect(mounted.emittedSuggestions).toEqual([])
    const review = recovery().querySelector('button') as HTMLButtonElement
    expect(review.textContent).toContain('Review request')
    review.click()
    await settle()
    expect(mounted.emittedSuggestions).toEqual([['Summarize the release']])

    for (const [code, action] of [
      ['AGENT_CONTEXT_TOO_LARGE', 'Start a new conversation'],
      ['UNKNOWN_FAILURE', 'Nothing is sent automatically']
    ]) {
      mounted.thread.value = {
        ...mounted.thread.value,
        messages: mounted.thread.value.messages.map(message =>
          message.role === 'assistant' ? { ...message, runOutcome: { ...runOutcome, errorCode: code } } : message
        )
      }
      await settle()
      expect(recovery().textContent).toContain(action)
    }
    mounted.thread.value = {
      ...mounted.thread.value,
      messages: mounted.thread.value.messages.map(message => (message.role === 'assistant' ? { ...message, runOutcome: undefined } : message)),
      session: {
        ...session,
        currentRun: {
          id: 'different-run',
          sessionId: session.id,
          status: 'running',
          attempt: 1,
          eventSequence: 1,
          canCancel: true,
          createdAt: session.createdAt,
          startedAt: session.createdAt,
          completedAt: null,
          errorCode: 'AGENT_QUOTA_EXHAUSTED',
          errorMessage: 'secret provider payload'
        }
      }
    }
    await settle()
    expect(recovery().textContent).toContain('Nothing is sent automatically')
    expect(recovery().textContent).not.toContain('quota')
    expect(recovery().textContent).not.toContain('secret provider payload')
  })

  it('offers bounded recovery for the matching partial run with a complete assistant answer only', async () => {
    const session = makeSession('session-partial')
    const mounted = await mountThread(
      makeThread(session.id, {
        session,
        messages: [
          makeMessage({ id: 'old-answer', runId: 'older-run', ordinal: 0, status: 'complete', content: 'An earlier answer' }),
          makeMessage({ id: 'user-request', role: 'user', ordinal: 1, status: 'complete', content: 'Summarize the release' }),
          makeMessage({
            id: 'partial-answer',
            ordinal: 2,
            status: 'complete',
            content: 'The returned portion of the answer',
            runOutcome: { status: 'partial', errorCode: null }
          })
        ]
      })
    )
    const articles = mounted.host.querySelectorAll<HTMLElement>('.agent-message')
    const recovery = articles[2].querySelector<HTMLElement>('.agent-message__recovery')!
    expect(mounted.host.querySelectorAll('.agent-message__recovery')).toHaveLength(1)
    expect(recovery.getAttribute('role')).toBe('region')
    expect(recovery.getAttribute('aria-label')).toBeTruthy()
    expect(recovery.querySelector('strong')?.textContent).toBe('Partial answer')
    expect(recovery.textContent).toContain('Review the returned answer')
    expect(recovery.textContent).toContain('Narrow')
    expect(recovery.textContent).toContain('explicit follow-up')
    expect(recovery.hasAttribute('aria-live')).toBe(false)
    expect(mounted.host.querySelectorAll('[aria-live="polite"]')).toHaveLength(1)
    expect(mounted.host.querySelector('.sr-status')?.textContent).toBe('Partial answer')
    expect(articles[2].getAttribute('aria-label')).toBe('Wiki Agent message · Partial')
    expect(articles[2].querySelector('.agent-message__status')?.textContent).toContain('Partial')
    for (const article of [articles[0], articles[1]]) {
      expect(article.getAttribute('aria-label')).toContain('Complete')
      expect(article.querySelector('.agent-message__recovery')).toBeNull()
    }
    expect(mounted.emittedSuggestions).toEqual([])
    const review = recovery.querySelector<HTMLButtonElement>('button')!
    expect(review.textContent).toContain('Review request')
    review.click()
    await settle()
    expect(mounted.emittedSuggestions).toEqual([['Summarize the release']])

    const announcement = mounted.host.querySelector('.sr-status')
    mounted.thread.value = structuredClone(mounted.thread.value)
    await settle()
    expect(mounted.host.querySelector('.sr-status')).toBe(announcement)
    expect(mounted.host.querySelectorAll('.agent-message__recovery')).toHaveLength(1)

    mounted.thread.value = {
      ...mounted.thread.value,
      messages: mounted.thread.value.messages.map(message =>
        message.id === 'partial-answer' ? { ...message, runOutcome: { status: 'succeeded', errorCode: null } } : message
      )
    }
    await settle()
    expect(mounted.host.querySelector('.agent-message__recovery')).toBeNull()
    expect(mounted.host.querySelectorAll('.agent-message')[2].getAttribute('aria-label')).toContain('Complete')
    expect(mounted.emittedSuggestions).toEqual([['Summarize the release']])
  })

  it('announces complete, active, approval, and reconnecting states on mount', async () => {
    const states: Array<[string, AgentThreadState, string]> = [
      ['complete', makeThread('session-complete', { messages: [makeMessage({ status: 'complete' })] }), 'Response complete.'],
      ['active', makeThread('session-active', { messages: [makeMessage({ status: 'streaming' })] }), 'Generating response.'],
      [
        'approval',
        makeThread('session-approval', {
          messages: [makeMessage({ status: 'streaming' })],
          tools: [makeTool()]
        }),
        'Review needed before the response can continue.'
      ],
      ['reconnecting', makeThread('session-reconnecting', { messages: [makeMessage({ status: 'complete' })] }), 'Connection interrupted. Reconnecting.']
    ]

    for (const [name, thread, expected] of states) {
      const mounted = await mountThread(thread, name === 'reconnecting' ? 'reconnecting' : 'connected')
      expect(mounted.host.querySelector('.sr-status')?.textContent).toBe(expected)
      mounted.unmount()
      mountedApps.pop()
    }
  })

  it('re-announces an identical status for a different session but suppresses duplicate snapshots', async () => {
    const mounted = await mountThread(makeThread('session-one', { messages: [makeMessage({ status: 'complete' })] }))
    const firstStatus = mounted.host.querySelector('.sr-status')
    expect(firstStatus?.textContent).toBe('Response complete.')

    mounted.thread.value = makeThread('session-two', { messages: [makeMessage({ status: 'complete' })] })
    await settle()
    const secondStatus = mounted.host.querySelector('.sr-status')
    expect(secondStatus?.textContent).toBe('Response complete.')
    expect(secondStatus).not.toBe(firstStatus)

    mounted.thread.value = makeThread('session-two', { messages: [makeMessage({ status: 'complete', updatedAt: '2026-09-03T10:00:02.000Z' })] })
    await settle()
    expect(mounted.host.querySelector('.sr-status')).toBe(secondStatus)
  })

  it('moves from preparing to generating with one central announcement and animates only live assistant identities', async () => {
    const mounted = await mountThread(
      makeThread('session-transition', {
        messages: [
          makeMessage({ id: 'old', runId: 'old-run', status: 'complete', content: 'An earlier answer.' }),
          makeMessage({ id: 'live', status: 'pending', ordinal: 2 })
        ]
      })
    )
    const articles = mounted.host.querySelectorAll('.agent-message')
    expect(articles[0]?.querySelector('.control-border-beam')).toBeNull()
    expect(articles[1]?.querySelector('.control-border-beam')).not.toBeNull()
    expect(articles[1]?.querySelector('.agent-message__status')?.textContent).toContain('Preparing a response')
    expect(mounted.host.querySelectorAll('[aria-live="polite"]')).toHaveLength(1)
    const indicator = articles[1]?.querySelector('.status-indicator')
    expect(indicator?.getAttribute('aria-hidden')).toBe('true')
    expect(indicator?.getAttribute('aria-live')).toBe('off')
    expect(indicator?.getAttribute('role')).toBe('presentation')
    const preparingAnnouncement = mounted.host.querySelector('.sr-status')

    mounted.thread.value = {
      ...mounted.thread.value,
      messages: mounted.thread.value.messages.map(message => (message.id === 'live' ? { ...message, status: 'streaming', content: 'First token' } : message))
    }
    await settle()
    expect(articles[1]?.querySelector('.agent-message__status')?.textContent).toContain('Generating response')
    expect(mounted.host.querySelector('.sr-status')).not.toBe(preparingAnnouncement)
    const generatingAnnouncement = mounted.host.querySelector('.sr-status')
    mounted.thread.value = {
      ...structuredClone(mounted.thread.value),
      messages: mounted.thread.value.messages.map(message => (message.id === 'live' ? { ...message, content: 'First token and more' } : message))
    }
    await settle()
    expect(mounted.host.querySelector('.sr-status')).toBe(generatingAnnouncement)

    mounted.thread.value = {
      ...mounted.thread.value,
      messages: mounted.thread.value.messages.map(message =>
        message.id === 'live' ? { ...message, status: 'complete', runOutcome: { status: 'succeeded', errorCode: null } } : message
      )
    }
    await settle()
    expect(mounted.host.querySelectorAll('.control-border-beam')).toHaveLength(0)
    expect(articles[1]?.querySelector('.agent-message__status')).toBeNull()
    expect(mounted.host.querySelectorAll('[aria-live="polite"]')).toHaveLength(1)
  })

  it('preserves untouched projected messages, runs and citations during polling, invalidating changed presentation inputs and evicting removed entries', async () => {
    const messages = Array.from({ length: 100 }, (_, index) =>
      makeMessage({
        id: `message-${index}`,
        runId: `run-${index}`,
        ordinal: index,
        status: index === 99 ? 'streaming' : 'complete',
        content: 'Evidence text',
        citations: [{ evidenceId: `page:${index}:section:1`, kind: 'page', label: `Page ${index} › Section`, href: `/en/page-${index}#section` }],
        googleSearchGrounding: { citations: [{ url: 'https://source.test/evidence', title: 'Evidence', startIndex: 0, endIndex: 8 }] }
      })
    )
    const mounted = await mountThread(
      makeThread('session-cache', {
        messages,
        tools: messages.map(message =>
          makeTool({ id: `tool-${message.id}`, runId: message.runId!, proposalId: null, actionName: 'pages.get', state: 'complete' })
        )
      })
    )
    const initial = mounted.projection.value.orderedMessages
    mounted.thread.value = structuredClone(mounted.thread.value)
    mounted.thread.value = {
      ...mounted.thread.value,
      messages: mounted.thread.value.messages.map(message => (message.id === 'message-99' ? { ...message, content: 'Evidence text continues' } : message))
    }
    await settle()
    const streamed = mounted.projection.value.orderedMessages
    for (let index = 0; index < 99; index += 1) {
      expect(streamed[index]).toBe(initial[index])
      expect(streamed[index]?.run).toBe(initial[index]?.run)
      expect(streamed[index]?.run?.pageLinks).toBe(initial[index]?.run?.pageLinks)
      expect(streamed[index]?.citationGroups).toBe(initial[index]?.citationGroups)
      expect(streamed[index]?.googleSearchCitations).toBe(initial[index]?.googleSearchCitations)
    }
    expect(streamed[99]).not.toBe(initial[99])
    expect(streamed[99]?.citationGroups[0]).toBe(initial[99]?.citationGroups[0])
    expect(streamed[99]?.run).toBe(initial[99]?.run)
    expect(streamed[99]?.googleSearchCitations).toBe(initial[99]?.googleSearchCitations)

    mounted.thread.value = {
      ...mounted.thread.value,
      messages: mounted.thread.value.messages.map(message =>
        message.id === 'message-0'
          ? {
              ...message,
              createdAt: '2026-09-03T12:00:00.000Z',
              runOutcome: { status: 'partial', errorCode: 'AGENT_OUTPUT_LIMITED' },
              citations: [{ ...message.citations[0]!, href: '/en/revised#section' }],
              googleSearchGrounding: { citations: [{ url: 'https://source.test/new', title: 'New evidence', startIndex: 0, endIndex: 4 }] }
            }
          : message
      )
    }
    await settle()
    const changed = mounted.projection.value.orderedMessages[0]!
    expect(changed).not.toBe(streamed[0])
    expect(changed.temporal.timestamp).not.toBe(streamed[0]?.temporal.timestamp)
    expect(changed.citationGroups).not.toBe(streamed[0]?.citationGroups)
    expect(changed.googleSearchCitations).not.toBe(streamed[0]?.googleSearchCitations)
    expect(changed.statusLabel).toBe('Partial')
    expect(mounted.projection.value.orderedMessages[1]).toBe(streamed[1])

    const savedThread = mounted.thread.value
    mounted.thread.value = { ...savedThread, messages: savedThread.messages.slice(1), tools: savedThread.tools.slice(1) }
    await settle()
    mounted.thread.value = structuredClone(savedThread)
    await settle()
    expect(mounted.projection.value.orderedMessages[0]).not.toBe(changed)
  })

  it('defaults live activity open, preserves manual preference across polls, collapses clean completion and keeps exceptional outcomes inspectable', async () => {
    const session = makeSession('session-activity')
    const activeThread = (runId: string): AgentThreadState =>
      makeThread(session.id, {
        session: { ...session, currentRun: makeCurrentRun(session.id, runId) },
        messages: [makeMessage({ id: `answer-${runId}`, runId })],
        tools: [makeTool({ runId, state: 'preparing', title: 'Read release notes', actionName: 'pages.get', proposalId: null, risk: 'read' })]
      })
    const mounted = await mountThread(activeThread('run-1'))
    const details = (): HTMLDetailsElement => mounted.host.querySelector('.agent-activity') as HTMLDetailsElement
    const toggle = async (): Promise<void> => {
      details().querySelector<HTMLElement>('summary')!.click()
      details().dispatchEvent(new browserWindow.Event('toggle'))
      await settle()
    }
    expect(details().open).toBe(true)
    await toggle()
    expect(details().open).toBe(false)
    mounted.thread.value = {
      ...structuredClone(mounted.thread.value),
      tools: mounted.thread.value.tools.map(tool => ({ ...tool, state: 'running' }))
    }
    await settle()
    expect(details().open).toBe(false)
    await toggle()
    expect(details().open).toBe(true)
    mounted.thread.value = {
      ...mounted.thread.value,
      session,
      messages: mounted.thread.value.messages.map(message => ({ ...message, status: 'complete', runOutcome: { status: 'succeeded', errorCode: null } })),
      tools: mounted.thread.value.tools.map(tool => ({ ...tool, state: 'complete' }))
    }
    await settle()
    expect(details().open).toBe(true)

    mounted.thread.value = activeThread('run-2')
    await settle()
    expect(details().open).toBe(true)
    mounted.thread.value = {
      ...mounted.thread.value,
      session,
      messages: mounted.thread.value.messages.map(message => ({ ...message, status: 'complete', runOutcome: { status: 'succeeded', errorCode: null } })),
      tools: mounted.thread.value.tools.map(tool => ({ ...tool, state: 'complete' }))
    }
    await settle()
    expect(details().open).toBe(false)
    mounted.thread.value = {
      ...mounted.thread.value,
      messages: mounted.thread.value.messages.map(message => ({ ...message, status: 'failed', runOutcome: { status: 'failed', errorCode: null } })),
      tools: mounted.thread.value.tools.map(tool => ({ ...tool, state: 'failed' }))
    }
    await settle()
    expect(details().open).toBe(true)
    await toggle()
    mounted.thread.value = structuredClone(mounted.thread.value)
    await settle()
    expect(details().open).toBe(false)
  })

  it('resolves runtime statuses, activity, recovery, section labels and accessible announcements through the current catalog', async () => {
    const english = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'server/locales/en.json'), 'utf8'))
    const engine = i18next.createInstance()
    await engine.init({
      lng: 'en',
      fallbackLng: 'en',
      defaultNS: 'common',
      initAsync: false,
      resources: {
        en: english,
        fr: {
          common: {
            agentThread: {
              preparingResponse: 'Préparation de la réponse',
              generatingResponse: 'Génération de la réponse',
              announcePreparing: 'Préparation en cours.',
              announceGenerating: 'Génération en cours.',
              assistantMessage: 'Message de l’agent · {{status}}',
              userMessage: 'Votre message · {{status}}',
              activityTitle: '{{title}}',
              activity: 'Activité',
              activityCount_one: '{{count}} activité',
              activityCount_other: '{{count}} activités',
              running: 'En cours',
              complete: 'Terminé',
              pageOverview: 'Vue de la page',
              partial: 'Partielle',
              partialAnswer: 'Réponse partielle',
              recoveryPartial: 'Relisez la réponse avant de poursuivre.'
            }
          }
        }
      }
    })
    const mounted = await mountThread(
      makeThread('session-localized', {
        messages: [
          makeMessage({ id: 'old-localized', runId: 'old-run', status: 'complete', content: 'A past answer.' }),
          makeMessage({
            id: 'live-localized',
            status: 'pending',
            ordinal: 2,
            citations: [{ evidenceId: 'page:1:section:1', kind: 'page', label: 'Page', href: '/en/page#section' }]
          })
        ],
        tools: [makeTool({ actionName: 'pages.get', title: 'Read sources', state: 'running', proposalId: null, risk: 'read' })]
      }),
      'connected',
      undefined,
      { engine, translate: (key, options = {}) => String(engine.t(key, options)) }
    )
    const englishProjection = mounted.projection.value.orderedMessages
    await engine.changeLanguage('fr')
    await settle()
    const articles = mounted.host.querySelectorAll('.agent-message')
    expect(articles[0]?.getAttribute('aria-label')).toBe('Message de l’agent · Terminé')
    expect(articles[1]?.querySelector('.agent-message__status')?.textContent).toContain('Préparation de la réponse')
    expect(articles[1]?.getAttribute('aria-label')).toBe('Message de l’agent · Préparation de la réponse')
    expect(mounted.host.querySelector('.agent-activity summary')?.textContent).toContain('Read sources · 1 activité')
    expect(mounted.host.querySelector('.agent-activity small')?.textContent).toBe('En cours')
    expect(mounted.host.querySelector('.agent-sources__label')?.textContent).toBe('Vue de la page')
    expect(mounted.host.querySelector('.sr-status')?.textContent).toBe('Préparation en cours.')
    expect(mounted.projection.value.orderedMessages[0]).not.toBe(englishProjection[0])
    expect(mounted.projection.value.orderedMessages[0]?.temporal.timestamp).not.toBe(englishProjection[0]?.temporal.timestamp)

    mounted.thread.value = {
      ...mounted.thread.value,
      messages: mounted.thread.value.messages.map(message =>
        message.id === 'live-localized' ? { ...message, status: 'streaming', content: 'Le début' } : message
      )
    }
    await settle()
    expect(articles[1]?.querySelector('.agent-message__status')?.textContent).toContain('Génération de la réponse')
    expect(mounted.host.querySelector('.sr-status')?.textContent).toBe('Génération en cours.')
    mounted.thread.value = {
      ...mounted.thread.value,
      messages: mounted.thread.value.messages.map(message =>
        message.id === 'live-localized' ? { ...message, status: 'complete', runOutcome: { status: 'partial', errorCode: null } } : message
      )
    }
    await settle()
    expect(articles[1]?.querySelector('.agent-message__recovery strong')?.textContent).toBe('Réponse partielle')
    expect(articles[1]?.querySelector('.agent-message__recovery span')?.textContent).toBe('Relisez la réponse avant de poursuivre.')
    expect(mounted.host.querySelector('.sr-status')?.textContent).toBe('Réponse partielle')
  })

  it('renders capacity-limited activity rows without treating them as failures', async () => {
    const mounted = await mountThread(
      makeThread('session-capacity', {
        messages: [makeMessage({ status: 'complete' })],
        tools: [
          makeTool({ id: 'complete', actionName: 'pages.get', title: 'Get page', state: 'complete', risk: 'read', proposalId: null }),
          makeTool({
            id: 'omitted',
            actionName: 'pages.get',
            title: 'Get page',
            state: 'omitted',
            risk: 'read',
            proposalId: null,
            contextExclusion: { status: 'omitted', reason: 'tool_result_capacity' }
          }),
          makeTool({
            id: 'not-executed',
            actionName: 'pages.get',
            title: 'Get page',
            state: 'not_executed',
            risk: 'read',
            proposalId: null,
            contextExclusion: { status: 'not_executed', reason: 'tool_result_capacity' }
          })
        ]
      })
    )
    const activity = mounted.host.querySelector('.agent-activity')
    const rows = activity?.querySelectorAll('.agent-activity__list > li')
    expect(activity?.querySelector('summary')?.textContent).toContain('Activity · 3 activities · 1 omitted · 1 not executed')
    expect(rows).toHaveLength(3)
    expect(Array.from(rows ?? []).map(row => row.querySelector('strong')?.textContent)).toEqual(['Get page', 'Get page', 'Get page'])
    expect(Array.from(rows ?? []).map(row => row.querySelector('small')?.textContent)).toEqual(['Complete', 'Result omitted', 'Not executed'])
    expect(activity?.textContent).not.toContain('pages.get')
    expect(rows?.[0]?.querySelector('.v-icon')?.getAttribute('data-color')).toBe('success')
    expect(rows?.[1]?.querySelector('.v-icon')?.getAttribute('data-color')).toBeNull()
    expect(rows?.[2]?.querySelector('.v-icon')?.getAttribute('data-color')).toBeNull()
    expect(activity?.textContent?.toLowerCase()).not.toContain('failed')
  })

  it('keeps unsafe links inert while preserving Wiki previews and hash deep links', async () => {
    const mounted = await mountThread(
      makeThread('session-links', {
        messages: [
          makeMessage({
            status: 'complete',
            citations: [
              { evidenceId: 'page:runbook', kind: 'page', label: 'Runbook', href: '/en/runbook' },
              { evidenceId: 'page:runbook:section:1', kind: 'page', label: 'Runbook › Response sequence', href: '/en/runbook#response' },
              { evidenceId: 'external', kind: 'page', label: 'Vendor documentation', href: 'https://vendor.test/en/reference' },
              { evidenceId: 'page:runbook:section:2', kind: 'page', label: 'Runbook › Unsafe', href: 'javascript:alert(1)' },
              { evidenceId: 'page:data:section:1', kind: 'page', label: 'Data source › Unsafe data URL', href: 'data:text/html,unsafe' },
              { evidenceId: 'page:malformed:section:1', kind: 'page', label: 'Malformed source › Malformed URL', href: 'https://[' }
            ]
          })
        ]
      })
    )

    const pageLink = mounted.host.querySelector<HTMLAnchorElement>('.agent-sources__page')
    expect(pageLink?.getAttribute('href')).toBe('/en/runbook')
    expect(pageLink?.getAttribute('target')).toBeNull()
    const hashLink = mounted.host.querySelector<HTMLAnchorElement>('.agent-sources__sections a[href="/en/runbook#response"]')
    expect(hashLink?.getAttribute('target')).toBeNull()
    expect(hashLink?.getAttribute('rel')).toBe('noopener noreferrer')
    const externalLink = mounted.host.querySelector<HTMLAnchorElement>('a[href="https://vendor.test/en/reference"]')
    expect(externalLink?.getAttribute('target')).toBe('_blank')
    expect(mounted.host.querySelector('.agent-sources__sections a[href^="javascript:"]')).toBeNull()
    expect(mounted.host.textContent).toContain('Unsafe')
    const unsafeSection = Array.from(mounted.host.querySelectorAll('.agent-sources__label')).find(label => label.textContent === 'Unsafe')
    expect(unsafeSection).toBeDefined()
    expect(unsafeSection?.closest('a')).toBeNull()
    for (const [pageLabel, sectionLabel] of [
      ['Data source', 'Unsafe data URL'],
      ['Malformed source', 'Malformed URL']
    ]) {
      const group = Array.from(mounted.host.querySelectorAll('.agent-sources__group')).find(
        row => row.querySelector('.agent-sources__page strong')?.textContent === pageLabel
      )
      expect(group?.querySelector('.agent-sources__label')?.textContent).toBe(sectionLabel)
      expect(group?.querySelectorAll('a')).toHaveLength(0)
    }

    if (!hashLink) throw new Error('Section citation did not render')
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) {
      const modifiedClick = new browserWindow.MouseEvent('click', { bubbles: true, cancelable: true, [modifier]: true })
      let wasIntercepted = true
      const finish = (event: Event): void => {
        wasIntercepted = event.defaultPrevented
        event.preventDefault()
      }
      mounted.host.addEventListener('click', finish, { once: true })
      hashLink.dispatchEvent(modifiedClick)
      expect(wasIntercepted).toBe(false)
      await settle()
      expect(mounted.host.querySelector('.wiki-source-preview')).toBeNull()
    }
    const click = new browserWindow.MouseEvent('click', { bubbles: true, cancelable: true })
    hashLink.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    await settle()
    expect(JSON.parse(mounted.host.querySelector('.wiki-source-preview')?.getAttribute('data-selector') ?? '{}')).toEqual({
      locale: 'en',
      path: 'runbook',
      visibility: 'public'
    })
  })

  it('renders artifacts when the thread has no messages', async () => {
    const artifact: AgentArtifactView = {
      id: 'artifact-1',
      kind: 'browser-screenshot',
      mimeType: 'image/png',
      byteLength: 128,
      width: 640,
      height: 480,
      createdAt: '2026-09-03T10:00:02.000Z',
      expiresAt: null,
      available: true
    }
    const mounted = await mountThread(makeThread('session-artifact', { artifacts: [artifact] }))
    expect(mounted.host.querySelector('.artifact-card')).not.toBeNull()
    const image = mounted.host.querySelector('.artifact-card img')
    expect(image?.getAttribute('decoding')).toBe('async')
    expect(image?.getAttribute('fetchpriority')).toBe('low')
    expect(mounted.host.querySelector('.artifact-card a')?.getAttribute('rel')).toBe('noopener noreferrer')
    mounted.thread.value = { ...mounted.thread.value, artifacts: [{ ...artifact, available: false }] }
    await settle()
    const unavailable = mounted.host.querySelector('.artifact-card')
    expect(unavailable?.querySelector('a, img')).toBeNull()
    expect(unavailable?.querySelector('.artifact-card__unavailable')?.textContent).toContain('expired')
    expect(unavailable?.hasAttribute('aria-disabled')).toBe(false)
  })

  it('shows each screenshot under the response that captured it, with a readable time in its alt text', async () => {
    const screenshot = (id: string, createdAt: string): AgentArtifactView => ({
      id,
      kind: 'browser-screenshot',
      mimeType: 'image/png',
      byteLength: 128,
      width: 640,
      height: 480,
      createdAt,
      expiresAt: null,
      available: true
    })
    const mounted = await mountThread(
      makeThread('session-artifact-placement', {
        messages: [
          makeMessage({
            id: 'assistant-early',
            runId: 'run-1',
            ordinal: 1,
            status: 'complete',
            content: 'First answer.',
            createdAt: '2026-09-03T10:00:00.000Z'
          }),
          makeMessage({
            id: 'assistant-late',
            runId: 'run-2',
            ordinal: 2,
            status: 'complete',
            content: 'Second answer.',
            createdAt: '2026-09-03T10:05:00.000Z'
          })
        ],
        artifacts: [
          screenshot('artifact-before', '2026-09-03T09:00:00.000Z'),
          screenshot('artifact-early', '2026-09-03T10:01:00.000Z'),
          screenshot('artifact-late', '2026-09-03T10:06:00.000Z')
        ]
      })
    )
    const messages = Array.from(mounted.host.querySelectorAll<HTMLElement>('article.agent-message'))
    const sources = (root: Element | null | undefined): string[] =>
      Array.from(root?.querySelectorAll('.artifact-card img') ?? []).map(image => image.getAttribute('src') ?? '')
    expect(sources(messages[0])).toEqual(['/_api/agents/artifacts/artifact-early/content'])
    expect(sources(messages[1])).toEqual(['/_api/agents/artifacts/artifact-late/content'])
    const trailing = mounted.host.querySelector('.agent-thread > .artifact-grid')
    expect(sources(trailing)).toEqual(['/_api/agents/artifacts/artifact-before/content'])
    const alt = messages[0]?.querySelector('.artifact-card img')?.getAttribute('alt') ?? ''
    expect(alt.startsWith('Browser screenshot, ')).toBe(true)
    expect(alt).not.toContain('2026-09-03T')
  })

  it('renders detached attachments as muted chips without a download link and keeps unavailable media messaging', async () => {
    const mounted = await mountThread(
      makeThread('session-detached', {
        messages: [
          makeMessage({
            status: 'complete',
            content: 'Report attached.',
            media: [
              makeMedia({ detached: true }),
              makeMedia({ id: 'media-2', filename: 'lost.pdf', available: false }),
              makeMedia({ id: 'media-3', filename: 'live.pdf' })
            ]
          })
        ]
      })
    )

    const figures = mounted.host.querySelectorAll('.agent-message__media figure')
    expect(figures.length).toBe(3)
    const detached = figures[0] as HTMLElement
    expect(detached.querySelector('.agent-message__media-detached')?.textContent).toContain('report.pdf · Detached from context')
    expect(detached.querySelector('a')).toBeNull()
    const detachedButtons = Array.from(detached.querySelectorAll('button')).map(button => button.textContent?.trim() ?? '')
    expect(detachedButtons).toContain('Re-attach')
    expect(figures[1]?.textContent).toContain('lost.pdf · No longer available')
    expect(figures[2]?.querySelector('a')?.getAttribute('href')).toBe('/_api/agents/media/media-3/content')
    expect(figures[2]?.querySelector('.agent-message__media-detached')).toBeNull()
  })

  it('requires confirmation before emitting re-attach for a detached attachment', async () => {
    const media = makeMedia({ id: 'media-detach-confirm', detached: true })
    const mounted = await mountThread(
      makeThread('session-reattach', {
        messages: [makeMessage({ status: 'complete', content: 'Summary of the report.', media: [media] })]
      })
    )

    const figure = mounted.host.querySelector('.agent-message__media figure') as HTMLElement
    const buttonWithText = (text: string): HTMLButtonElement =>
      Array.from(figure.querySelectorAll('button')).find(button => button.textContent?.includes(text)) as HTMLButtonElement
    expect(buttonWithText('Re-attach')).toBeTruthy()

    buttonWithText('Re-attach')?.click()
    await settle()
    expect(mounted.emittedReattachments).toEqual([])
    expect(figure.querySelector('.agent-message__media-confirm')?.textContent).toContain('Add this file to the next message again?')
    expect(buttonWithText('Re-attach')).toBeTruthy()
    expect(buttonWithText('Cancel')).toBeTruthy()

    buttonWithText('Cancel')?.click()
    await settle()
    expect(mounted.emittedReattachments).toEqual([])
    expect(buttonWithText('Re-attach')).toBeTruthy()
    expect(figure.querySelector('.agent-message__media-confirm')).toBeNull()

    buttonWithText('Re-attach')?.click()
    await settle()
    buttonWithText('Re-attach')?.click()
    await settle()
    expect(mounted.emittedReattachments).toEqual([[media]])
    expect(buttonWithText('Re-attach')).toBeTruthy()
  })
})
