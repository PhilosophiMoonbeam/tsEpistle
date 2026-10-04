import type {
  AgentActionName,
  AgentArtifactView,
  AgentCitation,
  AgentMessageView,
  AgentPageActionLink,
  AgentProposalStatus,
  AgentProposalView,
  AgentRunView,
  AgentRunWorkingPhase,
  AgentTaskView,
  AgentToolCallView
} from '../../../shared/agents/contracts.ts'

export interface AgentLocalizedText {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

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
  readonly sectionLabel: string | null
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
      sectionLabel: labelParts.slice(1).join(' › ') || null
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

const activityCount = (count: number): AgentLocalizedText => ({ key: 'common:agentThread.activityCount', params: { count } })

interface AgentActivityDispositionCounts {
  readonly failures: number
  readonly omitted: number
  readonly notExecuted: number
}

const activityDispositionCounts = (tools: readonly AgentToolCallView[]): AgentActivityDispositionCounts => {
  let failures = 0
  let omitted = 0
  let notExecuted = 0
  for (const tool of tools) {
    if (tool.state === 'failed') failures += 1
    else if (tool.state === 'omitted') omitted += 1
    else if (tool.state === 'not_executed') notExecuted += 1
  }
  return { failures, omitted, notExecuted }
}

export const agentActivityLabel = (tools: readonly AgentToolCallView[]): readonly AgentLocalizedText[] => {
  const active = tools.findLast(tool => tool.state === 'preparing' || tool.state === 'running' || tool.state === 'awaitingApproval')
  const { failures, omitted, notExecuted } = activityDispositionCounts(tools)
  const exceptional = failures > 0 || omitted > 0 || notExecuted > 0
  const parts: AgentLocalizedText[] = [
    active && !exceptional ? { key: 'common:agentThread.activityTitle', params: { title: active.title } } : { key: 'common:agentThread.activity' },
    activityCount(tools.length)
  ]
  if (omitted > 0) parts.push({ key: 'common:agentThread.activityOmitted', params: { count: omitted } })
  if (notExecuted > 0) parts.push({ key: 'common:agentThread.activityNotExecuted', params: { count: notExecuted } })
  if (failures > 0) parts.push({ key: 'common:agentThread.activityFailed', params: { count: failures } })
  if (!active && !exceptional) {
    parts.push({
      key: tools.some(tool => tool.state === 'cancelled' || tool.state === 'denied') ? 'common:agentThread.activityStopped' : 'common:agentThread.complete'
    })
  }
  return parts
}
export interface AgentRunPresentation extends AgentRunTools {
  readonly tasks: readonly AgentTaskView[]
  readonly pageLinks: readonly AgentPageActionLink[]
  readonly activityLabel: readonly AgentLocalizedText[]
  readonly workingPhase?: AgentRunWorkingPhase
}

export interface AgentMessageRecovery {
  readonly title: AgentLocalizedText
  readonly description: AgentLocalizedText
}

export interface AgentMessagePresentation {
  readonly message: AgentMessageView
  readonly run: AgentRunPresentation | null
  readonly citationGroups: readonly AgentCitationGroup[]
  readonly retryPrompt: string
  readonly statusLabel: AgentLocalizedText | null
  readonly ariaLabel: AgentLocalizedText
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
const hasSameSemanticSignature = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!hasSameSemanticSignature(left[index], right[index])) return false
    }
    return true
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  let leftKeyCount = 0
  let rightKeyCount = 0
  for (const key in leftRecord) {
    if (!Object.hasOwn(leftRecord, key)) continue
    leftKeyCount += 1
    if (!Object.hasOwn(rightRecord, key) || !hasSameSemanticSignature(leftRecord[key], rightRecord[key])) return false
  }
  for (const key in rightRecord) {
    if (Object.hasOwn(rightRecord, key)) rightKeyCount += 1
  }
  return leftKeyCount === rightKeyCount
}

const canonicalAgentCitations = (citations: readonly AgentCitation[], cached: readonly AgentCitation[]): readonly AgentCitation[] => {
  if (hasSameSemanticSignature(citations, cached)) return cached
  const cachedById = new Map(cached.map(citation => [citation.evidenceId, citation]))
  return citations.map(citation => {
    const cachedCitation = cachedById.get(citation.evidenceId)
    return cachedCitation && hasSameSemanticSignature(citation, cachedCitation) ? cachedCitation : citation
  })
}

const cachedAgentCitationGroups = (citations: readonly AgentCitation[], cached: readonly AgentCitationGroup[] | undefined): readonly AgentCitationGroup[] => {
  const groups = groupAgentCitations(citations)
  if (!cached) return groups
  const cachedByKey = new Map(cached.map(group => [group.key, group]))
  let preservedOrder = groups.length === cached.length
  const canonicalGroups = groups.map((group, index) => {
    const cachedGroup = cachedByKey.get(group.key)
    if (!cachedGroup || !hasSameSemanticSignature(group, cachedGroup)) {
      preservedOrder = false
      return group
    }
    if (cached[index] !== cachedGroup) preservedOrder = false
    return cachedGroup
  })
  return preservedOrder ? cached : canonicalGroups
}

const terminalAssistantOutcome = (message: AgentMessageView): AgentMessageView['runOutcome'] =>
  message.role === 'assistant' && message.runId !== null && message.status !== 'pending' && message.status !== 'streaming' ? message.runOutcome : undefined

const messageStatusLabel = (message: AgentMessageView, run: AgentRunPresentation | null): AgentLocalizedText | null => {
  const outcome = terminalAssistantOutcome(message)
  if (outcome?.status === 'partial' && message.status === 'complete') return { key: 'common:agentThread.partial' }
  if (message.role === 'user') {
    if (message.status === 'complete') return null
    if (message.status === 'failed') return { key: 'common:agentThread.sendFailed' }
    if (message.status === 'cancelled') return { key: 'common:agentThread.sendStopped' }
    return { key: 'common:agentThread.sending' }
  }
  if (message.status === 'failed' || outcome?.status === 'failed') return { key: 'common:agentThread.responseFailedStatus' }
  if (message.status === 'cancelled' || outcome?.status === 'cancelled') return { key: 'common:agentThread.responseStopped' }
  if (message.status === 'complete') return null
  if (run?.workingPhase === 'correcting') return { key: 'common:agentThread.correctingResponse' }
  return { key: message.status === 'streaming' ? 'common:agentThread.generatingResponse' : 'common:agentThread.preparingResponse' }
}

const messageRecovery = (message: AgentMessageView): AgentMessageRecovery | null => {
  const outcome = terminalAssistantOutcome(message)
  if (message.status === 'complete' && outcome?.status === 'partial') {
    return { title: { key: 'common:agentThread.partialAnswer' }, description: { key: 'common:agentThread.recoveryPartial' } }
  }
  const failed = message.status === 'failed' || outcome?.status === 'failed'
  const stopped = message.status === 'cancelled' || outcome?.status === 'cancelled'
  if (!failed && !stopped) return null
  let descriptionKey = 'common:agentThread.recoveryGeneric'
  if (failed && outcome?.status === 'failed') {
    switch (outcome.errorCode) {
      case 'AGENT_QUOTA_EXHAUSTED':
        descriptionKey = 'common:agentThread.recoveryQuota'
        break
      case 'AGENT_CONTEXT_TOO_LARGE':
      case 'PROVIDER_CONTEXT_TOO_LARGE':
      case 'PROVIDER_REQUEST_TOO_LARGE':
      case 'AGENT_MEDIA_CONTEXT_LIMIT':
        descriptionKey = 'common:agentThread.recoveryContext'
        break
      case 'AGENT_OUTPUT_LIMITED':
        descriptionKey = 'common:agentThread.recoveryOutput'
        break
      case 'AGENT_TOKEN_BUDGET_LIMITED':
        descriptionKey = 'common:agentThread.recoveryTokenBudget'
        break
    }
  }
  return {
    title: {
      key:
        message.role === 'user'
          ? failed
            ? 'common:agentThread.messageNotSent'
            : 'common:agentThread.messageStopped'
          : failed
            ? 'common:agentThread.responseFailed'
            : 'common:agentThread.responseStopped'
    },
    description: { key: descriptionKey }
  }
}

export const buildAgentThreadPresentation = (
  messages: readonly AgentMessageView[],
  tools: readonly AgentToolCallView[],
  tasks: readonly AgentTaskView[],
  proposals: readonly AgentProposalView[],
  previous?: AgentThreadPresentation,
  currentRun?: AgentRunView | null
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

  for (const message of messages) {
    if (message.runId && !mutableRuns.has(message.runId)) {
      mutableRuns.set(message.runId, emptyMutableRunPresentation())
    }
  }

  const runPresentations = new Map<string, AgentRunPresentation>()
  for (const [runId, run] of mutableRuns) {
    const workingPhase = currentRun?.id === runId && currentRun.status === 'running' ? currentRun.workingPhase : undefined
    const cached = previous?.runs.get(runId)
    if (
      cached &&
      hasSameSemanticSignature(run.activity, cached.activity) &&
      hasSameSemanticSignature(run.proposals, cached.proposals) &&
      hasSameSemanticSignature(run.tasks, cached.tasks) &&
      cached.workingPhase === workingPhase
    ) {
      runPresentations.set(runId, cached)
      continue
    }
    runPresentations.set(runId, {
      ...run,
      ...(workingPhase === undefined ? {} : { workingPhase }),
      pageLinks: (() => {
        const links = agentAppliedPageLinks(run.proposals)
        return cached && hasSameSemanticSignature(links, cached.pageLinks) ? cached.pageLinks : links
      })(),
      activityLabel: agentActivityLabel(run.activity)
    })
  }

  const orderedMessages: AgentMessagePresentation[] = []
  let retryPrompt = ''
  for (const message of messages) {
    if (message.role === 'user' && message.content.trim()) retryPrompt = message.content
    const cached = previous?.messages.get(message.id)
    const messageUnchanged = Boolean(cached && hasSameSemanticSignature(message, cached.message))
    const canonicalCitations = cached ? canonicalAgentCitations(message.citations, cached.message.citations) : message.citations
    const citationsUnchanged = Boolean(cached && canonicalCitations === cached.message.citations)
    const canonicalMessage = messageUnchanged
      ? cached!.message
      : canonicalCitations !== message.citations
        ? { ...message, citations: canonicalCitations }
        : message
    const run = canonicalMessage.runId ? (runPresentations.get(canonicalMessage.runId) ?? null) : null

    if (cached && canonicalMessage === cached.message && retryPrompt === cached.retryPrompt && run === cached.run) {
      orderedMessages.push(cached)
      continue
    }

    const statusLabel = messageStatusLabel(canonicalMessage, run)
    orderedMessages.push({
      message: canonicalMessage,
      run,
      citationGroups: citationsUnchanged ? cached!.citationGroups : cachedAgentCitationGroups(canonicalMessage.citations, cached?.citationGroups),
      retryPrompt,
      statusLabel,
      ariaLabel: { key: canonicalMessage.role === 'assistant' ? 'common:agentThread.assistantMessage' : 'common:agentThread.userMessage' },
      recovery: messageRecovery(canonicalMessage)
    })
  }
  const messagePresentations = new Map(orderedMessages.map(entry => [entry.message.id, entry]))
  return { runs: runPresentations, messages: messagePresentations, orderedMessages }
}

export type AgentLiveAnnouncementKind = 'preparing' | 'generating' | 'correcting' | 'approval' | 'complete' | 'partial' | 'stopped' | 'failed'

export interface AgentLiveAnnouncement {
  readonly key: string
  readonly kind: AgentLiveAnnouncementKind
  readonly message: AgentLocalizedText
  readonly tone: 'neutral' | 'error'
}

const liveAnnouncementCopy: Record<AgentLiveAnnouncementKind, AgentLocalizedText> = {
  preparing: { key: 'common:agentThread.announcePreparing' },
  generating: { key: 'common:agentThread.announceGenerating' },
  correcting: { key: 'common:agentThread.announceCorrecting' },
  approval: { key: 'common:agentThread.announceApproval' },
  complete: { key: 'common:agentThread.announceComplete' },
  partial: { key: 'common:agentThread.partialAnswer' },
  stopped: { key: 'common:agentThread.announceStopped' },
  failed: { key: 'common:agentThread.announceFailed' }
}

export const agentLiveAnnouncement = (
  messages: readonly AgentMessageView[],
  tools: readonly AgentToolCallView[],
  currentRun?: AgentRunView | null
): AgentLiveAnnouncement | null => {
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
  const outcome = terminalAssistantOutcome(latestAssistant)
  if (latestAssistant.status === 'complete' && outcome?.status === 'partial') kind = 'partial'
  else if (latestAssistant.status === 'failed' || outcome?.status === 'failed') kind = 'failed'
  else if (latestAssistant.status === 'cancelled' || outcome?.status === 'cancelled') kind = 'stopped'
  else if (latestAssistant.status === 'complete') kind = 'complete'
  else {
    const runId = latestAssistant.runId
    const awaitingApproval = runId !== null && tools.some(tool => tool.runId === runId && tool.state === 'awaitingApproval')
    const correcting = currentRun?.status === 'running' && currentRun.id === runId && currentRun.workingPhase === 'correcting'
    kind = awaitingApproval ? 'approval' : correcting ? 'correcting' : latestAssistant.status === 'streaming' ? 'generating' : 'preparing'
  }
  return {
    key: `${latestAssistant.id}:${kind}`,
    kind,
    message: liveAnnouncementCopy[kind],
    tone: kind === 'failed' ? 'error' : 'neutral'
  }
}

const approvalTitles: Partial<Record<AgentActionName, AgentLocalizedText>> = {
  'pages.prepareCreate': { key: 'common:agentToolCard.approvalCreateTitle' },
  'pages.preparePatch': { key: 'common:agentToolCard.approvalEditTitle' },
  'pages.prepareMove': { key: 'common:agentToolCard.approvalMoveTitle' },
  'pages.prepareRestore': { key: 'common:agentToolCard.approvalRestoreTitle' },
  'pages.prepareDelete': { key: 'common:agentToolCard.approvalDeleteTitle' }
}

export const agentApprovalTitle = (actionName: AgentActionName): AgentLocalizedText =>
  approvalTitles[actionName] ?? { key: 'common:agentToolCard.approvalReviewTitle' }

const receiptLabels: Record<AgentProposalStatus, AgentLocalizedText> = {
  pending: { key: 'common:agentToolCard.approvalRequired' },
  approved: { key: 'common:agentToolCard.approvedWaitingApply' },
  denied: { key: 'common:agentToolCard.changeDenied' },
  expired: { key: 'common:agentToolCard.approvalExpired' },
  applying: { key: 'common:agentToolCard.approvedApplyingChange' },
  applied: { key: 'common:agentToolCard.approvedAndApplied' },
  failed: { key: 'common:agentToolCard.approvedChangeFailed' },
  cancelled: { key: 'common:agentToolCard.changeCancelled' },
  recovery_required: { key: 'common:agentToolCard.recoveryRequired' }
}

export const agentProposalReceiptLabel = (status: AgentProposalStatus): AgentLocalizedText => receiptLabels[status]

export interface AgentVerticalBounds {
  readonly top: number
  readonly bottom: number
}

export const isAgentApprovalOutsideViewport = (viewport: AgentVerticalBounds, approval: AgentVerticalBounds): boolean =>
  approval.bottom <= viewport.top || approval.top >= viewport.bottom

export const shouldFollowGoalExpansion = (expanded: boolean, transcriptFollowing: boolean, transcriptNearBottom: boolean): boolean =>
  expanded && (transcriptFollowing || transcriptNearBottom)

export interface AgentArtifactPlacement {
  readonly byMessage: ReadonlyMap<string, readonly AgentArtifactView[]>
  readonly unplaced: readonly AgentArtifactView[]
}

/**
 * Places each browser screenshot under the assistant message that was active when it was
 * captured: the latest assistant message created at or before the screenshot. Screenshots
 * older than every assistant message (or with unreadable times) stay at the thread end.
 */
export const placeAgentArtifacts = (
  messages: readonly Pick<AgentMessageView, 'id' | 'role' | 'createdAt'>[],
  artifacts: readonly AgentArtifactView[]
): AgentArtifactPlacement => {
  const anchors = messages
    .filter(message => message.role === 'assistant')
    .map(message => ({ id: message.id, time: Date.parse(message.createdAt) }))
    .filter(anchor => Number.isFinite(anchor.time))
    .sort((left, right) => left.time - right.time)
  const byMessage = new Map<string, AgentArtifactView[]>()
  const unplaced: AgentArtifactView[] = []
  for (const artifact of artifacts) {
    const captured = Date.parse(artifact.createdAt)
    let anchor: string | null = null
    if (Number.isFinite(captured)) {
      for (const candidate of anchors) {
        if (candidate.time > captured) break
        anchor = candidate.id
      }
    }
    if (anchor === null) {
      unplaced.push(artifact)
      continue
    }
    const placed = byMessage.get(anchor)
    if (placed) placed.push(artifact)
    else byMessage.set(anchor, [artifact])
  }
  return { byMessage, unplaced }
}
