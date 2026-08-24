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
        <AgentMarkdown
          :content="message.content || (message.status === 'streaming' ? '…' : '')"
          :citations="message.citations"
        />
        <aside v-if="message.citations.length" class="agent-sources mt-3" aria-label="Sources">
          <div class="agent-sources__heading">
            <v-icon icon="mdi-book-open-page-variant-outline" size="18" />
            <strong>Sources</strong>
          </div>
          <ol>
            <li v-for="(citation, index) in message.citations" :key="citation.evidenceId">
              <component
                :is="citation.href ? 'a' : 'span'"
                :href="citation.href || undefined"
                :target="citation.href ? '_blank' : undefined"
                :rel="citation.href ? 'noopener noreferrer' : undefined"
                :aria-label="`Citation ${index + 1}: ${citation.label}`"
              >
                <span class="agent-sources__number">{{ index + 1 }}</span>
                <span class="agent-sources__label">
                  <strong>{{ citationPageLabel(citation.label) }}</strong>
                  <small v-if="citationSectionLabel(citation.label)">{{ citationSectionLabel(citation.label) }}</small>
                </span>
                <v-icon v-if="citation.href" icon="mdi-open-in-new" size="15" aria-hidden="true" />
              </component>
            </li>
          </ol>
        </aside>
        <nav
          v-if="message.role === 'assistant' && pageLinksForRun(message.runId).length"
          class="agent-page-links mt-3"
          aria-label="Changed pages"
        >
          <a
            v-for="link in pageLinksForRun(message.runId)"
            :key="link.href"
            :href="link.href"
            :title="`Open ${link.label}`"
          >
            <v-icon icon="mdi-file-link-outline" size="18" aria-hidden="true" />
            <span>{{ link.label }}</span>
          </a>
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
import type { AgentCitation, AgentPageActionLink, AgentToolCallView, AgentToolState, AgentThreadState } from '../../../shared/agents/contracts.ts'
import AgentMarkdown from './agent-markdown.vue'
import AgentToolCard from './agent-tool-card.vue'
import {
  agentActivityLabel,
  agentAppliedPageLinks,
  groupAgentToolsByRun,
  type AgentProposalTool
} from './agent-thread-presentation.ts'

const props = defineProps<{ thread: AgentThreadState; connection: string; decidingApprovalId?: string | null }>()
defineEmits<{ suggest: [prompt: string]; decision: [proposalId: string, approvalId: string, decision: 'approved' | 'denied', confirmationPath?: string] }>()

const groupedTools = computed(() => groupAgentToolsByRun(props.thread.tools, props.thread.proposals))
const activityForRun = (runId: string | null): readonly AgentToolCallView[] => runId ? groupedTools.value.get(runId)?.activity ?? [] : []
const proposalToolsForRun = (runId: string | null): readonly AgentProposalTool[] => runId ? groupedTools.value.get(runId)?.proposals ?? [] : []
const pageLinksForRun = (runId: string | null): readonly AgentPageActionLink[] => agentAppliedPageLinks(proposalToolsForRun(runId))
const activityLabel = agentActivityLabel
const citationLabelParts = (citation: AgentCitation['label']): readonly string[] => citation.split(' › ').filter(Boolean)
const citationPageLabel = (citation: AgentCitation['label']): string => citationLabelParts(citation)[0] ?? citation
const citationSectionLabel = (citation: AgentCitation['label']): string => citationLabelParts(citation).slice(1).join(' › ')
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
.agent-message { border: 1px solid color-mix(in srgb, rgb(var(--v-theme-secondary)) 38%, rgb(var(--v-theme-surface))); border-radius: .75rem; margin-bottom: 1rem; max-width: 54rem; padding: 1rem; background: color-mix(in srgb, rgb(var(--v-theme-secondary)) 18%, rgb(var(--v-theme-surface))); color: rgb(var(--v-theme-on-surface)); }
.agent-message--user { margin-inline-start: auto; background: rgb(var(--v-theme-primary)); color: rgb(var(--v-theme-on-primary)); }
.agent-sources { border-top: 1px solid rgb(var(--v-theme-outline-variant)); padding-top: .75rem; }
.agent-sources__heading { align-items: center; display: flex; gap: .4rem; margin-bottom: .45rem; }
.agent-sources ol { display: grid; gap: .35rem; list-style: none; margin: 0; padding: 0; }
.agent-sources li > a,
.agent-sources li > span { align-items: center; border-radius: .5rem; color: inherit; display: grid; gap: .55rem; grid-template-columns: auto minmax(0, 1fr) auto; min-height: 2.5rem; padding: .4rem .5rem; text-decoration: none; }
.agent-sources li > a:hover { background: rgb(var(--v-theme-surface)); }
.agent-sources li > a:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 2px; }
.agent-sources__number { align-items: center; background: rgb(var(--v-theme-primary-container)); border-radius: 999px; color: rgb(var(--v-theme-on-primary-container)); display: inline-flex; font-size: .72rem; font-weight: 700; height: 1.4rem; justify-content: center; width: 1.4rem; }
.agent-sources__label { min-width: 0; }
.agent-sources__label strong,
.agent-sources__label small { display: block; overflow-wrap: anywhere; }
.agent-sources__label small { color: rgb(var(--v-theme-on-surface-variant)); margin-top: .08rem; }
.agent-page-links { border-top: 1px solid rgb(var(--v-theme-outline-variant)); display: flex; flex-wrap: wrap; gap: .5rem; padding-top: .75rem; }
.agent-page-links a { align-items: center; background: rgb(var(--v-theme-surface)); border: 1px solid rgb(var(--v-theme-outline-variant)); border-radius: .5rem; color: rgb(var(--v-theme-primary)); display: inline-flex; gap: .4rem; min-height: 2.25rem; overflow-wrap: anywhere; padding: .35rem .65rem; text-decoration: none; }
.agent-page-links a:hover { background: rgb(var(--v-theme-primary-container)); color: rgb(var(--v-theme-on-primary-container)); }
.agent-page-links a:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 2px; }
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
