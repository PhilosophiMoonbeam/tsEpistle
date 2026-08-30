<template>
  <section class="agent-goal" :class="`agent-goal--${goal.status}`" aria-labelledby="agent-goal-title">
    <div class="agent-goal__mark" aria-hidden="true">
      <v-icon :icon="statusIcon" size="21" />
    </div>
    <div class="agent-goal__body">
      <header class="agent-goal__header">
        <div>
          <p class="agent-goal__eyebrow">Durable goal</p>
          <h2 id="agent-goal-title" class="agent-goal__title">{{ goal.objective }}</h2>
        </div>
        <v-chip :color="statusColor" size="small" variant="tonal">{{ statusLabel }}</v-chip>
      </header>
      <div
        class="agent-goal__meter"
        role="progressbar"
        :aria-valuenow="Math.round(budgetPercent)"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuetext="budgetAriaLabel"
      >
        <span :style="{ width: `${budgetPercent}%` }" />
      </div>
      <p class="agent-goal__summary" aria-live="polite">{{ progressLabel }}</p>
      <p v-if="goal.errorMessage" class="agent-goal__error" role="alert">{{ goal.errorMessage }}</p>
      <div v-if="canPause || canResume || canCancel" class="agent-goal__actions">
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
        >Resume</v-btn>
        <v-btn
          v-if="canCancel"
          size="small"
          variant="text"
          prepend-icon="mdi-close"
          :disabled="busy"
          :loading="pendingAction === 'cancel' && busy"
          @click="cancelDialogOpen = true"
        >Cancel goal</v-btn>
      </div>
      <v-dialog v-model="cancelDialogOpen" max-width="30rem" persistent>
        <v-card>
          <v-card-title>Cancel durable goal?</v-card-title>
          <v-card-text>
            This will stop <strong>{{ goal.objective }}</strong> and prevent any future continuations. This action cannot be undone.
          </v-card-text>
          <v-card-actions>
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
  if (props.goal.status === 'budget_limited') return 'Host-owned time, token, tool, or continuation limits stopped further work.'
  if (props.goal.status === 'cancelled') return 'No further work will run for this goal.'
  if (props.goal.status === 'failed') return 'The goal stopped after a non-recoverable failure.'
  return `Run ${props.goal.continuationCount + 1} of ${props.goal.maxContinuations + 1} · ${props.goal.consumedTokens.toLocaleString()} of ${props.goal.maxTokens.toLocaleString()} tokens · ${props.goal.consumedToolCalls} of ${props.goal.maxToolCalls} tool calls`
})
</script>

<style scoped>
.agent-goal {
  --goal-accent: rgb(var(--v-theme-primary));
  align-items: start;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--goal-accent) 12%, transparent), transparent 52%),
    rgb(var(--v-theme-surface));
  border: 1px solid color-mix(in srgb, var(--goal-accent) 34%, rgb(var(--v-theme-on-surface)) 14%);
  border-radius: 1rem;
  display: grid;
  gap: .875rem;
  grid-template-columns: 2.25rem minmax(0, 1fr);
  margin: 0 auto 1rem;
  max-width: 52rem;
  padding: 1rem;
  width: 100%;
}
.agent-goal--paused,
.agent-goal--blocked,
.agent-goal--budget_limited { --goal-accent: rgb(var(--v-theme-warning)); }
.agent-goal--completed { --goal-accent: rgb(var(--v-theme-success)); }
.agent-goal--failed { --goal-accent: rgb(var(--v-theme-error)); }
.agent-goal--cancelled { --goal-accent: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent); }
.agent-goal__mark {
  align-items: center;
  background: color-mix(in srgb, var(--goal-accent) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--goal-accent) 28%, transparent);
  border-radius: .75rem;
  color: var(--goal-accent);
  display: flex;
  height: 2.25rem;
  justify-content: center;
  width: 2.25rem;
}
.agent-goal__body { min-width: 0; }
.agent-goal__header {
  align-items: start;
  display: flex;
  gap: 1rem;
  justify-content: space-between;
}
.agent-goal__eyebrow {
  color: var(--goal-accent);
  font-size: .7rem;
  font-weight: 750;
  letter-spacing: .1em;
  margin: 0 0 .25rem;
  text-transform: uppercase;
}
.agent-goal__title {
  color: rgb(var(--v-theme-on-surface));
  font-size: .95rem;
  font-weight: 650;
  line-height: 1.45;
  margin: 0;
  overflow-wrap: anywhere;
}
.agent-goal__meter {
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 10%, transparent);
  border-radius: 999px;
  height: .25rem;
  margin-top: .875rem;
  overflow: hidden;
}
.agent-goal__meter span {
  background: var(--goal-accent);
  border-radius: inherit;
  display: block;
  height: 100%;
  transition: width .25s ease;
}
.agent-goal__summary {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  font-size: .76rem;
  line-height: 1.45;
  margin: .5rem 0 0;
}
.agent-goal__error {
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 10%, transparent);
  border-inline-start: 3px solid rgb(var(--v-theme-error));
  color: rgb(var(--v-theme-error));
  font-size: .8rem;
  line-height: 1.45;
  margin: .5rem 0 0;
  padding: .5rem .65rem;
}
.agent-goal__actions {
  display: flex;
  flex-wrap: wrap;
  gap: .375rem;
  margin-top: .75rem;
}
@media (max-width: 600px) {
  .agent-goal { grid-template-columns: 1.9rem minmax(0, 1fr); padding: .875rem; }
  .agent-goal__mark { height: 1.9rem; width: 1.9rem; }
  .agent-goal__header { align-items: flex-start; flex-direction: column; gap: .5rem; }
}
@media (prefers-reduced-motion: reduce) {
  .agent-goal__meter span { transition: none; }
}
</style>
