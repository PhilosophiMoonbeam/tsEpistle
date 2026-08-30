import type {
  AgentActionName,
  AgentCitation,
  AgentMessageView,
  AgentPageActionLink,
  AgentProposalStatus,
  AgentProposalView,
  AgentTaskView,
  AgentToolCallView
} from '../../../shared/agents/contracts.ts'

export interface AgentProposalTool {
  readonly tool: AgentToolCallView
  readonly proposal: AgentProposalView
}

export interface AgentRunTools {
  readonly activity: readonly AgentToolCallView[]
  readonly proposals: readonly AgentProposalTool[]
}
export interface AgentCitationEntry {
  readonly citation: AgentCitation
  readonly number: number
  readonly sectionLabel: string
}

export interface AgentCitationGroup {
  readonly key: string
  readonly pageLabel: string
  readonly pageHref: string | null
  readonly pageCitation: AgentCitationEntry | null
  readonly sections: readonly AgentCitationEntry[]
}

const citationLabelParts = (label: string): readonly string[] => label.split(' › ').filter(Boolean)

export const groupAgentCitations = (citations: readonly AgentCitation[]): readonly AgentCitationGroup[] => {
  const groups = new Map<
    string,
    {
      key: string
      pageLabel: string
      pageHref: string | null
      pageCitation: AgentCitationEntry | null
      sections: AgentCitationEntry[]
    }
  >()
  for (const [index, citation] of citations.entries()) {
    const pageEvidenceId = citation.kind === 'page' ? citation.evidenceId.match(/^(page:[^:]+)/u)?.[1] : undefined
    const key = pageEvidenceId ?? citation.evidenceId
    const labelParts = citationLabelParts(citation.label)
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        pageLabel: labelParts[0] ?? citation.label,
        pageHref: citation.href?.split('#', 1)[0] ?? null,
        pageCitation: null,
        sections: []
      }
      groups.set(key, group)
    }
    const entry = {
      citation,
      number: index + 1,
      sectionLabel: labelParts.slice(1).join(' › ') || 'Page overview'
    }
    if (citation.evidenceId === pageEvidenceId || pageEvidenceId === undefined) group.pageCitation ??= entry
    else group.sections.push(entry)
  }
  return [...groups.values()]
}

const emptyRunTools = (): { activity: AgentToolCallView[]; proposals: AgentProposalTool[] } => ({
  activity: [],
  proposals: []
})

export const groupAgentToolsByRun = (tools: readonly AgentToolCallView[], proposals: readonly AgentProposalView[]): ReadonlyMap<string, AgentRunTools> => {
  const proposalsById = new Map(proposals.map(proposal => [proposal.id, proposal]))
  const runs = new Map<string, { activity: AgentToolCallView[]; proposals: AgentProposalTool[] }>()
  for (const tool of tools) {
    const run = runs.get(tool.runId) ?? emptyRunTools()
    if (!runs.has(tool.runId)) runs.set(tool.runId, run)
    const proposal = tool.proposalId ? proposalsById.get(tool.proposalId) : undefined
    if (proposal) run.proposals.push({ tool, proposal })
    else run.activity.push(tool)
  }
  return runs
}

export const agentAppliedPageLinks = (entries: readonly AgentProposalTool[]): readonly AgentPageActionLink[] => {
  const seen = new Set<string>()
  const links: AgentPageActionLink[] = []
  for (const { proposal } of entries) {
    if (proposal.status !== 'applied' || proposal.pageLink === null || seen.has(proposal.pageLink.href)) continue
    seen.add(proposal.pageLink.href)
    links.push(proposal.pageLink)
  }
  return links
}

const actionCount = (count: number): string => `${count} ${count === 1 ? 'action' : 'actions'}`

export const agentActivityLabel = (tools: readonly AgentToolCallView[]): string => {
  let active: AgentToolCallView | undefined
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index]
    if (tool && (tool.state === 'preparing' || tool.state === 'running')) {
      active = tool
      break
    }
  }
  if (active) return `${active.title} · ${actionCount(tools.length)}`
  const failures = tools.filter(tool => tool.state === 'failed').length
  if (failures > 0) return `Activity · ${actionCount(tools.length)} · ${failures} failed`
  if (tools.some(tool => tool.state === 'cancelled' || tool.state === 'denied')) {
    return `Activity · ${actionCount(tools.length)} · Stopped`
  }
  return `Activity · ${actionCount(tools.length)} · Complete`
}
export interface AgentRunPresentation extends AgentRunTools {
  readonly tasks: readonly AgentTaskView[]
  readonly pageLinks: readonly AgentPageActionLink[]
  readonly activityLabel: string
}

export interface AgentMessageRecovery {
  readonly title: string
  readonly description: string
}

export interface AgentMessagePresentation {
  readonly message: AgentMessageView
  readonly run: AgentRunPresentation | null
  readonly citationGroups: readonly AgentCitationGroup[]
  readonly retryPrompt: string
  readonly statusLabel: string
  readonly ariaLabel: string
  readonly recovery: AgentMessageRecovery | null
}

export interface AgentThreadPresentation {
  readonly runs: ReadonlyMap<string, AgentRunPresentation>
  readonly messages: ReadonlyMap<string, AgentMessagePresentation>
  readonly orderedMessages: readonly AgentMessagePresentation[]
}

interface MutableRunPresentation {
  activity: readonly AgentToolCallView[]
  proposals: readonly AgentProposalTool[]
  tasks: AgentTaskView[]
}

const emptyMutableRunPresentation = (): MutableRunPresentation => ({
  activity: [],
  proposals: [],
  tasks: []
})
const messageStatusLabel = (message: AgentMessageView): string => {
  if (message.status === 'complete') return ''
  if (message.role === 'user') {
    if (message.status === 'failed') return 'Send failed'
    if (message.status === 'cancelled') return 'Send stopped'
    return 'Sending'
  }
  if (message.status === 'failed') return 'Response failed'
  if (message.status === 'cancelled') return 'Response stopped'
  return 'Preparing a response'
}

const messageRecovery = (message: AgentMessageView): AgentMessageRecovery | null => {
  if (message.status !== 'failed' && message.status !== 'cancelled') return null
  if (message.role === 'user') {
    return {
      title: message.status === 'failed' ? 'Message was not sent' : 'Message sending stopped',
      description: 'You can retry this message or revise it in the composer.'
    }
  }
  return {
    title: message.status === 'failed' ? 'Response could not be completed' : 'Response stopped',
    description: message.status === 'failed' ? 'You can retry the same request or revise it in the composer.' : 'You can continue by retrying the request.'
  }
}

export const buildAgentThreadPresentation = (
  messages: readonly AgentMessageView[],
  tools: readonly AgentToolCallView[],
  tasks: readonly AgentTaskView[],
  proposals: readonly AgentProposalView[]
): AgentThreadPresentation => {
  const groupedTools = groupAgentToolsByRun(tools, proposals)
  const mutableRuns = new Map<string, MutableRunPresentation>()
  for (const [runId, entries] of groupedTools) {
    mutableRuns.set(runId, { ...entries, tasks: [] })
  }
  for (const task of tasks) {
    const run = mutableRuns.get(task.runId) ?? emptyMutableRunPresentation()
    if (!mutableRuns.has(task.runId)) mutableRuns.set(task.runId, run)
    run.tasks.push(task)
  }

  const messageDetails: {
    message: AgentMessageView
    citationGroups: readonly AgentCitationGroup[]
    retryPrompt: string
  }[] = []
  let retryPrompt = ''
  for (const message of messages) {
    if (message.role === 'user' && message.content.trim()) retryPrompt = message.content
    messageDetails.push({
      message,
      citationGroups: groupAgentCitations(message.citations),
      retryPrompt
    })
    if (message.runId && !mutableRuns.has(message.runId)) {
      mutableRuns.set(message.runId, emptyMutableRunPresentation())
    }
  }

  const runPresentations = new Map<string, AgentRunPresentation>()
  for (const [runId, run] of mutableRuns) {
    runPresentations.set(runId, {
      ...run,
      pageLinks: agentAppliedPageLinks(run.proposals),
      activityLabel: agentActivityLabel(run.activity)
    })
  }
  const orderedMessages = messageDetails.map<AgentMessagePresentation>(entry => {
    const statusLabel = messageStatusLabel(entry.message)
    return {
      ...entry,
      run: entry.message.runId ? (runPresentations.get(entry.message.runId) ?? null) : null,
      statusLabel,
      ariaLabel: `${entry.message.role === 'assistant' ? 'Wiki Agent' : 'Your'} message · ${statusLabel || 'Complete'}`,
      recovery: messageRecovery(entry.message)
    }
  })
  const messagePresentations = new Map(orderedMessages.map(entry => [entry.message.id, entry]))
  return { runs: runPresentations, messages: messagePresentations, orderedMessages }
}

export type AgentLiveAnnouncementKind = 'preparing' | 'approval' | 'complete' | 'stopped' | 'failed'

export interface AgentLiveAnnouncement {
  readonly key: string
  readonly kind: AgentLiveAnnouncementKind
  readonly message: string
  readonly tone: 'neutral' | 'error'
}

const liveAnnouncementCopy: Record<AgentLiveAnnouncementKind, string> = {
  preparing: 'Preparing a response.',
  approval: 'Review needed before the response can continue.',
  complete: 'Response complete.',
  stopped: 'Response stopped.',
  failed: 'Response failed.'
}

export const agentLiveAnnouncement = (messages: readonly AgentMessageView[], tools: readonly AgentToolCallView[]): AgentLiveAnnouncement | null => {
  let latestAssistant: AgentMessageView | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant') {
      latestAssistant = message
      break
    }
  }
  if (!latestAssistant) return null

  let kind: AgentLiveAnnouncementKind
  if (latestAssistant.status === 'complete') kind = 'complete'
  else if (latestAssistant.status === 'cancelled') kind = 'stopped'
  else if (latestAssistant.status === 'failed') kind = 'failed'
  else {
    const runId = latestAssistant.runId
    const awaitingApproval = runId !== null && tools.some(tool => tool.runId === runId && tool.state === 'awaitingApproval')
    kind = awaitingApproval ? 'approval' : 'preparing'
  }
  return {
    key: `${latestAssistant.id}:${kind}`,
    kind,
    message: liveAnnouncementCopy[kind],
    tone: kind === 'failed' ? 'error' : 'neutral'
  }
}

const approvalTitles: Partial<Record<AgentActionName, string>> = {
  'pages.prepareCreate': 'Wiki Agent wants to create a page',
  'pages.preparePatch': 'Wiki Agent wants to edit a page',
  'pages.prepareMove': 'Wiki Agent wants to move a page',
  'pages.prepareRestore': 'Wiki Agent wants to restore a page',
  'pages.prepareDelete': 'Wiki Agent wants to delete a page'
}

export const agentApprovalTitle = (actionName: AgentActionName): string => approvalTitles[actionName] ?? 'Wiki Agent needs your approval'

const receiptLabels: Record<AgentProposalStatus, string> = {
  pending: 'Approval required',
  approved: 'Approved · Waiting to apply',
  denied: 'Change denied',
  expired: 'Approval expired',
  applying: 'Approved · Applying change',
  applied: 'Approved and applied',
  failed: 'Approved change failed',
  cancelled: 'Change cancelled',
  recovery_required: 'Recovery required'
}

export const agentProposalReceiptLabel = (status: AgentProposalStatus): string => receiptLabels[status]

export interface AgentVerticalBounds {
  readonly top: number
  readonly bottom: number
}

export const isAgentApprovalOutsideViewport = (viewport: AgentVerticalBounds, approval: AgentVerticalBounds): boolean =>
  approval.bottom <= viewport.top || approval.top >= viewport.bottom
