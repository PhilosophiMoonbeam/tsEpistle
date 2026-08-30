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
        <span class="agent-operation__eyebrow">{{ locallyExpired ? 'Approval window closed' : 'Operation requires a decision' }}</span>
        <h3 :id="`agent-approval-title-${proposal.id}`" class="text-title-medium">{{ locallyExpired ? 'Approval expired' : approvalTitle }}</h3>
      </div>
      <v-chip
        color="warning"
        size="small"
        variant="tonal"
        :prepend-icon="locallyExpired ? 'mdi-timer-alert-outline' : 'mdi-pause-circle-outline'"
      >{{ locallyExpired ? 'Approval expired' : 'Awaiting approval' }}</v-chip>
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
      <dt>Command</dt>
      <dd><code>{{ tool.actionName }}</code></dd>
      <template v-if="proposal.target">
        <dt>Target</dt>
        <dd><code>{{ proposal.target.locale }}/{{ proposal.target.path }}</code></dd>
      </template>
      <dt>Requested</dt>
      <dd>
        <time :datetime="proposal.approval?.requestedAt">{{ formatTimestamp(proposal.approval?.requestedAt) }}</time>
        <span class="operation-facts__secondary"> · {{ locallyExpired ? 'waited' : 'waiting' }} {{ approvalDuration }}</span>
      </dd>
      <dt>Deadline</dt>
      <dd>
        <time :datetime="proposal.expiresAt">{{ formatTimestamp(proposal.expiresAt) }}</time>
        <span class="operation-facts__secondary"> · {{ expiryLabel }}</span>
      </dd>
    </dl>

    <details class="operation-disclosure">
      <summary>
        <span>
          <v-icon icon="mdi-code-json" size="18" aria-hidden="true" />
          Input and verification
        </span>
        <small>Bounded review record</small>
      </summary>
      <dl class="operation-facts operation-facts--technical">
        <dt>Tool call</dt><dd><code>{{ tool.id }}</code></dd>
        <dt>Input digest</dt><dd><code>{{ proposal.inputHash }}</code></dd>
        <template v-if="proposal.baseSourceRevision">
          <dt>Base revision</dt><dd><code>{{ proposal.baseSourceRevision }}</code></dd>
        </template>
        <template v-if="proposal.patchSha256">
          <dt>Patch digest</dt><dd><code>{{ proposal.patchSha256 }}</code></dd>
        </template>
        <template v-if="proposal.diffSha256">
          <dt>Diff digest</dt><dd><code>{{ proposal.diffSha256 }}</code></dd>
        </template>
      </dl>
    </details>

    <details v-if="diffLines.length" class="operation-disclosure operation-disclosure--output" open>
      <summary>
        <span>
          <v-icon icon="mdi-file-compare-outline" size="18" aria-hidden="true" />
          Proposed output
        </span>
        <small>{{ diffLines.length }} diff {{ diffLines.length === 1 ? 'line' : 'lines' }}</small>
      </summary>
      <div class="proposal-diff">
        <pre tabindex="0" :aria-label="`Proposed output record for ${proposal.target?.path || actionLabel}`"><template v-for="(line, index) in visibleDiff" :key="index"><ins v-if="line.kind === 'insert'">{{ line.text }}</ins><del v-else-if="line.kind === 'delete'">{{ line.text }}</del><span v-else>{{ line.text }}</span>{{ '\n' }}</template></pre>
        <v-btn v-if="diffLines.length > collapsedLineCount" size="small" variant="text" @click="expanded = !expanded">
          {{ expanded ? 'Show less' : `Show all ${diffLines.length} lines` }}
        </v-btn>
      </div>
    </details>

    <div v-if="!locallyExpired && proposal.risk === 'destructive-write'" class="agent-operation__confirmation">
      <p><strong>Deletion confirmation</strong> · This cannot be undone from the Agent conversation.</p>
      <v-text-field
        v-model="confirmationPath"
        label="Type the exact page path to enable deletion"
        :hint="proposal.target?.path || ''"
        persistent-hint
        autocomplete="off"
        spellcheck="false"
        autocapitalize="none"
        autocorrect="off"
      />
    </div>

    <div v-if="decisionMessage && !decisionInFlight && !locallyExpired" class="agent-operation__decision-error" role="alert">
      <v-icon icon="mdi-alert-circle-outline" size="18" aria-hidden="true" />
      <span>{{ decisionMessage }}</span>
    </div>

    <div v-if="!locallyExpired" class="agent-operation__decision">
      <div class="agent-operation__decision-copy">
        <strong>Choose deliberately</strong>
        <small>Deny leaves Wiki unchanged. {{ reviewDescription }}</small>
      </div>
      <div class="agent-operation__actions">
        <v-btn
          ref="denyButton"
          variant="outlined"
          prepend-icon="mdi-close-circle-outline"
          :disabled="!canDecide"
          :loading="decisionInFlight === 'denied'"
          @click="decide('denied')"
        >Deny</v-btn>
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
      Approval expired. Refresh the proposal before deciding.
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
        <dt>Command</dt><dd><code>{{ tool.actionName }}</code></dd>
        <dt>Summary</dt><dd>{{ proposal.summary }}</dd>
        <template v-if="proposal.target">
          <dt>Target</dt><dd><code>{{ proposal.target.locale }}/{{ proposal.target.path }}</code></dd>
        </template>
        <dt>Execution</dt><dd>{{ toolStateLabel }}</dd>
        <dt>Duration</dt><dd>{{ toolDuration }}</dd>
        <template v-if="proposal.approval?.decidedAt">
          <dt>Decision time</dt>
          <dd>
            <time :datetime="proposal.approval.decidedAt">{{ formatTimestamp(proposal.approval.decidedAt) }}</time>
            <span class="operation-facts__secondary"> · {{ approvalDuration }} after request</span>
          </dd>
        </template>
        <template v-if="proposal.approval?.decisionNote">
          <dt>Decision note</dt><dd>{{ proposal.approval.decisionNote }}</dd>
        </template>
      </dl>

      <details class="operation-disclosure">
        <summary>
          <span>
            <v-icon icon="mdi-fingerprint" size="18" aria-hidden="true" />
            Verification record
          </span>
          <small>Hashes and identifiers</small>
        </summary>
        <dl class="operation-facts operation-facts--technical">
          <dt>Tool call</dt><dd><code>{{ tool.id }}</code></dd>
          <dt>Input digest</dt><dd><code>{{ proposal.inputHash }}</code></dd>
          <template v-if="proposal.patchSha256"><dt>Patch digest</dt><dd><code>{{ proposal.patchSha256 }}</code></dd></template>
          <template v-if="proposal.resultCanonicalSha256"><dt>Result digest</dt><dd><code>{{ proposal.resultCanonicalSha256 }}</code></dd></template>
          <template v-if="proposal.diffSha256"><dt>Diff digest</dt><dd><code>{{ proposal.diffSha256 }}</code></dd></template>
        </dl>
      </details>

      <details v-if="diffLines.length" class="operation-disclosure operation-disclosure--output">
        <summary>
          <span>
            <v-icon icon="mdi-file-compare-outline" size="18" aria-hidden="true" />
            Proposed output
          </span>
          <small>{{ diffLines.length }} diff {{ diffLines.length === 1 ? 'line' : 'lines' }}</small>
        </summary>
        <div class="proposal-diff">
          <pre tabindex="0" :aria-label="`Proposed output for ${proposal.target?.path || actionLabel}`"><template v-for="(line, index) in visibleDiff" :key="index"><ins v-if="line.kind === 'insert'">{{ line.text }}</ins><del v-else-if="line.kind === 'delete'">{{ line.text }}</del><span v-else>{{ line.text }}</span>{{ '\n' }}</template></pre>
          <v-btn v-if="diffLines.length > collapsedLineCount" size="small" variant="text" @click="expanded = !expanded">
            {{ expanded ? 'Show less' : `Show all ${diffLines.length} lines` }}
          </v-btn>
        </div>
      </details>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AgentProposalView, AgentToolCallView, AgentToolState } from '../../../shared/agents/contracts.ts'
import { agentApprovalTitle, agentProposalReceiptLabel } from './agent-thread-presentation.ts'

const props = defineProps<{ tool: AgentToolCallView; proposal: AgentProposalView; busy?: boolean }>()
const emit = defineEmits<{ decision: [proposalId: string, approvalId: string, decision: 'approved' | 'denied', confirmationPath?: string] }>()
const collapsedLineCount = 80
const expanded = ref(false)
const confirmationPath = ref('')
const expiryTick = ref(0)
const decisionInFlight = ref<'approved' | 'denied' | null>(null)
const decisionMessage = ref('')
const receiptSummary = ref<HTMLElement | null>(null)
const approveButton = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
const denyButton = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
let expiryTimer: number | null = null
let expiryDeadlineTimer: number | null = null

type OperationStatus = 'pending' | 'running' | 'success' | 'failed' | 'denied' | 'cancelled' | 'expired'

const approvalPending = computed(() => props.proposal.status === 'pending' && props.proposal.approval?.status === 'pending')
const hasExpired = (): boolean => new Date(props.proposal.expiresAt).valueOf() <= Date.now()
const locallyExpired = computed(() => {
  void expiryTick.value
  return approvalPending.value && hasExpired()
})
const approvalTitle = computed(() => agentApprovalTitle(props.proposal.actionName))
const actionLabel = computed(() => approvalTitle.value.replace(/^Wiki Agent wants to /, '').replace(/^Wiki Agent needs your approval$/, 'review this action'))
const approveLabel = computed(() => {
  if (props.proposal.risk === 'destructive-write') return 'Delete page'
  if (props.proposal.actionName === 'pages.preparePatch') return 'Apply edit'
  if (props.proposal.actionName === 'pages.prepareMove') return 'Move page'
  if (props.proposal.actionName === 'pages.prepareCreate') return 'Create page'
  if (props.proposal.actionName === 'pages.prepareRestore') return 'Restore page'
  return 'Approve action'
})
const riskLabel = computed(() => props.proposal.risk === 'destructive-write' ? 'High-risk destructive write' : 'Scoped Wiki write')
const riskDescription = computed(() => props.proposal.risk === 'destructive-write'
  ? 'Approval permanently authorizes deletion of the exact target named below.'
  : 'Approval authorizes this proposal only; it does not grant ongoing write access.')
const receiptLabel = computed(() => {
  if (props.proposal.approval?.status === 'denied') return 'Change denied'
  if (props.proposal.approval?.status === 'expired') return 'Approval expired'
  if (props.proposal.approval?.status === 'cancelled' || props.proposal.status === 'cancelled' || props.tool.state === 'cancelled') return 'Change cancelled'
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
  expired: 'mdi-timer-alert-outline'
})[statusKey.value])
const toolStateLabels: Readonly<Record<AgentToolState, string>> = {
  preparing: 'Preparing',
  running: 'Running',
  awaitingApproval: 'Awaiting approval',
  complete: 'Completed successfully',
  failed: 'Failed',
  denied: 'Denied',
  cancelled: 'Cancelled'
}
const toolStateLabel = computed(() => toolStateLabels[props.tool.state])
const receiptNote = computed(() => {
  if (statusKey.value === 'success') return 'The approved operation completed. The verification record remains available below.'
  if (statusKey.value === 'running') return 'Approval was recorded and the reviewed operation is now being applied.'
  if (statusKey.value === 'failed') return props.proposal.status === 'recovery_required'
    ? 'The operation could not finish cleanly and requires recovery by an administrator.'
    : 'The approved operation failed. No automatic retry was performed.'
  if (statusKey.value === 'denied') return 'The proposal was denied; no authority was granted.'
  if (statusKey.value === 'cancelled') return 'The operation was cancelled and no further work will run for this proposal.'
  if (statusKey.value === 'expired') return 'No decision was recorded before the approval window closed.'
  return 'This operation is waiting for a decision.'
})
const expiryLabel = computed(() => {
  if (locallyExpired.value) return 'expired'
  const minutes = Math.ceil((new Date(props.proposal.expiresAt).valueOf() - Date.now()) / 60_000)
  return minutes === 1 ? 'expires in 1 minute' : `expires in ${minutes} minutes`
})
const canDecide = computed(() => approvalPending.value && !locallyExpired.value && !props.busy && !decisionInFlight.value)
const diffLines = computed(() => props.proposal.diff ? props.proposal.diff.split('\n').map(text => ({
  text,
  kind: text.startsWith('+') && !text.startsWith('+++')
    ? 'insert' as const
    : text.startsWith('-') && !text.startsWith('---')
      ? 'delete' as const
      : 'context' as const
})) : [])
const reviewAdequate = computed(() => Boolean(props.proposal.target?.path.trim() || props.proposal.diff?.trim()))
const reviewDescription = computed(() => reviewAdequate.value
  ? 'Approve authorizes only the effect represented by the available target or proposed diff. The visible command, target, diff, and hashes are this bounded review record.'
  : 'Approval is unavailable because neither a target nor proposed diff represents the effect.')
const visibleDiff = computed(() => expanded.value ? diffLines.value : diffLines.value.slice(0, collapsedLineCount))
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const formatTimestamp = (value: string | null | undefined): string => value ? dateFormatter.format(new Date(value)) : 'Not recorded'
const formatDuration = (start: string | null | undefined, end: string | null | undefined): string => {
  if (!start) return 'Not recorded'
  const milliseconds = Math.max(0, (end ? new Date(end).valueOf() : Date.now()) - new Date(start).valueOf())
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 1) return 'under 1 second'
  if (seconds < 60) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}${remainingMinutes ? ` ${remainingMinutes} min` : ''}`
}
const approvalDuration = computed(() => {
  void expiryTick.value
  const end = props.proposal.approval?.decidedAt ?? (locallyExpired.value ? props.proposal.expiresAt : null)
  return formatDuration(props.proposal.approval?.requestedAt, end)
})
const toolDuration = computed(() => {
  void expiryTick.value
  return formatDuration(props.tool.startedAt, props.tool.completedAt)
})
const receiptTimestamp = computed(() => props.tool.completedAt ?? props.proposal.approval?.decidedAt ?? props.tool.startedAt)
const elementForRef = (value: { $el?: HTMLElement } | HTMLElement | null): HTMLElement | null => value instanceof HTMLElement ? value : value?.$el ?? null
const stopExpiryTimer = (): void => {
  if (expiryTimer !== null) window.clearInterval(expiryTimer)
  if (expiryDeadlineTimer !== null) window.clearTimeout(expiryDeadlineTimer)
  expiryTimer = null
  expiryDeadlineTimer = null
}
const startExpiryTimer = (): void => {
  stopExpiryTimer()
  if ((approvalPending.value && !locallyExpired.value) || statusKey.value === 'running') expiryTimer = window.setInterval(() => { expiryTick.value++ }, 30_000)
  if (approvalPending.value && !hasExpired()) {
    const remaining = Math.min(new Date(props.proposal.expiresAt).valueOf() - Date.now(), 2_147_483_647)
    expiryDeadlineTimer = window.setTimeout(() => {
      expiryDeadlineTimer = null
      expiryTick.value++
      if (!hasExpired()) startExpiryTimer()
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
  if (pending) startExpiryTimer()
  else {
    stopExpiryTimer()
    if (wasPending) void Promise.resolve().then(() => receiptSummary.value?.focus())
  }
}, { immediate: true })
watch(statusKey, startExpiryTimer)
watch(() => props.proposal.expiresAt, startExpiryTimer)
watch(() => props.busy, busy => {
  if (busy) return
  if (decisionInFlight.value && approvalPending.value) {
    const target = decisionInFlight.value === 'approved' ? approveButton.value : denyButton.value
    void Promise.resolve().then(() => elementForRef(target)?.focus())
    decisionMessage.value = 'The decision could not be completed. Review the request and try again.'
  }
  decisionInFlight.value = null
})
onMounted(startExpiryTimer)
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
  decisionMessage.value = decision === 'approved' ? 'Submitting approval.' : 'Submitting denial.'
  emit('decision', props.proposal.id, approval.id, decision, props.proposal.risk === 'destructive-write' ? confirmationPath.value : undefined)
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
.agent-operation-receipt summary:focus-visible,
.operation-disclosure summary:focus-visible,
.proposal-diff pre:focus-visible {
  outline: none;
  box-shadow: var(--wiki-focus-ring);
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

.agent-operation__eyebrow {
  display: block;
  margin-bottom: var(--wiki-space-1);
  color: var(--operation-accent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .09em;
  text-transform: uppercase;
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
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 70%, transparent);
  line-height: 1.45;
}

.operation-facts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--wiki-space-2) var(--wiki-space-4);
  margin: var(--wiki-space-4) 0 0;
}

.operation-facts dt {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
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
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
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
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  text-align: end;
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
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
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
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 76%, transparent);
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
  }
}
</style>
