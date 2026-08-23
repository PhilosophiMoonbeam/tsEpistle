<template>
  <section class="agent-thread" aria-label="Agent conversation">
    <div class="sr-status" aria-live="polite" aria-atomic="true">{{ liveSummary }}</div>
    <v-alert v-if="!thread.messages.length" type="info" variant="tonal" class="mb-4">
      Ask a question to search and read Wiki pages you are allowed to access.
    </v-alert>
    <template v-for="message in thread.messages" :key="message.id">
      <article class="agent-message" :class="`agent-message--${message.role}`">
        <div class="text-body-small text-medium-emphasis mb-1">
          {{ message.role === 'user' ? 'You' : 'Wiki Agent' }} · {{ message.status }}
        </div>
        <AgentMarkdown :content="message.content || (message.status === 'streaming' ? '…' : '')" />
        <nav v-if="message.citations.length" class="mt-3" aria-label="Citations">
          <v-chip
            v-for="citation in message.citations"
            :key="citation.evidenceId"
            class="mr-2 mb-2"
            size="small"
            :href="citation.href || undefined"
            :disabled="!citation.href"
            target="_blank"
            rel="noopener noreferrer"
            prepend-icon="mdi-book-open-page-variant-outline"
          >{{ citation.label }}</v-chip>
        </nav>
        <details
          v-if="message.role === 'assistant' && activityForRun(message.runId).length"
          class="agent-activity mt-3"
        >
          <summary>
            <v-icon icon="mdi-format-list-checks" size="18" />
            <span>{{ activityLabel(activityForRun(message.runId)) }}</span>
          </summary>
          <ul class="agent-activity__list">
            <li v-for="tool in activityForRun(message.runId)" :key="tool.id">
              <v-icon :icon="toolStateIcon(tool.state)" :color="toolStateColor(tool.state)" size="18" />
              <span>
                <strong>{{ tool.title }}</strong>
                <small>{{ tool.actionName }} · {{ toolStateLabel(tool.state) }}</small>
              </span>
            </li>
          </ul>
        </details>
      </article>
      <AgentToolCard
        v-for="entry in proposalToolsForRun(message.role === 'assistant' ? message.runId : null)"
        :key="entry.tool.id"
        :tool="entry.tool"
        :proposal="entry.proposal"
        :busy="Boolean(decidingApprovalId && entry.proposal.approval?.id === decidingApprovalId)"
        @decision="(...args) => $emit('decision', ...args)"
      />
    </template>
    <section v-if="thread.artifacts.length" class="artifact-grid mt-4" aria-label="Browser screenshots">
      <figure v-for="artifact in thread.artifacts" :key="artifact.id" class="artifact-card">
        <a
          v-if="artifact.available"
          :href="`/_api/agents/artifacts/${artifact.id}/content`"
          target="_blank"
          rel="noopener noreferrer"
        >
          <img
            :src="`/_api/agents/artifacts/${artifact.id}/content`"
            :alt="`Browser screenshot captured ${artifact.createdAt}`"
            :width="artifact.width"
            :height="artifact.height"
            loading="lazy"
          >
        </a>
        <figcaption class="text-body-small text-medium-emphasis">
          {{ artifact.available ? `Browser screenshot · ${artifact.width}×${artifact.height}` : 'Browser screenshot expired' }}
        </figcaption>
      </figure>
    </section>
    <div v-if="thread.suggestions.length" class="d-flex flex-wrap ga-2 mt-4" aria-label="Follow-up suggestions">
      <v-btn v-for="suggestion in thread.suggestions" :key="suggestion.id" variant="tonal" size="small" @click="$emit('suggest', suggestion.prompt)">{{ suggestion.label }}</v-btn>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AgentToolCallView, AgentToolState, AgentThreadState } from '../../../shared/agents/contracts.ts'
import AgentMarkdown from './agent-markdown.vue'
import AgentToolCard from './agent-tool-card.vue'
import {
  agentActivityLabel,
  groupAgentToolsByRun,
  type AgentProposalTool
} from './agent-thread-presentation.ts'

const props = defineProps<{ thread: AgentThreadState; connection: string; decidingApprovalId?: string | null }>()
defineEmits<{ suggest: [prompt: string]; decision: [proposalId: string, approvalId: string, decision: 'approved' | 'denied', confirmationPath?: string] }>()

const groupedTools = computed(() => groupAgentToolsByRun(props.thread.tools, props.thread.proposals))
const activityForRun = (runId: string | null): readonly AgentToolCallView[] => runId ? groupedTools.value.get(runId)?.activity ?? [] : []
const proposalToolsForRun = (runId: string | null): readonly AgentProposalTool[] => runId ? groupedTools.value.get(runId)?.proposals ?? [] : []
const activityLabel = agentActivityLabel
const stateLabels: Record<AgentToolState, string> = { preparing: 'Preparing', running: 'Running', awaitingApproval: 'Awaiting approval', complete: 'Complete', failed: 'Failed', denied: 'Denied', cancelled: 'Cancelled' }
const stateIcons: Record<AgentToolState, string> = { preparing: 'mdi-dots-horizontal', running: 'mdi-progress-clock', awaitingApproval: 'mdi-shield-alert-outline', complete: 'mdi-check-circle-outline', failed: 'mdi-alert-circle-outline', denied: 'mdi-cancel', cancelled: 'mdi-stop-circle-outline' }
const toolStateLabel = (state: AgentToolState): string => stateLabels[state]
const toolStateIcon = (state: AgentToolState): string => stateIcons[state]
const toolStateColor = (state: AgentToolState): string => state === 'complete' ? 'success' : state === 'failed' || state === 'denied' ? 'error' : 'primary'
const liveSummary = computed(() => {
  const run = props.thread.session.currentRun
  if (props.connection === 'reconnecting') return 'Connection interrupted. Reconnecting.'
  if (!run) return 'Agent is ready.'
  if (run.status === 'running') return 'Agent response is in progress.'
  if (run.status === 'awaiting_approval') return 'An action is awaiting approval.'
  return `Agent run ${run.status.replace('_', ' ')}.`
})
</script>

<style scoped>
.agent-thread { min-height: 12rem; }
.agent-message { border-radius: .75rem; margin-bottom: 1rem; max-width: 54rem; padding: 1rem; background: rgb(var(--v-theme-surface-variant)); }
.agent-message--user { margin-inline-start: auto; background: rgb(var(--v-theme-primary)); color: rgb(var(--v-theme-on-primary)); }
.agent-activity { border-top: 1px solid rgb(var(--v-theme-outline-variant)); padding-top: .65rem; }
.agent-activity summary { align-items: center; cursor: pointer; display: flex; gap: .5rem; list-style: none; min-height: 2rem; }
.agent-activity summary::-webkit-details-marker { display: none; }
.agent-activity summary::after { content: '›'; font-size: 1.25rem; margin-inline-start: auto; transform: rotate(90deg); transition: transform .15s ease; }
.agent-activity[open] summary::after { transform: rotate(270deg); }
.agent-activity__list { display: grid; gap: .55rem; list-style: none; margin: .75rem 0 0; padding: 0; }
.agent-activity__list li { align-items: start; display: grid; gap: .55rem; grid-template-columns: auto minmax(0, 1fr); }
.agent-activity__list small { display: block; opacity: .72; overflow-wrap: anywhere; }
.sr-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.artifact-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr)); }
.artifact-card { margin: 0; }
.artifact-card img { border: 1px solid rgb(var(--v-theme-outline)); border-radius: .5rem; display: block; height: auto; max-width: 100%; }
@media (prefers-reduced-motion: reduce) { .agent-activity summary::after { transition: none; } }
</style>
