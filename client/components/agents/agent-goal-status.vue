<template>
  <section
    class="agent-goal"
    :class="[`agent-goal--${goal.status}`, { 'agent-goal--expanded': expanded }]"
    :aria-labelledby="`${goalStatusId} ${goalCollapsedObjectiveId}`"
    :aria-busy="busy"
  >
    <div class="agent-goal__summary-row">
      <span class="agent-goal__mark" aria-hidden="true">
        <v-icon :icon="statusIcon" size="18" />
      </span>
      <span
        :id="goalStatusId"
        class="agent-goal__status-label"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >{{ statusLabel }}</span>
      <span :id="goalCollapsedObjectiveId" class="agent-goal__collapsed-objective">{{ goal.objective }}</span>
      <span class="agent-goal__collapsed-meta" :aria-label="$t('common:agentGoalStatus.goalRunPeakResource')">
        <span>{{ $t('common:agentGoalStatus.run', { continuationCount: goal.continuationCount + 1, interpolation: { escapeValue: false } }) }}</span>
        <span aria-hidden="true">·</span>
        <span>{{ $t('common:agentGoalStatus.peak', { budgetPercent: Math.round(budgetPercent), interpolation: { escapeValue: false } }) }}</span>
      </span>
      <button
        :id="goalToggleId"
        class="agent-goal__toggle"
        type="button"
        :aria-expanded="expanded"
        :aria-controls="goalDetailsId"
        :aria-label="toggleAriaLabel"
        :style="goalToggleTargetStyle"
        @click="toggleExpanded"
      >
        <span class="agent-goal__toggle-label">{{ expanded ? $t('common:agentGoalStatus.hideDetails') : $t('common:agentGoalStatus.showDetails') }}</span>
        <v-icon class="agent-goal__toggle-icon" icon="mdi-chevron-down" size="18" aria-hidden="true" />
      </button>
    </div>

    <v-expand-transition>
      <div
        v-if="expanded"
        :id="goalDetailsId"
        class="agent-goal__details"
        role="region"
        :aria-labelledby="goalTitleId"
      >
        <div class="agent-goal__body">
        <header class="agent-goal__header">
          <div class="agent-goal__heading">
            <p class="agent-goal__eyebrow">{{ $t('common:agentGoalStatus.durableGoal') }}</p>
            <h2 :id="goalTitleId" class="agent-goal__title">{{ goal.objective }}</h2>
          </div>
          <v-chip class="agent-goal__status" :color="statusColor" :prepend-icon="statusIcon" size="small" variant="tonal">{{ statusLabel }}</v-chip>
        </header>

        <div class="agent-goal__continuity" role="group" :aria-label="$t('common:agentGoalStatus.goalContinuity')">
          <span><v-icon icon="mdi-source-branch" size="15" /> {{ $t('common:agentGoalStatus.run2', { continuationCount: goal.continuationCount + 1, maxContinuations: goal.maxContinuations + 1, interpolation: { escapeValue: false } }) }}</span>
          <span><v-icon icon="mdi-calendar-clock-outline" size="15" /> {{ timelinePrefix }} <time :datetime="timelineAt">{{ timelineLabel }}</time></span>
        </div>

        <div class="agent-goal__progress">
          <div class="agent-goal__progress-heading">
            <span>{{ $t('common:agentGoalStatus.resourceUse') }}</span>
            <strong>{{ $t('common:agentGoalStatus.peak', { budgetPercent: Math.round(budgetPercent), interpolation: { escapeValue: false } }) }}</strong>
          </div>
          <div
            class="agent-goal__meter"
            :class="{
              'agent-goal__meter--warning': budgetPercent >= 80 && budgetPercent < 95,
              'agent-goal__meter--critical': budgetPercent >= 95
            }"
            role="progressbar"
            :aria-valuenow="Math.round(budgetPercent)"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuetext="budgetAriaLabel"
            :aria-label="$t('common:agentGoalStatus.peakGoalResourceUse')"
          >
            <span :style="{ width: `${budgetPercent}%` }" />
          </div>
        </div>

        <dl class="agent-goal__budgets" :aria-label="$t('common:agentGoalStatus.goalResourceBudgets')">
          <div v-for="metric in budgetMetrics" :key="metric.label" class="agent-goal__budget">
            <dt>{{ metric.label }}</dt>
            <dd>
              <span>{{ metric.value }}</span>
              <small>{{ $t('common:agentGoalStatus.of', { limit: metric.limit, interpolation: { escapeValue: false } }) }}</small>
            </dd>
            <dd class="agent-goal__budget-track" aria-hidden="true">
              <span :style="{ width: `${metric.percent}%` }" />
            </dd>
          </div>
        </dl>

        <section
          v-if="goal.status === 'budget_limited'"
          class="agent-goal__renewal"
          :class="{ 'agent-goal__renewal--available': canRenewTokenBudget }"
          :aria-labelledby="goalBudgetTitleId"
        >
          <div class="agent-goal__renewal-heading">
            <v-icon icon="mdi-information-outline" size="19" aria-hidden="true" />
            <h3 :id="goalBudgetTitleId">{{ $t('common:agentGoalStatus.budgetLimitDetails') }}</h3>
          </div>
          <dl class="agent-goal__renewal-facts">
            <div>
              <dt>{{ $t('common:agentGoalStatus.tokenTier') }}</dt>
              <dd>{{ tokenTierLabel }}</dd>
            </div>
            <div>
              <dt>{{ goal.budgetPolicyVersion === 2 ? $t('common:agentGoalStatus.currentCycleUsage') : $t('common:agentGoalStatus.lifetimeTokenBudget') }}</dt>
              <dd>{{ $t('common:agentGoalStatus.tokens', { currentCycleTokens: formatBudgetValue(currentCycleTokens), currentCycleTokenLimit: formatBudgetValue(currentCycleTokenLimit), interpolation: { escapeValue: false } }) }}</dd>
            </div>
            <div>
              <dt>{{ $t('common:agentGoalStatus.lifetimeUsage') }}</dt>
              <dd>{{ $t('common:agentGoalStatus.tokens2', { consumedTokens: formatBudgetValue(goal.consumedTokens), interpolation: { escapeValue: false } }) }}</dd>
            </div>
            <div>
              <dt>{{ $t('common:agentGoalStatus.budgetCycle') }}</dt>
              <dd>{{ goal.budgetCycle }}</dd>
            </div>
            <div>
              <dt>{{ $t('common:agentGoalStatus.limitingReason') }}</dt>
              <dd>{{ budgetLimitReasonLabel }}</dd>
            </div>
            <div>
              <dt>{{ $t('common:agentGoalStatus.nextCycleAllowance') }}</dt>
              <dd>{{ renewalAllowanceDescription }}</dd>
            </div>
          </dl>
          <p v-if="canRenewTokenBudget" class="agent-goal__renewal-copy" role="status">
            {{ $t('common:agentGoalStatus.confirmOneContinuationAnother', { renewalAllowanceLabel, interpolation: { escapeValue: false } }) }}
          </p>
          <p v-else class="agent-goal__renewal-copy" role="status">
            {{ $t('common:agentGoalStatus.limitCannotRenewedGoal') }}
          </p>
          <v-btn
            v-if="canRenewTokenBudget"
            class="agent-goal__renewal-action"
            color="primary"
            variant="tonal"
            prepend-icon="mdi-lightning-bolt-outline"
            :loading="pendingAction === 'renew-budget' && busy"
            :disabled="busy || networkBlocked"
            @click="renewBudget"
          >{{ $t('common:agentGoalStatus.continueAnotherTokenCycle', { renewalAllowanceLabel, interpolation: { escapeValue: false } }) }}</v-btn>
        </section>

        <p class="agent-goal__summary">{{ progressLabel }}</p>

        <aside
          v-if="blockerMessages.length"
          class="agent-goal__blockers"
          :class="{ 'agent-goal__blockers--error': goal.status === 'failed' }"
          :aria-labelledby="goalBlockersTitleId"
        >
          <div class="agent-goal__blockers-heading">
            <v-icon :icon="goal.status === 'failed' ? 'mdi-alert-octagon-outline' : 'mdi-alert-circle-outline'" size="19" />
            <h3 :id="goalBlockersTitleId">{{ goal.status === 'failed' ? $t('common:agentGoalStatus.whyGoalStopped') : $t('common:agentGoalStatus.needsAttention') }}</h3>
          </div>
          <ul>
            <li v-for="{ issue, key } in blockerEntries" :key="key">
              <span>{{ issue.message }}</span>
              <span class="agent-goal__issue-state">{{ issue.retryable ? $t('common:agentGoalStatus.canContinueAfterReview') : $t('common:agentGoalStatus.notAutomaticallyRetryable') }}</span>
            </li>
          </ul>
        </aside>

        <p v-if="networkBlocked" class="agent-goal__network-note" role="status" aria-live="polite">
          {{ $t('common:agentGoalStatus.connectionRequiredChangeGoal') }}
        </p>
        <p v-if="busy" class="agent-goal__pending" role="status" aria-live="polite">
          <v-progress-circular color="primary" indeterminate size="15" width="2" aria-hidden="true" />
          {{ pendingActionLabel }}
        </p>

        <div v-if="canPause || canResume || canCancel" class="agent-goal__actions" role="group" :aria-label="$t('common:agentGoalStatus.goalActions')">
          <v-btn
            v-if="canPause"
            size="small"
            variant="tonal"
            prepend-icon="mdi-pause"
            :loading="pendingAction === 'pause' && busy"
            :disabled="busy || networkBlocked"
            @click="runAction('pause')"
          >{{ $t('common:agentGoalStatus.pause') }}</v-btn>
          <v-btn
            v-if="canResume"
            size="small"
            color="primary"
            variant="tonal"
            prepend-icon="mdi-play"
            :loading="pendingAction === 'resume' && busy"
            :disabled="busy || networkBlocked"
            @click="runAction('resume')"
          >{{ $t('common:agentGoalStatus.resumeGoal') }}</v-btn>
          <v-btn
            v-if="canCancel"
            size="small"
            color="error"
            variant="text"
            prepend-icon="mdi-close"
            :disabled="busy || networkBlocked"
            :loading="pendingAction === 'cancel' && busy"
            @click="cancelDialogOpen = true"
          >{{ $t('common:agentGoalStatus.cancelGoal') }}</v-btn>
        </div>
      </div>
      </div>
    </v-expand-transition>

    <v-dialog content-class="agent-owned-overlay" v-model="cancelDialogOpen" max-width="30rem" :aria-labelledby="cancelGoalTitleId">
      <v-card rounded="xl">
        <v-card-title class="agent-goal__dialog-title">
          <v-avatar color="error" size="38" variant="tonal"><v-icon icon="mdi-stop-circle-outline" /></v-avatar>
          <span :id="cancelGoalTitleId">{{ $t('common:agentGoalStatus.cancelDurableGoal') }}</span>
        </v-card-title>
        <v-card-text>
          {{ $t('common:agentGoalStatus.willStop') }} <strong>{{ goal.objective }}</strong> {{ $t('common:agentGoalStatus.preventEveryFutureContinuation') }}
        </v-card-text>
        <v-card-actions class="agent-goal__dialog-actions">
          <v-spacer />
          <v-btn variant="text" :disabled="busy" @click="cancelDialogOpen = false">{{ $t('common:agentGoalStatus.keepGoal') }}</v-btn>
          <v-btn color="error" variant="tonal" :loading="pendingAction === 'cancel' && busy" :disabled="busy || networkBlocked" @click="confirmCancel">{{ $t('common:agentGoalStatus.cancelGoal') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentGoalView } from '../../../shared/agents/contracts.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()

const { goal, busy, runActive, networkBlocked } = defineProps<{ goal: AgentGoalView; busy: boolean; runActive: boolean; networkBlocked?: boolean }>()
const expanded = defineModel<boolean>('expanded', { required: true })
const emit = defineEmits<{ pause: []; resume: []; cancel: []; 'renew-budget': [] }>()
const pendingAction = ref<'pause' | 'resume' | 'cancel' | 'renew-budget' | null>(null)
const cancelDialogOpen = ref(false)
const goalTitleId = computed(() => `agent-goal-${goal.id}-title`)
const goalCollapsedObjectiveId = computed(() => `agent-goal-${goal.id}-collapsed-objective`)
const goalStatusId = computed(() => `agent-goal-${goal.id}-status`)
const goalToggleId = computed(() => `agent-goal-${goal.id}-toggle`)
const goalDetailsId = computed(() => `agent-goal-${goal.id}-details`)
const goalBlockersTitleId = computed(() => `agent-goal-${goal.id}-blockers-title`)
const cancelGoalTitleId = computed(() => `agent-goal-${goal.id}-cancel-title`)
const goalBudgetTitleId = computed(() => `agent-goal-${goal.id}-budget-title`)
const toggleAriaLabel = computed(() => t('common:agentGoalStatus.durableGoalDetails', { expanded: expanded.value ? 'Hide' : 'Show', objective: goal.objective, interpolation: { escapeValue: false } }))
const goalToggleTargetStyle = {
  minHeight: 'max(44px, var(--wiki-control-height, 44px))',
  minWidth: 'max(44px, var(--wiki-control-height, 44px))'
} as const
const toggleExpanded = (): void => { expanded.value = !expanded.value }
watch(() => busy, isBusy => { if (!isBusy) pendingAction.value = null })
watch(() => goal.id, () => {
  pendingAction.value = null
  cancelDialogOpen.value = false
})
watch(() => goal.status, status => {
  if (!['active', 'paused', 'blocked'].includes(status)) cancelDialogOpen.value = false
})
const runAction = (action: 'pause' | 'resume') => {
  if (busy || networkBlocked) return
  pendingAction.value = action
  if (action === 'pause') emit('pause')
  else emit('resume')
}
const confirmCancel = () => {
  if (busy || networkBlocked) return
  pendingAction.value = 'cancel'
  cancelDialogOpen.value = false
  emit('cancel')
}
const renewBudget = (): void => {
  if (busy || networkBlocked || !canRenewTokenBudget.value || pendingAction.value !== null) return
  pendingAction.value = 'renew-budget'
  emit('renew-budget')
}

const statusPresentation = {
  active: { label: t('common:agentGoalStatus.progress'), icon: 'mdi-bullseye-arrow', color: 'success' },
  paused: { label: t('common:agentGoalStatus.paused'), icon: 'mdi-pause-circle-outline', color: 'warning' },
  blocked: { label: t('common:agentGoalStatus.needsAttention'), icon: 'mdi-alert-circle-outline', color: 'warning' },
  budget_limited: { label: t('common:agentGoalStatus.limitReached'), icon: 'mdi-speedometer-slow', color: 'warning' },
  completed: { label: t('common:agentGoalStatus.completed'), icon: 'mdi-check-decagram-outline', color: 'success' },
  cancelled: { label: t('common:agentGoalStatus.cancelled'), icon: 'mdi-close-circle-outline', color: 'default' },
  failed: { label: t('common:agentGoalStatus.failed'), icon: 'mdi-alert-octagon-outline', color: 'error' }
} as const

const presentation = computed(() => statusPresentation[goal.status])
const statusLabel = computed(() => presentation.value.label)
const statusIcon = computed(() => presentation.value.icon)
const statusColor = computed(() => presentation.value.color)
const canPause = computed(() => goal.status === 'active')
const canResume = computed(() => !runActive && (goal.status === 'paused' || goal.status === 'blocked'))
const canCancel = computed(() => goal.status === 'active' || goal.status === 'paused' || goal.status === 'blocked')
const canRenewTokenBudget = computed(
  () =>
    !runActive &&
    goal.status === 'budget_limited' &&
    goal.budgetLimitReason === 'tokens' &&
    goal.canRenewTokenBudget &&
    goal.tokenAllowance !== null
)
const cycleTokenBaseline = computed(() =>
  goal.budgetPolicyVersion !== 2 || goal.tokenAllowance === null || goal.budgetCycle < 1 ? 0 : Math.max(0, goal.maxTokens - goal.tokenAllowance)
)
const currentCycleTokens = computed(() => Math.max(0, goal.consumedTokens - cycleTokenBaseline.value))
const currentCycleTokenLimit = computed(() => goal.budgetPolicyVersion === 2 ? (goal.tokenAllowance ?? goal.maxTokens) : goal.maxTokens)
const tokenPercent = computed(() => currentCycleTokenLimit.value > 0 ? (currentCycleTokens.value / currentCycleTokenLimit.value) * 100 : 0)
const toolPercent = computed(() => goal.maxToolCalls > 0 ? (goal.consumedToolCalls / goal.maxToolCalls) * 100 : 0)
const continuationPercent = computed(() => goal.maxContinuations > 0 ? (goal.continuationCount / goal.maxContinuations) * 100 : 0)
const budgetPercent = computed(() => Math.min(100, Math.max(0, Math.max(tokenPercent.value, toolPercent.value, continuationPercent.value))))
const formatBudgetValue = (value: number): string => value.toLocaleString()
const tokenTierLabel = computed(() => goal.tokenTier === 'small' ? t('common:agentGoalStatus.small') : goal.tokenTier === 'standard' ? t('common:agentGoalStatus.standard') : goal.tokenTier === 'extended' ? t('common:agentGoalStatus.extended') : t('common:agentGoalStatus.unavailable'))
const renewalAllowanceLabel = computed(() => goal.tokenAllowance === null ? t('common:agentGoalStatus.unavailable') : formatBudgetValue(goal.tokenAllowance))
const renewalAllowanceDescription = computed(() => goal.tokenAllowance === null ? t('common:agentGoalStatus.unavailable') : t('common:agentGoalStatus.exactlyTokens', { value: renewalAllowanceLabel.value, interpolation: { escapeValue: false } }))
const budgetLimitReasonLabel = computed(() => {
  if (goal.budgetLimitReason === 'tokens') return t('common:agentGoalStatus.tokenBudgetExhausted')
  if (goal.budgetLimitReason === 'tool_calls') return t('common:agentGoalStatus.toolCallLimitExhausted')
  if (goal.budgetLimitReason === 'duration') return t('common:agentGoalStatus.timeLimitExhausted')
  if (goal.budgetLimitReason === 'continuations') return t('common:agentGoalStatus.continuationLimitExhausted')
  if (goal.budgetLimitReason === 'quota') return t('common:agentGoalStatus.accountQuotaExhausted')
  if (goal.budgetLimitReason === 'accounting') return t('common:agentGoalStatus.usageAccountingRequiresReconciliation')
  if (goal.budgetLimitReason === 'authority') return t('common:agentGoalStatus.providerAuthorityChanged')
  return t('common:agentGoalStatus.noLimitingReasonRecorded')
})
const budgetMetrics = computed(() => [
  {
    label: goal.budgetPolicyVersion === 2 ? t('common:agentGoalStatus.currentCycleTokens') : t('common:agentGoalStatus.lifetimeTokens'),
    value: formatBudgetValue(currentCycleTokens.value),
    limit: formatBudgetValue(currentCycleTokenLimit.value),
    percent: Math.min(100, Math.max(0, tokenPercent.value))
  },
  {
    label: t('common:agentGoalStatus.toolCalls'),
    value: formatBudgetValue(goal.consumedToolCalls),
    limit: formatBudgetValue(goal.maxToolCalls),
    percent: Math.min(100, Math.max(0, toolPercent.value))
  },
  {
    label: t('common:agentGoalStatus.continuations'),
    value: formatBudgetValue(goal.continuationCount),
    limit: formatBudgetValue(goal.maxContinuations),
    percent: Math.min(100, Math.max(0, continuationPercent.value))
  }
])
const blockerMessages = computed(() => {
  const issues = [...(goal.completion?.issues ?? [])]
  const errorMessage = goal.errorMessage
  if (errorMessage && !issues.some(issue => issue.message === errorMessage)) {
    issues.unshift({
      code: goal.errorCode ?? 'GOAL_ATTENTION',
      message: errorMessage,
      retryable: goal.status === 'blocked'
    })
  }
  if (goal.status === 'blocked' && issues.length === 0) {
    issues.push({
      code: 'GOAL_BLOCKED',
      message: t('common:agentGoalStatus.goalCannotContinueUntil'),
      retryable: true
    })
  }
  return issues
})
const blockerEntries = computed(() => {
  const occurrences = new Map<string, number>()
  return blockerMessages.value.map(issue => {
    const fingerprint = `${issue.code.length}:${issue.code}:${issue.message.length}:${issue.message}:${issue.retryable}`
    const occurrence = occurrences.get(fingerprint) ?? 0
    occurrences.set(fingerprint, occurrence + 1)
    return { issue, key: `${fingerprint}:${occurrence}` }
  })
})
const currentYear = new Date().getFullYear()
const timelineFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})
const datedTimelineFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})
const timelineAt = computed(() => goal.completedAt ?? goal.deadlineAt)
const timelinePrefix = computed(() => goal.completedAt ? t('common:agentGoalStatus.finished') : t('common:agentGoalStatus.due'))
const timelineLabel = computed(() => {
  const date = new Date(timelineAt.value)
  return (date.getFullYear() === currentYear ? timelineFormatter : datedTimelineFormatter).format(date)
})
const pendingActionLabel = computed(() => {
  if (pendingAction.value === 'pause') return t('common:agentGoalStatus.pausingGoal')
  if (pendingAction.value === 'resume') return t('common:agentGoalStatus.resumingGoal')
  if (pendingAction.value === 'cancel') return t('common:agentGoalStatus.cancellingGoal')
  if (pendingAction.value === 'renew-budget') return t('common:agentGoalStatus.startingAnotherTokenAllowance')
  return t('common:agentGoalStatus.updatingGoal')
})
const budgetLabel = computed(() => {
  const budgets = [
    { label: t('common:agentGoalStatus.tokenBudget'), percent: tokenPercent.value },
    { label: 'tool-call budget', percent: toolPercent.value },
    { label: t('common:agentGoalStatus.continuationBudget'), percent: continuationPercent.value }
  ]
  return budgets.reduce((highest, budget) => budget.percent > highest.percent ? budget : highest).label
})
const budgetAriaLabel = computed(() => t('common:agentGoalStatus.used', { value: budgetLabel.value, value2: Math.round(budgetPercent.value), interpolation: { escapeValue: false } }))
const progressLabel = computed(() => {
  if (goal.status === 'completed') return t('common:agentGoalStatus.completedRun', { continuationCount: goal.continuationCount + 1, continuationCount2: goal.continuationCount === 0 ? '' : 's', interpolation: { escapeValue: false } })
  if (goal.status === 'budget_limited') {
    return canRenewTokenBudget.value
      ? t('common:agentGoalStatus.tokenBudgetStoppedRun')
      : t('common:agentGoalStatus.stoppedFurtherWorkLimit', { value: budgetLimitReasonLabel.value, interpolation: { escapeValue: false } })
  }
  if (goal.status === 'cancelled') return t('common:agentGoalStatus.noFurtherWorkWill')
  if (goal.status === 'failed') return t('common:agentGoalStatus.goalStoppedAfterNon')
  if (goal.status === 'paused') return t('common:agentGoalStatus.futureContinuationsPausedResume')
  if (goal.status === 'blocked') return t('common:agentGoalStatus.automaticWorkPausedUntil')
  return t('common:agentGoalStatus.agentWillContinueAcross')
})
</script>

<style scoped>
.agent-goal {
  --goal-accent: rgb(var(--v-theme-success));
  --goal-ink: color-mix(in srgb, var(--goal-accent) 72%, rgb(var(--v-theme-on-surface)));
  --goal-transcript-available-block-size: max(
    0px,
    calc(
      100cqh
      - var(--wiki-space-3)
      - var(--wiki-space-6)
      - var(--wiki-space-3)
      - var(--wiki-space-2)
      - var(--wiki-space-3)
    )
  );
  background: color-mix(in srgb, var(--goal-accent) 8%, var(--wiki-surface-raised));
  border: 1px solid color-mix(in srgb, var(--goal-accent) 30%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  width: 100%;
  transition:
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    box-shadow var(--wiki-motion-fast) var(--wiki-motion-ease);
}
.agent-goal--active,
.agent-goal--completed { --goal-accent: rgb(var(--v-theme-success)); }
.agent-goal--paused,
.agent-goal--blocked,
.agent-goal--budget_limited { --goal-accent: rgb(var(--v-theme-warning)); }
.agent-goal--failed { --goal-accent: rgb(var(--v-theme-error)); }
.agent-goal--cancelled { --goal-accent: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent); }
.agent-goal--expanded { max-block-size: var(--goal-transcript-available-block-size); }
.agent-goal__summary-row {
  align-items: center;
  display: grid;
  flex: 0 0 auto;
  gap: var(--wiki-space-2);
  grid-template-columns: auto auto minmax(0, 1fr) auto auto;
  min-height: 2.5rem;
  padding: var(--wiki-space-1) var(--wiki-space-2);
}
.agent-goal__mark {
  align-items: center;
  background: color-mix(in srgb, var(--goal-accent) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--goal-accent) 36%, transparent);
  border-radius: var(--wiki-control-radius);
  color: var(--goal-ink);
  display: flex;
  height: 1.75rem;
  justify-content: center;
  width: 1.75rem;
}
.agent-goal__status-label {
  color: var(--goal-ink);
  font-size: .7rem;
  font-weight: 750;
  line-height: 1.2;
  white-space: nowrap;
}
.agent-goal__collapsed-objective {
  color: rgb(var(--v-theme-on-surface));
  font-size: .78rem;
  font-weight: 625;
  line-height: 1.35;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-goal__collapsed-meta {
  align-items: center;
  color: var(--wiki-text-muted);
  display: inline-flex;
  flex: 0 0 auto;
  font-size: var(--wiki-type-micro, .75rem);
  font-variant-numeric: tabular-nums;
  gap: var(--wiki-space-1);
  white-space: nowrap;
}
.agent-goal__toggle {
  align-items: center;
  appearance: none;
  background: transparent;
  border: 0;
  border-radius: var(--wiki-control-radius);
  color: var(--goal-ink);
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  gap: var(--wiki-space-1);
  justify-content: center;
  min-height: max(44px, var(--wiki-control-height, 44px));
  min-width: max(44px, var(--wiki-control-height, 44px));
  padding: 0 var(--wiki-space-2);
  white-space: nowrap;
  transition: background 0.2s ease, transform 0.2s ease;
}
.agent-goal__toggle:hover { background: color-mix(in srgb, var(--goal-accent) 12%, transparent); }
.agent-goal__toggle:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
.agent-goal__toggle-label { font-size: var(--wiki-type-micro, .75rem); font-weight: 675; }
.agent-goal__toggle-icon {
  transition: transform var(--wiki-motion-normal) var(--wiki-motion-ease-out);
}
.agent-goal--expanded .agent-goal__toggle-icon { transform: rotate(180deg); }
.agent-goal__details {
  border-top: 1px solid color-mix(in srgb, var(--goal-accent) 20%, var(--wiki-surface-border));
  flex: 0 1 auto;
  max-block-size: min(
    36rem,
    max(0px, calc(var(--goal-transcript-available-block-size) - 2.5rem))
  );
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  padding: var(--wiki-space-3);
  scrollbar-gutter: stable;
}
.agent-goal__body { min-width: 0; }
.agent-goal__header {
  align-items: flex-start;
  display: flex;
  gap: var(--wiki-space-4);
  justify-content: space-between;
}
.agent-goal__heading { min-width: 0; }
.agent-goal__status { flex: 0 0 auto; }
.agent-goal__eyebrow {
  color: var(--goal-ink);
  font-size: var(--wiki-label-size);
  font-weight: 750;
  letter-spacing: .12em;
  margin: 0 0 var(--wiki-space-1);
  text-transform: uppercase;
}
.agent-goal__title {
  color: rgb(var(--v-theme-on-surface));
  font-size: .95rem;
  font-weight: 675;
  line-height: 1.45;
  margin: 0;
  overflow-wrap: anywhere;
}
.agent-goal__continuity {
  align-items: center;
  color: var(--wiki-text-muted);
  display: flex;
  flex-wrap: wrap;
  font-size: var(--wiki-type-micro, .75rem);
  gap: var(--wiki-space-2) var(--wiki-space-4);
  margin-top: var(--wiki-space-2);
}
.agent-goal__continuity span { align-items: center; display: inline-flex; gap: var(--wiki-space-1); }
.agent-goal__progress {
  background: var(--wiki-surface-sunken);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  margin-top: var(--wiki-space-3);
  padding: var(--wiki-space-2) var(--wiki-space-3);
}
.agent-goal__progress-heading {
  align-items: center;
  display: flex;
  font-size: var(--wiki-type-micro, .75rem);
  justify-content: space-between;
  margin-bottom: var(--wiki-space-2);
}
.agent-goal__progress-heading span { color: var(--wiki-text-muted); font-weight: 650; }
.agent-goal__progress-heading strong { color: var(--goal-ink); font-variant-numeric: tabular-nums; }
.agent-goal__meter {
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 10%, transparent);
  border-radius: var(--wiki-radius-pill);
  height: var(--wiki-space-1);
  overflow: hidden;
}
.agent-goal__meter > span {
  background: var(--goal-accent);
  border-radius: inherit;
  display: block;
  height: 100%;
  transition: width var(--wiki-motion-normal) var(--wiki-motion-ease-out);
}
.agent-goal__meter--warning > span { background: rgb(var(--v-theme-warning)); }
.agent-goal__meter--critical > span { background: rgb(var(--v-theme-error)); }
.agent-goal__budgets {
  display: grid;
  gap: var(--wiki-space-2);
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: var(--wiki-space-2) 0 0;
}
.agent-goal__budget {
  border-inline-start: 1px solid var(--wiki-surface-border);
  min-width: 0;
  padding-inline-start: var(--wiki-space-2);
}
.agent-goal__budget:first-child { border-inline-start: 0; padding-inline-start: 0; }
.agent-goal__budget dt {
  color: var(--wiki-text-muted);
  font-size: var(--wiki-type-micro, .75rem);
  font-weight: 650;
}
.agent-goal__budget dd {
  align-items: baseline;
  display: flex;
  gap: var(--wiki-space-1);
  margin: var(--wiki-space-1) 0;
  min-width: 0;
}
.agent-goal__budget dd span { font-size: .78rem; font-variant-numeric: tabular-nums; font-weight: 700; }
.agent-goal__budget dd small {
  color: var(--wiki-text-muted);
  font-size: var(--wiki-type-micro, .75rem);
  overflow-wrap: anywhere;
}
.agent-goal__budget-track {
  margin: 0;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 8%, transparent);
  border-radius: var(--wiki-radius-pill);
  display: block;
  height: 2px;
  overflow: hidden;
}
.agent-goal__budget-track > span { background: var(--goal-accent); display: block; height: 100%; }
.agent-goal__summary {
  color: var(--wiki-text-muted);
  font-size: .74rem;
  line-height: 1.5;
  margin: var(--wiki-space-3) 0 0;
}
.agent-goal__renewal {
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 8%, var(--wiki-surface-raised));
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-warning)) 30%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  margin-top: var(--wiki-space-3);
  padding: var(--wiki-space-3);
}
.agent-goal__renewal--available {
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 8%, var(--wiki-surface-raised));
  border-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 30%, var(--wiki-surface-border));
}
.agent-goal__renewal-heading { align-items: center; color: var(--goal-ink); display: flex; gap: var(--wiki-space-2); }
.agent-goal__renewal-heading h3 { font-size: .76rem; font-weight: 750; margin: 0; }
.agent-goal__renewal-facts {
  display: grid;
  gap: var(--wiki-space-2);
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: var(--wiki-space-3) 0 0;
}
.agent-goal__renewal-facts div { min-width: 0; }
.agent-goal__renewal-facts dt {
  color: var(--wiki-text-muted);
  font-size: var(--wiki-type-micro, .75rem);
  font-weight: 650;
}
.agent-goal__renewal-facts dd {
  color: rgb(var(--v-theme-on-surface));
  font-size: .76rem;
  font-variant-numeric: tabular-nums;
  margin: var(--wiki-space-1) 0 0;
  overflow-wrap: anywhere;
}
.agent-goal__renewal-copy {
  color: var(--wiki-text-muted);
  font-size: .74rem;
  line-height: 1.5;
  margin: var(--wiki-space-3) 0 0;
}
.agent-goal__renewal-action { margin-top: var(--wiki-space-3); }
.agent-goal__blockers {
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 9%, transparent);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-warning)) 28%, transparent);
  border-radius: var(--wiki-control-radius);
  color: rgb(var(--v-theme-on-surface));
  margin-top: var(--wiki-space-3);
  padding: var(--wiki-space-3);
}
.agent-goal__blockers--error {
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 8%, transparent);
  border-color: color-mix(in srgb, rgb(var(--v-theme-error)) 28%, transparent);
}
.agent-goal__blockers-heading { align-items: center; color: var(--goal-ink); display: flex; gap: var(--wiki-space-2); }
.agent-goal__blockers-heading h3 { font-size: .76rem; font-weight: 750; margin: 0; }
.agent-goal__blockers ul { margin: var(--wiki-space-2) 0 0; padding-inline-start: var(--wiki-space-5); }
.agent-goal__blockers li { font-size: .74rem; line-height: 1.45; overflow-wrap: anywhere; padding-inline-start: var(--wiki-space-1); }
.agent-goal__blockers li + li { margin-top: var(--wiki-space-2); }
.agent-goal__issue-state { color: var(--wiki-text-muted); display: block; font-size: .65rem; margin-top: var(--wiki-space-1); }
.agent-goal__pending {
  align-items: center;
  color: rgb(var(--v-theme-primary));
  display: flex;
  font-size: .72rem;
  gap: var(--wiki-space-2);
  margin: var(--wiki-space-3) 0 0;
}
.agent-goal__actions { display: flex; flex-wrap: wrap; gap: var(--wiki-space-2); margin-top: var(--wiki-space-3); }
.agent-goal__dialog-title { align-items: center; display: flex; gap: var(--wiki-space-3); overflow-wrap: anywhere; padding: var(--wiki-space-5) var(--wiki-space-5) var(--wiki-space-3); }
.agent-goal__dialog-actions { flex-wrap: wrap; padding: 0 var(--wiki-space-5) var(--wiki-space-4); }
.agent-goal__dialog-actions :deep(.v-spacer) { min-width: 0; }


@media (max-width: 600px) {
  .agent-goal__summary-row {
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    padding: var(--wiki-space-1) var(--wiki-space-2);
  }
  .agent-goal__mark { grid-column: 1; grid-row: 1; }
  .agent-goal__status-label { grid-column: 2; grid-row: 1; }
  .agent-goal__collapsed-objective { grid-column: 3; grid-row: 1; }
  .agent-goal__collapsed-meta {
    grid-column: 2 / 4;
    grid-row: 2;
  }
  .agent-goal__toggle {
    grid-column: 4;
    grid-row: 1 / 3;
    padding: 0 var(--wiki-space-1);
  }
  .agent-goal__toggle-label {
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }
  .agent-goal__details { padding: var(--wiki-space-3); }
  .agent-goal__header { align-items: flex-start; flex-direction: column; gap: var(--wiki-space-2); }
  .agent-goal__budgets { grid-template-columns: 1fr; }
  .agent-goal__budget,
  .agent-goal__budget:first-child { border-inline-start: 0; padding-inline-start: 0; }
  .agent-goal__budget + .agent-goal__budget { border-top: 1px solid var(--wiki-surface-border); padding-top: var(--wiki-space-2); }
  .agent-goal__renewal-facts { grid-template-columns: 1fr; }
  .agent-goal__actions :deep(.v-btn) { min-height: var(--wiki-control-height); }
  .agent-goal__dialog-actions {
    align-items: stretch;
    flex-direction: column;
    padding-inline: var(--wiki-space-3);
  }
  .agent-goal__dialog-actions :deep(.v-spacer) { display: none; }
  .agent-goal__dialog-actions :deep(.v-btn) { min-height: var(--wiki-control-height); width: 100%; }
}
@media (max-height: 520px) {
  .agent-goal__details { padding-block: var(--wiki-space-2); }
}
@media (prefers-reduced-motion: reduce) {
  .agent-goal__meter > span,
  .agent-goal__toggle-icon { transition: none; }
}
@media (forced-colors: active) {
  .agent-goal,
  .agent-goal__mark,
  .agent-goal__progress,
  .agent-goal__blockers,
  .agent-goal__renewal,
  .agent-goal__details { border-color: CanvasText; }
  .agent-goal__toggle:focus-visible { outline-color: Highlight; }
  .agent-goal__meter,
  .agent-goal__budget-track { border: 1px solid CanvasText; }
  .agent-goal__meter > span,
  .agent-goal__budget-track > span { background: Highlight; }
}
</style>
