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
        <header v-else class="agent-message__identity agent-message__identity--user">
          <span class="agent-message__role">You</span>
          <span
            v-if="messageStatusLabel(message.role, message.status)"
            class="agent-message__status"
            :class="`agent-message__status--${message.status}`"
          >
            <span class="agent-message__status-dot" aria-hidden="true" />
            {{ messageStatusLabel(message.role, message.status) }}
          </span>
        </header>
        <div class="agent-message__content">
          <header v-if="message.role === 'assistant'" class="agent-message__meta text-body-small">
            <span class="agent-message__role">Wiki Agent</span>
            <span
              v-if="messageStatusLabel(message.role, message.status)"
              class="agent-message__status"
              :class="`agent-message__status--${message.status}`"
            >
              <span class="agent-message__status-dot" aria-hidden="true" />
              {{ messageStatusLabel(message.role, message.status) }}
            </span>
          </header>
          <div class="agent-message__surface">
            <AgentMarkdown
              :content="message.content || (message.status === 'streaming' ? '…' : '')"
              :citations="message.citations"
            />
            <aside v-if="message.citations.length" class="agent-sources mt-3" aria-label="Sources">
              <div class="agent-sources__heading">
                <v-icon icon="mdi-book-open-page-variant-outline" size="18" />
                <strong>Sources</strong>
              </div>
              <ol class="agent-sources__groups">
                <li v-for="group in citationGroups(message.citations)" :key="group.key" class="agent-sources__group">
                  <component
                    :is="group.pageHref ? 'a' : 'div'"
                    class="agent-sources__page"
                    :href="group.pageHref || undefined"
                    :target="group.pageHref ? '_blank' : undefined"
                    :rel="group.pageHref ? 'noopener noreferrer' : undefined"
                  >
                    <span v-if="group.pageCitation" class="agent-sources__number">{{ group.pageCitation.number }}</span>
                    <v-icon v-else icon="mdi-file-document-outline" size="18" aria-hidden="true" />
                    <strong>{{ group.pageLabel }}</strong>
                    <v-icon v-if="group.pageHref" icon="mdi-open-in-new" size="15" aria-hidden="true" />
                  </component>
                  <ol v-if="group.sections.length" class="agent-sources__sections">
                    <li v-for="entry in group.sections" :key="entry.citation.evidenceId">
                      <component
                        :is="entry.citation.href ? 'a' : 'span'"
                        :href="entry.citation.href || undefined"
                        :target="entry.citation.href ? '_blank' : undefined"
                        :rel="entry.citation.href ? 'noopener noreferrer' : undefined"
                        :aria-label="`Citation ${entry.number}: ${entry.citation.label}`"
                      >
                        <span class="agent-sources__number">{{ entry.number }}</span>
                        <span>{{ entry.sectionLabel }}</span>
                        <v-icon v-if="entry.citation.href" icon="mdi-open-in-new" size="14" aria-hidden="true" />
                      </component>
                    </li>
                  </ol>
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
                    <strong>{{ tool.summary || tool.title }}</strong>
                    <small>{{ tool.summary ? `${tool.title} · ` : '' }}{{ tool.actionName }} · {{ toolStateLabel(tool.state) }}</small>
                  </span>
                </li>
              </ul>
            </details>
          </div>
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
  groupAgentCitations,
  type AgentProposalTool
} from './agent-thread-presentation.ts'

const props = defineProps<{ thread: AgentThreadState; connection: string; decidingApprovalId?: string | null }>()
defineEmits<{ suggest: [prompt: string]; decision: [proposalId: string, approvalId: string, decision: 'approved' | 'denied', confirmationPath?: string] }>()

const groupedTools = computed(() => groupAgentToolsByRun(props.thread.tools, props.thread.proposals))
const activityForRun = (runId: string | null): readonly AgentToolCallView[] => runId ? groupedTools.value.get(runId)?.activity ?? [] : []
const proposalToolsForRun = (runId: string | null): readonly AgentProposalTool[] => runId ? groupedTools.value.get(runId)?.proposals ?? [] : []
const pageLinksForRun = (runId: string | null): readonly AgentPageActionLink[] => agentAppliedPageLinks(proposalToolsForRun(runId))
const activityLabel = agentActivityLabel
const citationGroups = groupAgentCitations
const messageStatusLabels: Record<Exclude<AgentMessageStatus, 'complete'>, string> = {
  pending: 'Preparing',
  streaming: 'Responding',
  failed: 'Failed',
  cancelled: 'Cancelled'
}
const messageStatusLabel = (role: AgentMessageRole, status: AgentMessageStatus): string =>
  status === 'complete' ? '' : role === 'user' && status === 'pending' ? 'Sending' : messageStatusLabels[status]
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
.agent-thread {
  --agent-thread-border: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 16%, transparent);
  --agent-thread-divider: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 11%, transparent);
  --agent-thread-surface: color-mix(in srgb, rgb(var(--v-theme-surface)) 94%, rgb(var(--v-theme-primary)) 6%);
  --agent-thread-user-surface: color-mix(in srgb, rgb(var(--v-theme-surface)) 84%, rgb(var(--v-theme-primary)) 16%);
  color: rgb(var(--v-theme-on-surface));
  font-family: 'WikiAgentSans', 'Roboto', system-ui, sans-serif;
  margin-inline: auto;
  max-width: 52rem;
  min-height: 12rem;
  width: 100%;
}
.agent-message {
  color: rgb(var(--v-theme-on-surface));
  margin-block-end: 1.5rem;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.agent-message__content { min-width: 0; }
.agent-message__meta {
  align-items: center;
  color: rgb(var(--v-theme-on-surface));
  display: flex;
  gap: .5rem;
  margin-block-end: .5rem;
  min-height: 1.5rem;
}
.agent-message__role {
  font-size: .78rem;
  font-weight: 650;
  letter-spacing: .025em;
  line-height: 1.35;
}
.agent-message__status {
  align-items: center;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 70%, transparent);
  display: inline-flex;
  font-size: .72rem;
  gap: .3rem;
  line-height: 1.35;
  white-space: nowrap;
}
.agent-message__status-dot {
  background: rgb(var(--v-theme-primary));
  border-radius: 999px;
  flex: 0 0 auto;
  height: .4rem;
  width: .4rem;
}
.agent-message__status--streaming .agent-message__status-dot { animation: agentStatusPulse 1.6s ease-in-out infinite; }
.agent-message__status--failed { color: rgb(var(--v-theme-error)); }
.agent-message__status--failed .agent-message__status-dot { background: currentColor; }
.agent-message__status--cancelled .agent-message__status-dot { background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 48%, transparent); }
.agent-message--assistant {
  align-items: start;
  display: grid;
  gap: .75rem;
  grid-template-columns: 1.75rem minmax(0, 1fr);
}
.agent-message--assistant .agent-message__content { max-width: 47rem; }
.agent-message__identity {
  align-self: start;
  min-width: 0;
}
.agent-message__identity :deep(.v-avatar) {
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 28%, var(--agent-thread-border));
}
.agent-message__surface {
  font-size: .96rem;
  line-height: 1.68;
  min-width: 0;
}
.agent-message--assistant .agent-message__surface {
  background: var(--agent-thread-surface);
  border: 1px solid var(--agent-thread-border);
  border-radius: .75rem;
  padding-block: 1rem;
  padding-inline: 1.125rem;
}
.agent-message--user {
  align-items: flex-start;
  display: flex;
  gap: .625rem;
  justify-content: flex-end;
  margin-inline-start: auto;
  width: 100%;
}
.agent-message--user .agent-message__content {
  max-width: min(34rem, 78%);
  order: 2;
  width: fit-content;
}
.agent-message--user .agent-message__surface {
  background: var(--agent-thread-user-surface);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 36%, rgb(var(--v-theme-on-surface)) 16%);
  border-radius: .875rem;
  border-end-start-radius: .375rem;
  padding-block: .75rem;
  padding-inline: 1rem;
}
.agent-message__identity--user {
  align-items: end;
  display: grid;
  flex: 0 0 auto;
  gap: .25rem;
  order: 1;
  padding-block-start: .625rem;
  text-align: end;
}
.agent-message__identity--user .agent-message__status { justify-content: flex-end; }
.agent-message__surface :deep(.agent-markdown) { min-width: 0; }
.agent-message__surface :deep(.agent-markdown > :first-child) { margin-block-start: 0; }
.agent-message__surface :deep(.agent-markdown > :last-child) { margin-block-end: 0; }
.agent-message__surface :deep(p) { margin-block: 0 .875rem; }
.agent-message__surface :deep(ul),
.agent-message__surface :deep(ol) {
  margin-block: .75rem;
  padding-inline-start: 1.5rem;
}
.agent-message__surface :deep(li + li) { margin-block-start: .25rem; }
.agent-message__surface :deep(h1),
.agent-message__surface :deep(h2),
.agent-message__surface :deep(h3),
.agent-message__surface :deep(h4) {
  font-family: inherit;
  line-height: 1.3;
  margin-block: 1.25rem .5rem;
}
.agent-sources {
  border-block-start: 1px solid var(--agent-thread-divider);
  padding-block-start: .875rem;
}
.agent-sources__heading {
  align-items: center;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  display: flex;
  font-size: .82rem;
  gap: .4rem;
  margin-block-end: .5rem;
}
.agent-sources__groups {
  display: grid;
  gap: .5rem;
  list-style: none;
  margin: 0;
  padding: 0;
}
.agent-sources__group {
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--agent-thread-border);
  border-radius: .625rem;
  overflow: hidden;
}
.agent-sources__page,
.agent-sources__sections a,
.agent-sources__sections span {
  align-items: center;
  color: inherit;
  display: grid;
  gap: .5rem;
  grid-template-columns: auto minmax(0, 1fr) auto;
  line-height: 1.45;
  min-height: 2.5rem;
  padding-block: .5rem;
  padding-inline: .625rem;
  text-decoration: none;
}
.agent-sources__page strong {
  font-size: .88rem;
  min-width: 0;
  overflow-wrap: anywhere;
}
.agent-sources__page:hover,
.agent-sources__sections a:hover {
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 12%, rgb(var(--v-theme-surface)));
}
.agent-sources__page:focus-visible,
.agent-sources__sections a:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
}
.agent-sources__sections {
  border-block-start: 1px solid var(--agent-thread-divider);
  list-style: none;
  margin: 0;
  padding-block: .25rem .375rem;
  padding-inline: 1.25rem 0;
}
.agent-sources__sections li { position: relative; }
.agent-sources__sections li::before {
  background: var(--agent-thread-border);
  content: '';
  height: 100%;
  inset-block-start: -50%;
  inset-inline-start: -.625rem;
  position: absolute;
  width: 1px;
}
.agent-sources__sections span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.agent-sources__number {
  align-items: center;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 16%, rgb(var(--v-theme-surface)));
  border-radius: 999px;
  color: rgb(var(--v-theme-on-surface));
  display: inline-flex;
  font-size: .72rem;
  font-weight: 700;
  height: 1.4rem;
  justify-content: center;
  width: 1.4rem;
}
.agent-page-links {
  border-block-start: 1px solid var(--agent-thread-divider);
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
  padding-block-start: .875rem;
}
.agent-page-links a {
  align-items: center;
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--agent-thread-border);
  border-radius: .5rem;
  color: rgb(var(--v-theme-primary));
  display: inline-flex;
  gap: .4rem;
  line-height: 1.35;
  min-height: 2.25rem;
  overflow-wrap: anywhere;
  padding-block: .375rem;
  padding-inline: .625rem;
  text-decoration: none;
}
.agent-page-links a:hover {
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 16%, rgb(var(--v-theme-surface)));
  color: rgb(var(--v-theme-on-surface));
}
.agent-page-links a:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
.agent-activity {
  border-block-start: 1px solid var(--agent-thread-divider);
  padding-block-start: .75rem;
}
.agent-activity summary {
  align-items: center;
  border-radius: .375rem;
  cursor: pointer;
  display: flex;
  gap: .5rem;
  list-style: none;
  min-height: 2.25rem;
}
.agent-activity summary::-webkit-details-marker { display: none; }
.agent-activity summary::after {
  content: '›';
  font-size: 1.25rem;
  margin-inline-start: auto;
  transform: rotate(90deg);
  transition: transform .15s ease;
}
.agent-activity[open] summary::after { transform: rotate(270deg); }
.agent-activity summary:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
.agent-activity__list {
  display: grid;
  gap: .625rem;
  list-style: none;
  margin-block: .75rem 0;
  padding: 0;
}
.agent-activity__list li {
  align-items: start;
  display: grid;
  gap: .5rem;
  grid-template-columns: auto minmax(0, 1fr);
}
.agent-activity__list small {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 70%, transparent);
  display: block;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.sr-status {
  border: 0;
  clip: rect(0, 0, 0, 0);
  height: 1px;
  margin: -1px;
  overflow: hidden;
  padding: 0;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}
.artifact-grid {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr));
}
.artifact-card { margin: 0; }
.artifact-card a {
  border-radius: .5rem;
  display: block;
}
.artifact-card a:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 3px;
}
.artifact-card img {
  border: 1px solid var(--agent-thread-border);
  border-radius: .5rem;
  display: block;
  height: auto;
  max-width: 100%;
}
@keyframes agentStatusPulse {
  0%, 100% { opacity: .4; transform: scale(.8); }
  50% { opacity: 1; transform: scale(1); }
}
@media (max-width: 599.98px) {
  .agent-message { margin-block-end: 1.25rem; }
  .agent-message--assistant {
    gap: .5rem;
    grid-template-columns: 1.75rem minmax(0, 1fr);
  }
  .agent-message--assistant .agent-message__surface {
    padding-block: .875rem;
    padding-inline: .875rem;
  }
  .agent-message--user {
    gap: .5rem;
  }
  .agent-message--user .agent-message__content {
    max-width: calc(100% - 3.75rem);
  }
  .agent-message--user .agent-message__surface {
    padding-block: .6875rem;
    padding-inline: .875rem;
  }
  .agent-message__surface {
    font-size: .94rem;
    line-height: 1.64;
  }
  .agent-sources__sections { padding-inline-start: .875rem; }
  .agent-sources__sections li::before { inset-inline-start: -.375rem; }
}
@media (prefers-reduced-motion: reduce) {
  .agent-activity summary::after { transition: none; }
  .agent-message__status-dot { animation: none !important; }
}
@media (forced-colors: active) {
  .agent-message__identity :deep(.v-avatar),
  .agent-message__surface,
  .agent-sources__group,
  .agent-page-links a,
  .artifact-card img {
    background: Canvas;
    border-color: CanvasText;
  }
  .agent-message--user .agent-message__surface { border-width: 2px; }
  .agent-message__status-dot,
  .agent-sources__number { background: CanvasText; color: Canvas; }
  .agent-sources__page:focus-visible,
  .agent-sources__sections a:focus-visible,
  .agent-page-links a:focus-visible,
  .agent-activity summary:focus-visible,
  .artifact-card a:focus-visible {
    outline-color: Highlight;
  }
}
</style>
