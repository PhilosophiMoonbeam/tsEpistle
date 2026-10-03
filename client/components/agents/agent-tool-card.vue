<template>
  <article
    v-if="approvalPending"
    :id="`agent-approval-${proposal.id}`"
    class="agent-operation"
    :class="[`agent-operation--${statusKey}`, { 'agent-operation--destructive': proposal.risk === 'destructive-write' }]"
    tabindex="-1"
    :aria-labelledby="`agent-approval-title-${proposal.id}`"
    :aria-describedby="locallyExpired ? `agent-approval-risk-${proposal.id} agent-approval-expired-${proposal.id}` : `agent-approval-risk-${proposal.id}`"
  >
    <header class="agent-operation__header">
      <span class="agent-operation__state-mark" aria-hidden="true">
        <v-icon :icon="locallyExpired ? 'mdi-timer-alert-outline' : 'mdi-shield-key-outline'" size="20" />
      </span>
      <div class="agent-operation__heading">
        <h3 :id="`agent-approval-title-${proposal.id}`" class="text-title-medium">{{ locallyExpired ? $t('common:agentToolCard.approvalExpired') : approvalTitle }}</h3>
      </div>
      <v-chip
        :color="!locallyExpired && proposal.risk === 'destructive-write' ? 'error' : 'warning'"
        size="small"
        variant="tonal"
        :prepend-icon="locallyExpired ? 'mdi-timer-alert-outline' : 'mdi-pause-circle-outline'"
      >{{ locallyExpired ? $t('common:agentToolCard.expired') : $t('common:agentToolCard.awaitingApproval') }}</v-chip>
    </header>

    <p class="agent-operation__summary text-body-medium">{{ proposal.summary }}</p>

    <div :id="`agent-approval-risk-${proposal.id}`" class="agent-operation__risk">
      <v-icon
        :icon="proposal.risk === 'destructive-write' ? 'mdi-alert-octagon-outline' : 'mdi-shield-check-outline'"
        size="19"
        aria-hidden="true"
      />
      <span>
        <strong>{{ riskLabel }}</strong>
        <small>{{ riskDescription }}</small>
      </span>
    </div>

    <dl class="operation-facts">
      <dt>{{ $t('common:agentToolCard.command') }}</dt>
      <dd><code>{{ tool.actionName }}</code></dd>
      <template v-if="proposal.target">
        <dt>{{ $t('common:agentToolCard.target') }}</dt>
        <dd><code>{{ proposal.target.locale }}/{{ proposal.target.path }}</code></dd>
      </template>
      <dt>{{ $t('common:agentToolCard.requested') }}</dt>
      <dd>
        <time :datetime="proposal.approval?.requestedAt">{{ formatTimestamp(proposal.approval?.requestedAt) }}</time>
        <span class="operation-facts__secondary"> · {{ locallyExpired ? $t('common:agentToolCard.waited') : $t('common:agentToolCard.waiting') }} {{ approvalDuration }}</span>
      </dd>
      <dt>{{ $t('common:agentToolCard.deadline') }}</dt>
      <dd>
        <time :datetime="proposal.expiresAt">{{ formatTimestamp(proposal.expiresAt) }}</time>
        <span class="operation-facts__secondary"> · {{ expiryLabel }}</span>
      </dd>
    </dl>

    <details class="operation-disclosure">
      <summary>
        <span>
          <v-icon icon="mdi-code-json" size="18" aria-hidden="true" />
          {{ $t('common:agentToolCard.inputVerification') }}
        </span>
        <small>{{ $t('common:agentToolCard.boundedReviewRecord') }}</small>
      </summary>
      <dl class="operation-facts operation-facts--technical">
        <dt>{{ $t('common:agentToolCard.toolCall') }}</dt><dd><code>{{ tool.id }}</code></dd>
        <dt>{{ $t('common:agentToolCard.inputDigest') }}</dt><dd><code>{{ proposal.inputHash }}</code></dd>
        <template v-if="proposal.baseSourceRevision">
          <dt>{{ $t('common:agentToolCard.baseRevision') }}</dt><dd><code>{{ proposal.baseSourceRevision }}</code></dd>
        </template>
        <template v-if="proposal.patchSha256">
          <dt>{{ $t('common:agentToolCard.patchDigest') }}</dt><dd><code>{{ proposal.patchSha256 }}</code></dd>
        </template>
        <template v-if="proposal.diffSha256">
          <dt>{{ $t('common:agentToolCard.diffDigest') }}</dt><dd><code>{{ proposal.diffSha256 }}</code></dd>
        </template>
      </dl>
    </details>

    <details v-if="diffLines.length" class="operation-disclosure operation-disclosure--output" open>
      <summary>
        <span>
          <v-icon icon="mdi-file-compare" size="18" aria-hidden="true" />
          {{ $t('common:agentToolCard.proposedOutput2') }}
        </span>
        <small>{{ $t('common:agentToolCard.diffLinesCount', { count: diffLines.length }) }}</small>
      </summary>
      <div class="proposal-diff">
        <pre :id="`agent-approval-diff-${proposal.id}`" tabindex="0" :aria-label="$t('common:agentToolCard.proposedOutputRecord', { path: proposal.target?.path || actionLabel, interpolation: { escapeValue: false } })"><template v-for="line in visibleDiff" :key="line.key"><ins v-if="line.kind === 'insert'">{{ line.text }}</ins><del v-else-if="line.kind === 'delete'">{{ line.text }}</del><span v-else>{{ line.text }}</span>{{ '\n' }}</template></pre>
        <v-btn v-if="diffLines.length > collapsedLineCount" class="agent-operation__diff-toggle" size="small" variant="text" :aria-controls="`agent-approval-diff-${proposal.id}`" :aria-expanded="expanded" @click="expanded = !expanded">
          {{ expanded ? $t('common:agentToolCard.showLess') : $t('common:agentToolCard.showAllLines', { diffLinesCount: diffLines.length, interpolation: { escapeValue: false } }) }}
        </v-btn>
      </div>
    </details>

    <p v-if="networkBlocked" class="agent-operation__network-note" role="status">{{ $t('common:agentToolCard.connectionRequiredApproveDeny') }}</p>
    <div v-if="!locallyExpired && proposal.risk === 'destructive-write'" class="agent-operation__confirmation">
      <p><strong>{{ $t('common:agentToolCard.deletionConfirmation') }}</strong> {{ $t('common:agentToolCard.cannotUndoneAgentConversation') }}</p>
      <v-text-field
        v-model="confirmationPath"
        maxlength="1024"
        :label="$t('common:agentToolCard.typeExactPagePath')"
        :hint="proposal.target?.path || ''"
        persistent-hint
        autocomplete="off"
        spellcheck="false"
        autocapitalize="none"
        autocorrect="off"
        :disabled="!canDecide"
      />
    </div>

    <div v-if="decisionMessage && !decisionInFlight && !locallyExpired" class="agent-operation__decision-error" role="alert">
      <v-icon icon="mdi-alert-circle-outline" size="18" aria-hidden="true" />
      <span>{{ decisionMessage }}</span>
    </div>

    <div v-if="!locallyExpired" class="agent-operation__decision">
      <div class="agent-operation__decision-copy">
        <strong>{{ $t('common:agentToolCard.chooseDeliberately') }}</strong>
        <small>{{ $t('common:agentToolCard.denyLeavesWikiUnchanged', { reviewDescription, interpolation: { escapeValue: false } }) }}</small>
      </div>
      <div class="agent-operation__actions">
        <v-btn
          ref="denyButton"
          variant="outlined"
          prepend-icon="mdi-close-circle-outline"
          :disabled="!canDecide"
          :loading="decisionInFlight === 'denied'"
          @click="decide('denied')"
        >{{ $t('common:agentToolCard.deny') }}</v-btn>
        <v-btn
          ref="approveButton"
          :color="proposal.risk === 'destructive-write' ? 'error' : 'primary'"
          :prepend-icon="proposal.risk === 'destructive-write' ? 'mdi-delete-alert-outline' : 'mdi-check-decagram-outline'"
          :disabled="!canDecide || !reviewAdequate || (proposal.risk === 'destructive-write' && confirmationPath !== proposal.target?.path)"
          :loading="decisionInFlight === 'approved'"
          @click="decide('approved')"
        >{{ approveLabel }}</v-btn>
      </div>
    </div>
    <p v-else :id="`agent-approval-expired-${proposal.id}`" class="agent-operation__expired" role="status">
      <v-icon icon="mdi-timer-alert-outline" size="18" aria-hidden="true" />
      {{ $t('common:agentToolCard.approvalWindowClosed') }}
    </p>
    <p
      v-if="decisionInFlight && !locallyExpired"
      :id="`agent-approval-status-${proposal.id}`"
      class="sr-only"
      role="status"
      aria-live="polite"
    >{{ decisionMessage }}</p>
  </article>

  <details
    v-else
    :id="`agent-approval-${proposal.id}`"
    class="agent-operation-receipt"
    :class="`agent-operation-receipt--${statusKey}`"
    :aria-labelledby="`agent-approval-receipt-title-${proposal.id}`"
  >
    <summary ref="receiptSummary" :id="`agent-approval-receipt-title-${proposal.id}`">
      <span class="agent-operation-receipt__mark" aria-hidden="true">
        <v-icon :icon="statusIcon" size="19" />
      </span>
      <span class="agent-operation-receipt__heading">
        <strong>{{ receiptLabel }}</strong>
        <small>{{ tool.title }}<template v-if="proposal.target"> · {{ proposal.target.locale }}/{{ proposal.target.path }}</template></small>
      </span>
      <time v-if="receiptTimestamp" :datetime="receiptTimestamp">{{ formatTimestamp(receiptTimestamp) }}</time>
    </summary>
    <div class="agent-operation-receipt__details">
      <p class="agent-operation-receipt__note">{{ receiptNote }}</p>
      <dl class="operation-facts">
        <dt>{{ $t('common:agentToolCard.command') }}</dt><dd><code>{{ tool.actionName }}</code></dd>
        <dt>{{ $t('common:agentToolCard.summary') }}</dt><dd>{{ proposal.summary }}</dd>
        <template v-if="proposal.target">
          <dt>{{ $t('common:agentToolCard.target') }}</dt><dd><code>{{ proposal.target.locale }}/{{ proposal.target.path }}</code></dd>
        </template>
        <dt>{{ $t('common:agentToolCard.execution') }}</dt><dd>{{ toolStateLabel }}</dd>
        <dt>{{ $t('common:agentToolCard.duration') }}</dt><dd>{{ toolDuration }}</dd>
        <template v-if="proposal.approval?.decidedAt">
          <dt>{{ $t('common:agentToolCard.decisionTime') }}</dt>
          <dd>
            <time :datetime="proposal.approval.decidedAt">{{ formatTimestamp(proposal.approval.decidedAt) }}</time>
            <span class="operation-facts__secondary"> {{ $t('common:agentToolCard.afterRequest', { approvalDuration, interpolation: { escapeValue: false } }) }}</span>
          </dd>
        </template>
        <template v-if="proposal.approval?.decisionNote">
          <dt>{{ $t('common:agentToolCard.decisionNote') }}</dt><dd>{{ proposal.approval.decisionNote }}</dd>
        </template>
      </dl>

      <details class="operation-disclosure">
        <summary>
          <span>
            <v-icon icon="mdi-fingerprint" size="18" aria-hidden="true" />
            {{ $t('common:agentToolCard.verificationRecord') }}
          </span>
          <small>{{ $t('common:agentToolCard.hashesIdentifiers') }}</small>
        </summary>
        <dl class="operation-facts operation-facts--technical">
          <dt>{{ $t('common:agentToolCard.toolCall') }}</dt><dd><code>{{ tool.id }}</code></dd>
          <dt>{{ $t('common:agentToolCard.inputDigest') }}</dt><dd><code>{{ proposal.inputHash }}</code></dd>
          <template v-if="proposal.patchSha256"><dt>{{ $t('common:agentToolCard.patchDigest') }}</dt><dd><code>{{ proposal.patchSha256 }}</code></dd></template>
          <template v-if="proposal.resultCanonicalSha256"><dt>{{ $t('common:agentToolCard.resultDigest') }}</dt><dd><code>{{ proposal.resultCanonicalSha256 }}</code></dd></template>
          <template v-if="proposal.diffSha256"><dt>{{ $t('common:agentToolCard.diffDigest') }}</dt><dd><code>{{ proposal.diffSha256 }}</code></dd></template>
        </dl>
      </details>

      <details v-if="diffLines.length" class="operation-disclosure operation-disclosure--output">
        <summary>
          <span>
            <v-icon icon="mdi-file-compare" size="18" aria-hidden="true" />
            {{ $t('common:agentToolCard.proposedOutput2') }}
          </span>
          <small>{{ $t('common:agentToolCard.diffLinesCount', { count: diffLines.length }) }}</small>
        </summary>
        <div class="proposal-diff">
          <pre :id="`agent-approval-diff-${proposal.id}`" tabindex="0" :aria-label="$t('common:agentToolCard.proposedOutput', { path: proposal.target?.path || actionLabel, interpolation: { escapeValue: false } })"><template v-for="line in visibleDiff" :key="line.key"><ins v-if="line.kind === 'insert'">{{ line.text }}</ins><del v-else-if="line.kind === 'delete'">{{ line.text }}</del><span v-else>{{ line.text }}</span>{{ '\n' }}</template></pre>
          <v-btn v-if="diffLines.length > collapsedLineCount" class="agent-operation__diff-toggle" size="small" variant="text" :aria-controls="`agent-approval-diff-${proposal.id}`" :aria-expanded="expanded" @click="expanded = !expanded">
            {{ expanded ? $t('common:agentToolCard.showLess') : $t('common:agentToolCard.showAllLines', { diffLinesCount: diffLines.length, interpolation: { escapeValue: false } }) }}
          </v-btn>
        </div>
      </details>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import type { AgentProposalView, AgentToolCallView, AgentToolState } from '../../../shared/agents/contracts.ts'
import { agentApprovalTitle, agentProposalReceiptLabel } from './agent-thread-presentation.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()

const props = defineProps<{ tool: AgentToolCallView; proposal: AgentProposalView; busy?: boolean; networkBlocked?: boolean }>()
const emit = defineEmits<{ decision: [proposalId: string, approvalId: string, decision: 'approved' | 'denied', confirmationPath?: string] }>()
const collapsedLineCount = 80
const expanded = ref(false)
const confirmationPath = ref('')
const expiryTick = ref(0)
const decisionInFlight = ref<'approved' | 'denied' | null>(null)
const decisionMessage = ref('')
const receiptSummary = useTemplateRef<HTMLElement>('receiptSummary')
const approveButton = useTemplateRef<{ $el?: HTMLElement } | HTMLElement>('approveButton')
const denyButton = useTemplateRef<{ $el?: HTMLElement } | HTMLElement>('denyButton')
let expiryTimer: number | null = null
let expiryDeadlineTimer: number | null = null

type OperationStatus = 'pending' | 'running' | 'success' | 'failed' | 'denied' | 'cancelled' | 'expired' | 'omitted' | 'not_executed'

const approvalPending = computed(() =>
  props.tool.state !== 'omitted' &&
  props.tool.state !== 'not_executed' &&
  props.proposal.status === 'pending' &&
  props.proposal.approval?.status === 'pending'
)
const hasExpired = (): boolean => new Date(props.proposal.expiresAt).valueOf() <= Date.now()
const locallyExpired = computed(() => {
  void expiryTick.value
  return approvalPending.value && hasExpired()
})
const approvalTitle = computed(() => agentApprovalTitle(props.proposal.actionName))
const actionLabel = computed(() => approvalTitle.value.replace(/^Wiki Agent wants to /, '').replace(/^Wiki Agent needs your approval$/, 'review this action'))
const approveLabel = computed(() => {
  if (props.proposal.risk === 'destructive-write') return t('common:agentToolCard.deletePage')
  if (props.proposal.actionName === 'pages.preparePatch') return t('common:agentToolCard.applyEdit')
  if (props.proposal.actionName === 'pages.prepareMove') return t('common:agentToolCard.movePage')
  if (props.proposal.actionName === 'pages.prepareCreate') return t('common:agentToolCard.createPage')
  if (props.proposal.actionName === 'pages.prepareRestore') return t('common:agentToolCard.restorePage')
  return t('common:agentToolCard.approveAction')
})
const riskLabel = computed(() => props.proposal.risk === 'destructive-write' ? t('common:agentToolCard.highRiskDestructiveWrite') : t('common:agentToolCard.scopedWikiWrite'))
const riskDescription = computed(() => props.proposal.risk === 'destructive-write'
  ? t('common:agentToolCard.approvalPermanentlyAuthorizesDeletion')
  : t('common:agentToolCard.approvalAuthorizesProposalOnly'))
const receiptLabel = computed(() => {
  if (props.proposal.approval?.status === 'denied') return t('common:agentToolCard.changeDenied')
  if (props.proposal.approval?.status === 'expired') return t('common:agentToolCard.approvalExpired')
  if (props.proposal.approval?.status === 'cancelled' || props.proposal.status === 'cancelled' || props.tool.state === 'cancelled') return t('common:agentToolCard.changeCancelled')
  if (props.tool.state === 'omitted') return t('common:agentToolCard.resultOmitted')
  if (props.tool.state === 'not_executed') return t('common:agentToolCard.notExecuted')
  return agentProposalReceiptLabel(props.proposal.status)
})
const statusKey = computed<OperationStatus>(() => {
  if (props.proposal.approval?.status === 'denied') return 'denied'
  if (props.proposal.approval?.status === 'cancelled') return 'cancelled'
  if (props.proposal.approval?.status === 'expired') return 'expired'
  if (locallyExpired.value) return 'expired'
  if (props.proposal.status === 'denied') return 'denied'
  if (props.proposal.status === 'cancelled') return 'cancelled'
  if (props.proposal.status === 'expired') return 'expired'
  if (props.proposal.status === 'failed' || props.proposal.status === 'recovery_required') return 'failed'
  if (props.tool.state === 'omitted') return 'omitted'
  if (props.tool.state === 'not_executed') return 'not_executed'
  if (props.proposal.status === 'applied') return 'success'
  if (props.proposal.status === 'approved' || props.proposal.status === 'applying') return 'running'
  if (props.tool.state === 'denied') return 'denied'
  if (props.tool.state === 'cancelled') return 'cancelled'
  if (props.tool.state === 'failed') return 'failed'
  if (props.tool.state === 'complete') return 'success'
  if (props.tool.state === 'running') return 'running'
  return 'pending'
})
const statusIcon = computed(() => ({
  pending: 'mdi-pause-circle-outline',
  running: 'mdi-progress-clock',
  success: 'mdi-check-circle-outline',
  failed: 'mdi-alert-octagon-outline',
  denied: 'mdi-cancel',
  cancelled: 'mdi-stop-circle-outline',
  expired: 'mdi-timer-alert-outline',
  omitted: 'mdi-eye-off-outline',
  not_executed: 'mdi-minus-circle-outline'
})[statusKey.value])
const toolStateLabels: Readonly<Record<AgentToolState, string>> = {
  preparing: t('common:agentToolCard.preparing'),
  running: t('common:agentToolCard.running'),
  awaitingApproval: t('common:agentToolCard.awaitingApproval'),
  complete: t('common:agentToolCard.completedSuccessfully'),
  failed: t('common:agentToolCard.failed'),
  denied: t('common:agentToolCard.denied'),
  cancelled: t('common:agentToolCard.cancelled'),
  omitted: t('common:agentToolCard.resultOmitted'),
  not_executed: t('common:agentToolCard.notExecuted')
}
const toolStateLabel = computed(() => toolStateLabels[props.tool.state])
const receiptNote = computed(() => {
  if (statusKey.value === 'success') return t('common:agentToolCard.approvedOperationCompletedVerification')
  if (statusKey.value === 'omitted') return t('common:agentToolCard.operationCompletedButResult')
  if (statusKey.value === 'not_executed') return t('common:agentToolCard.operationWasNotExecuted')
  if (statusKey.value === 'running') return t('common:agentToolCard.approvalWasRecordedReviewed')
  if (statusKey.value === 'failed') return props.proposal.status === 'recovery_required'
    ? t('common:agentToolCard.operationCouldNotFinish')
    : t('common:agentToolCard.approvedOperationFailedNo')
  if (statusKey.value === 'denied') return t('common:agentToolCard.proposalWasDeniedNo')
  if (statusKey.value === 'cancelled') return t('common:agentToolCard.operationWasCancelledNo')
  if (statusKey.value === 'expired') return t('common:agentToolCard.noDecisionWasRecorded')
  return t('common:agentToolCard.operationWaitingDecision')
})
const expiryLabel = computed(() => {
  if (locallyExpired.value) return 'expired'
  const minutes = Math.ceil((new Date(props.proposal.expiresAt).valueOf() - Date.now()) / 60_000)
  return minutes === 1 ? t('common:agentToolCard.expires1Minute') : t('common:agentToolCard.expiresMinutes', { minutes, interpolation: { escapeValue: false } })
})
const canDecide = computed(() => approvalPending.value && !locallyExpired.value && !props.busy && !props.networkBlocked && !decisionInFlight.value)
const diffLines = computed(() => {
  if (!props.proposal.diff) return []
  return props.proposal.diff.split('\n').map((text, index) => ({
    key: index,
    text,
    kind: text.startsWith('+') && !text.startsWith('+++')
      ? 'insert' as const
      : text.startsWith('-') && !text.startsWith('---')
        ? 'delete' as const
        : 'context' as const
  }))
})
const reviewAdequate = computed(() => Boolean(props.proposal.target?.path.trim() || props.proposal.diff?.trim()))
const reviewDescription = computed(() => reviewAdequate.value
  ? t('common:agentToolCard.approveAuthorizesOnlyEffect')
  : t('common:agentToolCard.approvalUnavailableBecauseNeither'))
const visibleDiff = computed(() => expanded.value ? diffLines.value : diffLines.value.slice(0, collapsedLineCount))
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const formatTimestamp = (value: string | null | undefined): string => value ? dateFormatter.format(new Date(value)) : t('common:agentToolCard.notRecorded')
const formatDuration = (start: string | null | undefined, end: string | null | undefined): string => {
  if (!start) return t('common:agentToolCard.notRecorded')
  if (!end) void expiryTick.value
  const milliseconds = Math.max(0, (end ? new Date(end).valueOf() : Date.now()) - new Date(start).valueOf())
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 1) return t('common:agentToolCard.under1Second')
  if (seconds < 60) return `${t('common:agentToolCard.secondsCount', { count: seconds })}`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${t('common:agentToolCard.minutesCount', { count: minutes })}`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${t('common:agentToolCard.hoursCount', { count: hours })}${remainingMinutes ? t('common:agentToolCard.min', { remainingMinutes, interpolation: { escapeValue: false } }) : ''}`
}
const approvalDuration = computed(() => {
  const end = props.proposal.approval?.decidedAt ?? (locallyExpired.value ? props.proposal.expiresAt : null)
  return formatDuration(props.proposal.approval?.requestedAt, end)
})
const toolDuration = computed(() => formatDuration(props.tool.startedAt, props.tool.completedAt))
const receiptTimestamp = computed(() => props.tool.completedAt ?? props.proposal.approval?.decidedAt ?? props.tool.startedAt)
const elementForRef = (value: { $el?: HTMLElement } | HTMLElement | null): HTMLElement | null => value instanceof HTMLElement ? value : value?.$el ?? null
const stopExpiryTimer = (): void => {
  if (expiryTimer !== null) window.clearInterval(expiryTimer)
  if (expiryDeadlineTimer !== null) window.clearTimeout(expiryDeadlineTimer)
  expiryTimer = null
  expiryDeadlineTimer = null
}
const startExpiryTimer = (): void => {
  if (typeof window === 'undefined') return
  stopExpiryTimer()
  if ((approvalPending.value && !locallyExpired.value) || (statusKey.value === 'running' && !props.tool.completedAt)) expiryTimer = window.setInterval(() => { expiryTick.value++ }, 30_000)
  if (approvalPending.value && !hasExpired()) {
    const remaining = Math.min(new Date(props.proposal.expiresAt).valueOf() - Date.now(), 2_147_483_647)
    expiryDeadlineTimer = window.setTimeout(() => {
      expiryDeadlineTimer = null
      expiryTick.value++
      startExpiryTimer()
    }, remaining)
  }
}
watch(() => props.proposal.id, () => {
  confirmationPath.value = ''
  expanded.value = false
  decisionInFlight.value = null
  decisionMessage.value = ''
})
watch(approvalPending, (pending, wasPending) => {
  if (!pending && wasPending) void nextTick(() => receiptSummary.value?.focus())
})
watch(
  [approvalPending, statusKey, () => props.proposal.expiresAt, () => props.tool.completedAt],
  startExpiryTimer,
  { immediate: true }
)
watch(() => props.busy, busy => {
  if (busy) return
  const target = decisionInFlight.value && approvalPending.value
    ? decisionInFlight.value === 'approved' ? approveButton.value : denyButton.value
    : null
  if (target) decisionMessage.value = t('common:agentToolCard.decisionCouldNotCompleted')
  decisionInFlight.value = null
  if (target) void nextTick(() => elementForRef(target)?.focus())
})
onBeforeUnmount(stopExpiryTimer)
const decide = (decision: 'approved' | 'denied'): void => {
  const approval = props.proposal.approval
  if (!approval) return
  if (hasExpired()) {
    expiryTick.value++
    return
  }
  if (!canDecide.value) return
  if (decision === 'approved' && !reviewAdequate.value) return
  if (decision === 'approved' && props.proposal.risk === 'destructive-write' && confirmationPath.value !== props.proposal.target?.path) return
  decisionInFlight.value = decision
  decisionMessage.value = decision === 'approved' ? t('common:agentToolCard.submittingApproval') : t('common:agentToolCard.submittingDenial')
  emit('decision', props.proposal.id, approval.id, decision, props.proposal.risk === 'destructive-write' ? confirmationPath.value : undefined)
  void nextTick(() => {
    if (props.busy || !approvalPending.value || decisionInFlight.value !== decision) return
    decisionMessage.value = t('common:agentToolCard.decisionCouldNotCompleted')
    decisionInFlight.value = null
    const target = decision === 'approved' ? approveButton.value : denyButton.value
    void nextTick(() => elementForRef(target)?.focus())
  })
}
</script>
<style scoped>
.agent-operation,
.agent-operation-receipt {
  --operation-accent: rgb(var(--v-theme-warning));
  width: 100%;
  max-width: 54rem;
  margin: 0 0 var(--wiki-space-4);
  border: 1px solid color-mix(in srgb, var(--operation-accent) 44%, var(--wiki-surface-border));
  border-inline-start-width: var(--wiki-space-1);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
  color: rgb(var(--v-theme-on-surface));
}

.agent-operation {
  padding: var(--wiki-space-4);
}

.agent-operation--destructive {
  --operation-accent: rgb(var(--v-theme-error));
}

.agent-operation--expired {
  --operation-accent: rgb(var(--v-theme-warning));
}

.agent-operation:focus-visible,
.agent-operation-receipt summary:focus-visible {
  outline: none;
  box-shadow: var(--wiki-focus-ring);
}

.operation-disclosure summary:focus-visible,
.proposal-diff pre:focus-visible {
  outline: 2px solid var(--wiki-focus-color);
  outline-offset: calc(-1 * var(--wiki-focus-offset));
}

.agent-operation__header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--wiki-space-3);
  align-items: start;
}

.agent-operation__state-mark,
.agent-operation-receipt__mark {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--operation-accent) 36%, transparent);
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--operation-accent) 12%, transparent);
  color: var(--operation-accent);
}

.agent-operation__state-mark {
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
}

.agent-operation__heading {
  min-width: 0;
}

.agent-operation__heading h3,
.agent-operation__summary {
  margin: 0;
  overflow-wrap: anywhere;
}

.agent-operation__summary {
  margin-top: var(--wiki-space-4);
  line-height: var(--wiki-leading-body);
}

.agent-operation__risk,
.agent-operation__decision-error,
.agent-operation__expired {
  display: flex;
  gap: var(--wiki-space-2);
  align-items: flex-start;
  margin: var(--wiki-space-4) 0 0;
  padding: var(--wiki-space-3);
  border-radius: var(--wiki-control-radius);
}

.agent-operation__risk {
  border: 1px solid color-mix(in srgb, var(--operation-accent) 32%, transparent);
  background: color-mix(in srgb, var(--operation-accent) 9%, transparent);
  color: color-mix(in srgb, var(--operation-accent) 80%, rgb(var(--v-theme-on-surface)));
}

.agent-operation__risk > span {
  display: grid;
  gap: var(--wiki-space-1);
  min-width: 0;
}

.agent-operation__risk small,
.agent-operation__decision-copy small {
  color: var(--wiki-text-muted);
  line-height: 1.45;
}

.agent-operation__decision-error span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.operation-facts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--wiki-space-2) var(--wiki-space-4);
  margin: var(--wiki-space-4) 0 0;
}

.operation-facts dt {
  color: var(--wiki-text-muted);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .055em;
  text-transform: uppercase;
}

.operation-facts dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.operation-facts code,
.proposal-diff pre {
  direction: ltr;
  font-family: var(--wiki-font-mono);
  text-align: start;
  unicode-bidi: plaintext;
}

.operation-facts code {
  padding: 0 var(--wiki-space-1);
  border-radius: var(--wiki-radius-xs);
  background: var(--wiki-surface-sunken);
  font-size: .82em;
  word-break: break-all;
}

.operation-facts__secondary {
  color: var(--wiki-text-muted);
  font-size: .82em;
}

.operation-facts--technical {
  margin-top: var(--wiki-space-3);
  padding: var(--wiki-space-3);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}

.operation-disclosure {
  margin-top: var(--wiki-space-4);
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: rgb(var(--v-theme-surface));
}

.operation-disclosure summary,
.agent-operation-receipt > summary {
  display: flex;
  gap: var(--wiki-space-2);
  align-items: center;
  min-height: var(--wiki-control-height);
  padding: var(--wiki-space-2) var(--wiki-space-3);
  cursor: pointer;
  list-style: none;
}

.operation-disclosure summary::-webkit-details-marker,
.agent-operation-receipt > summary::-webkit-details-marker {
  display: none;
}

.operation-disclosure summary > span {
  display: flex;
  gap: var(--wiki-space-2);
  align-items: center;
  min-width: 0;
  font-weight: 650;
}

.operation-disclosure summary small {
  margin-inline-start: auto;
  color: var(--wiki-text-muted);
  text-align: end;
}

.operation-disclosure summary small {
  min-width: 0;
  overflow-wrap: anywhere;
}

.operation-disclosure summary::after,
.agent-operation-receipt > summary::after {
  content: '›';
  flex: 0 0 auto;
  font-size: 1.25rem;
  transform: rotate(90deg);
  transition: transform var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.operation-disclosure[open] summary::after,
.agent-operation-receipt[open] > summary::after {
  transform: rotate(270deg);
}

.operation-disclosure > .operation-facts {
  margin: 0;
}

.proposal-diff {
  overflow: hidden;
  border-block-start: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);
}

.proposal-diff pre {
  max-height: 30rem;
  margin: 0;
  padding: var(--wiki-space-3);
  overflow: auto;
  font-size: .78rem;
  line-height: 1.55;
  overscroll-behavior: contain;
  white-space: pre;
}

.proposal-diff ins,
.proposal-diff del,
.proposal-diff span {
  display: inline;
  text-decoration: none;
}

.proposal-diff ins {
  background: color-mix(in srgb, rgb(var(--v-theme-success)) 20%, transparent);
}

.proposal-diff del {
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 18%, transparent);
  text-decoration: line-through;
}

.agent-operation__confirmation {
  margin-top: var(--wiki-space-4);
  padding: var(--wiki-space-3);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-error)) 36%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 7%, var(--wiki-surface-raised));
}

.agent-operation__confirmation p {
  margin: 0 0 var(--wiki-space-2);
}

.agent-operation__confirmation :deep(.v-messages__message) {
  overflow-wrap: anywhere;
}

.agent-operation__decision-error {
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-error)) 34%, transparent);
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 9%, transparent);
  color: rgb(var(--v-theme-error));
}

.agent-operation__decision {
  display: flex;
  gap: var(--wiki-space-4);
  align-items: end;
  justify-content: space-between;
  margin-top: var(--wiki-space-5);
  padding-top: var(--wiki-space-4);
  border-block-start: 1px solid var(--wiki-surface-border);
}

.agent-operation__decision-copy {
  display: grid;
  gap: var(--wiki-space-1);
  max-width: 34rem;
}

.agent-operation__actions {
  display: flex;
  flex: 0 0 auto;
  gap: var(--wiki-space-2);
}

.agent-operation__expired {
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-warning)) 34%, transparent);
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 9%, transparent);
  color: color-mix(in srgb, rgb(var(--v-theme-warning)) 74%, rgb(var(--v-theme-on-surface)));
}

.agent-operation-receipt--running {
  --operation-accent: rgb(var(--v-theme-primary));
}

.agent-operation-receipt--success {
  --operation-accent: rgb(var(--v-theme-success));
}
.agent-operation-receipt--omitted {
  --operation-accent: rgb(var(--v-theme-info));
}

.agent-operation-receipt--not_executed {
  --operation-accent: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
}

.agent-operation-receipt--failed,
.agent-operation-receipt--denied {
  --operation-accent: rgb(var(--v-theme-error));
}

.agent-operation-receipt--cancelled {
  --operation-accent: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
}

.agent-operation-receipt--expired {
  --operation-accent: rgb(var(--v-theme-warning));
}

.agent-operation-receipt > summary {
  padding: var(--wiki-space-3) var(--wiki-space-4);
}

.agent-operation-receipt__mark {
  width: calc(var(--wiki-control-height) - var(--wiki-space-2));
  height: calc(var(--wiki-control-height) - var(--wiki-space-2));
}

.agent-operation-receipt__heading {
  display: grid;
  flex: 1;
  min-width: 0;
}

.agent-operation-receipt__heading strong {
  color: var(--operation-accent);
}

.agent-operation-receipt__heading small,
.agent-operation-receipt > summary time {
  overflow-wrap: anywhere;
  color: var(--wiki-text-muted);
  font-size: var(--wiki-label-size);
}

.agent-operation-receipt > summary time {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.agent-operation-receipt__details {
  padding: var(--wiki-space-4);
  border-block-start: 1px solid var(--wiki-surface-border);
}

.agent-operation-receipt__note {
  margin: 0;
  color: var(--wiki-text-muted);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}

@media (pointer: coarse) {
  .agent-operation__diff-toggle {
    min-width: var(--wiki-control-height);
    min-height: var(--wiki-control-height);
  }
}

@media (max-width: 599.98px) {
  .agent-operation {
    padding: var(--wiki-space-3);
  }

  .agent-operation__header {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .agent-operation__header :deep(.v-chip) {
    grid-column: 1 / -1;
    justify-self: start;
  }

  .operation-facts {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--wiki-space-1);
  }

  .operation-facts dd + dt {
    margin-top: var(--wiki-space-2);
  }

  .agent-operation__decision {
    align-items: stretch;
    flex-direction: column;
  }

  .agent-operation__actions {
    flex-direction: column;
  }

  .agent-operation__actions :deep(.v-btn) {
    width: 100%;
    min-height: var(--wiki-control-height);
  }

  .operation-disclosure summary {
    align-items: flex-start;
  }

  .operation-disclosure summary small,
  .agent-operation-receipt > summary time {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .operation-disclosure summary::after,
  .agent-operation-receipt > summary::after {
    transition: none;
  }
}

@media (forced-colors: active) {
  .agent-operation,
  .agent-operation-receipt,
  .operation-disclosure,
  .agent-operation__risk,
  .agent-operation__confirmation,
  .agent-operation__decision-error,
  .agent-operation__expired {
    border-color: CanvasText;
  }

  .proposal-diff ins {
    border-inline-start: var(--wiki-space-1) solid CanvasText;
  }

  .proposal-diff del {
    border-inline-start: var(--wiki-space-1) double CanvasText;
  }

  .agent-operation:focus-visible,
  .agent-operation-receipt summary:focus-visible,
  .operation-disclosure summary:focus-visible,
  .proposal-diff pre:focus-visible {
    outline: var(--wiki-space-1) solid Highlight;
    outline-offset: calc(-1 * var(--wiki-focus-offset));
  }
}
</style>
