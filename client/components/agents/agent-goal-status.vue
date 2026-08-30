<template>
  <section
    class="agent-goal"
    :class="`agent-goal--${goal.status}`"
    :aria-labelledby="goalTitleId"
    :aria-describedby="goalSummaryId"
    :aria-busy="busy"
  >
    <div class="agent-goal__rail" aria-hidden="true">
      <div class="agent-goal__mark">
        <v-icon :icon="statusIcon" size="21" />
      </div>
      <span />
    </div>

    <div class="agent-goal__body">
      <header class="agent-goal__header">
        <div class="agent-goal__heading">
          <p class="agent-goal__eyebrow">Durable goal</p>
          <h2 :id="goalTitleId" class="agent-goal__title">{{ goal.objective }}</h2>
        </div>
        <v-chip :color="statusColor" :prepend-icon="statusIcon" size="small" variant="tonal">{{ statusLabel }}</v-chip>
      </header>

      <div class="agent-goal__continuity" aria-label="Goal continuity">
        <span><v-icon icon="mdi-source-branch" size="15" /> Run {{ goal.continuationCount + 1 }} of {{ goal.maxContinuations + 1 }}</span>
        <span><v-icon icon="mdi-calendar-clock-outline" size="15" /> {{ timelinePrefix }} <time :datetime="timelineAt">{{ timelineLabel }}</time></span>
      </div>

      <div class="agent-goal__progress">
        <div class="agent-goal__progress-heading">
          <span>Resource use</span>
          <strong>{{ Math.round(budgetPercent) }}% peak</strong>
        </div>
        <div
          class="agent-goal__meter"
          :class="{ 'agent-goal__meter--warning': budgetPercent >= 80 }"
          role="progressbar"
          :aria-valuenow="Math.round(budgetPercent)"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuetext="budgetAriaLabel"
          aria-label="Peak goal resource use"
        >
          <span :style="{ width: `${budgetPercent}%` }" />
        </div>
      </div>

      <dl class="agent-goal__budgets" aria-label="Goal resource budgets">
        <div v-for="metric in budgetMetrics" :key="metric.label" class="agent-goal__budget">
          <dt>{{ metric.label }}</dt>
          <dd>
            <span>{{ metric.value }}</span>
            <small>of {{ metric.limit }}</small>
          </dd>
          <span class="agent-goal__budget-track" aria-hidden="true">
            <span :style="{ width: `${metric.percent}%` }" />
          </span>
        </div>
      </dl>

      <p :id="goalSummaryId" class="agent-goal__summary" aria-live="polite">{{ progressLabel }}</p>

      <aside
        v-if="blockerMessages.length"
        class="agent-goal__blockers"
        :class="{ 'agent-goal__blockers--error': goal.status === 'failed' }"
        :aria-labelledby="goalBlockersTitleId"
      >
        <div class="agent-goal__blockers-heading">
          <v-icon :icon="goal.status === 'failed' ? 'mdi-alert-octagon-outline' : 'mdi-alert-circle-outline'" size="19" />
          <h3 :id="goalBlockersTitleId">{{ goal.status === 'failed' ? 'Why this goal stopped' : 'Needs attention' }}</h3>
        </div>
        <ul>
          <li v-for="(issue, index) in blockerMessages" :key="`${issue.code}-${index}`">
            <span>{{ issue.message }}</span>
            <span class="agent-goal__issue-state">{{ issue.retryable ? 'Can continue after review' : 'Not automatically retryable' }}</span>
          </li>
        </ul>
      </aside>

      <p v-if="busy" class="agent-goal__pending" role="status" aria-live="polite">
        <v-progress-circular color="primary" indeterminate size="15" width="2" />
        {{ pendingActionLabel }}
      </p>

      <div v-if="canPause || canResume || canCancel" class="agent-goal__actions" aria-label="Goal actions">
        <v-btn
          v-if="canPause"
          size="small"
          variant="tonal"
          prepend-icon="mdi-pause"
          :loading="pendingAction === 'pause' && busy"
          :disabled="busy"
          @click="runAction('pause')"
        >Pause</v-btn>
        <v-btn
          v-if="canResume"
          size="small"
          color="primary"
          variant="tonal"
          prepend-icon="mdi-play"
          :loading="pendingAction === 'resume' && busy"
          :disabled="busy"
          @click="runAction('resume')"
        >Resume goal</v-btn>
        <v-btn
          v-if="canCancel"
          size="small"
          color="error"
          variant="text"
          prepend-icon="mdi-close"
          :disabled="busy"
          :loading="pendingAction === 'cancel' && busy"
          @click="cancelDialogOpen = true"
        >Cancel goal</v-btn>
      </div>

      <v-dialog v-model="cancelDialogOpen" max-width="30rem" :aria-labelledby="cancelGoalTitleId">
        <v-card rounded="xl">
          <v-card-title class="agent-goal__dialog-title">
            <v-avatar color="error" size="38" variant="tonal"><v-icon icon="mdi-stop-circle-outline" /></v-avatar>
            <span :id="cancelGoalTitleId">Cancel durable goal?</span>
          </v-card-title>
          <v-card-text>
            This will stop <strong>{{ goal.objective }}</strong> and prevent every future continuation. Completed work remains in this conversation, but the goal cannot be resumed.
          </v-card-text>
          <v-card-actions class="agent-goal__dialog-actions">
            <v-spacer />
            <v-btn variant="text" :disabled="busy" @click="cancelDialogOpen = false">Keep goal</v-btn>
            <v-btn color="error" variant="tonal" :loading="pendingAction === 'cancel' && busy" :disabled="busy" @click="confirmCancel">Cancel goal</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentGoalView } from '../../../shared/agents/contracts.ts'

const props = defineProps<{ goal: AgentGoalView; busy: boolean; runActive: boolean }>()
const emit = defineEmits<{ pause: []; resume: []; cancel: [] }>()
const pendingAction = ref<'pause' | 'resume' | 'cancel' | null>(null)
const cancelDialogOpen = ref(false)
const goalTitleId = computed(() => `agent-goal-${props.goal.id}-title`)
const goalSummaryId = computed(() => `agent-goal-${props.goal.id}-summary`)
const goalBlockersTitleId = computed(() => `agent-goal-${props.goal.id}-blockers-title`)
const cancelGoalTitleId = computed(() => `agent-goal-${props.goal.id}-cancel-title`)
watch(() => props.busy, busy => { if (!busy) pendingAction.value = null })
watch(() => props.goal.status, status => {
  if (!['active', 'paused', 'blocked'].includes(status)) cancelDialogOpen.value = false
})
const runAction = (action: 'pause' | 'resume') => {
  if (props.busy) return
  pendingAction.value = action
  if (action === 'pause') emit('pause')
  else emit('resume')
}
const confirmCancel = () => {
  if (props.busy) return
  pendingAction.value = 'cancel'
  cancelDialogOpen.value = false
  emit('cancel')
}

const statusPresentation = {
  active: { label: 'In progress', icon: 'mdi-bullseye-arrow', color: 'primary' },
  paused: { label: 'Paused', icon: 'mdi-pause-circle-outline', color: 'warning' },
  blocked: { label: 'Needs attention', icon: 'mdi-alert-circle-outline', color: 'warning' },
  budget_limited: { label: 'Limit reached', icon: 'mdi-speedometer-slow', color: 'warning' },
  completed: { label: 'Completed', icon: 'mdi-check-decagram-outline', color: 'success' },
  cancelled: { label: 'Cancelled', icon: 'mdi-close-circle-outline', color: 'default' },
  failed: { label: 'Failed', icon: 'mdi-alert-octagon-outline', color: 'error' }
} as const

const presentation = computed(() => statusPresentation[props.goal.status])
const statusLabel = computed(() => presentation.value.label)
const statusIcon = computed(() => presentation.value.icon)
const statusColor = computed(() => presentation.value.color)
const canPause = computed(() => props.goal.status === 'active')
const canResume = computed(() => !props.runActive && (props.goal.status === 'paused' || props.goal.status === 'blocked'))
const canCancel = computed(() => props.goal.status === 'active' || props.goal.status === 'paused' || props.goal.status === 'blocked')
const tokenPercent = computed(() => props.goal.maxTokens > 0 ? (props.goal.consumedTokens / props.goal.maxTokens) * 100 : 0)
const toolPercent = computed(() => props.goal.maxToolCalls > 0 ? (props.goal.consumedToolCalls / props.goal.maxToolCalls) * 100 : 0)
const continuationPercent = computed(() => props.goal.maxContinuations > 0 ? (props.goal.continuationCount / props.goal.maxContinuations) * 100 : 0)
const budgetPercent = computed(() => Math.min(100, Math.max(0, Math.max(tokenPercent.value, toolPercent.value, continuationPercent.value))))
const formatBudgetValue = (value: number): string => value.toLocaleString()
const budgetMetrics = computed(() => [
  {
    label: 'Tokens',
    value: formatBudgetValue(props.goal.consumedTokens),
    limit: formatBudgetValue(props.goal.maxTokens),
    percent: Math.min(100, Math.max(0, tokenPercent.value))
  },
  {
    label: 'Tool calls',
    value: formatBudgetValue(props.goal.consumedToolCalls),
    limit: formatBudgetValue(props.goal.maxToolCalls),
    percent: Math.min(100, Math.max(0, toolPercent.value))
  },
  {
    label: 'Continuations',
    value: formatBudgetValue(props.goal.continuationCount),
    limit: formatBudgetValue(props.goal.maxContinuations),
    percent: Math.min(100, Math.max(0, continuationPercent.value))
  }
])
const blockerMessages = computed(() => {
  const issues = [...(props.goal.completion?.issues ?? [])]
  const errorMessage = props.goal.errorMessage
  if (errorMessage && !issues.some(issue => issue.message === errorMessage)) {
    issues.unshift({
      code: props.goal.errorCode ?? 'GOAL_ATTENTION',
      message: errorMessage,
      retryable: props.goal.status === 'blocked'
    })
  }
  if (props.goal.status === 'blocked' && issues.length === 0) {
    issues.push({
      code: 'GOAL_BLOCKED',
      message: 'The goal cannot continue until its blocking condition is reviewed.',
      retryable: true
    })
  }
  return issues
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
const timelineAt = computed(() => props.goal.completedAt ?? props.goal.deadlineAt)
const timelinePrefix = computed(() => props.goal.completedAt ? 'Finished' : 'Due')
const timelineLabel = computed(() => {
  const date = new Date(timelineAt.value)
  return (date.getFullYear() === currentYear ? timelineFormatter : datedTimelineFormatter).format(date)
})
const pendingActionLabel = computed(() => {
  if (pendingAction.value === 'pause') return 'Pausing goal…'
  if (pendingAction.value === 'resume') return 'Resuming goal…'
  if (pendingAction.value === 'cancel') return 'Cancelling goal…'
  return 'Updating goal…'
})
const budgetLabel = computed(() => {
  const budgets = [
    { label: 'token budget', percent: tokenPercent.value },
    { label: 'tool-call budget', percent: toolPercent.value },
    { label: 'continuation budget', percent: continuationPercent.value }
  ]
  return budgets.reduce((highest, budget) => budget.percent > highest.percent ? budget : highest).label
})
const budgetAriaLabel = computed(() => `${budgetLabel.value} is ${Math.round(budgetPercent.value)}% used`)
const progressLabel = computed(() => {
  if (props.goal.status === 'completed') return `Completed in ${props.goal.continuationCount + 1} run${props.goal.continuationCount === 0 ? '' : 's'}.`
  if (props.goal.status === 'budget_limited') return 'A host-owned time, token, tool, or continuation limit stopped further work.'
  if (props.goal.status === 'cancelled') return 'No further work will run for this goal.'
  if (props.goal.status === 'failed') return 'The goal stopped after a non-recoverable failure.'
  if (props.goal.status === 'paused') return 'Future continuations are paused. Resume when you are ready for the agent to continue.'
  if (props.goal.status === 'blocked') return 'Automatic work is paused until the blocking condition is resolved.'
  return 'The agent will continue across runs until the objective is complete, needs review, or reaches a host-owned limit.'
})
</script>

<style scoped>
.agent-goal {
  --goal-accent: rgb(var(--v-theme-primary));
  align-items: stretch;
  background: var(--wiki-surface-raised);
  border: 1px solid color-mix(in srgb, var(--goal-accent) 32%, var(--wiki-surface-border));
  border-radius: var(--wiki-panel-radius);
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
  display: grid;
  gap: var(--wiki-space-3);
  grid-template-columns: var(--wiki-control-height) minmax(0, 1fr);
  margin: 0 auto var(--wiki-space-4);
  max-width: 52rem;
  overflow: hidden;
  padding: var(--wiki-space-4);
  position: relative;
  width: 100%;
}
.agent-goal--paused,
.agent-goal--blocked,
.agent-goal--budget_limited { --goal-accent: rgb(var(--v-theme-warning)); }
.agent-goal--completed { --goal-accent: rgb(var(--v-theme-success)); }
.agent-goal--failed { --goal-accent: rgb(var(--v-theme-error)); }
.agent-goal--cancelled { --goal-accent: rgba(var(--v-theme-on-surface), .58); }
.agent-goal__rail { align-items: center; display: flex; flex-direction: column; min-height: 100%; }
.agent-goal__rail > span {
  background: linear-gradient(to bottom, color-mix(in srgb, var(--goal-accent) 42%, transparent), transparent);
  flex: 1;
  margin-top: var(--wiki-space-2);
  min-height: var(--wiki-space-6);
  width: 1px;
}
.agent-goal__mark {
  align-items: center;
  background: color-mix(in srgb, var(--goal-accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--goal-accent) 26%, transparent);
  border-radius: var(--wiki-control-radius);
  color: var(--goal-accent);
  display: flex;
  height: var(--wiki-control-height);
  justify-content: center;
  width: var(--wiki-control-height);
}
.agent-goal__body { min-width: 0; }
.agent-goal__header {
  align-items: flex-start;
  display: flex;
  gap: var(--wiki-space-4);
  justify-content: space-between;
}
.agent-goal__heading { min-width: 0; }
.agent-goal__eyebrow {
  color: var(--goal-accent);
  font-size: var(--wiki-label-size);
  font-weight: 750;
  letter-spacing: .1em;
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
  color: rgba(var(--v-theme-on-surface), .62);
  display: flex;
  flex-wrap: wrap;
  font-size: .7rem;
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
  font-size: .68rem;
  justify-content: space-between;
  margin-bottom: var(--wiki-space-2);
}
.agent-goal__progress-heading span { color: rgba(var(--v-theme-on-surface), .62); font-weight: 650; }
.agent-goal__progress-heading strong { color: var(--goal-accent); font-variant-numeric: tabular-nums; }
.agent-goal__meter {
  background: rgba(var(--v-theme-on-surface), .1);
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
  color: rgba(var(--v-theme-on-surface), .68);
  font-size: .65rem;
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
  color: rgba(var(--v-theme-on-surface), .68);
  font-size: .62rem;
  overflow-wrap: anywhere;
}
.agent-goal__budget-track {
  background: rgba(var(--v-theme-on-surface), .08);
  border-radius: var(--wiki-radius-pill);
  display: block;
  height: 2px;
  overflow: hidden;
}
.agent-goal__budget-track > span { background: var(--goal-accent); display: block; height: 100%; }
.agent-goal__summary {
  color: rgba(var(--v-theme-on-surface), .72);
  font-size: .74rem;
  line-height: 1.5;
  margin: var(--wiki-space-3) 0 0;
}
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
.agent-goal__blockers-heading { align-items: center; color: var(--goal-accent); display: flex; gap: var(--wiki-space-2); }
.agent-goal__blockers-heading h3 { font-size: .76rem; font-weight: 750; margin: 0; }
.agent-goal__blockers ul { margin: var(--wiki-space-2) 0 0; padding-inline-start: var(--wiki-space-5); }
.agent-goal__blockers li { font-size: .74rem; line-height: 1.45; overflow-wrap: anywhere; padding-inline-start: var(--wiki-space-1); }
.agent-goal__blockers li + li { margin-top: var(--wiki-space-2); }
.agent-goal__issue-state { color: rgba(var(--v-theme-on-surface), .68); display: block; font-size: .65rem; margin-top: var(--wiki-space-1); }
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
  .agent-goal {
    border-radius: var(--wiki-control-radius);
    gap: var(--wiki-space-2);
    grid-template-columns: 2rem minmax(0, 1fr);
    padding: var(--wiki-space-3);
  }
  .agent-goal__mark { height: 2rem; width: 2rem; }
  .agent-goal__header { align-items: flex-start; flex-direction: column; gap: var(--wiki-space-2); }
  .agent-goal__budgets { grid-template-columns: 1fr; }
  .agent-goal__budget,
  .agent-goal__budget:first-child { border-inline-start: 0; padding-inline-start: 0; }
  .agent-goal__budget + .agent-goal__budget { border-top: 1px solid var(--wiki-surface-border); padding-top: var(--wiki-space-2); }
  .agent-goal__actions :deep(.v-btn) { min-height: var(--wiki-control-height); }
  .agent-goal__dialog-actions {
    align-items: stretch;
    flex-direction: column;
    padding-inline: var(--wiki-space-3);
  }
  .agent-goal__dialog-actions :deep(.v-spacer) { display: none; }
  .agent-goal__dialog-actions :deep(.v-btn) { min-height: var(--wiki-control-height); width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .agent-goal__meter > span { transition: none; }
}
@media (forced-colors: active) {
  .agent-goal,
  .agent-goal__progress,
  .agent-goal__blockers { border: 1px solid CanvasText; }
  .agent-goal__meter,
  .agent-goal__budget-track { border: 1px solid CanvasText; }
  .agent-goal__meter > span,
  .agent-goal__budget-track > span { background: Highlight; }
}
</style>
