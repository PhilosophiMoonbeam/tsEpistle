import { describe, expect, it } from 'vitest'
import type { AgentCitation, AgentProposalView, AgentToolCallView } from '../../../shared/agents/contracts.ts'
import {
  agentActivityLabel,
  agentAppliedPageLinks,
  agentApprovalTitle,
  agentProposalReceiptLabel,
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

describe('Agent thread presentation', () => {
  it('groups routine activity and approval proposals with their originating run', () => {
    const patch = proposal({ id: 'proposal-1' })
    const runs = groupAgentToolsByRun([
      tool({ id: 'read-1', runId: 'run-1' }),
      tool({ id: 'patch-1', runId: 'run-1', actionName: 'pages.preparePatch', title: 'Prepare page patch', state: 'awaitingApproval', risk: 'proposal', proposalId: patch.id, completedAt: null }),
      tool({ id: 'search-2', runId: 'run-2', actionName: 'pages.search', title: 'Search pages', state: 'running', completedAt: null })
    ], [patch])

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
    const entries = groupAgentToolsByRun([
      tool({ id: 'create', runId: 'run', proposalId: created.id }),
      tool({ id: 'edit', runId: 'run', proposalId: edited.id }),
      tool({ id: 'move', runId: 'run', proposalId: moved.id }),
      tool({ id: 'restore', runId: 'run', proposalId: pending.id })
    ], [created, edited, moved, pending]).get('run')?.proposals ?? []

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


  it('keeps routine activity compact while surfacing current and failed states', () => {
    expect(agentActivityLabel([
      tool({ id: 'read', runId: 'run', title: 'Read page' }),
      tool({ id: 'search', runId: 'run', title: 'Search pages', state: 'running', completedAt: null })
    ])).toBe('Search pages · 2 actions')
    expect(agentActivityLabel([
      tool({ id: 'read', runId: 'run' }),
      tool({ id: 'search', runId: 'run', state: 'failed' })
    ])).toBe('Activity · 2 actions · 1 failed')
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
