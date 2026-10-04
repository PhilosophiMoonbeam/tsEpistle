<template>
  <section class="approval-surface" :class="`approval-surface--${statusKey}`" :aria-labelledby="approvalTitleId" :aria-busy="loading || Boolean(pendingDecision)">
    <header class="approval-masthead">
      <span class="approval-masthead__mark" aria-hidden="true">
        <v-icon icon="mdi-lan-connect" size="24" />
      </span>
      <div>
        <p class="approval-masthead__eyebrow">{{ $t('common:agentMcpApproval.mcpAuthorizationCheckpoint') }}</p>
        <h1 :id="approvalTitleId">{{ $t('common:agentMcpApproval.reviewExternalWikiOperation') }}</h1>
        <p>{{ $t('common:agentMcpApproval.verifyVisibleCommandTarget') }}</p>
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
      :aria-label="$t('common:agentMcpApproval.loadingProposal')"
    />

    <div v-if="loading && !proposal" class="approval-loading" role="status">
      <span class="approval-loading__mark" aria-hidden="true">
        <v-progress-circular indeterminate color="primary" size="24" width="2" />
      </span>
      <span>
        <strong>{{ $t('common:agentMcpApproval.retrievingAuthorizationRecord') }}</strong>
        <small>{{ $t('common:agentMcpApproval.decisionControlsRemainUnavailable') }}</small>
      </span>
    </div>

    <v-alert
      v-if="networkBlocked"
      class="approval-connection-warning"
      type="warning"
      variant="tonal"
      role="status"
      icon="mdi-cloud-off-outline"
    >
      {{ $t('common:agentMcpApproval.connectionRequiredDecideRequest') }}
    </v-alert>

    <v-alert
      v-if="error"
      ref="errorAlert"
      class="approval-error"
      type="error"
      variant="tonal"
      role="alert"
      tabindex="-1"
    >
      <template #title>{{ $t('common:agentMcpApproval.operationCouldNotContinue') }}</template>
      <div class="approval-error__content">
        <span>{{ error }}</span>
        <v-btn
          v-if="!pendingDecision"
          size="small"
          variant="outlined"
          prepend-icon="mdi-refresh"
          :loading="loading"
          :disabled="loading || networkBlocked"
          @click="load()"
        >{{ $t('common:agentMcpApproval.retry') }}</v-btn>
      </div>
    </v-alert>

    <v-card v-if="proposal" class="operation-review" :class="`operation-review--${statusKey}`" variant="outlined">
      <div class="operation-review__header">
        <span class="operation-review__state-mark" aria-hidden="true">
          <v-icon :icon="statusIcon" size="22" />
        </span>
        <div>
          <span class="operation-review__eyebrow">{{ statusKey === 'pending' ? decisionStageLabel : statusLabel }}</span>
          <h2>{{ actionLabel }}</h2>
          <code>{{ proposal.actionName }}</code>
        </div>
        <span class="operation-review__elapsed">{{ decisionDuration }}</span>
      </div>


      <v-card-text class="operation-review__body">
        <div class="operation-review__inspection">

        <section class="operation-section" :aria-labelledby="requestRecordTitleId">
          <div class="operation-section__heading">
            <div>
              <h3 :id="requestRecordTitleId">{{ $t('common:agentMcpApproval.requestRecord') }}</h3>
              <p>{{ $t('common:agentMcpApproval.whoAskedWhatWill') }}</p>
            </div>
          </div>
          <dl class="proposal-facts">
            <dt>{{ $t('common:agentMcpApproval.command') }}</dt><dd><code>{{ proposal.actionName }}</code></dd>
            <dt>{{ $t('common:agentMcpApproval.summary') }}</dt><dd>{{ proposal.summary }}</dd>
            <template v-if="proposal.path">
              <dt>{{ $t('common:agentMcpApproval.targetPath') }}</dt><dd><code>{{ proposal.path }}</code></dd>
            </template>
            <template v-else-if="proposal.pageId">
              <dt>{{ $t('common:agentMcpApproval.targetPageId') }}</dt><dd><code>{{ proposal.pageId }}</code></dd>
            </template>
            <dt>{{ $t('common:agentMcpApproval.requested') }}</dt>
            <dd><time :datetime="proposal.approval.requestedAt">{{ formatTimestamp(proposal.approval.requestedAt) }}</time></dd>
            <dt>{{ $t('common:agentMcpApproval.expires') }}</dt>
            <dd><time :datetime="proposal.expiresAt">{{ formatTimestamp(proposal.expiresAt) }}</time></dd>
            <template v-if="proposal.approval.decidedAt">
              <dt>{{ $t('common:agentMcpApproval.decided') }}</dt>
              <dd><time :datetime="proposal.approval.decidedAt">{{ formatTimestamp(proposal.approval.decidedAt) }}</time></dd>
            </template>
            <template v-if="proposal.baseSourceRevision">
              <dt>{{ $t('common:agentMcpApproval.baseRevision') }}</dt><dd><code>{{ proposal.baseSourceRevision }}</code></dd>
            </template>
          </dl>

          <details class="proposal-verification">
            <summary>
              <span>
                <v-icon icon="mdi-fingerprint" size="18" aria-hidden="true" />
                {{ $t('common:agentMcpApproval.inputVerification') }}
              </span>
              <small>{{ $t('common:agentMcpApproval.boundedReviewRecord') }}</small>
            </summary>
            <dl class="proposal-facts proposal-facts--technical">
              <dt>{{ $t('common:agentMcpApproval.proposalId') }}</dt><dd><code>{{ proposal.id }}</code></dd>
              <dt>{{ $t('common:agentMcpApproval.inputDigest') }}</dt><dd><code>{{ proposal.inputHash }}</code></dd>
              <template v-if="proposal.patchHash"><dt>{{ $t('common:agentMcpApproval.patchDigest') }}</dt><dd><code>{{ proposal.patchHash }}</code></dd></template>
              <template v-if="proposal.diffHash"><dt>{{ $t('common:agentMcpApproval.diffDigest') }}</dt><dd><code>{{ proposal.diffHash }}</code></dd></template>
            </dl>
          </details>
        </section>

        <section class="operation-section" :aria-labelledby="proposalOutputTitleId">
          <div class="operation-section__heading">
            <div>
              <h3 :id="proposalOutputTitleId">{{ $t('common:agentMcpApproval.proposedOutputRecord') }}</h3>
              <p>{{ $t('common:agentMcpApproval.diffBelowProposedOutput') }}</p>
            </div>
          </div>
          <div v-if="proposal.diff" class="proposal-output">
            <div class="proposal-output__legend">
              <span class="proposal-output__addition">{{ $t('common:agentMcpApproval.added') }}</span>
              <span class="proposal-output__deletion">{{ $t('common:agentMcpApproval.removed') }}</span>
              <span>{{ $t('common:agentMcpApproval.linesCount', { count: diffLines.length }) }}</span>
            </div>
            <pre :id="proposalDiffId" class="proposal-diff" tabindex="0" :aria-label="$t('common:agentMcpApproval.proposedOutputDiff')"><template v-for="line in visibleDiff" :key="line.key"><ins v-if="line.kind === 'insert'">{{ line.text }}</ins><del v-else-if="line.kind === 'delete'">{{ line.text }}</del><span v-else>{{ line.text }}</span>{{ '\n' }}</template></pre>
            <v-btn
              v-if="diffLines.length > collapsedLineCount"
              class="proposal-output__expand"
              size="small"
              variant="text"
              :aria-expanded="expanded"
              :aria-controls="proposalDiffId"
              @click="expanded = !expanded"
            >{{ expanded ? $t('common:agentMcpApproval.showFewerLines') : $t('common:agentMcpApproval.showAllLines', { diffLinesCount: diffLines.length, interpolation: { escapeValue: false } }) }}</v-btn>
          </div>
          <div v-else class="proposal-output__empty">
            <v-icon icon="mdi-file-hidden" size="20" aria-hidden="true" />
            <span>
              <strong>{{ $t('common:agentMcpApproval.noTextualDiffSupplied') }}</strong>
              <small>{{ $t('common:agentMcpApproval.reviewVisibleCommandTarget') }}</small>
            </span>
          </div>
        </section>
        </div>
        <aside class="operation-review__authorization" :aria-label="$t('common:agentMcpApproval.authorizationDecision')">

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
        <section
          v-if="proposal.approval.status === 'pending' && !locallyExpired && !acceptedDecisionForProposal"
          class="operation-section decision-zone"
          ref="decisionZone"
          :aria-labelledby="decisionTitleId"
        >
          <div class="operation-section__heading">
            <div>
              <h3 :id="decisionTitleId">{{ $t('common:agentMcpApproval.authorizationDecision') }}</h3>
              <p>{{ $t('common:agentMcpApproval.denyStopsProposal', { decisionReviewCopy, interpolation: { escapeValue: false } }) }}</p>
            </div>
          </div>

          <v-textarea
            v-model="decisionNote"
            class="decision-zone__note"
            :label="$t('common:agentMcpApproval.decisionNoteOptional')"
            :hint="$t('common:agentMcpApproval.storedApprovalRecord')"
            persistent-hint
            maxlength="4000"
            counter
            rows="2"
            variant="outlined"
            :disabled="Boolean(pendingDecision) || loading || networkBlocked"
          />

          <div v-if="proposal.risk === 'destructive-write'" class="decision-zone__confirmation">
            <v-icon icon="mdi-delete-alert-outline" size="20" aria-hidden="true" />
            <div>
              <strong>{{ $t('common:agentMcpApproval.confirmDestructiveTarget') }}</strong>
              <p>{{ $t('common:agentMcpApproval.type') }} <code>{{ proposal.confirmationPath }}</code> {{ $t('common:agentMcpApproval.exactlyPastingTypingPath') }}</p>
              <v-text-field
                v-model="confirmationPath"
                maxlength="1024"
                :label="$t('common:agentMcpApproval.exactPagePath')"
                :hint="proposal.confirmationPath ?? ''"
                persistent-hint
                autocomplete="off"
                spellcheck="false"
                autocapitalize="none"
                autocorrect="off"
                variant="outlined"
                :disabled="Boolean(pendingDecision) || loading || networkBlocked || !decisionReady"
              />
            </div>
          </div>

          <div class="approval-actions">
            <div class="approval-actions__choice">
              <v-btn
                variant="outlined"
                prepend-icon="mdi-close-circle-outline"
                :disabled="Boolean(pendingDecision) || networkBlocked || !decisionReady"
                :loading="pendingDecision === 'denied'"
                @click="decide('denied')"
              >{{ $t('common:agentMcpApproval.denyRequest') }}</v-btn>
              <small>{{ $t('common:agentMcpApproval.wikiRemainsUnchanged') }}</small>
            </div>
            <div class="approval-actions__choice approval-actions__choice--approve">
              <v-btn
                :color="proposal.risk === 'destructive-write' ? 'error' : 'primary'"
                :prepend-icon="proposal.risk === 'destructive-write' ? 'mdi-delete-alert-outline' : 'mdi-check-decagram-outline'"
                :loading="pendingDecision === 'approved'"
                :disabled="Boolean(pendingDecision) || networkBlocked || !decisionReady || !reviewAdequate || (proposal.risk === 'destructive-write' && confirmationPath !== proposal.confirmationPath)"
                @click="decide('approved')"
              >{{ approveLabel }}</v-btn>
              <small>{{ $t('common:agentMcpApproval.authorizesProposalOnce') }}</small>
            </div>
          </div>
        </section>

        <section v-else class="operation-section decision-receipt" :aria-labelledby="decisionReceiptTitleId">
          <div class="operation-section__heading">
            <div>
              <h3 :id="decisionReceiptTitleId">{{ $t('common:agentMcpApproval.decisionReceipt') }}</h3>
              <p>{{ $t('common:agentMcpApproval.authorizationCheckpointClosed') }}</p>
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
        </aside>
      </v-card-text>
    </v-card>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId, useTemplateRef, watch } from 'vue'
import i18next from 'i18next'
import { decideAgentProposal, getMcpAgentProposal, type McpAgentProposal } from '../../helpers/agents-api.ts'
import type { AgentRefreshResult } from '../../store/agents.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const translate = useTranslate()
const localeRevision = ref(0)
const refreshLocale = (): void => { localeRevision.value += 1 }
i18next.on('languageChanged', refreshLocale)
i18next.on('loaded', refreshLocale)
onBeforeUnmount(() => {
  i18next.off('languageChanged', refreshLocale)
  i18next.off('loaded', refreshLocale)
})
const t: typeof translate = (key, options) => {
  void localeRevision.value
  return translate(key, options)
}

const props = defineProps<{ csrfToken: string; proposalId: string; networkBlocked?: boolean }>()
const instanceId = useId()
const approvalTitleId = `${instanceId}-approval-title`
const requestRecordTitleId = `${instanceId}-request-record-title`
const proposalOutputTitleId = `${instanceId}-proposal-output-title`
const proposalDiffId = `${instanceId}-proposal-diff`
const decisionTitleId = `${instanceId}-decision-title`
const decisionReceiptTitleId = `${instanceId}-decision-receipt-title`
const collapsedLineCount = 80
const loading = ref(true)
const pendingDecision = ref<'approved' | 'denied' | null>(null)
const error = ref('')
const proposal = shallowRef<McpAgentProposal | null>(null)
type AcceptedDecision = {
  readonly csrfToken: string
  readonly proposalId: string
  readonly decision: 'approved' | 'denied'
}
const acceptedDecision = shallowRef<AcceptedDecision | null>(null)
const proposalReadAccepted = ref(false)
const decisionNeedsReconciliation = ref(true)
const acceptedReadStateKey = ref('')
const acceptedReadIdentity = shallowRef<ApprovalIdentity | null>(null)
const expanded = ref(false)
const decisionNote = ref('')
const confirmationPath = ref('')
const clockTick = ref(0)
type ComponentRoot = { $el?: unknown }
const settledReceipt = useTemplateRef<ComponentRoot | HTMLElement>('settledReceipt')
const decisionZone = useTemplateRef<HTMLElement>('decisionZone')
const errorAlert = useTemplateRef<ComponentRoot | HTMLElement>('errorAlert')
const networkBlocked = computed(() => props.networkBlocked === true)
const componentGeneration = ref(0)
const transportGeneration = ref(0)
let expiryDeadlineTimer: number | null = null
let clockTimer: number | null = null
let loadController: AbortController | null = null
let loadGeneration = 0
let decisionGeneration = 0
let disposed = false

type ApprovalIdentity = {
  readonly csrfToken: string
  readonly proposalId: string
  readonly componentGeneration: number
  readonly transportGeneration: number
}
type ApprovalSurfaceStatus = 'pending' | 'running' | 'success' | 'failed' | 'denied' | 'cancelled' | 'expired' | 'idle'
const statusIcons: Readonly<Record<ApprovalSurfaceStatus, string>> = {
  idle: 'mdi-progress-clock',
  pending: 'mdi-shield-key-outline',
  running: 'mdi-progress-clock',
  success: 'mdi-check-circle-outline',
  failed: 'mdi-alert-octagon-outline',
  denied: 'mdi-cancel',
  cancelled: 'mdi-stop-circle-outline',
  expired: 'mdi-timer-alert-outline'
}
const statusColors: Readonly<Record<ApprovalSurfaceStatus, string | undefined>> = {
  idle: undefined,
  pending: 'warning',
  running: 'primary',
  success: 'success',
  failed: 'error',
  denied: 'error',
  cancelled: undefined,
  expired: 'warning'
}

const actionLabels = computed<Partial<Record<McpAgentProposal['actionName'], string>>>(() => ({
  'pages.prepareCreate': t('common:agentMcpApproval.createWikiPage'),
  'pages.preparePatch': t('common:agentMcpApproval.editWikiPage'),
  'pages.prepareMove': t('common:agentMcpApproval.moveWikiPage'),
  'pages.prepareRestore': t('common:agentMcpApproval.restoreWikiPage'),
  'pages.prepareDelete': t('common:agentMcpApproval.deleteWikiPage')
}))
const proposalStatusLabels = computed<Record<McpAgentProposal['status'], string>>(() => ({
  pending: t('common:agentMcpApproval.awaitingDecision'),
  approved: t('common:agentMcpApproval.approvedWaitingApply'),
  denied: t('common:agentMcpApproval.denied'),
  expired: t('common:agentMcpApproval.expired'),
  applying: t('common:agentMcpApproval.applyingApprovedChange'),
  applied: t('common:agentMcpApproval.appliedSuccessfully'),
  failed: t('common:agentMcpApproval.operationFailed'),
  cancelled: t('common:agentMcpApproval.cancelled'),
  recovery_required: t('common:agentMcpApproval.recoveryRequired')
}))
const captureIdentity = (proposalId = props.proposalId): ApprovalIdentity => ({
  csrfToken: props.csrfToken,
  proposalId,
  componentGeneration: componentGeneration.value,
  transportGeneration: transportGeneration.value
})
const isBaseIdentityCurrent = (identity: ApprovalIdentity): boolean =>
  !disposed
  && identity.csrfToken === props.csrfToken
  && identity.proposalId === props.proposalId
  && identity.componentGeneration === componentGeneration.value
const isTransportIdentityCurrent = (identity: ApprovalIdentity): boolean =>
  isBaseIdentityCurrent(identity)
  && identity.transportGeneration === transportGeneration.value
  && !networkBlocked.value
const isDecisionCurrent = (identity: ApprovalIdentity, generation: number): boolean =>
  generation === decisionGeneration && isTransportIdentityCurrent(identity)
const proposalReadStateKeyFor = (value: McpAgentProposal | null): string => value
  ? `${value.id}\u0000${value.status}\u0000${value.approval.status}\u0000${value.expiresAt}`
  : ''
const proposalReadStateKey = computed(() => proposalReadStateKeyFor(proposal.value))
const acceptedDecisionForProposal = computed(() => {
  const decision = acceptedDecision.value
  if (!decision || decision.proposalId !== props.proposalId || decision.csrfToken !== props.csrfToken) return null
  return decision
})
const actionLabel = computed(() => proposal.value ? actionLabels.value[proposal.value.actionName] ?? t('common:agentMcpApproval.reviewWikiOperation') : t('common:agentMcpApproval.reviewWikiOperation'))
const approveLabel = computed(() => proposal.value?.risk === 'destructive-write' ? t('common:agentMcpApproval.approvePageDeletion') : t('common:agentMcpApproval.approveReviewedProposal'))
const hasExpired = (expiresAt: string): boolean => new Date(expiresAt).valueOf() <= Date.now()
const locallyExpired = computed(() => {
  void clockTick.value
  const current = proposal.value
  return Boolean(current
    && !acceptedDecisionForProposal.value
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
  if (acceptedDecisionForProposal.value?.decision === 'denied') return 'denied'
  if (acceptedDecisionForProposal.value?.decision === 'approved') return 'running'
  if (proposal.value.status === 'approved' || proposal.value.status === 'applying' || proposal.value.approval.status === 'approved') return 'running'
  return 'pending'
})
const statusLabel = computed(() => {
  if (!proposal.value) return t('common:agentMcpApproval.loadingRequest')
  if (proposal.value.approval.status === 'denied') return t('common:agentMcpApproval.denied')
  if (proposal.value.approval.status === 'cancelled') return t('common:agentMcpApproval.cancelled')
  if (proposal.value.approval.status === 'expired' || locallyExpired.value) return t('common:agentMcpApproval.expired')
  if (acceptedDecisionForProposal.value?.decision === 'denied') return t('common:agentMcpApproval.denied')
  if (acceptedDecisionForProposal.value?.decision === 'approved' && proposal.value.status === 'pending') return t('common:agentMcpApproval.approved')
  if (proposal.value.approval.status === 'approved' && proposal.value.status === 'pending') return t('common:agentMcpApproval.approved')
  return proposalStatusLabels.value[proposal.value.status]
})
const statusIcon = computed(() => statusIcons[statusKey.value])
const statusColor = computed(() => statusColors[statusKey.value])
const decisionAlertType = computed<'success' | 'error' | 'warning' | 'info'>(() => {
  if (statusKey.value === 'success' || statusKey.value === 'running') return 'success'
  if (statusKey.value === 'failed' || statusKey.value === 'denied') return 'error'
  if (statusKey.value === 'expired') return 'warning'
  return 'info'
})
const settledCopy = computed(() => {
  if (!proposal.value) return ''
  if (statusKey.value === 'success') return t('common:agentMcpApproval.approvedProposalWasApplied')
  if (statusKey.value === 'running') return t('common:agentMcpApproval.approvalSavedReturnMcp')
  if (statusKey.value === 'denied') return t('common:agentMcpApproval.proposalWasDeniedNo')
  if (statusKey.value === 'cancelled') return t('common:agentMcpApproval.proposalWasCancelledNo')
  if (statusKey.value === 'expired') return t('common:agentMcpApproval.approvalWindowClosedWithout')
  return t('common:agentMcpApproval.authorizedOperationFailedReturn')
})
const riskLabel = computed(() => proposal.value?.risk === 'destructive-write' ? t('common:agentMcpApproval.highRiskDestructiveOperation') : t('common:agentMcpApproval.scopedWriteAuthorization'))
const riskDescription = computed(() => proposal.value?.risk === 'destructive-write'
  ? t('common:agentMcpApproval.approvalPermanentlyAuthorizesDeletion')
  : t('common:agentMcpApproval.checkpointGrantsOneTime'))
const diffLines = computed(() => (proposal.value?.diff ?? '').split('\n').map((text, index) => ({
  key: `${proposal.value?.id ?? 'proposal'}:${index}`,
  text,
  kind: text.startsWith('+') && !text.startsWith('+++')
    ? 'insert'
    : text.startsWith('-') && !text.startsWith('---')
      ? 'delete'
      : 'context'
})))
const visibleDiff = computed(() => expanded.value ? diffLines.value : diffLines.value.slice(0, collapsedLineCount))
const reviewAdequate = computed(() => Boolean(proposal.value && (proposal.value.path?.trim() || proposal.value.pageId || proposal.value.diff?.trim())))
const decisionReady = computed(() => {
  const current = proposal.value
  const readIdentity = acceptedReadIdentity.value
  return Boolean(
    !networkBlocked.value
    && !loading.value
    && !pendingDecision.value
    && proposalReadAccepted.value
    && !decisionNeedsReconciliation.value
    && acceptedReadStateKey.value === proposalReadStateKey.value
    && readIdentity
    && isTransportIdentityCurrent(readIdentity)
    && !acceptedDecisionForProposal.value
    && current
    && current.id === props.proposalId
    && current.approval.status === 'pending'
    && current.status === 'pending'
    && !hasExpired(current.expiresAt)
  )
})
const decisionStageLabel = computed(() => statusKey.value === 'pending'
  ? (decisionReady.value ? t('common:agentMcpApproval.awaitingYou') : t('common:agentMcpApproval.refreshRequired'))
  : statusLabel.value)
const decisionReviewCopy = computed(() => reviewAdequate.value
  ? t('common:agentMcpApproval.approveAuthorizesOnlyEffect')
  : t('common:agentMcpApproval.approvalUnavailableBecauseNeither'))
const dateFormatter = computed(() => {
  void localeRevision.value
  return new Intl.DateTimeFormat(i18next.resolvedLanguage || i18next.language || undefined, { dateStyle: 'medium', timeStyle: 'short' })
})
const formatTimestamp = (value: string): string => dateFormatter.value.format(new Date(value))
const formatDuration = (start: string, end: string | null): string => {
  if (!end) void clockTick.value
  const milliseconds = Math.max(0, (end ? new Date(end).valueOf() : Date.now()) - new Date(start).valueOf())
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 1) return t('common:agentMcpApproval.under1Second')
  if (seconds < 60) return `${t('common:agentMcpApproval.secondsCount', { count: seconds })}`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${t('common:agentMcpApproval.minutesCount', { count: minutes })}`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${t('common:agentMcpApproval.hoursCount', { count: hours })}${remainingMinutes ? ` ${t('common:agentMcpApproval.min', { remainingMinutes, interpolation: { escapeValue: false } })}` : ''}`
}
const decisionDuration = computed(() => {
  const current = proposal.value
  if (!current) return ''
  if (current.approval.decidedAt) {
    return t('common:agentMcpApproval.decidedAfter', { decidedAt: formatDuration(current.approval.requestedAt, current.approval.decidedAt), interpolation: { escapeValue: false } })
  }
  if (statusKey.value === 'expired') {
    return t('common:agentMcpApproval.expiredAfter', { expiresAt: formatDuration(current.approval.requestedAt, current.expiresAt), interpolation: { escapeValue: false } })
  }
  return t('common:agentMcpApproval.open', { null: formatDuration(current.approval.requestedAt, null), interpolation: { escapeValue: false } })
})
const stopClockTimer = (): void => {
  if (clockTimer !== null) window.clearInterval(clockTimer)
  clockTimer = null
}
const syncClockTimer = (identity: ApprovalIdentity = captureIdentity()): void => {
  stopClockTimer()
  const current = proposal.value
  if (!current || networkBlocked.value || !isBaseIdentityCurrent(identity) || current.approval.decidedAt || (statusKey.value !== 'pending' && statusKey.value !== 'running')) return
  clockTimer = window.setInterval(() => {
    if (!isBaseIdentityCurrent(identity) || networkBlocked.value) {
      stopClockTimer()
      return
    }
    clockTick.value++
  }, 30_000)
}
const clearExpiryDeadline = (): void => {
  if (expiryDeadlineTimer !== null) window.clearTimeout(expiryDeadlineTimer)
  expiryDeadlineTimer = null
}
const syncExpiryDeadline = (identity: ApprovalIdentity = captureIdentity()): void => {
  clearExpiryDeadline()
  const current = proposal.value
  if (!current || networkBlocked.value || acceptedDecisionForProposal.value || !isBaseIdentityCurrent(identity) || current.approval.status !== 'pending' || current.status !== 'pending') return
  if (hasExpired(current.expiresAt)) {
    clockTick.value++
    syncClockTimer(identity)
    return
  }
  const remaining = Math.min(new Date(current.expiresAt).valueOf() - Date.now(), 2_147_483_647)
  expiryDeadlineTimer = window.setTimeout(() => {
    expiryDeadlineTimer = null
    if (!isBaseIdentityCurrent(identity)) return
    clockTick.value++
    syncClockTimer(identity)
    if (!hasExpired(current.expiresAt)) syncExpiryDeadline(identity)
  }, remaining)
}
const componentElement = (component: ComponentRoot | HTMLElement | null): HTMLElement | null => {
  if (component instanceof HTMLElement) return component
  return component?.$el instanceof HTMLElement ? component.$el : null
}
const focusError = async (identity: ApprovalIdentity): Promise<void> => {
  await nextTick()
  if (!isTransportIdentityCurrent(identity)) return
  componentElement(errorAlert.value)?.focus()
}
const rejectedRefresh = (error?: unknown, current = false): AgentRefreshResult => ({
  accepted: false,
  current,
  ...(error === undefined ? {} : { error })
})
const invalidateDecisionReadiness = (): void => {
  proposalReadAccepted.value = false
  acceptedReadStateKey.value = ''
  acceptedReadIdentity.value = null
  decisionNeedsReconciliation.value = true
}
const load = async (requestedIdentity?: ApprovalIdentity): Promise<AgentRefreshResult> => {
  const identity = requestedIdentity ?? captureIdentity()
  if (!isBaseIdentityCurrent(identity) || networkBlocked.value) {
    if (isBaseIdentityCurrent(identity)) {
      loadGeneration++
      loadController?.abort()
      loadController = null
      loading.value = false
      invalidateDecisionReadiness()
    }
    return rejectedRefresh(undefined, false)
  }
  loadController?.abort()
  const controller = new AbortController()
  loadController = controller
  const generation = ++loadGeneration
  const proposalId = identity.proposalId
  loading.value = true
  error.value = ''
  invalidateDecisionReadiness()
  if (!proposalId) {
    const invalid = new Error(t('common:agentMcpApproval.proposalUrlInvalid'))
    error.value = invalid.message
    await focusError(identity)
    if (!isTransportIdentityCurrent(identity) || generation !== loadGeneration || controller.signal.aborted) return rejectedRefresh(undefined, false)
    return rejectedRefresh(invalid, true)
  }
  try {
    const nextProposal = await getMcpAgentProposal(window.fetch.bind(window), identity.csrfToken, proposalId, controller.signal)
    if (!isTransportIdentityCurrent(identity) || generation !== loadGeneration || controller.signal.aborted) return rejectedRefresh(undefined, false)
    if (nextProposal.id !== proposalId) throw new Error(t('common:agentMcpApproval.proposalResponseDidNot'))
    proposal.value = nextProposal
    proposalReadAccepted.value = true
    acceptedReadStateKey.value = proposalReadStateKeyFor(nextProposal)
    acceptedReadIdentity.value = identity
    decisionNeedsReconciliation.value = false
    syncExpiryDeadline(identity)
    syncClockTimer(identity)
    return { accepted: true, current: true }
  } catch (value) {
    if (!isTransportIdentityCurrent(identity) || generation !== loadGeneration || controller.signal.aborted) return rejectedRefresh(undefined, false)
    proposalReadAccepted.value = false
    acceptedReadStateKey.value = ''
    acceptedReadIdentity.value = null
    decisionNeedsReconciliation.value = true
    error.value = value instanceof Error ? value.message : t('common:agentMcpApproval.proposalCouldNotLoaded')
    await focusError(identity)
    if (!isTransportIdentityCurrent(identity) || generation !== loadGeneration || controller.signal.aborted) return rejectedRefresh(undefined, false)
    return rejectedRefresh(value, true)
  } finally {
    if (isBaseIdentityCurrent(identity) && generation === loadGeneration) {
      loading.value = false
      if (loadController === controller) loadController = null
    }
  }
}

const decide = async (decision: 'approved' | 'denied'): Promise<void> => {
  const identity = captureIdentity()
  if (!decisionReady.value || !isTransportIdentityCurrent(identity)) {
    if (proposal.value && hasExpired(proposal.value.expiresAt)) {
      clockTick.value++
      clearExpiryDeadline()
      syncClockTimer(identity)
    }
    return
  }
  const current = proposal.value
  if (!current || current.id !== identity.proposalId) return
  if (decision === 'approved' && !reviewAdequate.value) return
  if (decision === 'approved' && current.risk === 'destructive-write' && confirmationPath.value !== current.confirmationPath) return
  pendingDecision.value = decision
  error.value = ''
  const generation = ++decisionGeneration
  const note = decisionNote.value.trim()
  const confirmedPath = confirmationPath.value
  try {
    await decideAgentProposal(window.fetch.bind(window), identity.csrfToken, current.id, current.approval.id, {
      decision,
      ...(note ? { decisionNote: note } : {}),
      ...(decision === 'approved' && current.confirmationPath ? { confirmationPath: confirmedPath } : {})
    })
    if (!isDecisionCurrent(identity, generation)) return
    acceptedDecision.value = {
      csrfToken: identity.csrfToken,
      proposalId: identity.proposalId,
      decision
    }
    proposalReadAccepted.value = false
    acceptedReadStateKey.value = ''
    acceptedReadIdentity.value = null
    decisionNeedsReconciliation.value = false
    const refreshResult = await load(identity)
    if (!isDecisionCurrent(identity, generation)) return
    if (!refreshResult.current) return
    if (!refreshResult.accepted) {
      decisionNeedsReconciliation.value = true
      proposalReadAccepted.value = false
      acceptedReadStateKey.value = ''
      acceptedReadIdentity.value = null
      error.value = t('common:agentMcpApproval.decisionSavedButProposal')
      await focusError(identity)
      return
    }
    await nextTick()
    if (!isDecisionCurrent(identity, generation)) return
    componentElement(settledReceipt.value)?.focus()
  } catch (value) {
    if (!isDecisionCurrent(identity, generation)) return
    acceptedDecision.value = null
    invalidateDecisionReadiness()
    const outcomeMessage = value instanceof Error ? value.message : t('common:agentMcpApproval.decisionOutcomeUnknown')
    const reconciliation = await load(identity)
    if (!isDecisionCurrent(identity, generation)) return
    if (reconciliation.current && reconciliation.accepted) return
    if (!reconciliation.current) return
    invalidateDecisionReadiness()
    const refreshMessage = reconciliation.error instanceof Error ? ` ${reconciliation.error.message}` : ''
    error.value = t('common:agentMcpApproval.refreshProposalBeforeTrying', { outcomeMessage, refreshMessage, interpolation: { escapeValue: false } })
    await focusError(identity)
  } finally {
    if (isDecisionCurrent(identity, generation)) pendingDecision.value = null
  }
}

const resetContext = (): void => {
  componentGeneration.value += 1
  loadGeneration += 1
  decisionGeneration += 1
  loadController?.abort()
  loadController = null
  pendingDecision.value = null
  acceptedDecision.value = null
  invalidateDecisionReadiness()
  stopClockTimer()
  clearExpiryDeadline()
  proposal.value = null
  expanded.value = false
  decisionNote.value = ''
  confirmationPath.value = ''
  loading.value = false
  error.value = ''
}

watch(
  () => [props.proposalId, props.csrfToken] as const,
  () => {
    resetContext()
    if (disposed || networkBlocked.value) return
    const identity = captureIdentity()
    void load(identity)
  },
  { immediate: true, flush: 'sync' }
)
watch(networkBlocked, blocked => {
  transportGeneration.value += 1
  loadGeneration += 1
  loadController?.abort()
  loadController = null
  if (blocked) {
    decisionGeneration += 1
    pendingDecision.value = null
    loading.value = false
    stopClockTimer()
    clearExpiryDeadline()
    invalidateDecisionReadiness()
    return
  }
  if (disposed) return
  const identity = captureIdentity()
  void load(identity)
}, { flush: 'sync' })
watch(proposalReadStateKey, () => {
  if (acceptedReadStateKey.value === proposalReadStateKey.value && acceptedReadIdentity.value) return
  proposalReadAccepted.value = false
  acceptedReadStateKey.value = ''
  acceptedReadIdentity.value = null
  if (proposal.value) decisionNeedsReconciliation.value = true
}, { flush: 'sync' })
watch(locallyExpired, expired => {
  if (!expired) return
  const focusedControl = decisionZone.value?.contains(document.activeElement) ? document.activeElement : null
  const identity = captureIdentity()
  if (focusedControl) void nextTick(() => {
    if (!isBaseIdentityCurrent(identity) || !locallyExpired.value) return
    if (document.activeElement !== focusedControl && document.activeElement !== document.body) return
    componentElement(settledReceipt.value)?.focus()
  })
  invalidateDecisionReadiness()
  stopClockTimer()
  clearExpiryDeadline()
}, { flush: 'sync' })
onBeforeUnmount(() => {
  disposed = true
  componentGeneration.value += 1
  transportGeneration.value += 1
  loadGeneration += 1
  decisionGeneration += 1
  loadController?.abort()
  loadController = null
  pendingDecision.value = null
  acceptedDecision.value = null
  invalidateDecisionReadiness()
  stopClockTimer()
  clearExpiryDeadline()
})
</script>

<style scoped>
.approval-surface {
  --approval-accent: rgb(var(--v-theme-warning));
  box-sizing: border-box;
  color: rgb(var(--v-theme-on-surface));
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  margin-inline: auto;
  max-width: 72rem;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: clamp(var(--wiki-space-3), 2vw, var(--wiki-space-5));
  width: 100%;
}
.approval-surface--running,
.operation-review--running { --approval-accent: rgb(var(--v-theme-primary)); }
.approval-surface--success,
.operation-review--success { --approval-accent: rgb(var(--v-theme-success)); }
.approval-surface--failed,
.approval-surface--denied,
.operation-review--failed,
.operation-review--denied { --approval-accent: rgb(var(--v-theme-error)); }
.approval-surface--cancelled,
.operation-review--cancelled { --approval-accent: var(--wiki-text-muted); }
.approval-surface--expired,
.operation-review--expired { --approval-accent: rgb(var(--v-theme-warning)); }
.approval-masthead { align-items: start; display: grid; gap: var(--wiki-space-3); grid-template-columns: auto minmax(0, 1fr) auto; margin-bottom: var(--wiki-space-4); }
.approval-masthead > div { min-width: 0; }
.approval-masthead__mark,
.operation-review__state-mark,
.approval-loading__mark { align-items: center; color: var(--wiki-text-muted); display: inline-flex; flex: 0 0 auto; height: 2.75rem; justify-content: center; width: 2.75rem; }
.approval-masthead__eyebrow,
.operation-review__eyebrow { color: var(--wiki-text-muted); font-size: .8125rem; font-weight: 600; margin: 0 0 var(--wiki-space-1); }
.approval-masthead h1 { font-family: var(--wiki-font-heading); font-size: clamp(1.125rem, 2vw, 1.5rem); font-weight: 650; line-height: 1.35; margin: 0; overflow-wrap: anywhere; }
.approval-masthead h1 + p { color: var(--wiki-text-muted); font-size: .875rem; line-height: 1.5; margin: var(--wiki-space-2) 0 0; max-width: 48rem; }
.approval-loading-bar { margin-bottom: var(--wiki-space-3); }
.approval-loading,
.approval-error,
.approval-connection-warning { margin-bottom: var(--wiki-space-4); }
.approval-loading { align-items: center; background: var(--wiki-surface-raised); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); display: flex; gap: var(--wiki-space-3); padding: var(--wiki-space-4); }
.approval-loading > span:last-child { display: grid; gap: var(--wiki-space-1); min-width: 0; overflow-wrap: anywhere; }
.approval-loading small { color: var(--wiki-text-muted); font-size: .8125rem; }
.approval-error__content { align-items: center; display: flex; gap: var(--wiki-space-3); justify-content: space-between; }
.approval-error__content > span { min-width: 0; overflow-wrap: anywhere; }
.operation-review { background: var(--wiki-surface-raised) !important; border-color: var(--wiki-surface-border) !important; border-inline-start: 3px solid var(--approval-accent) !important; border-radius: var(--wiki-panel-radius) !important; box-shadow: none; color: rgb(var(--v-theme-on-surface)) !important; flex: 0 0 auto; min-width: 0; overflow: hidden; }
.operation-review__header { align-items: center; background: var(--wiki-surface-sunken); border-bottom: 1px solid var(--wiki-surface-border); display: grid; gap: var(--wiki-space-3); grid-template-columns: auto minmax(0, 1fr) auto; padding: var(--wiki-space-3) var(--wiki-space-4); }
.operation-review__header > div { min-width: 0; }
.operation-review__header h2 { font-size: 1rem; font-weight: 650; line-height: 1.4; margin: 0; overflow-wrap: anywhere; }
.operation-review__header code { color: var(--wiki-text-muted); display: block; font-family: var(--wiki-font-mono); font-size: .8125rem; overflow-wrap: anywhere; }
.operation-review__elapsed { color: var(--wiki-text-muted); font-size: .8125rem; font-variant-numeric: tabular-nums; }
.operation-review__body { align-items: start; display: grid; gap: var(--wiki-space-5); grid-template-columns: minmax(0, 1.25fr) minmax(18rem, .8fr); padding: var(--wiki-space-4) !important; }
.operation-review__inspection,
.operation-review__authorization { min-width: 0; }
.operation-review__authorization { border-inline-start: 1px solid var(--wiki-surface-border); padding-inline-start: var(--wiki-space-5); }
.risk-brief { align-items: flex-start; background: var(--wiki-surface-sunken); border: 1px solid var(--wiki-surface-border); border-inline-start: 3px solid rgb(var(--v-theme-warning)); border-radius: var(--wiki-control-radius); display: flex; gap: var(--wiki-space-2); padding: var(--wiki-space-3); }
.risk-brief--destructive { border-inline-start-color: rgb(var(--v-theme-error)); }
.risk-brief > span { display: grid; gap: var(--wiki-space-1); min-width: 0; overflow-wrap: anywhere; }
.risk-brief strong { font-size: .875rem; font-weight: 650; }
.risk-brief small { color: var(--wiki-text-muted); font-size: .8125rem; line-height: 1.5; }
.operation-section + .operation-section { border-top: 1px solid var(--wiki-surface-border); margin-top: var(--wiki-space-4); padding-top: var(--wiki-space-4); }
.operation-section__heading { margin-bottom: var(--wiki-space-3); min-width: 0; }
.operation-section__heading h3,
.operation-section__heading p { margin: 0; overflow-wrap: anywhere; }
.operation-section__heading h3 { font-size: .9375rem; font-weight: 650; line-height: 1.4; }
.operation-section__heading p { color: var(--wiki-text-muted); font-size: .8125rem; line-height: 1.5; margin-top: var(--wiki-space-1); }
.proposal-facts { display: grid; font-size: .875rem; gap: var(--wiki-space-2) var(--wiki-space-3); grid-template-columns: minmax(6rem, auto) minmax(0, 1fr); margin: 0; }
.proposal-facts dt { color: var(--wiki-text-muted); font-size: .8125rem; font-weight: 550; }
.proposal-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.proposal-facts code,
.decision-zone__confirmation code { background: var(--wiki-surface-sunken); font-family: var(--wiki-font-mono); font-size: .875em; overflow-wrap: anywhere; padding-inline: var(--wiki-space-1); }
.proposal-facts code,
.decision-zone__confirmation code,
.decision-zone__confirmation :deep(input),
.proposal-diff { direction: ltr; text-align: start; unicode-bidi: plaintext; }
.proposal-verification { background: var(--wiki-surface-raised); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); margin-top: var(--wiki-space-3); overflow: hidden; }
.proposal-verification summary { align-items: center; cursor: pointer; display: flex; flex-wrap: wrap; gap: var(--wiki-space-2); list-style: none; min-height: 44px; padding: var(--wiki-space-2) var(--wiki-space-3); }
.proposal-verification summary::-webkit-details-marker { display: none; }
.proposal-verification summary > span { align-items: center; display: flex; flex: 1 1 9rem; font-size: .875rem; font-weight: 550; gap: var(--wiki-space-2); min-width: 0; overflow-wrap: anywhere; }
.proposal-verification summary small { color: var(--wiki-text-muted); font-size: .8125rem; margin-inline-start: auto; }
.proposal-verification summary::after { content: '›'; flex: 0 0 auto; font-size: 1.25rem; transform: rotate(90deg); }
.proposal-verification[open] summary::after { transform: rotate(270deg); }
.proposal-verification summary:focus-visible,
.proposal-diff:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: -2px; }
.proposal-facts--technical { background: var(--wiki-surface-sunken); border-top: 1px solid var(--wiki-surface-border); padding: var(--wiki-space-3); }
.proposal-output { background: var(--wiki-surface-sunken); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); min-width: 0; overflow: hidden; }
.proposal-output__legend { border-bottom: 1px solid var(--wiki-surface-border); color: var(--wiki-text-muted); display: flex; flex-wrap: wrap; font-size: .8125rem; gap: var(--wiki-space-2) var(--wiki-space-3); padding: var(--wiki-space-2) var(--wiki-space-3); }
.proposal-output__legend span:last-child { margin-inline-start: auto; }
.proposal-output__addition::before { content: '+ '; font-family: var(--wiki-font-mono); font-weight: 700; }
.proposal-output__deletion::before { content: '− '; font-family: var(--wiki-font-mono); font-weight: 700; }
.proposal-diff { font-family: var(--wiki-font-mono); font-size: .8125rem; line-height: 1.55; margin: 0; max-height: min(26rem, 45dvh); overflow: auto; overscroll-behavior: contain; padding: var(--wiki-space-3); scrollbar-gutter: stable; white-space: pre; }
.proposal-diff ins,
.proposal-diff del,
.proposal-diff span { display: inline; text-decoration: none; }
.proposal-diff ins { background: color-mix(in srgb, rgb(var(--v-theme-success)) 16%, var(--wiki-surface-sunken)); }
.proposal-diff del { background: color-mix(in srgb, rgb(var(--v-theme-error)) 14%, var(--wiki-surface-sunken)); text-decoration: line-through; }
.proposal-output__expand { margin: var(--wiki-space-2); max-width: calc(100% - var(--wiki-space-4)); }
.proposal-output__expand :deep(.v-btn__content) { white-space: normal; }
.proposal-output__empty { align-items: center; background: var(--wiki-surface-sunken); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); color: var(--wiki-text-muted); display: flex; gap: var(--wiki-space-3); padding: var(--wiki-space-3); }
.proposal-output__empty > span { display: grid; gap: var(--wiki-space-1); min-width: 0; overflow-wrap: anywhere; }
.decision-zone,
.decision-receipt { border-top: 1px solid var(--wiki-surface-border); margin-top: var(--wiki-space-4); padding-top: var(--wiki-space-4); }
.decision-zone__note { margin-top: var(--wiki-space-2); }
.decision-zone__confirmation { background: var(--wiki-surface-sunken); border: 1px solid var(--wiki-surface-border); border-inline-start: 3px solid rgb(var(--v-theme-error)); border-radius: var(--wiki-control-radius); display: grid; gap: var(--wiki-space-2); grid-template-columns: auto minmax(0, 1fr); margin-top: var(--wiki-space-3); padding: var(--wiki-space-3); }
.decision-zone__confirmation p { color: var(--wiki-text-muted); font-size: .875rem; line-height: 1.5; margin: var(--wiki-space-1) 0 var(--wiki-space-3); overflow-wrap: anywhere; }
.decision-zone__confirmation > div { min-width: 0; }
.decision-zone__confirmation :deep(.v-messages__message),
.decision-zone__note :deep(.v-messages__message) { overflow-wrap: anywhere; }
.approval-actions { border-top: 1px solid var(--wiki-surface-border); display: grid; gap: var(--wiki-space-3); margin-top: var(--wiki-space-4); padding-top: var(--wiki-space-3); }
.approval-actions__choice { display: grid; gap: var(--wiki-space-1); min-width: 0; }
.approval-actions__choice small { color: var(--wiki-text-muted); font-size: .8125rem; line-height: 1.45; }
.approval-actions :deep(.v-btn) { height: auto; min-height: 44px; padding-block: var(--wiki-space-2); }
.approval-actions :deep(.v-btn__content) { white-space: normal; }
@media (max-width: 900px) {
  .operation-review__body { grid-template-columns: minmax(0, 1fr); }
  .operation-review__authorization { border-inline-start: 0; border-top: 1px solid var(--wiki-surface-border); padding-inline-start: 0; padding-top: var(--wiki-space-4); }
}
@media (max-width: 599.98px) {
  .approval-masthead { grid-template-columns: auto minmax(0, 1fr); }
  .approval-masthead :deep(.v-chip) { grid-column: 1 / -1; justify-self: start; }
  .operation-review__header { grid-template-columns: auto minmax(0, 1fr); padding: var(--wiki-space-3); }
  .operation-review__elapsed { grid-column: 2; }
  .operation-review__body { gap: var(--wiki-space-4); padding: var(--wiki-space-3) !important; }
  .proposal-facts { gap: var(--wiki-space-1); grid-template-columns: minmax(0, 1fr); }
  .proposal-facts dd + dt { margin-top: var(--wiki-space-2); }
  .proposal-output__expand { height: auto; min-height: 44px; padding-block: var(--wiki-space-2); }
  .approval-error__content { align-items: stretch; flex-direction: column; }
}
@media (forced-colors: active) {
  .operation-review,
  .approval-loading,
  .risk-brief,
  .proposal-verification,
  .proposal-output,
  .proposal-output__empty,
  .decision-zone__confirmation { border-color: CanvasText !important; }
  .proposal-diff ins { border-inline-start: 3px solid CanvasText; }
  .proposal-diff del { border-inline-start: 3px double CanvasText; }
  .proposal-verification summary:focus-visible,
  .proposal-diff:focus-visible { outline-color: Highlight; }
}
</style>
