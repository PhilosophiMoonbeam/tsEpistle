import fs from 'node:fs'
import path from 'node:path'

import { compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import type { RenderFunction } from 'vue'
import type {
  AgentArtifactView,
  AgentMessageView,
  AgentProposalView,
  AgentSessionView,
  AgentThreadState,
  AgentToolCallView
} from '../../../shared/agents/contracts.ts'
import { agentLiveAnnouncement, buildAgentThreadPresentation } from './agent-thread-presentation.ts'
import { wikiSourceSelectorFromHref } from '../../../shared/wiki-source.ts'

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-thread.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const parsedSfc = parse(componentSource, { filename: componentPath })
if (parsedSfc.errors.length > 0) throw new Error(`Could not parse agent-thread.vue: ${parsedSfc.errors.join(', ')}`)
if (!parsedSfc.descriptor.template || !parsedSfc.descriptor.scriptSetup) throw new Error('AgentThread template and setup script are required')

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'https://wiki.test/'
})
const browserWindow = dom.window
const globalValues: Record<string, unknown> = {
  Element: browserWindow.Element,
  Event: browserWindow.Event,
  HTMLDetailsElement: browserWindow.HTMLDetailsElement,
  HTMLElement: browserWindow.HTMLElement,
  MouseEvent: browserWindow.MouseEvent,
  Node: browserWindow.Node,
  SVGElement: browserWindow.SVGElement,
  document: browserWindow.document,
  navigator: browserWindow.navigator,
  window: browserWindow
}
for (const [name, value] of Object.entries(globalValues)) {
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true })
}

// Vue must load after JSDOM so runtime-dom captures the test document.
const Vue = await import('vue')
const compiledTemplate = compileTemplate({
  source: parsedSfc.descriptor.template.content,
  filename: componentPath,
  id: 'agent-thread-interaction-test',
  compilerOptions: { mode: 'function' }
})
const renderAgentThread = new Function('Vue', compiledTemplate.code)(Vue) as RenderFunction

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
  `${executableScript}
return { emit, forwardDecision, liveSummary, liveSummaryRevision, previewSelector, sourceDomId, threadPresentation, threadProjection, toolStateColor, toolStateIcon, toolStateLabel }`
) as (...dependencies: unknown[]) => Record<string, unknown>

const NullStub = Vue.defineComponent({
  inheritAttrs: false,
  setup: () => () => null
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
const ApprovalStub = Vue.defineComponent({
  props: {
    proposal: { type: Object, required: true },
    busy: Boolean
  },
  emits: ['decision'],
  setup(props, { emit }) {
    return () => {
      const proposal = props.proposal as AgentProposalView
      return Vue.h(
        'button',
        {
          'aria-label': 'Approve pending change',
          'data-agent-approval': 'pending',
          disabled: props.busy,
          onClick: () => emit('decision', proposal.id, proposal.approval?.id ?? '', 'approved')
        },
        'Approve'
      )
    }
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

const makeProposal = (overrides: Partial<AgentProposalView> = {}): AgentProposalView => ({
  id: 'proposal-1',
  sourceKind: 'agent',
  actionName: 'pages.preparePatch',
  risk: 'proposal',
  status: 'pending',
  summary: 'Add a release checklist.',
  target: {
    id: 12,
    locale: 'en',
    path: 'release-notes',
    title: 'Release notes',
    contentType: 'markdown',
    sourceRevision: '4'
  },
  pageLink: null,
  baseSourceRevision: '4',
  authoritySha256: 'a'.repeat(64),
  inputHash: 'b'.repeat(64),
  patchSha256: 'c'.repeat(64),
  resultCanonicalSha256: 'd'.repeat(64),
  diffSha256: 'e'.repeat(64),
  diff: '+Checklist',
  expiresAt: '2026-09-03T10:10:00.000Z',
  approval: {
    id: 'approval-1',
    proposalId: 'proposal-1',
    status: 'pending',
    requestedAt: '2026-09-03T10:00:01.000Z',
    expiresAt: '2026-09-03T10:10:00.000Z',
    decidedAt: null,
    decisionNote: null
  },
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
  readonly emittedDecisions: unknown[][]
  readonly unmount: () => void
}

const mountedApps: Array<() => void> = []
const settle = async (): Promise<void> => {
  await Vue.nextTick()
  await Vue.nextTick()
}

const mountThread = async (initialThread: AgentThreadState, initialConnection = 'connected'): Promise<MountedThread> => {
  const host = document.createElement('div')
  document.body.append(host)
  const thread = Vue.shallowRef(initialThread)
  const connection = Vue.ref(initialConnection)
  const emittedDecisions: unknown[][] = []
  const agentThread = Vue.defineComponent({
    name: 'AgentThreadInteractionHarness',
    props: {
      thread: { type: Object, required: true },
      connection: { type: String, required: true },
      decidingApprovalId: { type: String, default: null },
      canSubmit: { type: Boolean, default: true }
    },
    emits: ['askSource', 'suggest', 'decision'],
    setup(props, { emit }) {
      return evaluateAgentThread(
        Vue.computed,
        Vue.ref,
        Vue.watch,
        () => props,
        () => emit,
        wikiSourceSelectorFromHref,
        agentLiveAnnouncement,
        buildAgentThreadPresentation
      )
    },
    render: renderAgentThread
  })
  const harness = Vue.defineComponent({
    setup: () => ({ thread, connection }),
    render: () =>
      Vue.h(agentThread, {
        thread: thread.value,
        connection: connection.value,
        onDecision: (...args: unknown[]) => emittedDecisions.push(args)
      })
  })
  const app = Vue.createApp(harness)
  for (const name of ['AgentAnswerActions', 'AgentMarkdown', 'AgentTaskProgress', 'StatusIndicator', 'v-avatar', 'v-icon']) app.component(name, NullStub)
  app.component('v-btn', ButtonStub)
  app.component('AgentToolCard', ApprovalStub)
  app.component('WikiSourcePreview', PreviewStub)
  app.mount(host)
  await settle()
  const unmount = (): void => {
    app.unmount()
    host.remove()
  }
  mountedApps.push(unmount)
  return { host, thread, connection, emittedDecisions, unmount }
}

afterEach(() => {
  for (const unmount of mountedApps.splice(0)) unmount()
  document.body.replaceChildren()
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

  it('keeps unsafe links inert while preserving Wiki previews and hash deep links', async () => {
    const mounted = await mountThread(
      makeThread('session-links', {
        messages: [
          makeMessage({
            status: 'complete',
            citations: [
              { evidenceId: 'page:runbook', kind: 'page', label: 'Runbook', href: '/en/runbook' },
              { evidenceId: 'page:runbook:section:1', kind: 'page', label: 'Runbook › Response sequence', href: '/en/runbook#response' },
              { evidenceId: 'page:runbook:section:2', kind: 'page', label: 'Runbook › Unsafe', href: 'javascript:alert(1)' }
            ]
          })
        ]
      })
    )

    const pageLink = mounted.host.querySelector<HTMLAnchorElement>('.agent-sources__page')
    expect(pageLink?.getAttribute('href')).toBe('/en/runbook')
    expect(pageLink?.getAttribute('target')).toBe('_blank')
    const hashLink = mounted.host.querySelector<HTMLAnchorElement>('.agent-sources__sections a[href="/en/runbook#response"]')
    expect(hashLink?.getAttribute('target')).toBe('_blank')
    expect(hashLink?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(mounted.host.querySelector('.agent-sources__sections a[href^="javascript:"]')).toBeNull()
    expect(mounted.host.querySelector('.agent-sources__sections > li:last-child span')?.textContent).toContain('Unsafe')

    const previewButton = mounted.host.querySelector<HTMLButtonElement>('.agent-sources__preview')
    if (!previewButton) throw new Error('Wiki source preview button did not render')
    previewButton.click()
    await settle()
    expect(JSON.parse(mounted.host.querySelector('.wiki-source-preview')?.getAttribute('data-selector') ?? '{}')).toEqual({
      locale: 'en',
      path: 'runbook',
      visibility: 'public'
    })
  })

  it('does not render first-use copy for goal or artifact-only threads and keeps approvals actionable', async () => {
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
    const goalThread = makeThread('session-goal-artifact', { artifacts: [artifact] })
    const mountedGoal = await mountThread(goalThread)
    expect(mountedGoal.host.querySelector('.agent-thread__empty')).toBeNull()
    expect(mountedGoal.host.textContent).not.toContain('Begin a grounded conversation')
    expect(mountedGoal.host.querySelector('.artifact-card')).not.toBeNull()
    mountedGoal.unmount()
    mountedApps.pop()

    const proposal = makeProposal()
    const mountedApproval = await mountThread(
      makeThread('session-pending-approval', {
        messages: [makeMessage({ status: 'streaming' })],
        tools: [makeTool()],
        proposals: [proposal]
      })
    )
    const approval = mountedApproval.host.querySelector<HTMLButtonElement>('[data-agent-approval="pending"]')
    expect(approval).not.toBeNull()
    expect(approval?.disabled).toBe(false)
    approval?.click()
    await settle()
    expect(mountedApproval.emittedDecisions).toEqual([[proposal.id, proposal.approval?.id, 'approved', undefined]])
  })
})
