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
      <span class="agent-goal__collapsed-meta">
        <span>{{ $t('common:agentGoalStatus.run', { continuationCount: formatBudgetValue(goal.continuationCount + 1), interpolation: { escapeValue: false } }) }}</span>
        <span aria-hidden="true">·</span>
        <span>{{ $t('common:agentGoalStatus.peak', { budgetPercent: formatBudgetValue(Math.round(budgetPercent)), interpolation: { escapeValue: false } }) }}</span>
      </span>
      <button
        :id="goalToggleId"
        class="agent-goal__toggle"
        type="button"
        :aria-expanded="expanded"
        :aria-controls="expanded ? goalDetailsId : undefined"
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
        </header>

        <div class="agent-goal__continuity" role="group" :aria-label="$t('common:agentGoalStatus.goalContinuity')">
          <span><v-icon icon="mdi-source-branch" size="15" /> {{ $t('common:agentGoalStatus.run2', { continuationCount: formatBudgetValue(goal.continuationCount + 1), maxContinuations: formatBudgetValue(goal.maxContinuations + 1), interpolation: { escapeValue: false } }) }}</span>
          <span><v-icon icon="mdi-calendar-clock-outline" size="15" /> {{ timelinePrefix }} <time :datetime="timelineAt">{{ timelineLabel }}</time></span>
        </div>
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

        <div class="agent-goal__progress">
          <div class="agent-goal__progress-heading">
            <span>{{ $t('common:agentGoalStatus.resourceUse') }}</span>
            <strong>{{ $t('common:agentGoalStatus.peak', { budgetPercent: formatBudgetValue(Math.round(budgetPercent)), interpolation: { escapeValue: false } }) }}</strong>
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
              <dd>{{ formatBudgetValue(goal.budgetCycle) }}</dd>
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
            @click="budgetDialogOpen = true"
          >{{ $t('common:agentGoalStatus.continueAnotherTokenCycle', { renewalAllowanceLabel, interpolation: { escapeValue: false } }) }}</v-btn>
        </section>


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
      <v-card class="agent-goal__dialog">
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

    <v-dialog content-class="agent-owned-overlay" v-model="budgetDialogOpen" max-width="32rem" :aria-labelledby="renewBudgetTitleId" :persistent="busy">
      <v-card class="agent-goal__dialog">
        <v-card-title :id="renewBudgetTitleId" class="agent-goal__dialog-title">
          {{ $t('common:agentGoalStatus.continueAnotherTokenCycle', { renewalAllowanceLabel, interpolation: { escapeValue: false } }) }}
        </v-card-title>
        <v-card-text>
          <p class="agent-goal__dialog-objective">{{ goal.objective }}</p>
          <dl class="agent-goal__renewal-facts">
            <div><dt>{{ $t('common:agentGoalStatus.currentCycleUsage') }}</dt><dd>{{ $t('common:agentGoalStatus.tokens', { currentCycleTokens: formatBudgetValue(currentCycleTokens), currentCycleTokenLimit: formatBudgetValue(currentCycleTokenLimit), interpolation: { escapeValue: false } }) }}</dd></div>
            <div><dt>{{ $t('common:agentGoalStatus.nextCycleAllowance') }}</dt><dd>{{ renewalAllowanceDescription }}</dd></div>
            <div><dt>{{ $t('common:agentGoalStatus.lifetimeUsage') }}</dt><dd>{{ $t('common:agentGoalStatus.tokens2', { consumedTokens: formatBudgetValue(goal.consumedTokens), interpolation: { escapeValue: false } }) }}</dd></div>
            <div><dt>{{ $t('common:agentGoalStatus.continuations') }}</dt><dd>{{ $t('common:agentGoalStatus.run2', { continuationCount: formatBudgetValue(goal.continuationCount + 1), maxContinuations: formatBudgetValue(goal.maxContinuations + 1), interpolation: { escapeValue: false } }) }}</dd></div>
          </dl>
          <p class="agent-goal__renewal-copy">{{ $t('common:agentGoalStatus.confirmOneContinuationAnother', { renewalAllowanceLabel, interpolation: { escapeValue: false } }) }}</p>
          <p v-if="networkBlocked" class="agent-goal__network-note" role="status">{{ $t('common:agentGoalStatus.connectionRequiredChangeGoal') }}</p>
        </v-card-text>
        <v-card-actions class="agent-goal__dialog-actions">
          <v-spacer />
          <v-btn variant="text" :disabled="busy" @click="budgetDialogOpen = false">{{ $t('common:actions.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :disabled="busy || networkBlocked || !canRenewTokenBudget" :loading="pendingAction === 'renew-budget' && busy" @click="renewBudget">{{ $t('common:agentGoalStatus.continueAnotherTokenCycle', { renewalAllowanceLabel, interpolation: { escapeValue: false } }) }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import i18next from 'i18next'
import type { AgentGoalView } from '../../../shared/agents/contracts.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const localeRevision = ref(0)
const refreshLocale = (): void => { localeRevision.value += 1 }
i18next.on('languageChanged', refreshLocale)
i18next.on('loaded', refreshLocale)
onUnmounted(() => {
  i18next.off('languageChanged', refreshLocale)
  i18next.off('loaded', refreshLocale)
})
const locale = computed(() => {
  void localeRevision.value
  return i18next.resolvedLanguage || i18next.language || undefined
})
const numberFormatter = computed(() => new Intl.NumberFormat(locale.value))

const { goal, busy, runActive, networkBlocked } = defineProps<{ goal: AgentGoalView; busy: boolean; runActive: boolean; networkBlocked?: boolean }>()
const expanded = defineModel<boolean>('expanded', { required: true })
const emit = defineEmits<{ pause: []; resume: []; cancel: []; 'renew-budget': [] }>()
const pendingAction = ref<'pause' | 'resume' | 'cancel' | 'renew-budget' | null>(null)
const cancelDialogOpen = ref(false)
const budgetDialogOpen = ref(false)
const goalTitleId = computed(() => `agent-goal-${goal.id}-title`)
const goalCollapsedObjectiveId = computed(() => `agent-goal-${goal.id}-collapsed-objective`)
const goalStatusId = computed(() => `agent-goal-${goal.id}-status`)
const goalToggleId = computed(() => `agent-goal-${goal.id}-toggle`)
const goalDetailsId = computed(() => `agent-goal-${goal.id}-details`)
const goalBlockersTitleId = computed(() => `agent-goal-${goal.id}-blockers-title`)
const cancelGoalTitleId = computed(() => `agent-goal-${goal.id}-cancel-title`)
const goalBudgetTitleId = computed(() => `agent-goal-${goal.id}-budget-title`)
const renewBudgetTitleId = computed(() => `agent-goal-${goal.id}-renew-title`)
const toggleAriaLabel = computed(() => {
  void localeRevision.value
  return t('common:agentGoalStatus.durableGoalDetails', { expanded: expanded.value ? t('common:agentGoalStatus.hide') : t('common:agentGoalStatus.show'), objective: goal.objective, interpolation: { escapeValue: false } })
})
const goalToggleTargetStyle = {
  minHeight: 'max(44px, var(--wiki-control-height, 44px))',
  minWidth: 'max(44px, var(--wiki-control-height, 44px))'
} as const
const toggleExpanded = (): void => { expanded.value = !expanded.value }
watch(() => busy, isBusy => { if (!isBusy) pendingAction.value = null })
watch(() => goal.id, () => {
  pendingAction.value = null
  cancelDialogOpen.value = false
  budgetDialogOpen.value = false
})
watch(() => goal.status, status => {
  if (!['active', 'paused', 'blocked'].includes(status)) cancelDialogOpen.value = false
  if (status !== 'budget_limited') budgetDialogOpen.value = false
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
  budgetDialogOpen.value = false
  emit('renew-budget')
}

const statusPresentation = computed(() => {
  void localeRevision.value
  return {
    active: { label: t('common:agentGoalStatus.progress'), icon: 'mdi-bullseye-arrow' },
    paused: { label: t('common:agentGoalStatus.paused'), icon: 'mdi-pause-circle-outline' },
    blocked: { label: t('common:agentGoalStatus.needsAttention'), icon: 'mdi-alert-circle-outline' },
    budget_limited: { label: t('common:agentGoalStatus.limitReached'), icon: 'mdi-speedometer-slow' },
    completed: { label: t('common:agentGoalStatus.completed'), icon: 'mdi-check-decagram-outline' },
    cancelled: { label: t('common:agentGoalStatus.cancelled'), icon: 'mdi-close-circle-outline' },
    failed: { label: t('common:agentGoalStatus.failed'), icon: 'mdi-alert-octagon-outline' }
  } as const
})

const presentation = computed(() => statusPresentation.value[goal.status])
const statusLabel = computed(() => presentation.value.label)
const statusIcon = computed(() => presentation.value.icon)
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
const formatBudgetValue = (value: number): string => numberFormatter.value.format(value)
const tokenTierLabel = computed(() => {
  void localeRevision.value
  return goal.tokenTier === 'small' ? t('common:agentGoalStatus.small') : goal.tokenTier === 'standard' ? t('common:agentGoalStatus.standard') : goal.tokenTier === 'extended' ? t('common:agentGoalStatus.extended') : t('common:agentGoalStatus.unavailable')
})
const renewalAllowanceLabel = computed(() => {
  void localeRevision.value
  return goal.tokenAllowance === null ? t('common:agentGoalStatus.unavailable') : formatBudgetValue(goal.tokenAllowance)
})
const renewalAllowanceDescription = computed(() => {
  void localeRevision.value
  return goal.tokenAllowance === null ? t('common:agentGoalStatus.unavailable') : t('common:agentGoalStatus.exactlyTokens', { value: renewalAllowanceLabel.value, interpolation: { escapeValue: false } })
})
const budgetLimitReasonLabel = computed(() => {
  void localeRevision.value
  if (goal.budgetLimitReason === 'tokens') return t('common:agentGoalStatus.tokenBudgetExhausted')
  if (goal.budgetLimitReason === 'tool_calls') return t('common:agentGoalStatus.toolCallLimitExhausted')
  if (goal.budgetLimitReason === 'duration') return t('common:agentGoalStatus.timeLimitExhausted')
  if (goal.budgetLimitReason === 'continuations') return t('common:agentGoalStatus.continuationLimitExhausted')
  if (goal.budgetLimitReason === 'quota') return t('common:agentGoalStatus.accountQuotaExhausted')
  if (goal.budgetLimitReason === 'accounting') return t('common:agentGoalStatus.usageAccountingRequiresReconciliation')
  if (goal.budgetLimitReason === 'authority') return t('common:agentGoalStatus.providerAuthorityChanged')
  return t('common:agentGoalStatus.noLimitingReasonRecorded')
})
const budgetMetrics = computed(() => {
  void localeRevision.value
  return [
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
  ]
})
const blockerMessages = computed(() => {
  void localeRevision.value
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
const timelineFormatters = computed(() => ({
  currentYear: new Intl.DateTimeFormat(locale.value, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }),
  dated: new Intl.DateTimeFormat(locale.value, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}))
const timelineAt = computed(() => goal.completedAt ?? goal.deadlineAt)
const timelinePrefix = computed(() => {
  void localeRevision.value
  return goal.completedAt ? t('common:agentGoalStatus.finished') : t('common:agentGoalStatus.due')
})
const timelineLabel = computed(() => {
  // Refresh the year on goal updates, even when the deadline itself is unchanged.
  void goal.version
  const date = new Date(goal.completedAt ?? goal.deadlineAt)
  const formats = timelineFormatters.value
  return (date.getFullYear() === new Date().getFullYear() ? formats.currentYear : formats.dated).format(date)
})
const pendingActionLabel = computed(() => {
  void localeRevision.value
  if (pendingAction.value === 'pause') return t('common:agentGoalStatus.pausingGoal')
  if (pendingAction.value === 'resume') return t('common:agentGoalStatus.resumingGoal')
  if (pendingAction.value === 'cancel') return t('common:agentGoalStatus.cancellingGoal')
  if (pendingAction.value === 'renew-budget') return t('common:agentGoalStatus.startingAnotherTokenAllowance')
  return t('common:agentGoalStatus.updatingGoal')
})
const budgetLabel = computed(() => {
  void localeRevision.value
  const budgets = [
    { label: t('common:agentGoalStatus.tokenBudget'), percent: tokenPercent.value },
    { label: t('common:agentGoalStatus.toolCallBudget'), percent: toolPercent.value },
    { label: t('common:agentGoalStatus.continuationBudget'), percent: continuationPercent.value }
  ]
  return budgets.reduce((highest, budget) => budget.percent > highest.percent ? budget : highest).label
})
const budgetAriaLabel = computed(() => {
  void localeRevision.value
  return t('common:agentGoalStatus.used', { value: budgetLabel.value, value2: formatBudgetValue(Math.round(budgetPercent.value)), interpolation: { escapeValue: false } })
})
const progressLabel = computed(() => {
  void localeRevision.value
  if (goal.status === 'completed') return t('common:agentGoalStatus.completedRun', { count: goal.continuationCount + 1, interpolation: { escapeValue: false } })
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
  --goal-transcript-available-block-size: max(0px, calc(100cqh - var(--wiki-space-3) - var(--wiki-space-6) - var(--wiki-space-3) - var(--wiki-space-2) - var(--wiki-space-3)));
  background: var(--wiki-surface-raised);
  border: 1px solid var(--wiki-surface-border);
  border-inline-start: 3px solid var(--goal-accent);
  border-radius: var(--wiki-panel-radius);
  box-sizing: border-box;
  color: rgb(var(--v-theme-on-surface));
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  width: 100%;
}
.agent-goal--active,
.agent-goal--completed { --goal-accent: rgb(var(--v-theme-success)); }
.agent-goal--paused,
.agent-goal--blocked,
.agent-goal--budget_limited { --goal-accent: rgb(var(--v-theme-warning)); }
.agent-goal--failed { --goal-accent: rgb(var(--v-theme-error)); }
.agent-goal--cancelled { --goal-accent: var(--wiki-text-muted); }
.agent-goal--expanded { max-block-size: var(--goal-transcript-available-block-size); }
.agent-goal__summary-row {
  align-items: center;
  display: grid;
  flex: 0 0 auto;
  gap: var(--wiki-space-2);
  grid-template-columns: auto auto minmax(0, 1fr) auto auto;
  min-height: 3.5rem;
  padding: var(--wiki-space-1) var(--wiki-space-3);
}
.agent-goal__mark { color: var(--wiki-text-muted); display: flex; }
.agent-goal__status-label { font-size: .8125rem; font-weight: 650; line-height: 1.4; }
.agent-goal__collapsed-objective { font-size: .875rem; font-weight: 550; line-height: 1.4; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-goal__collapsed-meta { color: var(--wiki-text-muted); display: inline-flex; font-size: .8125rem; font-variant-numeric: tabular-nums; gap: var(--wiki-space-1); white-space: nowrap; }
.agent-goal__toggle {
  align-items: center;
  appearance: none;
  background: transparent;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  color: var(--wiki-text-muted);
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  gap: var(--wiki-space-1);
  justify-content: center;
  padding: 0 var(--wiki-space-2);
}
.agent-goal__toggle:hover { background: var(--wiki-surface-sunken); color: rgb(var(--v-theme-on-surface)); }
.agent-goal__toggle:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: 2px; }
.agent-goal__toggle-label { font-size: .8125rem; font-weight: 550; }
.agent-goal__toggle-icon { transition: transform var(--wiki-motion-fast) var(--wiki-motion-ease); }
.agent-goal--expanded .agent-goal__toggle-icon { transform: rotate(180deg); }
.agent-goal__details {
  border-top: 1px solid var(--wiki-surface-border);
  flex: 0 1 auto;
  max-block-size: min(32rem, max(0px, calc(var(--goal-transcript-available-block-size) - 3.5rem)));
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--wiki-space-4);
  scrollbar-gutter: stable;
}
.agent-goal__body,
.agent-goal__heading { min-width: 0; }
.agent-goal__eyebrow { color: var(--wiki-text-muted); font-size: .8125rem; font-weight: 600; margin: 0 0 var(--wiki-space-1); }
.agent-goal__title { font-size: 1rem; font-weight: 650; line-height: 1.45; margin: 0; overflow-wrap: anywhere; }
.agent-goal__continuity { color: var(--wiki-text-muted); display: flex; flex-wrap: wrap; font-size: .8125rem; gap: var(--wiki-space-2) var(--wiki-space-4); margin-top: var(--wiki-space-2); }
.agent-goal__continuity span { align-items: center; display: inline-flex; gap: var(--wiki-space-1); }
.agent-goal__summary { font-size: .875rem; line-height: 1.5; margin: var(--wiki-space-3) 0 0; }
.agent-goal__progress { border-top: 1px solid var(--wiki-surface-border); margin-top: var(--wiki-space-4); padding-top: var(--wiki-space-3); }
.agent-goal__progress-heading { align-items: center; display: flex; flex-wrap: wrap; font-size: .875rem; gap: var(--wiki-space-2); justify-content: space-between; margin-bottom: var(--wiki-space-2); }
.agent-goal__progress-heading span { font-weight: 600; }
.agent-goal__progress-heading strong { font-size: .8125rem; font-variant-numeric: tabular-nums; }
.agent-goal__meter { background: var(--wiki-surface-sunken); border: 1px solid var(--wiki-surface-border); border-radius: 2px; height: .375rem; overflow: hidden; }
.agent-goal__meter > span { background: rgb(var(--v-theme-primary)); display: block; height: 100%; }
.agent-goal__meter--warning > span { background: rgb(var(--v-theme-warning)); }
.agent-goal__meter--critical > span { background: rgb(var(--v-theme-error)); }
.agent-goal__budgets { display: grid; gap: var(--wiki-space-3); grid-template-columns: repeat(3, minmax(0, 1fr)); margin: var(--wiki-space-3) 0 0; }
.agent-goal__budget { min-width: 0; }
.agent-goal__budget dt,
.agent-goal__renewal-facts dt { color: var(--wiki-text-muted); font-size: .8125rem; font-weight: 550; line-height: 1.4; }
.agent-goal__budget dd { align-items: baseline; display: flex; flex-wrap: wrap; gap: var(--wiki-space-1); margin: var(--wiki-space-1) 0; min-width: 0; }
.agent-goal__budget dd span { font-size: .9375rem; font-variant-numeric: tabular-nums; font-weight: 650; }
.agent-goal__budget dd small { color: var(--wiki-text-muted); font-size: .8125rem; overflow-wrap: anywhere; }
.agent-goal__budget-track { background: var(--wiki-surface-sunken); display: block !important; height: 3px; overflow: hidden; }
.agent-goal__budget-track > span { background: rgb(var(--v-theme-primary)); display: block; height: 100%; }
.agent-goal__renewal,
.agent-goal__blockers { background: var(--wiki-surface-sunken); border: 1px solid var(--wiki-surface-border); border-inline-start: 3px solid rgb(var(--v-theme-warning)); border-radius: var(--wiki-control-radius); margin-top: var(--wiki-space-3); padding: var(--wiki-space-3); }
.agent-goal__renewal--available { border-inline-start-color: rgb(var(--v-theme-primary)); }
.agent-goal__blockers--error { border-inline-start-color: rgb(var(--v-theme-error)); }
.agent-goal__renewal-heading,
.agent-goal__blockers-heading { align-items: center; display: flex; gap: var(--wiki-space-2); }
.agent-goal__renewal-heading h3,
.agent-goal__blockers-heading h3 { font-size: .875rem; font-weight: 650; margin: 0; }
.agent-goal__renewal-facts { display: grid; gap: var(--wiki-space-3); grid-template-columns: repeat(2, minmax(0, 1fr)); margin: var(--wiki-space-3) 0 0; }
.agent-goal__renewal-facts div { min-width: 0; }
.agent-goal__renewal-facts dd { font-size: .875rem; font-variant-numeric: tabular-nums; margin: var(--wiki-space-1) 0 0; overflow-wrap: anywhere; }
.agent-goal__renewal-copy { font-size: .875rem; line-height: 1.5; margin: var(--wiki-space-3) 0 0; }
.agent-goal__renewal-action { margin-top: var(--wiki-space-3); max-width: 100%; }
.agent-goal__renewal-action :deep(.v-btn__content) { white-space: normal; }
.agent-goal__blockers ul { margin: var(--wiki-space-2) 0 0; padding-inline-start: var(--wiki-space-5); }
.agent-goal__blockers li { font-size: .875rem; line-height: 1.5; overflow-wrap: anywhere; }
.agent-goal__blockers li + li { margin-top: var(--wiki-space-2); }
.agent-goal__issue-state { color: var(--wiki-text-muted); display: block; font-size: .8125rem; margin-top: var(--wiki-space-1); }
.agent-goal__network-note { color: var(--wiki-text-muted); font-size: .875rem; margin-top: var(--wiki-space-3); }
.agent-goal__pending { align-items: center; color: var(--wiki-primary-ink); display: flex; font-size: .875rem; gap: var(--wiki-space-2); margin: var(--wiki-space-3) 0 0; }
.agent-goal__actions { border-top: 1px solid var(--wiki-surface-border); display: flex; flex-wrap: wrap; gap: var(--wiki-space-2); margin-top: var(--wiki-space-4); padding-top: var(--wiki-space-3); }
.agent-goal__dialog { background: var(--wiki-surface-raised); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); }
.agent-goal__dialog-title { align-items: center; display: flex; font-size: 1.125rem; gap: var(--wiki-space-3); line-height: 1.4; overflow-wrap: anywhere; padding: var(--wiki-space-5) var(--wiki-space-5) var(--wiki-space-3); white-space: normal; }
.agent-goal__dialog-objective { font-weight: 600; margin: 0; overflow-wrap: anywhere; }
.agent-goal__dialog :deep(.v-card-text) { overflow-wrap: anywhere; }
.agent-goal__dialog-actions { flex-wrap: wrap; padding: 0 var(--wiki-space-5) var(--wiki-space-4); }
.agent-goal__dialog-actions :deep(.v-spacer) { min-width: 0; }
.agent-goal__dialog-actions :deep(.v-btn__content) { white-space: normal; }
@media (max-width: 600px) {
  .agent-goal__summary-row { grid-template-columns: auto minmax(0, 1fr) auto; gap: var(--wiki-space-1) var(--wiki-space-2); padding-inline: var(--wiki-space-2); }
  .agent-goal__mark { grid-column: 1; grid-row: 1; }
  .agent-goal__status-label { grid-column: 2; grid-row: 1; }
  .agent-goal__collapsed-objective { grid-column: 1 / 3; grid-row: 2; }
  .agent-goal__collapsed-meta { grid-column: 1 / 3; grid-row: 3; flex-wrap: wrap; white-space: normal; }
  .agent-goal__toggle { grid-column: 3; grid-row: 1 / 4; padding-inline: var(--wiki-space-1); }
  .agent-goal__toggle-label { max-width: 4.5rem; white-space: normal; }
  .agent-goal__details { padding: var(--wiki-space-3); }
  .agent-goal__budgets,
  .agent-goal__renewal-facts { grid-template-columns: 1fr; }
  .agent-goal__budget + .agent-goal__budget { border-top: 1px solid var(--wiki-surface-border); padding-top: var(--wiki-space-2); }
  .agent-goal__actions :deep(.v-btn),
  .agent-goal__renewal-action { min-height: 44px; height: auto; padding-block: var(--wiki-space-2); }
  .agent-goal__dialog-actions { align-items: stretch; flex-direction: column; padding-inline: var(--wiki-space-3); }
  .agent-goal__dialog-actions :deep(.v-spacer) { display: none; }
  .agent-goal__dialog-actions :deep(.v-btn) { min-height: 44px; height: auto; padding-block: var(--wiki-space-2); width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .agent-goal__toggle-icon { transition: none; }
}
@media (forced-colors: active) {
  .agent-goal,
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
