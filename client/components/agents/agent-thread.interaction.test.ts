import fs from 'node:fs'
import path from 'node:path'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import type { RenderFunction } from 'vue'
import type {
  AgentArtifactView,
  AgentMediaView,
  AgentMessageView,
  AgentSessionView,
  AgentThreadState,
  AgentToolCallView
} from '../../../shared/agents/contracts.ts'
import { agentLiveAnnouncement, buildAgentThreadPresentation, placeAgentArtifacts } from './agent-thread-presentation.ts'
import { agentMediaContentUrl } from '../../helpers/agents-api.ts'
import { wikiSourceSelectorFromHref } from '../../../shared/wiki-source.ts'
import { resolveUserPicture, type UserPicture } from '../../helpers/user-picture.ts'

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-thread.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const parsedSfc = parse(componentSource, { filename: componentPath })
if (parsedSfc.errors.length > 0) throw new Error(`Could not parse agent-thread.vue: ${parsedSfc.errors.join(', ')}`)
if (!parsedSfc.descriptor.template || !parsedSfc.descriptor.scriptSetup) throw new Error('AgentThread template and setup script are required')

import { browserWindow, setLocation, resetBody } from '../../test/browser-dom.mts'
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

// Render the real screenshot grid child so placement and alt text are checked end to end.
Bun.plugin({
  name: 'agent-thread-real-artifact-grid',
  setup(builder) {
    builder.onLoad({ filter: /agent-artifact-grid\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const script = compileScript(parsed.descriptor, { id: 'agent-thread-real-artifact-grid', genDefaultAs: '__component', inlineTemplate: true })
      return { loader: 'ts', contents: `${script.content}\nexport default __component;` }
    })
  }
})
const AgentArtifactGrid = (await import('./agent-artifact-grid.vue')).default

const scriptWithoutImports = parsedSfc.descriptor.scriptSetup.content.replace(/import[\s\S]*?from\s+['"][^'"]+['"]\s*/g, '')
const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(scriptWithoutImports)
const evaluateAgentThread = new Function(
  'computed',
  'ref',
  'watch',
  'defineProps',
  'defineEmits',
  'wikiSourceSelectorFromHref',
  'agentLiveAnnouncement',
  'buildAgentThreadPresentation',
  'agentMediaContentUrl',
  'placeAgentArtifacts',
  `${executableScript}
return { artifactPlacement, artifactTimeLabel, emit, forwardDecision, liveSummary, liveSummaryRevision, previewSelector, previewCitation, sourceDomId, threadPresentation, threadProjection, toolStateColor, toolStateIcon, toolStateLabel, reattachConfirmId, requestReattach, cancelReattach, confirmReattach, agentMediaContentUrl }`
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
  skills: [],
  currentRun: null,
  createdAt: '2026-09-03T10:00:00.000Z',
  updatedAt: '2026-09-03T10:00:00.000Z',
  lastActivityAt: '2026-09-03T10:00:00.000Z',
  expiresAt: null
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
  suggestions: [],
  historyWindow: { messageLimit: 100, hasOlderMessages: false, runLimit: 25, hasOlderRuns: false },
  ...overrides
})

interface MountedThread {
  readonly host: HTMLElement
  readonly thread: { value: AgentThreadState }
  readonly connection: { value: string }
  readonly userPicture: { value: UserPicture }
  readonly emittedReattachments: unknown[][]
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
  initialUserPicture: UserPicture = resolveUserPicture({ id: 42, name: 'Ada Lovelace', pictureUrl: '' })
): Promise<MountedThread> => {
  const host = document.createElement('div')
  document.body.append(host)
  const thread = Vue.shallowRef(initialThread)
  const userPicture = Vue.shallowRef(initialUserPicture)
  const connection = Vue.ref(initialConnection)
  const emittedReattachments: unknown[][] = []
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
      return evaluateAgentThread(
        Vue.computed,
        Vue.ref,
        Vue.watch,
        () => props,
        () => emit,
        wikiSourceSelectorFromHref,
        agentLiveAnnouncement,
        buildAgentThreadPresentation,
        agentMediaContentUrl,
        placeAgentArtifacts
      )
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
        onReattach: (...args: unknown[]) => emittedReattachments.push(args)
      })
  })
  const app = Vue.createApp(harness)
  for (const name of ['AgentAnswerActions', 'AgentMarkdown', 'AgentTaskProgress', 'StatusIndicator', 'AgentToolCard']) app.component(name, NullStub)
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
  return { host, thread, connection, userPicture, emittedReattachments, unmount }
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
    expect(userDetails?.querySelector('.agent-message__status')?.textContent?.trim()).toBe('Send failed')
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
  it('announces complete, active, approval, and reconnecting states on mount', async () => {
    const states: Array<[string, AgentThreadState, string]> = [
      ['complete', makeThread('session-complete', { messages: [makeMessage({ status: 'complete' })] }), 'Response complete.'],
      ['active', makeThread('session-active', { messages: [makeMessage({ status: 'streaming' })] }), 'Preparing a response.'],
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
    expect(Array.from(rows ?? []).map(row => row.querySelector('small')?.textContent)).toEqual([
      'pages.get · Complete',
      'pages.get · Result omitted',
      'pages.get · Not executed'
    ])
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
    for (const [pageLabel, sectionLabel] of [['Data source', 'Unsafe data URL'], ['Malformed source', 'Malformed URL']]) {
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
  })

  it('shows each screenshot under the response that captured it, with a readable time in its alt text', async () => {
    const screenshot = (id: string, createdAt: string): AgentArtifactView => ({
      id, kind: 'browser-screenshot', mimeType: 'image/png', byteLength: 128, width: 640, height: 480, createdAt, expiresAt: null, available: true
    })
    const mounted = await mountThread(makeThread('session-artifact-placement', {
      messages: [
        makeMessage({ id: 'assistant-early', runId: 'run-1', ordinal: 1, status: 'complete', content: 'First answer.', createdAt: '2026-09-03T10:00:00.000Z' }),
        makeMessage({ id: 'assistant-late', runId: 'run-2', ordinal: 2, status: 'complete', content: 'Second answer.', createdAt: '2026-09-03T10:05:00.000Z' })
      ],
      artifacts: [
        screenshot('artifact-before', '2026-09-03T09:00:00.000Z'),
        screenshot('artifact-early', '2026-09-03T10:01:00.000Z'),
        screenshot('artifact-late', '2026-09-03T10:06:00.000Z')
      ]
    }))
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
