<template>
  <section class="agent-thread" aria-label="Agent conversation">
    <div class="sr-status" aria-live="polite" aria-atomic="true">{{ liveSummary }}</div>
    <v-alert v-if="!thread.messages.length" type="info" variant="tonal" class="mb-4">
      Ask a question to search and read Wiki pages you are allowed to access.
    </v-alert>
    <template v-for="message in thread.messages" :key="message.id">
      <article class="agent-message" :class="`agent-message--${message.role}`">
        <div v-if="message.role === 'assistant'" class="agent-message__identity" aria-hidden="true">
          <v-avatar color="primary" size="28" variant="tonal">
            <v-icon icon="mdi-auto-fix" size="16" />
          </v-avatar>
        </div>
        <div class="agent-message__content">
          <div class="agent-message__meta text-body-small">
            <span class="agent-message__role">{{ message.role === 'user' ? 'You' : 'Wiki Agent' }}</span>
            <span
              v-if="messageStatusLabel(message.role, message.status)"
              class="agent-message__status"
              :class="`agent-message__status--${message.status}`"
            >
              <span class="agent-message__status-dot" aria-hidden="true" />
              {{ messageStatusLabel(message.role, message.status) }}
            </span>
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
        </div>
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
import type { AgentCitation, AgentMessageRole, AgentMessageStatus, AgentPageActionLink, AgentToolCallView, AgentToolState, AgentThreadState } from '../../../shared/agents/contracts.ts'
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
const messageStatusLabels: Record<Exclude<AgentMessageStatus, 'complete'>, string> = {
  pending: 'Preparing',
  streaming: 'Responding',
  failed: 'Failed',
  cancelled: 'Cancelled'
}
const messageStatusLabel = (role: AgentMessageRole, status: AgentMessageStatus): string =>
  status === 'complete' ? '' : role === 'user' && status === 'pending' ? 'Sending' : messageStatusLabels[status]
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
.agent-thread { margin: 0 auto; max-width: 48rem; min-height: 12rem; width: 100%; }
.agent-message { color: rgb(var(--v-theme-on-surface)); margin-bottom: 1.5rem; max-width: 100%; overflow-wrap: anywhere; }
.agent-message__content { min-width: 0; }
.agent-message__meta { align-items: center; color: rgb(var(--v-theme-on-surface)); display: flex; gap: .5rem; margin-bottom: .45rem; min-height: 1.35rem; }
.agent-message__role { font-weight: 600; letter-spacing: .01em; }
.agent-message__status { align-items: center; display: inline-flex; font-size: .72rem; gap: .3rem; }
.agent-message__status-dot { background: rgb(var(--v-theme-primary)); border-radius: 999px; height: .4rem; width: .4rem; }
.agent-message__status--streaming .agent-message__status-dot { animation: agentStatusPulse 1.6s ease-in-out infinite; }
.agent-message__status--failed { color: rgb(var(--v-theme-error)); }
.agent-message__status--failed .agent-message__status-dot { background: currentColor; }
.agent-message__status--cancelled .agent-message__status-dot { background: rgb(var(--v-theme-outline)); }
.agent-message--assistant .agent-message__status { opacity: .68; }
.agent-message--assistant {
  border-bottom: 1px solid color-mix(in srgb, rgb(var(--v-theme-outline)) 18%, transparent);
  display: grid;
  gap: .75rem;
  grid-template-columns: 1.75rem minmax(0, 1fr);
  padding: .25rem 0 1.35rem;
}
.agent-message__identity { align-self: start; padding-top: .05rem; }
.agent-message--user {
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 24%, rgb(var(--v-theme-surface)));
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 38%, rgb(var(--v-theme-outline)));
  border-radius: 1.1rem 1.1rem .35rem 1.1rem;
  color: rgb(var(--v-theme-on-surface));
  margin-inline-start: auto;
  max-width: min(36rem, 76%);
  padding: .8rem 1rem .9rem;
}
.agent-message--user .agent-message__meta { color: inherit; font-size: .72rem !important; margin-bottom: .3rem; opacity: .72; }
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
@keyframes agentStatusPulse {
  0%, 100% { opacity: .4; transform: scale(.8); }
  50% { opacity: 1; transform: scale(1); }
}
@media (max-width: 599.98px) {
  .agent-message--assistant { gap: .55rem; }
  .agent-message--user { max-width: 90%; }
}
@media (prefers-reduced-motion: reduce) {
  .agent-activity summary::after { transition: none; }
  .agent-message__status-dot { animation: none !important; }
}
</style>
