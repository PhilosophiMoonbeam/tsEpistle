<template>
  <section class="approval-surface" :class="`approval-surface--${statusKey}`" aria-labelledby="approval-title" :aria-busy="loading || Boolean(pendingDecision)">
    <header class="approval-masthead">
      <span class="approval-masthead__mark" aria-hidden="true">
        <v-icon icon="mdi-lan-connect" size="24" />
      </span>
      <div>
        <p class="approval-masthead__eyebrow">MCP authorization checkpoint</p>
        <h1 id="approval-title">Review external Wiki operation</h1>
        <p>Verify the visible command, target, proposed diff, and hashes that make up this bounded review record before deciding.</p>
      </div>
      <v-chip
        v-if="proposal"
        :color="statusColor"
        :prepend-icon="statusIcon"
        size="small"
        variant="tonal"
      >{{ statusLabel }}</v-chip>
    </header>

    <v-progress-linear
      v-if="loading"
      class="approval-loading-bar"
      indeterminate
      color="primary"
      aria-label="Loading proposal"
    />

    <div v-if="loading && !proposal" class="approval-loading" role="status">
      <span class="approval-loading__mark" aria-hidden="true">
        <v-progress-circular indeterminate color="primary" size="24" width="2" />
      </span>
      <span>
        <strong>Retrieving the authorization record</strong>
        <small>Decision controls remain unavailable until the validated proposal record is loaded.</small>
      </span>
    </div>

    <v-alert
      v-if="error"
      ref="errorAlert"
      class="approval-error"
      type="error"
      variant="tonal"
      role="alert"
      tabindex="-1"
    >
      <template #title>Operation could not continue</template>
      <div class="approval-error__content">
        <span>{{ error }}</span>
        <v-btn
          v-if="!pendingDecision"
          size="small"
          variant="outlined"
          prepend-icon="mdi-refresh"
          :loading="loading"
          :disabled="loading"
          @click="load"
        >Retry</v-btn>
      </div>
    </v-alert>

    <v-card v-if="proposal" class="operation-review" :class="`operation-review--${statusKey}`" variant="outlined">
      <div class="operation-review__header">
        <span class="operation-review__state-mark" aria-hidden="true">
          <v-icon :icon="statusIcon" size="22" />
        </span>
        <div>
          <span class="operation-review__eyebrow">{{ statusLabel }}</span>
          <h2>{{ actionLabel }}</h2>
          <code>{{ proposal.actionName }}</code>
        </div>
        <span class="operation-review__elapsed">{{ decisionDuration }}</span>
      </div>

      <ol class="approval-sequence" aria-label="Authorization stages">
        <li class="approval-sequence__step approval-sequence__step--complete">
          <v-icon icon="mdi-check-circle-outline" size="17" aria-hidden="true" />
          <span><strong>Request</strong><small>Received</small></span>
        </li>
        <li class="approval-sequence__step approval-sequence__step--complete">
          <v-icon icon="mdi-check-circle-outline" size="17" aria-hidden="true" />
          <span><strong>Proposal</strong><small>Ready to inspect</small></span>
        </li>
        <li class="approval-sequence__step" :class="`approval-sequence__step--${statusKey}`">
          <v-icon :icon="statusIcon" size="17" aria-hidden="true" />
          <span><strong>Decision</strong><small>{{ decisionStageLabel }}</small></span>
        </li>
      </ol>

      <v-card-text class="operation-review__body">
        <div class="risk-brief" :class="{ 'risk-brief--destructive': proposal.risk === 'destructive-write' }">
          <v-icon
            :icon="proposal.risk === 'destructive-write' ? 'mdi-alert-octagon-outline' : 'mdi-shield-check-outline'"
            size="21"
            aria-hidden="true"
          />
          <span>
            <strong>{{ riskLabel }}</strong>
            <small>{{ riskDescription }}</small>
          </span>
        </div>

        <section class="operation-section" aria-labelledby="request-record-title">
          <div class="operation-section__heading">
            <span class="operation-section__number" aria-hidden="true">01</span>
            <div>
              <h3 id="request-record-title">Request record</h3>
              <p>Who asked, what will run, and when the authority expires.</p>
            </div>
          </div>
          <dl class="proposal-facts">
            <dt>Command</dt><dd><code>{{ proposal.actionName }}</code></dd>
            <dt>Summary</dt><dd>{{ proposal.summary }}</dd>
            <template v-if="proposal.path">
              <dt>Target path</dt><dd><code>{{ proposal.path }}</code></dd>
            </template>
            <template v-else-if="proposal.pageId">
              <dt>Target page ID</dt><dd><code>{{ proposal.pageId }}</code></dd>
            </template>
            <dt>Requested</dt>
            <dd><time :datetime="proposal.approval.requestedAt">{{ formatTimestamp(proposal.approval.requestedAt) }}</time></dd>
            <dt>Expires</dt>
            <dd><time :datetime="proposal.expiresAt">{{ formatTimestamp(proposal.expiresAt) }}</time></dd>
            <template v-if="proposal.approval.decidedAt">
              <dt>Decided</dt>
              <dd><time :datetime="proposal.approval.decidedAt">{{ formatTimestamp(proposal.approval.decidedAt) }}</time></dd>
            </template>
            <template v-if="proposal.baseSourceRevision">
              <dt>Base revision</dt><dd><code>{{ proposal.baseSourceRevision }}</code></dd>
            </template>
          </dl>

          <details class="proposal-verification">
            <summary>
              <span>
                <v-icon icon="mdi-fingerprint" size="18" aria-hidden="true" />
                Input and verification
              </span>
              <small>Bounded review record</small>
            </summary>
            <dl class="proposal-facts proposal-facts--technical">
              <dt>Proposal ID</dt><dd><code>{{ proposal.id }}</code></dd>
              <dt>Input digest</dt><dd><code>{{ proposal.inputHash }}</code></dd>
              <template v-if="proposal.patchHash"><dt>Patch digest</dt><dd><code>{{ proposal.patchHash }}</code></dd></template>
              <template v-if="proposal.diffHash"><dt>Diff digest</dt><dd><code>{{ proposal.diffHash }}</code></dd></template>
            </dl>
          </details>
        </section>

        <section class="operation-section" aria-labelledby="proposal-output-title">
          <div class="operation-section__heading">
            <span class="operation-section__number" aria-hidden="true">02</span>
            <div>
              <h3 id="proposal-output-title">Proposed output record</h3>
              <p>The diff below is the proposed-output portion of this bounded review record.</p>
            </div>
          </div>
          <div v-if="proposal.diff" class="proposal-output">
            <div class="proposal-output__legend">
              <span class="proposal-output__addition">Added</span>
              <span class="proposal-output__deletion">Removed</span>
              <span>{{ diffLines.length }} {{ diffLines.length === 1 ? 'line' : 'lines' }}</span>
            </div>
            <pre class="proposal-diff" tabindex="0" aria-label="Proposed output diff"><template v-for="(line, index) in visibleDiff" :key="index"><ins v-if="line.kind === 'insert'">{{ line.text }}</ins><del v-else-if="line.kind === 'delete'">{{ line.text }}</del><span v-else>{{ line.text }}</span>{{ '\n' }}</template></pre>
            <v-btn
              v-if="diffLines.length > collapsedLineCount"
              class="proposal-output__expand"
              size="small"
              variant="text"
              @click="expanded = !expanded"
            >{{ expanded ? 'Show fewer lines' : `Show all ${diffLines.length} lines` }}</v-btn>
          </div>
          <div v-else class="proposal-output__empty">
            <v-icon icon="mdi-file-hidden" size="20" aria-hidden="true" />
            <span>
              <strong>No textual diff supplied</strong>
              <small>Review the visible command and target above. Approval is unavailable if neither a target nor diff represents the effect.</small>
            </span>
          </div>
        </section>

        <section
          v-if="proposal.approval.status === 'pending' && !locallyExpired"
          class="operation-section decision-zone"
          aria-labelledby="decision-title"
        >
          <div class="operation-section__heading">
            <span class="operation-section__number" aria-hidden="true">03</span>
            <div>
              <h3 id="decision-title">Authorization decision</h3>
              <p>Deny stops this proposal. {{ decisionReviewCopy }}</p>
            </div>
          </div>

          <v-textarea
            v-model="decisionNote"
            class="decision-zone__note"
            label="Decision note (optional)"
            hint="Stored with this approval record"
            persistent-hint
            maxlength="4000"
            counter
            rows="2"
          />

          <div v-if="proposal.risk === 'destructive-write'" class="decision-zone__confirmation">
            <v-icon icon="mdi-delete-alert-outline" size="20" aria-hidden="true" />
            <div>
              <strong>Confirm the destructive target</strong>
              <p>Type <code>{{ proposal.confirmationPath }}</code> exactly. Pasting or typing the path does not approve the request; the deletion button remains a separate decision.</p>
              <v-text-field
                v-model="confirmationPath"
                label="Exact page path"
                :hint="proposal.confirmationPath ?? ''"
                persistent-hint
                autocomplete="off"
                spellcheck="false"
                autocapitalize="none"
                autocorrect="off"
              />
            </div>
          </div>

          <div class="approval-actions">
            <div class="approval-actions__choice">
              <v-btn
                variant="outlined"
                prepend-icon="mdi-close-circle-outline"
                :disabled="Boolean(pendingDecision)"
                :loading="pendingDecision === 'denied'"
                @click="decide('denied')"
              >Deny request</v-btn>
              <small>Wiki remains unchanged.</small>
            </div>
            <div class="approval-actions__choice approval-actions__choice--approve">
              <v-btn
                :color="proposal.risk === 'destructive-write' ? 'error' : 'primary'"
                :prepend-icon="proposal.risk === 'destructive-write' ? 'mdi-delete-alert-outline' : 'mdi-check-decagram-outline'"
                :loading="pendingDecision === 'approved'"
                :disabled="Boolean(pendingDecision) || !reviewAdequate || (proposal.risk === 'destructive-write' && confirmationPath !== proposal.confirmationPath)"
                @click="decide('approved')"
              >{{ approveLabel }}</v-btn>
              <small>Authorizes this proposal once.</small>
            </div>
          </div>
        </section>

        <section v-else class="operation-section decision-receipt" aria-labelledby="decision-receipt-title">
          <div class="operation-section__heading">
            <span class="operation-section__number" aria-hidden="true">03</span>
            <div>
              <h3 id="decision-receipt-title">Decision receipt</h3>
              <p>The authorization checkpoint is closed.</p>
            </div>
          </div>
          <v-alert
            ref="settledReceipt"
            :type="decisionAlertType"
            :icon="statusIcon"
            variant="tonal"
            role="status"
            aria-live="polite"
            tabindex="-1"
          >
            <template #title>{{ statusLabel }}</template>
            {{ settledCopy }}
          </v-alert>
        </section>
      </v-card-text>
    </v-card>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { decideAgentProposal, getMcpAgentProposal, type McpAgentProposal } from '../../helpers/agents-api.ts'

const props = defineProps<{ csrfToken: string; proposalId: string }>()
const collapsedLineCount = 80
const loading = ref(true)
const pendingDecision = ref<'approved' | 'denied' | null>(null)
const error = ref('')
const proposal = ref<McpAgentProposal | null>(null)
const expanded = ref(false)
const decisionNote = ref('')
const confirmationPath = ref('')
const clockTick = ref(0)
const settledReceipt = ref<{ $el: HTMLElement } | null>(null)
const errorAlert = ref<{ $el: HTMLElement } | null>(null)
let clockTimer: number | null = null
let expiryDeadlineTimer: number | null = null
let loadController: AbortController | null = null
let loadGeneration = 0
let decisionGeneration = 0
let disposed = false

type ApprovalSurfaceStatus = 'pending' | 'running' | 'success' | 'failed' | 'denied' | 'cancelled' | 'expired' | 'idle'

const actionLabels: Partial<Record<McpAgentProposal['actionName'], string>> = {
  'pages.prepareCreate': 'Create Wiki page',
  'pages.preparePatch': 'Edit Wiki page',
  'pages.prepareMove': 'Move Wiki page',
  'pages.prepareRestore': 'Restore Wiki page',
  'pages.prepareDelete': 'Delete Wiki page'
}
const proposalStatusLabels: Record<McpAgentProposal['status'], string> = {
  pending: 'Awaiting decision',
  approved: 'Approved · waiting to apply',
  denied: 'Denied',
  expired: 'Expired',
  applying: 'Applying approved change',
  applied: 'Applied successfully',
  failed: 'Operation failed',
  cancelled: 'Cancelled',
  recovery_required: 'Recovery required'
}
const actionLabel = computed(() => proposal.value ? actionLabels[proposal.value.actionName] ?? 'Review Wiki operation' : 'Review Wiki operation')
const approveLabel = computed(() => proposal.value?.risk === 'destructive-write' ? 'Approve page deletion' : 'Approve reviewed proposal')
const hasExpired = (expiresAt: string): boolean => new Date(expiresAt).valueOf() <= Date.now()
const locallyExpired = computed(() => {
  void clockTick.value
  const current = proposal.value
  return Boolean(current
    && current.approval.status === 'pending'
    && current.status === 'pending'
    && hasExpired(current.expiresAt))
})
const statusKey = computed<ApprovalSurfaceStatus>(() => {
  if (!proposal.value) return 'idle'
  if (proposal.value.approval.status === 'denied' || proposal.value.status === 'denied') return 'denied'
  if (proposal.value.approval.status === 'cancelled' || proposal.value.status === 'cancelled') return 'cancelled'
  if (proposal.value.approval.status === 'expired' || proposal.value.status === 'expired' || locallyExpired.value) return 'expired'
  if (proposal.value.status === 'failed' || proposal.value.status === 'recovery_required') return 'failed'
  if (proposal.value.status === 'applied') return 'success'
  if (proposal.value.status === 'approved' || proposal.value.status === 'applying' || proposal.value.approval.status === 'approved') return 'running'
  return 'pending'
})
const statusLabel = computed(() => {
  if (!proposal.value) return 'Loading request'
  if (proposal.value.approval.status === 'denied') return 'Denied'
  if (proposal.value.approval.status === 'cancelled') return 'Cancelled'
  if (proposal.value.approval.status === 'expired' || locallyExpired.value) return 'Expired'
  if (proposal.value.approval.status === 'approved' && proposal.value.status === 'pending') return 'Approved'
  return proposalStatusLabels[proposal.value.status]
})
const statusIcon = computed(() => ({
  idle: 'mdi-progress-clock',
  pending: 'mdi-shield-key-outline',
  running: 'mdi-progress-clock',
  success: 'mdi-check-circle-outline',
  failed: 'mdi-alert-octagon-outline',
  denied: 'mdi-cancel',
  cancelled: 'mdi-stop-circle-outline',
  expired: 'mdi-timer-alert-outline'
})[statusKey.value])
const statusColor = computed(() => ({
  idle: undefined,
  pending: 'warning',
  running: 'primary',
  success: 'success',
  failed: 'error',
  denied: 'error',
  cancelled: undefined,
  expired: 'warning'
})[statusKey.value])
const decisionStageLabel = computed(() => statusKey.value === 'pending' ? 'Awaiting you' : statusLabel.value)
const decisionAlertType = computed<'success' | 'error' | 'warning' | 'info'>(() => {
  if (statusKey.value === 'success' || statusKey.value === 'running') return 'success'
  if (statusKey.value === 'failed' || statusKey.value === 'denied') return 'error'
  if (statusKey.value === 'expired') return 'warning'
  return 'info'
})
const settledCopy = computed(() => {
  if (!proposal.value) return ''
  if (statusKey.value === 'success') return 'The approved proposal was applied. Return to the MCP client to continue.'
  if (statusKey.value === 'running') return 'Approval is saved. Return to the MCP client while the authorized operation continues.'
  if (statusKey.value === 'denied') return 'This proposal was denied. No authority remains for the MCP client to apply it.'
  if (statusKey.value === 'cancelled') return 'This proposal was cancelled. No further operation will run under this authorization record.'
  if (statusKey.value === 'expired') return 'The approval window closed without active authority. Request a new proposal from the MCP client.'
  return 'The authorized operation failed. Return to the MCP client for failure details; no automatic retry was approved.'
})
const riskLabel = computed(() => proposal.value?.risk === 'destructive-write' ? 'High-risk destructive operation' : 'Scoped write authorization')
const riskDescription = computed(() => proposal.value?.risk === 'destructive-write'
  ? 'This approval permanently authorizes deletion of the named page. The change cannot be undone from this screen.'
  : 'This checkpoint grants one-time authority for this reviewed proposal. It does not grant the MCP client ongoing write access.')
const diffLines = computed(() => (proposal.value?.diff ?? '').split('\n').map(text => ({
  text,
  kind: text.startsWith('+') && !text.startsWith('+++')
    ? 'insert'
    : text.startsWith('-') && !text.startsWith('---')
      ? 'delete'
      : 'context'
} as const)))
const visibleDiff = computed(() => expanded.value ? diffLines.value : diffLines.value.slice(0, collapsedLineCount))
const reviewAdequate = computed(() => Boolean(proposal.value && (proposal.value.path?.trim() || proposal.value.pageId || proposal.value.diff?.trim())))
const decisionReviewCopy = computed(() => reviewAdequate.value
  ? 'Approve authorizes only the effect represented by the available target or proposed diff. The visible command, target, diff, and hashes are this bounded review record.'
  : 'Approval is unavailable because neither a target nor proposed diff represents the effect.')
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const formatTimestamp = (value: string): string => dateFormatter.format(new Date(value))
const formatDuration = (start: string, end: string | null): string => {
  if (!end) void clockTick.value
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
const decisionDuration = computed(() => {
  const current = proposal.value
  if (!current) return ''
  if (current.approval.decidedAt) {
    return `Decided after ${formatDuration(current.approval.requestedAt, current.approval.decidedAt)}`
  }
  if (statusKey.value === 'expired') {
    return `Expired after ${formatDuration(current.approval.requestedAt, current.expiresAt)}`
  }
  return `Open for ${formatDuration(current.approval.requestedAt, null)}`
})
const stopClockTimer = (): void => {
  if (clockTimer !== null) window.clearInterval(clockTimer)
  clockTimer = null
}
const syncClockTimer = (): void => {
  stopClockTimer()
  const current = proposal.value
  if (!current || current.approval.decidedAt || (statusKey.value !== 'pending' && statusKey.value !== 'running')) return
  clockTimer = window.setInterval(() => { clockTick.value++ }, 30_000)
}
const clearExpiryDeadline = (): void => {
  if (expiryDeadlineTimer !== null) window.clearTimeout(expiryDeadlineTimer)
  expiryDeadlineTimer = null
}
const syncExpiryDeadline = (): void => {
  clearExpiryDeadline()
  const current = proposal.value
  if (!current || current.approval.status !== 'pending' || current.status !== 'pending') return
  if (hasExpired(current.expiresAt)) {
    clockTick.value++
    syncClockTimer()
    return
  }
  const remaining = Math.min(new Date(current.expiresAt).valueOf() - Date.now(), 2_147_483_647)
  expiryDeadlineTimer = window.setTimeout(() => {
    expiryDeadlineTimer = null
    clockTick.value++
    syncClockTimer()
    if (!hasExpired(current.expiresAt)) syncExpiryDeadline()
  }, remaining)
}

const focusError = async (): Promise<void> => {
  await nextTick()
  errorAlert.value?.$el.focus()
}
const load = async (): Promise<void> => {
  if (disposed) return
  loadController?.abort()
  const controller = new AbortController()
  loadController = controller
  const generation = ++loadGeneration
  loading.value = true
  error.value = ''
  if (!props.proposalId) {
    error.value = 'Proposal URL is invalid.'
    loading.value = false
    if (loadController === controller) loadController = null
    await focusError()
    return
  }
  try {
    const nextProposal = await getMcpAgentProposal(window.fetch.bind(window), props.csrfToken, props.proposalId, controller.signal)
    if (generation !== loadGeneration) return
    proposal.value = nextProposal
    syncExpiryDeadline()
    syncClockTimer()
  } catch (value) {
    if (generation !== loadGeneration || controller.signal.aborted) return
    error.value = value instanceof Error ? value.message : 'Proposal could not be loaded.'
    await focusError()
  } finally {
    if (generation === loadGeneration) {
      loading.value = false
      if (loadController === controller) loadController = null
    }
  }
}

const decide = async (decision: 'approved' | 'denied'): Promise<void> => {
  const current = proposal.value
  if (!current || pendingDecision.value || current.approval.status !== 'pending' || current.status !== 'pending') return
  if (hasExpired(current.expiresAt)) {
    clockTick.value++
    clearExpiryDeadline()
    syncClockTimer()
    return
  }
  if (decision === 'approved' && !reviewAdequate.value) return
  if (decision === 'approved' && current.risk === 'destructive-write' && confirmationPath.value !== current.confirmationPath) return
  pendingDecision.value = decision
  error.value = ''
  const proposalId = props.proposalId
  const generation = ++decisionGeneration
  try {
    await decideAgentProposal(window.fetch.bind(window), props.csrfToken, current.id, current.approval.id, {
      decision,
      ...(decisionNote.value.trim() ? { decisionNote: decisionNote.value.trim() } : {}),
      ...(decision === 'approved' && current.confirmationPath ? { confirmationPath: confirmationPath.value } : {})
    })
    if (disposed || props.proposalId !== proposalId || generation !== decisionGeneration) return
    await load()
    if (!disposed && props.proposalId === proposalId && generation === decisionGeneration && proposal.value?.approval.status !== 'pending') {
      await nextTick()
      settledReceipt.value?.$el.focus()
    }
  } catch (value) {
    if (disposed || props.proposalId !== proposalId || generation !== decisionGeneration) return
    error.value = value instanceof Error ? value.message : 'Proposal decision failed.'
    await focusError()
  } finally {
    if (generation === decisionGeneration) pendingDecision.value = null
  }
}

watch(
  () => [props.proposalId, props.csrfToken] as const,
  () => {
    decisionGeneration++
    pendingDecision.value = null
    stopClockTimer()
    clearExpiryDeadline()
    proposal.value = null
    expanded.value = false
    decisionNote.value = ''
    confirmationPath.value = ''
    void load()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  disposed = true
  loadGeneration++
  decisionGeneration++
  loadController?.abort()
  stopClockTimer()
  clearExpiryDeadline()
})
</script>

<style scoped>
.approval-surface {
  --approval-accent: rgb(var(--v-theme-warning));
  box-sizing: border-box;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  width: 100%;
  max-width: 68rem;
  min-height: 0;
  margin-inline: auto;
  padding: clamp(var(--wiki-space-3), 2vw, var(--wiki-space-6));
  overflow-y: auto;
  color: rgb(var(--v-theme-on-surface));
}

.approval-surface--running {
  --approval-accent: rgb(var(--v-theme-primary));
}

.approval-surface--success {
  --approval-accent: rgb(var(--v-theme-success));
}

.approval-surface--failed,
.approval-surface--denied {
  --approval-accent: rgb(var(--v-theme-error));
}

.approval-surface--cancelled {
  --approval-accent: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
}

.approval-surface--expired {
  --approval-accent: rgb(var(--v-theme-warning));
}

.approval-masthead {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--wiki-space-4);
  align-items: start;
  margin-bottom: var(--wiki-space-5);
}

.approval-masthead > div {
  min-width: 0;
}

.approval-masthead__mark,
.operation-review__state-mark,
.approval-loading__mark {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--approval-accent) 34%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--approval-accent) 10%, var(--wiki-surface-raised));
  color: var(--approval-accent);
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
}

.approval-masthead__mark {
  width: calc(var(--wiki-control-height) + var(--wiki-space-2));
  height: calc(var(--wiki-control-height) + var(--wiki-space-2));
}

.approval-masthead__eyebrow,
.operation-review__eyebrow {
  margin: 0 0 var(--wiki-space-1);
  color: var(--approval-accent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .1em;
  text-transform: uppercase;
}

.approval-masthead h1 {
  margin: 0;
  overflow-wrap: anywhere;
  font-family: var(--wiki-font-heading);
  font-size: clamp(1.35rem, 3vw, 2rem);
  line-height: var(--wiki-leading-heading);
}

.approval-masthead h1 + p {
  max-width: 48rem;
  margin: var(--wiki-space-2) 0 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 70%, transparent);
  line-height: 1.55;
}

.approval-loading-bar {
  margin-bottom: var(--wiki-space-3);
}

.approval-loading,
.approval-error {
  margin-bottom: var(--wiki-space-4);
}

.approval-loading {
  display: flex;
  gap: var(--wiki-space-3);
  align-items: center;
  padding: var(--wiki-space-5);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-xs);
}

.approval-loading__mark {
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
}

.approval-loading > span:last-child {
  display: grid;
  min-width: 0;
}

.approval-loading small {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
}

.approval-error__content {
  display: flex;
  gap: var(--wiki-space-3);
  align-items: center;
  justify-content: space-between;
}

.approval-error__content > span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.operation-review {
  --approval-accent: rgb(var(--v-theme-warning));
  overflow: hidden;
  border-color: color-mix(in srgb, var(--approval-accent) 38%, var(--wiki-surface-border)) !important;
  border-inline-start-width: var(--wiki-space-1) !important;
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised) !important;
  color: rgb(var(--v-theme-on-surface)) !important;
  box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);
}

.operation-review--running {
  --approval-accent: rgb(var(--v-theme-primary));
}

.operation-review--success {
  --approval-accent: rgb(var(--v-theme-success));
}

.operation-review--failed,
.operation-review--denied {
  --approval-accent: rgb(var(--v-theme-error));
}

.operation-review--cancelled {
  --approval-accent: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
}

.operation-review--expired {
  --approval-accent: rgb(var(--v-theme-warning));
}

.operation-review__header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--wiki-space-3);
  align-items: center;
  padding: var(--wiki-space-4) var(--wiki-space-5);
  border-block-end: 1px solid var(--wiki-surface-border);
  background:
    linear-gradient(110deg, color-mix(in srgb, var(--approval-accent) 10%, transparent), transparent 54%),
    rgb(var(--v-theme-surface));
}

.operation-review__header > div {
  min-width: 0;
}

.operation-review__state-mark {
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
}

.operation-review__header h2 {
  margin: 0;
  font-size: 1.05rem;
  line-height: 1.35;
}

.operation-review__header code {
  display: block;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-family: var(--wiki-font-mono);
  font-size: var(--wiki-label-size);
  overflow-wrap: anywhere;
}

.operation-review__elapsed {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-size: var(--wiki-label-size);
  font-variant-numeric: tabular-nums;
}

.approval-sequence {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
  padding: 0;
  border-block-end: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);
  list-style: none;
}

.approval-sequence__step {
  display: flex;
  gap: var(--wiki-space-2);
  align-items: center;
  min-width: 0;
  padding: var(--wiki-space-3) var(--wiki-space-4);
  color: var(--approval-accent);
}

.approval-sequence__step + .approval-sequence__step {
  border-inline-start: 1px solid var(--wiki-surface-border);
}

.approval-sequence__step > span {
  display: grid;
  min-width: 0;
}

.approval-sequence__step strong,
.approval-sequence__step small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.approval-sequence__step strong {
  font-size: .75rem;
}

.approval-sequence__step small {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: var(--wiki-label-size);
}

.approval-sequence__step--complete {
  color: rgb(var(--v-theme-success));
}

.operation-review__body {
  padding: var(--wiki-space-5) !important;
}

.risk-brief {
  display: flex;
  gap: var(--wiki-space-3);
  align-items: flex-start;
  padding: var(--wiki-space-3) var(--wiki-space-4);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-warning)) 34%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 9%, transparent);
  color: color-mix(in srgb, rgb(var(--v-theme-warning)) 76%, rgb(var(--v-theme-on-surface)));
}

.risk-brief--destructive {
  border-color: color-mix(in srgb, rgb(var(--v-theme-error)) 40%, var(--wiki-surface-border));
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 9%, transparent);
  color: color-mix(in srgb, rgb(var(--v-theme-error)) 82%, rgb(var(--v-theme-on-surface)));
}

.risk-brief > span {
  display: grid;
  gap: var(--wiki-space-1);
  min-width: 0;
}

.risk-brief small {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  line-height: 1.5;
}

.operation-section {
  margin-top: var(--wiki-space-6);
  padding-top: var(--wiki-space-5);
  border-block-start: 1px solid var(--wiki-surface-border);
}

.operation-section__heading {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--wiki-space-3);
  align-items: start;
  margin-bottom: var(--wiki-space-4);
}

.operation-section__number {
  color: var(--approval-accent);
  font-family: var(--wiki-font-mono);
  font-size: var(--wiki-label-size);
  font-weight: 700;
  letter-spacing: .08em;
}

.operation-section__heading h3,
.operation-section__heading p {
  margin: 0;
}

.operation-section__heading h3 {
  font-size: .95rem;
  line-height: 1.4;
}

.operation-section__heading p {
  margin-top: var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
  font-size: .78rem;
  line-height: 1.45;
}

.proposal-facts {
  display: grid;
  grid-template-columns: minmax(8rem, auto) minmax(0, 1fr);
  gap: var(--wiki-space-2) var(--wiki-space-4);
  margin: 0;
}

.proposal-facts dt {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .055em;
  text-transform: uppercase;
}

.proposal-facts dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.proposal-facts code,
.decision-zone__confirmation code {
  padding-inline: var(--wiki-space-1);
  border-radius: var(--wiki-radius-xs);
  background: var(--wiki-surface-sunken);
  font-family: var(--wiki-font-mono);
  font-size: .82em;
  word-break: break-all;
}

.proposal-facts code,
.decision-zone__confirmation code,
.proposal-diff {
  direction: ltr;
  text-align: start;
  unicode-bidi: plaintext;
}
.proposal-verification {
  margin-top: var(--wiki-space-4);
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: rgb(var(--v-theme-surface));
}

.proposal-verification summary {
  display: flex;
  gap: var(--wiki-space-2);
  align-items: center;
  min-height: var(--wiki-control-height);
  padding: var(--wiki-space-2) var(--wiki-space-3);
  cursor: pointer;
  list-style: none;
}

.proposal-verification summary::-webkit-details-marker {
  display: none;
}

.proposal-verification summary > span {
  display: flex;
  gap: var(--wiki-space-2);
  align-items: center;
  font-weight: 650;
}

.proposal-verification summary small {
  margin-inline-start: auto;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
}

.proposal-verification summary::after {
  content: '›';
  flex: 0 0 auto;
  font-size: 1.25rem;
  transform: rotate(90deg);
  transition: transform var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.proposal-verification[open] summary::after {
  transform: rotate(270deg);
}

.proposal-verification summary:focus-visible,
.proposal-diff:focus-visible {
  outline: 2px solid var(--wiki-focus-color);
  outline-offset: calc(-1 * var(--wiki-focus-offset));
}

.proposal-facts--technical {
  padding: var(--wiki-space-3);
  border-block-start: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);
}

.proposal-output {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}

.proposal-output__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border-block-end: 1px solid var(--wiki-surface-border);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
}

.proposal-output__legend span:last-child {
  margin-inline-start: auto;
}

.proposal-output__addition::before,
.proposal-output__deletion::before {
  display: inline-block;
  width: var(--wiki-space-2);
  height: var(--wiki-space-2);
  margin-inline-end: var(--wiki-space-1);
  border-radius: var(--wiki-radius-xs);
  background: rgb(var(--v-theme-success));
  content: '';
}

.proposal-output__deletion::before {
  background: rgb(var(--v-theme-error));
}

.proposal-diff {
  max-height: 32rem;
  margin: 0;
  padding: var(--wiki-space-4);
  overflow: auto;
  font-family: var(--wiki-font-mono);
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

.proposal-output__expand {
  margin: 0 var(--wiki-space-2) var(--wiki-space-2);
}

.proposal-output__empty {
  display: flex;
  gap: var(--wiki-space-3);
  align-items: center;
  padding: var(--wiki-space-4);
  border: 1px dashed var(--wiki-surface-border-strong);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
}

.proposal-output__empty > span {
  display: grid;
  min-width: 0;
  overflow-wrap: anywhere;
}

.decision-zone {
  border-block-start-color: color-mix(in srgb, var(--approval-accent) 34%, var(--wiki-surface-border));
}

.decision-zone__note {
  margin-top: var(--wiki-space-2);
}

.decision-zone__confirmation {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--wiki-space-3);
  align-items: start;
  margin-top: var(--wiki-space-4);
  padding: var(--wiki-space-4);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-error)) 40%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 8%, transparent);
  color: color-mix(in srgb, rgb(var(--v-theme-error)) 82%, rgb(var(--v-theme-on-surface)));
}

.decision-zone__confirmation p {
  margin: var(--wiki-space-1) 0 var(--wiki-space-3);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  line-height: 1.5;
}

.decision-zone__confirmation > div {
  min-width: 0;
}

.decision-zone__confirmation :deep(.v-messages__message) {
  overflow-wrap: anywhere;
}

.approval-actions {
  display: flex;
  gap: var(--wiki-space-4);
  align-items: flex-end;
  justify-content: space-between;
  margin-top: var(--wiki-space-5);
  padding-top: var(--wiki-space-4);
  border-block-start: 1px solid var(--wiki-surface-border);
}

.approval-actions__choice {
  display: grid;
  gap: var(--wiki-space-1);
}

.approval-actions__choice--approve {
  justify-items: end;
  text-align: end;
}

.approval-actions__choice small {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: var(--wiki-label-size);
}

@media (max-width: 599.98px) {
  .approval-masthead {
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--wiki-space-3);
  }

  .approval-masthead :deep(.v-chip) {
    grid-column: 1 / -1;
    justify-self: start;
  }

  .operation-review__header {
    grid-template-columns: auto minmax(0, 1fr);
    padding: var(--wiki-space-3);
  }

  .operation-review__elapsed {
    grid-column: 2;
  }

  .approval-sequence {
    grid-template-columns: minmax(0, 1fr);
  }

  .approval-sequence__step + .approval-sequence__step {
    border-block-start: 1px solid var(--wiki-surface-border);
    border-inline-start: 0;
  }

  .operation-review__body {
    padding: var(--wiki-space-3) !important;
  }

  .proposal-facts {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--wiki-space-1);
  }

  .proposal-facts dd + dt {
    margin-top: var(--wiki-space-2);
  }

  .proposal-verification summary small {
    display: none;
  }

  .approval-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .approval-actions__choice,
  .approval-actions__choice--approve {
    justify-items: stretch;
    text-align: start;
  }

  .approval-actions :deep(.v-btn) {
    width: 100%;
    min-height: var(--wiki-control-height);
  }

  .approval-error__content {
    align-items: stretch;
    flex-direction: column;
  }
}

@media (prefers-reduced-motion: reduce) {
  .proposal-verification summary::after {
    transition: none;
  }
}

@media (forced-colors: active) {
  .operation-review,
  .approval-loading,
  .risk-brief,
  .proposal-verification,
  .proposal-output,
  .proposal-output__empty,
  .decision-zone__confirmation {
    border-color: CanvasText !important;
  }

  .proposal-diff ins {
    border-inline-start: var(--wiki-space-1) solid CanvasText;
  }

  .proposal-diff del {
    border-inline-start: var(--wiki-space-1) double CanvasText;
  }

  .proposal-verification summary:focus-visible,
  .proposal-diff:focus-visible {
    outline: var(--wiki-space-1) solid Highlight;
    outline-offset: calc(-1 * var(--wiki-focus-offset));
  }
}
</style>
