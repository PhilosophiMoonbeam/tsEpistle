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
      <div class="agent-goal__meter" aria-hidden="true">
        <span :style="{ width: `${budgetPercent}%` }" />
      </div>
      <p class="agent-goal__summary" aria-live="polite">
        {{ progressLabel }}
        <span v-if="goal.errorMessage"> · {{ goal.errorMessage }}</span>
      </p>
      <div v-if="canPause || canResume || canCancel" class="agent-goal__actions">
        <v-btn
          v-if="canPause"
          size="small"
          variant="tonal"
          prepend-icon="mdi-pause"
          :loading="busy"
          @click="$emit('pause')"
        >Pause</v-btn>
        <v-btn
          v-if="canResume"
          size="small"
          color="primary"
          variant="tonal"
          prepend-icon="mdi-play"
          :loading="busy"
          @click="$emit('resume')"
        >Resume</v-btn>
        <v-btn
          v-if="canCancel"
          size="small"
          variant="text"
          prepend-icon="mdi-close"
          :disabled="busy"
          @click="$emit('cancel')"
        >Cancel goal</v-btn>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AgentGoalView } from '../../../shared/agents/contracts.ts'

const props = defineProps<{ goal: AgentGoalView; busy: boolean; runActive: boolean }>()
defineEmits<{ pause: []; resume: []; cancel: [] }>()

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
const budgetPercent = computed(() => Math.max(3, Math.min(100, Math.max(tokenPercent.value, toolPercent.value, continuationPercent.value))))
const progressLabel = computed(() => {
  if (props.goal.status === 'completed') return `Completed in ${props.goal.continuationCount + 1} run${props.goal.continuationCount === 0 ? '' : 's'}.`
  if (props.goal.status === 'budget_limited') return 'Host-owned time, token, tool, or continuation limits stopped further work.'
  if (props.goal.status === 'cancelled') return 'No further work will run for this goal.'
  if (props.goal.status === 'failed') return 'The goal stopped after a non-recoverable failure.'
  return `Run ${props.goal.continuationCount + 1} of ${props.goal.maxContinuations + 1} · ${props.goal.consumedTokens.toLocaleString()} tokens · ${props.goal.consumedToolCalls} tool calls`
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
