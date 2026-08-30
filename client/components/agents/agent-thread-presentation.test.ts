import { describe, expect, it } from '../../../server/test/bun-test.mts'
import type { AgentCitation, AgentMessageView, AgentProposalView, AgentTaskView, AgentToolCallView } from '../../../shared/agents/contracts.ts'
import { formatAgentCitationMarkers } from './agent-citations.ts'
import {
  agentActivityLabel,
  agentAppliedPageLinks,
  agentApprovalTitle,
  agentLiveAnnouncement,
  agentProposalReceiptLabel,
  buildAgentThreadPresentation,
  groupAgentCitations,
  groupAgentToolsByRun,
  isAgentApprovalOutsideViewport
} from './agent-thread-presentation.ts'

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
          { citation: citations[0], number: 1, sectionLabel: 'Page overview' },
          { citation: citations[1], number: 2, sectionLabel: 'Response sequence' }
        ]
      },
      {
        key: 'page:19',
        pageLabel: 'Assessment',
        pageHref: '/en/assessment',
        pageCitation: { citation: citations[2], number: 3, sectionLabel: 'Page overview' },
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

    expect(formatAgentCitationMarkers('Literal [[ text. Claim [[cite:page:6:section', citations, true)).toBe('Literal [[ text. Claim ')
    expect(formatAgentCitationMarkers('Claim [[cite:', citations, true)).toBe('Claim ')
    expect(formatAgentCitationMarkers('Claim [[cite:page:6:section:1]', citations, true)).toBe('Claim ')
    expect(formatAgentCitationMarkers('Literal [[ text.', citations, true)).toBe('Literal [[ text.')
    expect(formatAgentCitationMarkers('Claim [[cite:page:6:section', citations)).toBe('Claim [[cite:page:6:section')
    expect(formatAgentCitationMarkers('Claim [[cite:page:6:section:1]]', citations, true)).toBe(
      'Claim [1](/en/runbook#incident-runbook "Citation 1: Incident Runbook")'
    )
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
      activityLabel: 'Activity · 1 action · Complete',
      tasks: [runTask]
    })
    expect(presentation.messages.get('assistant-1')).toMatchObject({
      retryPrompt: 'How should I respond?',
      citationGroups: [{ key: 'page:6' }]
    })
    expect(presentation.orderedMessages.map(entry => entry.message.id)).toEqual(['user-1', 'assistant-1'])
    expect(presentation.orderedMessages[0]).toMatchObject({
      statusLabel: '',
      ariaLabel: 'Your message · Complete',
      recovery: null
    })
    expect(presentation.orderedMessages[1]).toMatchObject({
      statusLabel: 'Response failed',
      ariaLabel: 'Wiki Agent message · Response failed',
      retryPrompt: 'How should I respond?',
      recovery: {
        title: 'Response could not be completed',
        description: 'You can retry the same request or revise it in the composer.'
      },
      run: {
        activityLabel: 'Activity · 1 action · Complete',
        tasks: [runTask]
      }
    })
  })

  it('presents meaningful live transitions from the latest assistant message', () => {
    const preparing = message({ id: 'assistant-1', role: 'assistant', status: 'streaming' })
    expect(agentLiveAnnouncement([preparing], [])).toEqual({
      key: 'assistant-1:preparing',
      kind: 'preparing',
      message: 'Preparing a response.',
      tone: 'neutral'
    })
    expect(agentLiveAnnouncement([{ ...preparing, content: 'Another streamed token' }], [])?.key).toBe('assistant-1:preparing')
    expect(agentLiveAnnouncement([preparing], [tool({ id: 'approval-1', runId: 'run', state: 'awaitingApproval' })])).toMatchObject({
      key: 'assistant-1:approval',
      message: 'Review needed before the response can continue.'
    })
    expect(agentLiveAnnouncement([preparing, message({ id: 'assistant-2', role: 'assistant', status: 'complete' })], [])).toMatchObject({
      kind: 'complete',
      message: 'Response complete.'
    })
    expect(agentLiveAnnouncement([message({ id: 'assistant-2', role: 'assistant', status: 'cancelled' })], [])).toMatchObject({
      kind: 'stopped',
      message: 'Response stopped.',
      tone: 'neutral'
    })
    expect(agentLiveAnnouncement([message({ id: 'assistant-2', role: 'assistant', status: 'failed' })], [])).toMatchObject({
      kind: 'failed',
      message: 'Response failed.',
      tone: 'error'
    })
  })

  it('keeps routine activity compact while surfacing current and failed states', () => {
    expect(
      agentActivityLabel([
        tool({ id: 'read', runId: 'run', title: 'Read page' }),
        tool({ id: 'search', runId: 'run', title: 'Search pages', state: 'running', completedAt: null })
      ])
    ).toBe('Search pages · 2 actions')
    expect(agentActivityLabel([tool({ id: 'read', runId: 'run' }), tool({ id: 'search', runId: 'run', state: 'failed' })])).toBe(
      'Activity · 2 actions · 1 failed'
    )
    expect(agentActivityLabel([tool({ id: 'read', runId: 'run' })])).toBe('Activity · 1 action · Complete')
  })

  it('uses conversational approval titles and durable receipt labels', () => {
    expect(agentApprovalTitle('pages.preparePatch')).toBe('Wiki Agent wants to edit a page')
    expect(agentApprovalTitle('pages.prepareDelete')).toBe('Wiki Agent wants to delete a page')
    expect(agentProposalReceiptLabel('applied')).toBe('Approved and applied')
    expect(agentProposalReceiptLabel('denied')).toBe('Change denied')
    expect(agentProposalReceiptLabel('recovery_required')).toBe('Recovery required')
  })

  it('shows the approval jump only while the approval is outside the transcript viewport', () => {
    const viewport = { top: 100, bottom: 700 }
    expect(isAgentApprovalOutsideViewport(viewport, { top: 720, bottom: 920 })).toBe(true)
    expect(isAgentApprovalOutsideViewport(viewport, { top: -100, bottom: 80 })).toBe(true)
    expect(isAgentApprovalOutsideViewport(viewport, { top: 650, bottom: 900 })).toBe(false)
  })
})
