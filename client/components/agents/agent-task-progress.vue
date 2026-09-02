<template>
  <span class="agent-tasks__live sr-only" role="status" aria-live="polite" aria-atomic="true">{{ liveSummary }}</span>
  <details
    class="agent-tasks"
    :class="`agent-tasks--${planState}`"
    :open="tasks.length > 0 && !cleanCompletion"
  >
    <summary class="agent-tasks__header">
      <span class="agent-tasks__mark" aria-hidden="true">
        <v-icon :icon="planIcon" size="19" />
      </span>
      <span class="agent-tasks__heading">
        <span class="agent-tasks__eyebrow">Research operations</span>
        <strong>{{ planTitle }}</strong>
        <small>{{ progressLabel }}</small>
      </span>
      <span v-if="tasks.length" class="agent-tasks__count" aria-hidden="true">{{ terminalCount }}/{{ tasks.length }}</span>
    </summary>

    <div
      v-if="tasks.length"
      class="agent-tasks__progress"
      role="progressbar"
      :aria-valuenow="terminalCount"
      aria-valuemin="0"
      :aria-valuemax="tasks.length"
      :aria-valuetext="progressLabel"
      aria-label="Research operation progress"
    >
      <span
        v-if="successfulCount"
        class="agent-tasks__progress-fill agent-tasks__progress-fill--success"
        :style="{ width: `${successfulPercent}%` }"
      />
      <span
        v-if="attentionCount"
        class="agent-tasks__progress-fill agent-tasks__progress-fill--attention"
        :style="{ width: `${attentionPercent}%` }"
      />
    </div>

    <ol v-if="tasks.length" class="agent-tasks__list">
      <li
        v-for="task in tasks"
        :key="task.id"
        class="agent-tasks__item"
        :class="`agent-tasks__item--${statusFor(task)}`"
      >
        <span class="agent-tasks__state-mark" aria-hidden="true">
          <v-icon :icon="statusIcon(statusFor(task))" size="18" />
        </span>
        <div class="agent-tasks__body">
          <div class="agent-tasks__title-row">
            <strong>{{ task.title }}</strong>
            <span class="agent-tasks__status">{{ statusLabel(statusFor(task)) }}</span>
          </div>

          <div class="agent-tasks__meta">
            <span>{{ kindLabel(task.kind) }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ evidenceLabel(task) }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ attemptLabel(task) }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ durationLabel(task) }}</span>
          </div>

          <p
            v-if="statusFor(task) === 'partial' || task.status === 'failed' || task.status === 'blocked' || task.status === 'cancelled'"
            class="agent-tasks__note"
          >
            <span>{{ terminalNote(task) }}</span>
          </p>

          <details class="agent-task-record">
            <summary>
              <span>Operation record</span>
              <small>Input, output, and timing</small>
            </summary>
            <dl class="agent-task-record__facts">
              <dt>Input</dt>
              <dd class="agent-task-record__payload">{{ task.question }}</dd>

              <template v-if="task.sourceScope.length">
                <dt>Scope</dt>
                <dd class="agent-task-record__scopes">
                  <span v-for="(scope, index) in task.sourceScope" :key="`${index}:${scope}`" :title="scope">{{ scope }}</span>
                </dd>
              </template>

              <dt>Output</dt>
              <dd>{{ outputLabel(task) }}</dd>

              <dt>Created</dt>
              <dd><time :datetime="task.createdAt">{{ formatTimestamp(task.createdAt) }}</time></dd>

              <template v-if="task.startedAt">
                <dt>Started</dt>
                <dd><time :datetime="task.startedAt">{{ formatTimestamp(task.startedAt) }}</time></dd>
              </template>

              <template v-if="task.completedAt">
                <dt>Finished</dt>
                <dd><time :datetime="task.completedAt">{{ formatTimestamp(task.completedAt) }}</time></dd>
              </template>

              <template v-if="task.errorCode">
                <dt>Error code</dt>
                <dd><code>{{ task.errorCode }}</code></dd>
              </template>

              <template v-if="task.errorMessage">
                <dt>Error detail</dt>
                <dd class="agent-task-record__payload agent-task-record__payload--error">{{ task.errorMessage }}</dd>
              </template>
            </dl>
          </details>
        </div>
      </li>
    </ol>

    <div v-else class="agent-tasks__empty">
      <v-icon icon="mdi-clipboard-text-outline" size="21" aria-hidden="true" />
      <span>
        <strong>No research operations</strong>
        <small>Tasks will appear here when the Agent creates a research plan.</small>
      </span>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AgentTaskKind, AgentTaskView } from '../../../shared/agents/contracts.ts'

const props = defineProps<{ tasks: readonly AgentTaskView[] }>()
type DisplayTaskStatus = AgentTaskView['status'] | 'partial'
type PlanState = 'idle' | 'running' | 'attention' | 'success'

const tick = ref(0)
let durationTimer: number | null = null
const statusFor = (task: AgentTaskView): DisplayTaskStatus => task.status === 'completed' && task.outcome === 'partial' ? 'partial' : task.status
const terminalStatuses: ReadonlySet<AgentTaskView['status']> = new Set(['blocked', 'completed', 'failed', 'cancelled'])
const planCounts = computed(() => {
  let terminal = 0
  let successful = 0
  let running = 0
  let queued = 0
  let attention = 0

  for (const task of props.tasks) {
    const status = statusFor(task)
    if (terminalStatuses.has(task.status)) terminal++
    if (status === 'completed') successful++
    if (status === 'running') running++
    if (status === 'pending') queued++
    if (status === 'blocked' || status === 'failed' || status === 'cancelled' || status === 'partial') attention++
  }

  return { terminal, successful, running, queued, attention }
})
const terminalCount = computed(() => planCounts.value.terminal)
const successfulCount = computed(() => planCounts.value.successful)
const runningCount = computed(() => planCounts.value.running)
const queuedCount = computed(() => planCounts.value.queued)
const attentionCount = computed(() => planCounts.value.attention)
const allTerminal = computed(() => props.tasks.length > 0 && terminalCount.value === props.tasks.length)
const cleanCompletion = computed(() => allTerminal.value && attentionCount.value === 0)
const successfulPercent = computed(() => props.tasks.length === 0 ? 0 : (successfulCount.value / props.tasks.length) * 100)
const attentionPercent = computed(() => props.tasks.length === 0 ? 0 : (attentionCount.value / props.tasks.length) * 100)
const planState = computed<PlanState>(() => {
  if (!props.tasks.length) return 'idle'
  if (runningCount.value || queuedCount.value) return attentionCount.value ? 'attention' : 'running'
  return attentionCount.value ? 'attention' : 'success'
})
const planIcon = computed(() => ({
  idle: 'mdi-clipboard-text-outline',
  running: 'mdi-source-branch',
  attention: 'mdi-alert-circle-outline',
  success: 'mdi-check-all'
})[planState.value])
const planTitle = computed(() => allTerminal.value ? 'Research plan resolved' : 'Research plan')
const progressLabel = computed(() => {
  if (!props.tasks.length) return 'No tasks recorded'
  if (allTerminal.value) {
    return `${successfulCount.value} successful${attentionCount.value ? ` · ${attentionCount.value} need attention` : ''}`
  }
  const parts = []
  if (runningCount.value) parts.push(`${runningCount.value} running`)
  if (queuedCount.value) parts.push(`${queuedCount.value} queued`)
  if (terminalCount.value) parts.push(`${terminalCount.value} resolved`)
  return parts.join(' · ')
})
const liveSummary = computed(() => attentionCount.value
  ? `${progressLabel.value}. Some research operations need attention.`
  : progressLabel.value)

const statusLabels: Readonly<Record<DisplayTaskStatus, string>> = {
  pending: 'Pending',
  running: 'Running',
  blocked: 'Blocked',
  completed: 'Successful',
  partial: 'Partial',
  failed: 'Failed',
  cancelled: 'Cancelled'
}
const statusIcons: Readonly<Record<DisplayTaskStatus, string>> = {
  pending: 'mdi-clock-outline',
  running: 'mdi-progress-clock',
  blocked: 'mdi-pause-circle-outline',
  completed: 'mdi-check-circle-outline',
  partial: 'mdi-circle-half-full',
  failed: 'mdi-alert-octagon-outline',
  cancelled: 'mdi-stop-circle-outline'
}
const kindLabels: Readonly<Record<AgentTaskKind, string>> = {
  source_scout: 'Source review',
  fact_check: 'Fact check',
  conflict_check: 'Conflict check'
}
const outcomeLabels: Readonly<Record<NonNullable<AgentTaskView['outcome']>, string>> = {
  completed: 'Evidence requirement satisfied',
  blocked: 'Insufficient evidence',
  partial: 'Partial evidence returned',
  failed: 'No reliable output'
}
const statusLabel = (status: DisplayTaskStatus): string => statusLabels[status]
const statusIcon = (status: DisplayTaskStatus): string => statusIcons[status]
const kindLabel = (kind: AgentTaskKind): string => kindLabels[kind]
const evidenceLabel = (task: AgentTaskView): string => `${task.evidenceCount}/${task.requiredEvidenceCount} ${task.requiredEvidenceCount === 1 ? 'source' : 'sources'}`
const attemptLabel = (task: AgentTaskView): string => task.attempt > 1 ? `Attempt ${task.attempt} · retried ${task.attempt - 1}` : 'Attempt 1'
const outputLabel = (task: AgentTaskView): string => task.outcome
  ? `${outcomeLabels[task.outcome]} · ${evidenceLabel(task)}`
  : task.status === 'running'
    ? `Collecting evidence · ${evidenceLabel(task)}`
    : `No output yet · ${evidenceLabel(task)}`
const terminalNote = (task: AgentTaskView): string => {
  if (statusFor(task) === 'partial') return `Only ${task.evidenceCount} of ${task.requiredEvidenceCount} required ${task.requiredEvidenceCount === 1 ? 'source was' : 'sources were'} found.`
  if (task.errorCode === 'SUBAGENT_TIMEOUT') return 'The research deadline was reached. A later run may retry this operation.'
  if (task.errorCode === 'AGENT_CHILD_BUDGET_EXCEEDED') return 'The research budget was reached before the evidence requirement.'
  if (task.errorCode === 'ORCHESTRATION_DISABLED') return 'Specialist research was disabled before this task ran.'
  if (task.status === 'blocked') return 'Available Wiki evidence was insufficient for a reliable result.'
  if (task.status === 'cancelled') return 'Research stopped with the parent response.'
  return 'This research operation could not be completed. Open the record for the exact error.'
}
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const formatTimestamp = (value: string): string => dateFormatter.format(new Date(value))
const formatDuration = (start: string, end: string | null): string => {
  void tick.value
  const milliseconds = Math.max(0, (end ? new Date(end).valueOf() : Date.now()) - new Date(start).valueOf())
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 1) return 'under 1 sec'
  if (seconds < 60) return `${seconds} sec`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours} hr${remainingMinutes ? ` ${remainingMinutes} min` : ''}`
}
const durationLabel = (task: AgentTaskView): string => {
  if (task.status === 'pending') return `Queued ${formatDuration(task.createdAt, null)}`
  const duration = formatDuration(task.startedAt ?? task.createdAt, task.completedAt)
  return task.status === 'running' ? `Running ${duration}` : `Duration ${duration}`
}
const stopDurationTimer = (): void => {
  if (durationTimer !== null) window.clearInterval(durationTimer)
  durationTimer = null
}
const syncDurationTimer = (): void => {
  stopDurationTimer()
  if (runningCount.value || queuedCount.value) durationTimer = window.setInterval(() => { tick.value++ }, 30_000)
}
watch([runningCount, queuedCount], syncDurationTimer)
onMounted(syncDurationTimer)
onBeforeUnmount(stopDurationTimer)
</script>

<style scoped>
.agent-tasks {
  --tasks-accent: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  margin-block: var(--wiki-space-4);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--tasks-accent) 32%, var(--wiki-surface-border));
  border-radius: var(--wiki-panel-radius);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--tasks-accent) 7%, transparent), transparent 48%),
    var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
}

.agent-tasks--running {
  --tasks-accent: rgb(var(--v-theme-primary));
}

.agent-tasks--attention {
  --tasks-accent: rgb(var(--v-theme-warning));
}

.agent-tasks--success {
  --tasks-accent: rgb(var(--v-theme-success));
}

.agent-tasks__header {
  display: flex;
  gap: var(--wiki-space-3);
  align-items: center;
  min-height: var(--wiki-control-height);
  padding: var(--wiki-space-3) var(--wiki-space-4);
  cursor: pointer;
  list-style: none;
}

.agent-tasks__header::-webkit-details-marker,
.agent-task-record summary::-webkit-details-marker {
  display: none;
}

.agent-tasks__header::after,
.agent-task-record summary::after {
  content: '›';
  flex: 0 0 auto;
  margin-inline-start: var(--wiki-space-1);
  font-size: 1.25rem;
  transform: rotate(90deg);
  transition: transform var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.agent-tasks[open] > .agent-tasks__header::after,
.agent-task-record[open] summary::after {
  transform: rotate(270deg);
}

.agent-tasks__header:focus-visible,
.agent-task-record summary:focus-visible {
  outline: 2px solid var(--wiki-focus-color);
  outline-offset: calc(-1 * var(--wiki-focus-offset));
}

.agent-tasks__mark,
.agent-tasks__state-mark {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
  background: color-mix(in srgb, currentColor 10%, transparent);
  color: var(--tasks-accent);
}

.agent-tasks__mark {
  width: calc(var(--wiki-control-height) - var(--wiki-space-1));
  height: calc(var(--wiki-control-height) - var(--wiki-space-1));
  border-radius: var(--wiki-control-radius);
}

.agent-tasks__heading {
  display: grid;
  flex: 1;
  min-width: 0;
  line-height: 1.35;
}

.agent-tasks__eyebrow {
  margin-bottom: var(--wiki-space-1);
  color: var(--tasks-accent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .085em;
  text-transform: uppercase;
}

.agent-tasks__heading strong {
  font-size: .875rem;
}

.agent-tasks__heading small,
.agent-tasks__meta,
.agent-tasks__note,
.agent-task-record summary small {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
}

.agent-tasks__count {
  min-width: calc(var(--wiki-space-8) + var(--wiki-space-1));
  padding: var(--wiki-space-1) var(--wiki-space-2);
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, var(--tasks-accent) 12%, transparent);
  color: var(--tasks-accent);
  font-size: var(--wiki-label-size);
  font-variant-numeric: tabular-nums;
  font-weight: var(--wiki-label-weight);
  text-align: center;
}

.agent-tasks__progress {
  display: flex;
  height: var(--wiki-space-1);
  overflow: hidden;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 9%, transparent);
}

.agent-tasks__progress-fill {
  display: block;
  height: 100%;
  transition: width var(--wiki-motion-normal) var(--wiki-motion-ease-out);
}

.agent-tasks__progress-fill--success {
  background: rgb(var(--v-theme-success));
}

.agent-tasks__progress-fill--attention {
  background: rgb(var(--v-theme-warning));
}

.agent-tasks__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.agent-tasks__item {
  --task-accent: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 54%, transparent);
  display: grid;
  grid-template-columns: calc(var(--wiki-control-height) - var(--wiki-space-4)) minmax(0, 1fr);
  gap: var(--wiki-space-3);
  align-items: start;
  padding: var(--wiki-space-3) var(--wiki-space-4);
  border-block-start: 1px solid var(--wiki-surface-border);
}

.agent-tasks__item--running {
  --task-accent: rgb(var(--v-theme-primary));
}

.agent-tasks__item--completed {
  --task-accent: rgb(var(--v-theme-success));
}

.agent-tasks__item--partial,
.agent-tasks__item--blocked {
  --task-accent: rgb(var(--v-theme-warning));
}

.agent-tasks__item--failed {
  --task-accent: rgb(var(--v-theme-error));
}

.agent-tasks__item--cancelled {
  --task-accent: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
}

.agent-tasks__state-mark {
  width: calc(var(--wiki-control-height) - var(--wiki-space-4));
  height: calc(var(--wiki-control-height) - var(--wiki-space-4));
  border-radius: var(--wiki-radius-xs);
  color: var(--task-accent);
}

.agent-tasks__body {
  display: grid;
  min-width: 0;
  gap: var(--wiki-space-1);
}

.agent-tasks__title-row {
  display: flex;
  gap: var(--wiki-space-3);
  align-items: baseline;
  justify-content: space-between;
}

.agent-tasks__title-row strong {
  min-width: 0;
  font-size: .82rem;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.agent-tasks__status {
  flex: 0 0 auto;
  padding: var(--wiki-space-1) var(--wiki-space-2);
  border: 1px solid color-mix(in srgb, var(--task-accent) 30%, transparent);
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, var(--task-accent) 10%, transparent);
  color: var(--task-accent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .055em;
  line-height: 1.2;
  text-transform: uppercase;
}

.agent-tasks__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-1);
  font-size: var(--wiki-label-size);
  font-variant-numeric: tabular-nums;
}

.agent-tasks__note {
  display: flex;
  gap: var(--wiki-space-2);
  align-items: flex-start;
  margin: var(--wiki-space-1) 0 0;
  padding: var(--wiki-space-2);
  border-inline-start: var(--wiki-space-1) solid var(--task-accent);
  border-radius: var(--wiki-radius-xs);
  background: color-mix(in srgb, var(--task-accent) 8%, transparent);
  color: color-mix(in srgb, var(--task-accent) 82%, rgb(var(--v-theme-on-surface)));
  font-size: .75rem;
  line-height: 1.45;
}

.agent-tasks__note span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.agent-task-record {
  margin-top: var(--wiki-space-2);
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: rgb(var(--v-theme-surface));
}

.agent-task-record summary {
  display: flex;
  gap: var(--wiki-space-2);
  align-items: center;
  min-height: calc(var(--wiki-control-height) - var(--wiki-space-1));
  padding: var(--wiki-space-2) var(--wiki-space-3);
  cursor: pointer;
  list-style: none;
  font-size: .75rem;
  font-weight: 650;
}

.agent-task-record summary small {
  margin-inline-start: auto;
  font-size: var(--wiki-label-size);
  font-weight: 400;
}

.agent-task-record__facts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--wiki-space-2) var(--wiki-space-3);
  margin: 0;
  padding: var(--wiki-space-3);
  border-block-start: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);
}

.agent-task-record__facts dt {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .055em;
  text-transform: uppercase;
}

.agent-task-record__facts dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  font-size: .75rem;
}

.agent-task-record__facts code {
  direction: ltr;
  font-family: var(--wiki-font-mono);
  text-align: start;
  unicode-bidi: plaintext;
  word-break: break-all;
}

.agent-task-record__payload {
  max-height: 12rem;
  padding: var(--wiki-space-2);
  overflow: auto;
  border-radius: var(--wiki-radius-xs);
  background: rgb(var(--v-theme-surface));
  line-height: 1.5;
  overscroll-behavior: contain;
  white-space: pre-wrap;
}

.agent-task-record__payload--error {
  border-inline-start: var(--wiki-space-1) solid rgb(var(--v-theme-error));
}

.agent-task-record__scopes {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-1);
}

.agent-task-record__scopes span {
  max-width: 100%;
  padding: var(--wiki-space-1) var(--wiki-space-2);
  overflow-wrap: anywhere;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-radius-pill);
  background: rgb(var(--v-theme-surface));
  font-size: var(--wiki-label-size);
}

.agent-tasks__empty {
  display: flex;
  gap: var(--wiki-space-3);
  align-items: center;
  padding: var(--wiki-space-4);
  border-block-start: 1px solid var(--wiki-surface-border);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
}

.agent-tasks__empty > span {
  display: grid;
  min-width: 0;
}

.agent-tasks__live,
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

@media (max-width: 599.98px) {
  .agent-tasks__header,
  .agent-tasks__item {
    padding-inline: var(--wiki-space-3);
  }

  .agent-tasks__item {
    grid-template-columns: calc(var(--wiki-control-height) - var(--wiki-space-5)) minmax(0, 1fr);
    gap: var(--wiki-space-2);
  }

  .agent-tasks__state-mark {
    width: calc(var(--wiki-control-height) - var(--wiki-space-5));
    height: calc(var(--wiki-control-height) - var(--wiki-space-5));
  }

  .agent-tasks__title-row {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--wiki-space-1);
  }

  .agent-task-record summary small {
    display: none;
  }

  .agent-task-record__facts {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--wiki-space-1);
  }

  .agent-task-record__facts dd + dt {
    margin-top: var(--wiki-space-2);
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-tasks__header::after,
  .agent-task-record summary::after,
  .agent-tasks__progress-fill {
    transition: none;
  }
}

@media (forced-colors: active) {
  .agent-tasks,
  .agent-tasks__mark,
  .agent-tasks__state-mark,
  .agent-tasks__status,
  .agent-task-record,
  .agent-task-record__scopes span {
    border-color: CanvasText;
  }

  .agent-tasks__progress-fill--success {
    background: Highlight;
  }

  .agent-tasks__progress-fill--attention {
    background: CanvasText;
  }

  .agent-tasks__header:focus-visible,
  .agent-task-record summary:focus-visible {
    outline: var(--wiki-space-1) solid Highlight;
    outline-offset: calc(-1 * var(--wiki-focus-offset));
  }
}
</style>
