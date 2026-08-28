<template>
  <section class="agent-tasks" :aria-label="progressLabel" aria-live="polite">
    <header class="agent-tasks__header">
      <span class="agent-tasks__mark" aria-hidden="true">
        <v-icon icon="mdi-source-branch" size="18" />
      </span>
      <span class="agent-tasks__heading">
        <strong>Research plan</strong>
        <small>{{ progressLabel }}</small>
      </span>
      <span class="agent-tasks__count" aria-hidden="true">{{ terminalCount }}/{{ tasks.length }}</span>
    </header>
    <div
      class="agent-tasks__progress"
      role="progressbar"
      :aria-valuenow="terminalCount"
      aria-valuemin="0"
      :aria-valuemax="tasks.length"
      :aria-label="progressLabel"
    >
      <span :style="{ width: `${progressPercent}%` }" />
    </div>
    <ol class="agent-tasks__list">
      <li v-for="task in tasks" :key="task.id" class="agent-tasks__item">
        <v-icon
          class="agent-tasks__state-icon"
          :class="`agent-tasks__state-icon--${statusFor(task)}`"
          :icon="statusIcon(statusFor(task))"
          size="19"
          aria-hidden="true"
        />
        <span class="agent-tasks__body">
          <span class="agent-tasks__title-row">
            <strong>{{ task.title }}</strong>
            <span class="agent-tasks__status" :class="`agent-tasks__status--${statusFor(task)}`">{{ statusLabel(statusFor(task)) }}</span>
          </span>
          <small class="agent-tasks__meta">
            <span>{{ kindLabel(task.kind) }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ evidenceLabel(task) }}</span>
          </small>
          <span v-if="task.sourceScope.length" class="agent-tasks__scopes" aria-label="Research scope">
            <span v-for="scope in task.sourceScope" :key="scope">{{ scope }}</span>
          </span>
          <small v-if="task.status === 'failed' || task.status === 'blocked' || task.status === 'cancelled'" class="agent-tasks__note">
            {{ terminalNote(task) }}
          </small>
        </span>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AgentTaskKind, AgentTaskView } from '../../../shared/agents/contracts.ts'

const props = defineProps<{ tasks: readonly AgentTaskView[] }>()

type DisplayTaskStatus = AgentTaskView['status'] | 'partial'
const terminalStatuses: ReadonlySet<AgentTaskView['status']> = new Set(['blocked', 'completed', 'failed', 'cancelled'])
const terminalCount = computed(() => props.tasks.filter(task => terminalStatuses.has(task.status)).length)
const progressPercent = computed(() => props.tasks.length === 0 ? 0 : Math.round((terminalCount.value / props.tasks.length) * 100))
const progressLabel = computed(() => terminalCount.value === props.tasks.length
  ? `${props.tasks.length} research ${props.tasks.length === 1 ? 'task' : 'tasks'} finished`
  : `${terminalCount.value} of ${props.tasks.length} research tasks finished`)

const statusFor = (task: AgentTaskView): DisplayTaskStatus => task.status === 'completed' && task.outcome === 'partial' ? 'partial' : task.status
const statusLabels: Readonly<Record<DisplayTaskStatus, string>> = {
  pending: 'Queued',
  running: 'Researching',
  blocked: 'Blocked',
  completed: 'Complete',
  partial: 'Partial',
  failed: 'Failed',
  cancelled: 'Cancelled'
}
const statusIcons: Readonly<Record<DisplayTaskStatus, string>> = {
  pending: 'mdi-circle-outline',
  running: 'mdi-progress-clock',
  blocked: 'mdi-pause-circle-outline',
  completed: 'mdi-check-circle',
  partial: 'mdi-circle-half-full',
  failed: 'mdi-alert-circle-outline',
  cancelled: 'mdi-stop-circle-outline'
}
const kindLabels: Readonly<Record<AgentTaskKind, string>> = {
  source_scout: 'Source review',
  fact_check: 'Fact check',
  conflict_check: 'Conflict check'
}
const statusLabel = (status: DisplayTaskStatus): string => statusLabels[status]
const statusIcon = (status: DisplayTaskStatus): string => statusIcons[status]
const kindLabel = (kind: AgentTaskKind): string => kindLabels[kind]
const evidenceLabel = (task: AgentTaskView): string => `${task.evidenceCount}/${task.requiredEvidenceCount} ${task.requiredEvidenceCount === 1 ? 'source' : 'sources'}`
const terminalNote = (task: AgentTaskView): string => {
  if (task.errorCode === 'SUBAGENT_TIMEOUT') return 'The research deadline was reached.'
  if (task.errorCode === 'AGENT_CHILD_BUDGET_EXCEEDED') return 'The research budget was reached.'
  if (task.errorCode === 'ORCHESTRATION_DISABLED') return 'Specialist research was disabled before this task ran.'
  if (task.status === 'blocked') return 'The available Wiki evidence was insufficient.'
  if (task.status === 'cancelled') return 'Research stopped with the parent response.'
  return 'This research task could not be completed.'
}
</script>

<style scoped>
.agent-tasks {
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 94%, rgb(var(--v-theme-primary)) 6%);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 14%, transparent);
  border-radius: .9rem;
  margin-block: .9rem;
  overflow: hidden;
}
.agent-tasks__header {
  align-items: center;
  display: flex;
  gap: .65rem;
  padding: .75rem .85rem .65rem;
}
.agent-tasks__mark {
  align-items: center;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 14%, transparent);
  border-radius: .55rem;
  color: rgb(var(--v-theme-primary));
  display: inline-flex;
  height: 2rem;
  justify-content: center;
  width: 2rem;
}
.agent-tasks__heading {
  display: grid;
  flex: 1;
  line-height: 1.25;
  min-width: 0;
}
.agent-tasks__heading strong { font-size: .82rem; }
.agent-tasks__heading small,
.agent-tasks__meta,
.agent-tasks__note { color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent); }
.agent-tasks__count {
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 8%, transparent);
  border-radius: 999px;
  font-size: .72rem;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  padding: .2rem .5rem;
}
.agent-tasks__progress {
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, transparent);
  height: 2px;
  overflow: hidden;
}
.agent-tasks__progress > span {
  background: rgb(var(--v-theme-primary));
  display: block;
  height: 100%;
  transition: width 180ms ease-out;
}
.agent-tasks__list { list-style: none; margin: 0; padding: 0; }
.agent-tasks__item {
  align-items: flex-start;
  border-block-start: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 9%, transparent);
  display: flex;
  gap: .65rem;
  padding: .75rem .85rem;
}
.agent-tasks__state-icon { color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 48%, transparent); margin-block-start: .05rem; }
.agent-tasks__state-icon--running { color: rgb(var(--v-theme-primary)); }
.agent-tasks__state-icon--completed { color: rgb(var(--v-theme-success)); }
.agent-tasks__state-icon--partial,
.agent-tasks__state-icon--blocked { color: rgb(var(--v-theme-warning)); }
.agent-tasks__state-icon--failed { color: rgb(var(--v-theme-error)); }
.agent-tasks__body { display: grid; flex: 1; gap: .3rem; min-width: 0; }
.agent-tasks__title-row { align-items: baseline; display: flex; gap: .6rem; justify-content: space-between; }
.agent-tasks__title-row strong { font-size: .82rem; line-height: 1.35; }
.agent-tasks__status {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  flex: 0 0 auto;
  font-size: .69rem;
  font-weight: 650;
  letter-spacing: .02em;
  text-transform: uppercase;
}
.agent-tasks__status--running { color: rgb(var(--v-theme-primary)); }
.agent-tasks__status--completed { color: rgb(var(--v-theme-success)); }
.agent-tasks__status--partial,
.agent-tasks__status--blocked { color: rgb(var(--v-theme-warning)); }
.agent-tasks__status--failed { color: rgb(var(--v-theme-error)); }
.agent-tasks__meta { display: flex; flex-wrap: wrap; font-size: .72rem; gap: .3rem; }
.agent-tasks__scopes { display: flex; flex-wrap: wrap; gap: .3rem; }
.agent-tasks__scopes > span {
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 7%, transparent);
  border-radius: .35rem;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 74%, transparent);
  font-size: .67rem;
  line-height: 1.3;
  max-width: 100%;
  overflow: hidden;
  padding: .16rem .38rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-tasks__note { font-size: .72rem; line-height: 1.35; }
@media (prefers-reduced-motion: reduce) {
  .agent-tasks__progress > span { transition: none; }
}
</style>
