import type {
  AgentActionName,
  AgentPageActionLink,
  AgentProposalStatus,
  AgentProposalView,
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

const emptyRunTools = (): { activity: AgentToolCallView[], proposals: AgentProposalTool[] } => ({
  activity: [],
  proposals: []
})

export const groupAgentToolsByRun = (
  tools: readonly AgentToolCallView[],
  proposals: readonly AgentProposalView[]
): ReadonlyMap<string, AgentRunTools> => {
  const proposalsById = new Map(proposals.map(proposal => [proposal.id, proposal]))
  const runs = new Map<string, { activity: AgentToolCallView[], proposals: AgentProposalTool[] }>()
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

export const isAgentApprovalOutsideViewport = (
  viewport: AgentVerticalBounds,
  approval: AgentVerticalBounds
): boolean => approval.bottom <= viewport.top || approval.top >= viewport.bottom
