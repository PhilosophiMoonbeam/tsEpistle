import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { JSDOM } from 'jsdom'
import type { AgentCitation, AgentMessageView, AgentProposalView, AgentRunView, AgentTaskView, AgentToolCallView } from '../../../shared/agents/contracts.ts'
import { renderSafeMarkdown } from '../../helpers/safe-markdown.ts'
import { createAgentCitationResolver, formatAgentCitationMarkers } from './agent-citations.ts'
import {
  agentActivityLabel,
  agentAppliedPageLinks,
  agentApprovalTitle,
  agentProposalReceiptLabel,
  agentLiveAnnouncement,
  buildAgentThreadPresentation,
  groupAgentCitations,
  groupAgentToolsByRun,
  isAgentApprovalOutsideViewport,
  shouldFollowGoalExpansion
} from './agent-thread-presentation.ts'
import { translateEnglish } from '../../test/english-translate.mts'
import type { AgentLocalizedText } from './agent-thread-presentation.ts'

const text = (value: AgentLocalizedText | null): string => (value ? translateEnglish(value.key, value.params) : '')
const activityText = (tools: readonly AgentToolCallView[]): string => agentActivityLabel(tools).map(text).join(' · ')

const tool = (input: Partial<AgentToolCallView> & Pick<AgentToolCallView, 'id' | 'runId'>): AgentToolCallView => ({
  actionName: 'pages.get',
  title: 'Get page',
  state: 'complete',
  risk: 'read',
  summary: null,
  proposalId: null,
  startedAt: '2026-08-23T20:00:00.000Z',
  completedAt: '2026-08-23T20:00:01.000Z',
  ...input
})

const proposal = (input: Partial<AgentProposalView> & Pick<AgentProposalView, 'id'>): AgentProposalView => ({
  sourceKind: 'agent',
  actionName: 'pages.preparePatch',
  risk: 'proposal',
  status: 'pending',
  summary: 'Add a release checklist.',
  target: { id: 12, locale: 'en', path: 'release-notes', title: 'Release notes', contentType: 'markdown', sourceRevision: '4' },
  pageLink: null,
  baseSourceRevision: '4',
  authoritySha256: 'a'.repeat(64),
  inputHash: 'b'.repeat(64),
  patchSha256: 'c'.repeat(64),
  resultCanonicalSha256: 'd'.repeat(64),
  diffSha256: 'e'.repeat(64),
  diff: '+Checklist',
  expiresAt: '2026-08-23T20:10:00.000Z',
  approval: {
    id: 'approval-1',
    proposalId: input.id,
    status: 'pending',
    requestedAt: '2026-08-23T20:00:00.000Z',
    expiresAt: '2026-08-23T20:10:00.000Z',
    decidedAt: null,
    decisionNote: null
  },
  ...input
})
const message = (input: Partial<AgentMessageView> & Pick<AgentMessageView, 'id' | 'role' | 'status'>): AgentMessageView => ({
  runId: input.role === 'assistant' ? 'run' : null,
  ordinal: 1,
  content: '',
  citations: [],
  createdAt: '2026-08-23T20:00:00.000Z',
  updatedAt: '2026-08-23T20:00:00.000Z',
  ...input
})

const runView = (input: Partial<AgentRunView> = {}): AgentRunView => ({
  id: 'run',
  sessionId: 'session',
  status: 'running',
  attempt: 1,
  eventSequence: 1,
  canCancel: true,
  createdAt: '2026-08-23T20:00:00.000Z',
  startedAt: '2026-08-23T20:00:00.000Z',
  completedAt: null,
  errorCode: null,
  errorMessage: null,
  ...input
})

const task = (input: Partial<AgentTaskView> & Pick<AgentTaskView, 'id' | 'runId'>): AgentTaskView => ({
  kind: 'source_scout',
  title: 'Scout sources',
  question: 'Which sources support the answer?',
  sourceScope: [],
  requiredEvidenceCount: 1,
  status: 'running',
  subagentRunId: null,
  attempt: 1,
  outcome: null,
  evidenceCount: 0,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-08-23T20:00:00.000Z',
  startedAt: '2026-08-23T20:00:00.000Z',
  completedAt: null,
  ...input
})

describe('Agent thread presentation', () => {
  it('keeps approval and receipt copy translatable at the consumer boundary', () => {
    const createTitle = agentApprovalTitle('pages.prepareCreate')
    const deleteTitle = agentApprovalTitle('pages.prepareDelete')
    const genericTitle = agentApprovalTitle('pages.search')
    const pendingReceipt = agentProposalReceiptLabel('pending')
    const appliedReceipt = agentProposalReceiptLabel('applied')
    const recoveryReceipt = agentProposalReceiptLabel('recovery_required')

    for (const descriptor of [createTitle, deleteTitle, genericTitle, pendingReceipt, appliedReceipt, recoveryReceipt]) {
      expect(typeof descriptor.key).toBe('string')
      expect(text(descriptor)).not.toBe(descriptor.key)
      expect(text(descriptor).length).toBeGreaterThan(0)
    }
    expect(text(createTitle)).not.toBe(text(deleteTitle))
    expect(text(genericTitle)).not.toBe(text(createTitle))
    expect(text(pendingReceipt)).not.toBe(text(appliedReceipt))
    expect(text(recoveryReceipt)).not.toBe(text(appliedReceipt))
  })

  it('groups routine activity and approval proposals with their originating run', () => {
    const patch = proposal({ id: 'proposal-1' })
    const runs = groupAgentToolsByRun(
      [
        tool({ id: 'read-1', runId: 'run-1' }),
        tool({
          id: 'patch-1',
          runId: 'run-1',
          actionName: 'pages.preparePatch',
          title: 'Prepare page patch',
          state: 'awaitingApproval',
          risk: 'proposal',
          proposalId: patch.id,
          completedAt: null
        }),
        tool({ id: 'search-2', runId: 'run-2', actionName: 'pages.search', title: 'Search pages', state: 'running', completedAt: null })
      ],
      [patch]
    )

    expect(runs.get('run-1')?.activity.map(entry => entry.id)).toEqual(['read-1'])
    expect(runs.get('run-1')?.proposals.map(entry => entry.proposal.id)).toEqual(['proposal-1'])
    expect(runs.get('run-2')?.activity.map(entry => entry.id)).toEqual(['search-2'])
  })

  it('links applied page changes once per destination', () => {
    const created = proposal({
      id: 'proposal-create',
      actionName: 'pages.prepareCreate',
      status: 'applied',
      pageLink: { label: '/release-notes', href: '/en/release-notes' }
    })
    const edited = proposal({
      id: 'proposal-edit',
      status: 'applied',
      pageLink: { label: '/release-notes', href: '/en/release-notes' }
    })
    const moved = proposal({
      id: 'proposal-move',
      actionName: 'pages.prepareMove',
      status: 'applied',
      pageLink: { label: '/handbook/releases', href: '/en/handbook/releases' }
    })
    const pending = proposal({
      id: 'proposal-pending',
      actionName: 'pages.prepareRestore',
      pageLink: { label: '/archived', href: '/en/archived' }
    })
    const entries =
      groupAgentToolsByRun(
        [
          tool({ id: 'create', runId: 'run', proposalId: created.id }),
          tool({ id: 'edit', runId: 'run', proposalId: edited.id }),
          tool({ id: 'move', runId: 'run', proposalId: moved.id }),
          tool({ id: 'restore', runId: 'run', proposalId: pending.id })
        ],
        [created, edited, moved, pending]
      ).get('run')?.proposals ?? []

    expect(agentAppliedPageLinks(entries)).toEqual([
      { label: '/release-notes', href: '/en/release-notes' },
      { label: '/handbook/releases', href: '/en/handbook/releases' }
    ])
  })
  it('nests numbered section citations under one page source', () => {
    const citations: readonly AgentCitation[] = [
      { evidenceId: 'page:6:section:1', kind: 'page', label: 'Incident Runbook', href: '/en/runbook#incident-runbook' },
      { evidenceId: 'page:6:section:2', kind: 'page', label: 'Incident Runbook › Response sequence', href: '/en/runbook#response-sequence' },
      { evidenceId: 'page:19', kind: 'page', label: 'Assessment', href: '/en/assessment' }
    ]

    expect(groupAgentCitations(citations)).toEqual([
      {
        key: 'page:6',
        pageLabel: 'Incident Runbook',
        pageHref: '/en/runbook',
        pageCitation: null,
        sections: [
          { citation: citations[0], number: 1, sectionLabel: null },
          { citation: citations[1], number: 2, sectionLabel: 'Response sequence' }
        ]
      },
      {
        key: 'page:19',
        pageLabel: 'Assessment',
        pageHref: '/en/assessment',
        pageCitation: { citation: citations[2], number: 3, sectionLabel: null },
        sections: []
      }
    ])
  })
  it('hides only a trailing incomplete citation protocol while streaming', () => {
    const citations: readonly AgentCitation[] = [
      {
        evidenceId: 'page:6:section:1',
        kind: 'page',
        label: 'Incident Runbook',
        href: '/en/runbook#incident-runbook'
      }
    ]

    const renderStreaming = (content: string): Document =>
      new JSDOM(renderSafeMarkdown(content, { resolveCitation: createAgentCitationResolver(citations), streaming: true })).window.document

    expect(renderStreaming('Literal [[ text. Claim [[cite:page:6:section').body.textContent?.trim()).toBe('Literal [[ text. Claim')
    expect(renderStreaming('Claim [[cite:').body.textContent?.trim()).toBe('Claim')
    expect(renderStreaming('Claim [[cite:page:6:section:1]').body.textContent?.trim()).toBe('Claim')
    expect(renderStreaming('Literal [[ text.').body.textContent?.trim()).toBe('Literal [[ text.')
    expect(formatAgentCitationMarkers('Claim [[cite:page:6:section', citations)).toBe('Claim [[cite:page:6:section')
    const completed = renderStreaming('Claim [[cite:page:6:section:1]]')
    expect(completed.body.textContent?.trim()).toBe('Claim 1')
    expect(completed.querySelector('a')?.textContent).toBe('1')
    expect(completed.querySelector('a')?.getAttribute('href')).toBe('/en/runbook#incident-runbook')
  })

  it('precomputes run and message presentation for a thread snapshot', () => {
    const citation: AgentCitation = {
      evidenceId: 'page:6',
      kind: 'page',
      label: 'Incident Runbook',
      href: '/en/runbook'
    }
    const runTask = task({ id: 'task-1', runId: 'run' })
    const presentation = buildAgentThreadPresentation(
      [
        message({ id: 'user-1', role: 'user', status: 'complete', content: 'How should I respond?' }),
        message({ id: 'assistant-1', role: 'assistant', status: 'failed', citations: [citation] })
      ],
      [tool({ id: 'read-1', runId: 'run' })],
      [runTask],
      []
    )

    expect(presentation.runs.get('run')).toMatchObject({
      tasks: [runTask]
    })
    expect(presentation.messages.get('assistant-1')).toMatchObject({
      retryPrompt: 'How should I respond?',
      citationGroups: [{ key: 'page:6' }]
    })
    expect(presentation.orderedMessages.map(entry => entry.message.id)).toEqual(['user-1', 'assistant-1'])
    expect(presentation.orderedMessages[0]?.statusLabel).toBeNull()
    expect(presentation.orderedMessages[0]?.recovery).toBeNull()
    expect(presentation.orderedMessages[1]?.retryPrompt).toBe('How should I respond?')
    expect(text(presentation.orderedMessages[1]?.recovery?.title ?? null)).toBe('Response could not be completed')
  })

  it('announces correction progress while preserving approval and terminal priority', () => {
    const preparing = message({ id: 'assistant-1', role: 'assistant', status: 'streaming' })
    expect(agentLiveAnnouncement([preparing], [])?.kind).toBe('generating')
    const correctingRun = runView({ workingPhase: 'correcting' })
    expect(agentLiveAnnouncement([preparing], [], correctingRun)?.kind).toBe('correcting')
    expect(agentLiveAnnouncement([{ ...preparing, content: 'Another streamed token' }], [], correctingRun)?.key).toBe('assistant-1:correcting')
    expect(agentLiveAnnouncement([preparing], [], runView({ id: 'other-run', workingPhase: 'correcting' }))?.kind).toBe('generating')
    expect(agentLiveAnnouncement([preparing], [tool({ id: 'approval-1', runId: 'run', state: 'awaitingApproval' })], correctingRun)?.kind).toBe('approval')
    for (const [status, kind, tone] of [
      ['complete', 'complete', 'neutral'],
      ['cancelled', 'stopped', 'neutral'],
      ['failed', 'failed', 'error']
    ] as const) {
      expect(agentLiveAnnouncement([message({ id: 'assistant-2', role: 'assistant', status })], [], correctingRun)).toMatchObject({ kind, tone })
    }
  })

  it('updates only live status when a persisted run phase changes', () => {
    const citation: AgentCitation = { evidenceId: 'page:6', kind: 'page', label: 'Runbook', href: '/en/runbook' }
    const preparing = message({
      id: 'assistant-1',
      role: 'assistant',
      status: 'streaming',
      content: 'A response in progress.',
      citations: [citation]
    })
    const initial = buildAgentThreadPresentation([preparing], [], [], [])
    expect(text(initial.messages.get('assistant-1')?.statusLabel ?? null)).toBe('Generating response')

    const correcting = buildAgentThreadPresentation([preparing], [], [], [], initial, runView({ workingPhase: 'correcting' }))
    expect(text(correcting.messages.get('assistant-1')?.statusLabel ?? null)).toBe('Checking and correcting a response')
    expect(correcting.messages.get('assistant-1')?.run?.workingPhase).toBe('correcting')
    expect(correcting.messages.get('assistant-1')?.message).toEqual(preparing)
    expect(correcting.messages.get('assistant-1')?.citationGroups).toEqual([
      {
        key: 'page:6',
        pageLabel: 'Runbook',
        pageHref: '/en/runbook',
        pageCitation: { citation, number: 1, sectionLabel: null },
        sections: []
      }
    ])

    const accepted = message({ id: 'assistant-1', role: 'assistant', status: 'complete', content: 'The accepted response.' })
    const completed = buildAgentThreadPresentation([accepted], [], [], [], correcting, null)
    expect(completed.messages.get('assistant-1')).toMatchObject({ statusLabel: null, message: { content: 'The accepted response.' } })
    expect(agentLiveAnnouncement([accepted], [], null)?.kind).toBe('complete')
  })

  it('keeps capacity-limited activity calm and separate from genuine failures', () => {
    const activities = [
      ...Array.from({ length: 3 }, (_, index) => tool({ id: `complete-${index}`, runId: 'run' })),
      tool({
        id: 'omitted',
        runId: 'run',
        state: 'omitted',
        contextExclusion: { status: 'omitted', reason: 'tool_result_capacity' }
      }),
      ...Array.from({ length: 7 }, (_, index) =>
        tool({
          id: `not-executed-${index}`,
          runId: 'run',
          state: 'not_executed',
          contextExclusion: { status: 'not_executed', reason: 'tool_result_capacity' }
        })
      )
    ]

    expect(activityText(activities)).toContain('1 omitted · 7 not executed')
    expect(activityText(activities)).not.toContain('failed')
  })

  it('keeps genuine failures prominent when capacity dispositions are mixed in', () => {
    const capacityLimited = [
      tool({ id: 'complete', runId: 'run' }),
      tool({ id: 'omitted', runId: 'run', state: 'omitted', contextExclusion: { status: 'omitted', reason: 'tool_result_capacity' } }),
      tool({
        id: 'not-executed',
        runId: 'run',
        state: 'not_executed',
        contextExclusion: { status: 'not_executed', reason: 'tool_result_capacity' }
      }),
      tool({ id: 'failed', runId: 'run', state: 'failed' })
    ]
    expect(activityText(capacityLimited)).toContain('1 omitted · 1 not executed · 1 failed')
  })

  it('claims the approval jump dock only when the approval is fully outside the transcript viewport', () => {
    const viewport = { top: 100, bottom: 700 }
    expect(isAgentApprovalOutsideViewport(viewport, { top: 720, bottom: 920 })).toBe(true)
    expect(isAgentApprovalOutsideViewport(viewport, { top: -100, bottom: 80 })).toBe(true)
    expect(isAgentApprovalOutsideViewport(viewport, { top: 700, bottom: 920 })).toBe(true)
    expect(isAgentApprovalOutsideViewport(viewport, { top: -100, bottom: 100 })).toBe(true)
    expect(isAgentApprovalOutsideViewport(viewport, { top: 699, bottom: 920 })).toBe(false)
    expect(isAgentApprovalOutsideViewport(viewport, { top: 650, bottom: 900 })).toBe(false)
  })
  it('preserves scroll follow only when expanding a following or near-bottom goal dock', () => {
    expect(shouldFollowGoalExpansion(true, true, false)).toBe(true)
    expect(shouldFollowGoalExpansion(true, false, true)).toBe(true)
    expect(shouldFollowGoalExpansion(true, false, false)).toBe(false)
    expect(shouldFollowGoalExpansion(false, true, true)).toBe(false)
    expect(shouldFollowGoalExpansion(false, false, false)).toBe(false)
  })
})
