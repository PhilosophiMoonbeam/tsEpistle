<template>
  <section class="agent-thread" aria-label="Agent conversation">
    <div class="sr-status" aria-live="polite" aria-atomic="true">{{ liveSummary }}</div>
    <div v-if="!thread.messages.length" class="agent-thread__empty">
      <v-icon icon="mdi-bookshelf" size="24" aria-hidden="true" />
      <div>
        <strong>Begin a grounded conversation</strong>
        <p>Ask a question to search and read Wiki pages you are allowed to access.</p>
      </div>
    </div>
    <template v-for="entry in threadPresentation.orderedMessages" :key="entry.message.id">
      <article
        class="agent-message"
        :class="[`agent-message--${entry.message.role}`, `agent-message--${entry.message.status}`]"
        :aria-busy="entry.message.status === 'pending' || entry.message.status === 'streaming'"
        :aria-label="entry.ariaLabel"
      >
        <div v-if="entry.message.role === 'assistant'" class="agent-message__identity" aria-hidden="true">
          <v-avatar color="primary" size="28" variant="tonal">
            <v-icon icon="mdi-auto-fix" size="16" />
          </v-avatar>
        </div>
        <header v-else class="agent-message__identity agent-message__identity--user">
          <span class="agent-message__role">You</span>
          <time
            class="agent-message__time"
            :datetime="entry.message.createdAt"
            :title="messageTimestamp(entry.message.createdAt)"
          >{{ messageTime(entry.message.createdAt) }}</time>
          <span
            v-if="entry.statusLabel"
            class="agent-message__status"
            :class="`agent-message__status--${entry.message.status}`"
          >
            <span class="agent-message__status-dot" aria-hidden="true" />
            {{ entry.statusLabel }}
          </span>
        </header>
        <div class="agent-message__content">
          <header v-if="entry.message.role === 'assistant'" class="agent-message__meta text-body-small">
            <span class="agent-message__role">Wiki Agent</span>
            <time
              class="agent-message__time"
              :datetime="entry.message.createdAt"
              :title="messageTimestamp(entry.message.createdAt)"
            >{{ messageTime(entry.message.createdAt) }}</time>
            <span
              v-if="entry.statusLabel"
              class="agent-message__status"
              :class="`agent-message__status--${entry.message.status}`"
            >
              <span class="agent-message__status-dot" aria-hidden="true" />
              {{ entry.statusLabel }}
            </span>
          </header>
          <div class="agent-message__surface">
            <AgentTaskProgress
              v-if="entry.message.role === 'assistant' && entry.run?.tasks.length"
              :tasks="entry.run?.tasks ?? []"
            />
            <AgentMarkdown
              v-if="entry.message.content"
              :content="entry.message.content"
              :citations="entry.message.citations"
              :streaming="entry.message.status === 'streaming'"
            />
            <div
              v-else-if="entry.message.status === 'pending' || entry.message.status === 'streaming'"
              class="agent-message__waiting"
            >
              <span class="agent-message__waiting-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>{{ entry.message.role === 'user' ? 'Sending message' : 'Composing response' }}</span>
            </div>
            <p v-else-if="entry.message.status === 'complete'" class="agent-message__terminal-copy">
              No response content was returned.
            </p>
            <aside
              v-if="entry.recovery"
              class="agent-message__recovery"
            >
              <v-icon
                :icon="entry.message.status === 'failed' ? 'mdi-alert-circle-outline' : 'mdi-stop-circle-outline'"
                size="20"
                aria-hidden="true"
              />
              <div>
                <strong>{{ entry.recovery.title }}</strong>
                <span>{{ entry.recovery.description }}</span>
              </div>
              <v-btn
                v-if="entry.retryPrompt"
                size="small"
                variant="text"
                :disabled="canSubmit === false"
                prepend-icon="mdi-reload"
                @click="$emit('suggest', entry.retryPrompt)"
              >
                Try again
              </v-btn>
            </aside>
            <details v-if="entry.message.citations.length" class="agent-sources mt-3" aria-label="Sources">
              <summary class="agent-sources__heading">
                <v-icon icon="mdi-book-open-page-variant-outline" size="18" aria-hidden="true" />
                <strong>Sources</strong>
                <span class="agent-sources__count">{{ entry.message.citations.length }}</span>
              </summary>
              <ol class="agent-sources__groups">
                <li v-for="group in entry.citationGroups" :key="group.key" class="agent-sources__group">
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
                    <span v-if="group.pageHref" class="agent-sources__new-window"> (opens in a new tab)</span>
                  </component>
                  <ol v-if="group.sections.length" class="agent-sources__sections">
                    <li v-for="citationEntry in group.sections" :key="citationEntry.citation.evidenceId">
                      <component
                        :is="citationEntry.citation.href ? 'a' : 'span'"
                        :href="citationEntry.citation.href || undefined"
                        :target="citationEntry.citation.href ? '_blank' : undefined"
                        :rel="citationEntry.citation.href ? 'noopener noreferrer' : undefined"
                        :aria-label="`Citation ${citationEntry.number}: ${citationEntry.citation.label}${citationEntry.citation.href ? ' (opens in a new tab)' : ''}`"
                      >
                        <span class="agent-sources__number">{{ citationEntry.number }}</span>
                        <span class="agent-sources__label">{{ citationEntry.sectionLabel }}</span>
                        <v-icon v-if="citationEntry.citation.href" icon="mdi-open-in-new" size="14" aria-hidden="true" />
                      </component>
                    </li>
                  </ol>
                </li>
              </ol>
            </details>
            <nav
              v-if="entry.message.role === 'assistant' && entry.run?.pageLinks.length"
              class="agent-page-links mt-3"
              aria-label="Changed pages"
            >
              <a
                v-for="link in entry.run?.pageLinks"
                :key="link.href"
                :href="link.href"
                :title="`Open ${link.label}`"
              >
                <v-icon icon="mdi-file-link-outline" size="18" aria-hidden="true" />
                <span>{{ link.label }}</span>
              </a>
            </nav>
            <details
              v-if="entry.message.role === 'assistant' && entry.run?.activity.length"
              class="agent-activity mt-3"
            >
              <summary>
                <v-icon icon="mdi-format-list-checks" size="18" />
                <span>{{ entry.run?.activityLabel }}</span>
              </summary>
              <ul class="agent-activity__list">
                <li v-for="tool in entry.run?.activity" :key="tool.id">
                  <v-icon :icon="toolStateIcon(tool.state)" :color="toolStateColor(tool.state)" size="18" />
                  <span>
                    <strong>{{ tool.summary ? tool.summary : tool.title }}</strong>
                    <small>{{ tool.summary ? `${tool.title} · ` : '' }}{{ tool.actionName }} · {{ toolStateLabel(tool.state) }}</small>
                  </span>
                </li>
              </ul>
            </details>
          </div>
        </div>
      </article>
      <AgentToolCard
        v-for="proposalEntry in entry.message.role === 'assistant' ? entry.run?.proposals ?? [] : []"
        :key="proposalEntry.tool.id"
        :tool="proposalEntry.tool"
        :proposal="proposalEntry.proposal"
        :busy="Boolean(decidingApprovalId && proposalEntry.proposal.approval?.id === decidingApprovalId)"
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
    <div v-if="thread.suggestions.length" class="agent-suggestions" aria-label="Follow-up suggestions">
      <v-btn
        v-for="suggestion in thread.suggestions"
        :key="suggestion.id"
        variant="tonal"
        size="small"
        :disabled="canSubmit === false"
        @click="$emit('suggest', suggestion.prompt)"
      >{{ suggestion.label }}</v-btn>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentToolState, AgentThreadState } from '../../../shared/agents/contracts.ts'
import AgentMarkdown from './agent-markdown.vue'
import AgentTaskProgress from './agent-task-progress.vue'
import AgentToolCard from './agent-tool-card.vue'
import {
  agentLiveAnnouncement,
  buildAgentThreadPresentation
} from './agent-thread-presentation.ts'

const props = defineProps<{ thread: AgentThreadState; connection: string; decidingApprovalId?: string | null; canSubmit?: boolean }>()

const messageTimeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const messageTimestampFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const messageTemporalMetadata = computed(() => {
  const metadata = new Map<string, { time: string; timestamp: string }>()
  for (const message of props.thread.messages) {
    if (metadata.has(message.createdAt)) continue
    const date = new Date(message.createdAt)
    metadata.set(message.createdAt, Number.isNaN(date.valueOf())
      ? { time: '', timestamp: message.createdAt }
      : { time: messageTimeFormat.format(date), timestamp: messageTimestampFormat.format(date) })
  }
  return metadata
})
const messageTime = (createdAt: string): string => messageTemporalMetadata.value.get(createdAt)?.time ?? ''
const messageTimestamp = (createdAt: string): string => messageTemporalMetadata.value.get(createdAt)?.timestamp ?? createdAt
const threadPresentation = computed(() => buildAgentThreadPresentation(
  props.thread.messages,
  props.thread.tools,
  props.thread.tasks,
  props.thread.proposals
))
const stateLabels: Record<AgentToolState, string> = { preparing: 'Preparing', running: 'Running', awaitingApproval: 'Awaiting approval', complete: 'Complete', failed: 'Failed', denied: 'Denied', cancelled: 'Cancelled' }
const stateIcons: Record<AgentToolState, string> = { preparing: 'mdi-dots-horizontal', running: 'mdi-progress-clock', awaitingApproval: 'mdi-shield-alert-outline', complete: 'mdi-check-circle-outline', failed: 'mdi-alert-circle-outline', denied: 'mdi-cancel', cancelled: 'mdi-stop-circle-outline' }
const toolStateLabel = (state: AgentToolState): string => stateLabels[state]
const toolStateIcon = (state: AgentToolState): string => stateIcons[state]
const toolStateColor = (state: AgentToolState): string | undefined => {
  if (state === 'complete') return 'success'
  if (state === 'failed' || state === 'denied') return 'error'
  if (state === 'cancelled') return undefined
  return 'primary'
}
const currentLiveAnnouncement = computed(() => {
  if (props.connection === 'reconnecting') {
    return { key: 'connection:reconnecting', message: 'Connection interrupted. Reconnecting.' }
  }
  return agentLiveAnnouncement(props.thread.messages, props.thread.tools)
})
const liveSummary = ref('')
watch(
  [() => props.thread.session.id, currentLiveAnnouncement],
  ([sessionId, announcement], [previousSessionId, previousAnnouncement]) => {
    if (sessionId !== previousSessionId) {
      liveSummary.value = ''
      return
    }
    if (announcement?.key === previousAnnouncement?.key) return
    liveSummary.value = announcement?.message ?? ''
  }
)
</script>

<style scoped>
.agent-thread {
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-body);
  margin-inline: auto;
  max-width: calc(var(--wiki-space-12) * 18);
  min-height: calc(var(--wiki-space-12) * 4);
  width: 100%;
}

.agent-thread__empty {
  align-items: start;
  background: var(--wiki-surface-sunken);
  border: 1px dashed var(--wiki-surface-border-strong);
  border-radius: var(--wiki-panel-radius);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  display: grid;
  gap: var(--wiki-space-3);
  grid-template-columns: auto minmax(0, 1fr);
  padding: var(--wiki-space-5);
}

.agent-thread__empty > .v-icon {
  color: var(--wiki-accent-warm);
  margin-block-start: var(--wiki-space-1);
}

.agent-thread__empty strong {
  color: rgb(var(--v-theme-on-surface));
  display: block;
  font-family: var(--wiki-font-heading);
  font-size: .95rem;
  font-weight: 700;
}

.agent-thread__empty p {
  margin: var(--wiki-space-1) 0 0;
}

.agent-message {
  color: rgb(var(--v-theme-on-surface));
  margin-block-end: var(--wiki-space-8);
  max-width: 100%;
  overflow-wrap: anywhere;
}

.agent-message__content {
  min-width: 0;
}

.agent-message__meta {
  align-items: center;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  margin-block-end: var(--wiki-space-2);
  min-height: var(--wiki-space-6);
}

.agent-message__role {
  color: rgb(var(--v-theme-on-surface));
  font-size: .78rem;
  font-weight: 720;
  letter-spacing: .025em;
  line-height: 1.35;
}

.agent-message__time {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 52%, transparent);
  font-family: var(--wiki-font-mono);
  font-size: var(--wiki-label-size);
  line-height: 1.35;
}

.agent-message__time::before {
  content: '·';
  margin-inline-end: var(--wiki-space-2);
}

.agent-message__status {
  align-items: center;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
  display: inline-flex;
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  gap: var(--wiki-space-1);
  letter-spacing: .025em;
  line-height: 1.35;
  white-space: nowrap;
}

.agent-message__status-dot {
  background: var(--wiki-accent-warm);
  border-radius: var(--wiki-radius-pill);
  flex: 0 0 auto;
  height: var(--wiki-space-1);
  width: var(--wiki-space-1);
}

.agent-message__status--pending .agent-message__status-dot,
.agent-message__status--streaming .agent-message__status-dot {
  animation: agentStatusPulse 1.6s var(--wiki-motion-ease) infinite;
}

.agent-message__status--failed {
  color: rgb(var(--v-theme-error));
}

.agent-message__status--failed .agent-message__status-dot {
  background: currentColor;
}

.agent-message__status--cancelled .agent-message__status-dot {
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 48%, transparent);
}

.agent-message--assistant {
  align-items: start;
  display: grid;
  gap: var(--wiki-space-3);
  grid-template-columns: var(--wiki-space-8) minmax(0, 1fr);
}

.agent-message--assistant .agent-message__content {
  max-width: calc(var(--wiki-space-12) * 16);
}

.agent-message__identity {
  align-self: start;
  min-width: 0;
}

.agent-message__identity :deep(.v-avatar) {
  background: color-mix(in srgb, var(--wiki-accent-warm) 9%, var(--wiki-surface-raised)) !important;
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 24%, var(--wiki-surface-border));
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
}

.agent-message__surface {
  font-size: .96rem;
  line-height: var(--wiki-leading-body);
  min-width: 0;
}

.agent-message--assistant .agent-message__surface {
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--wiki-surface-border);
  border-inline-start: var(--wiki-space-1) solid color-mix(in srgb, var(--wiki-accent-warm) 62%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
  padding: var(--wiki-space-4) var(--wiki-space-5);
}

.agent-message--assistant.agent-message--pending .agent-message__surface,
.agent-message--assistant.agent-message--streaming .agent-message__surface {
  border-inline-start-color: var(--wiki-accent-warm);
}

.agent-message--assistant.agent-message--failed .agent-message__surface {
  border-inline-start-color: rgb(var(--v-theme-error));
}

.agent-message--assistant.agent-message--cancelled .agent-message__surface {
  border-inline-start-color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 48%, var(--wiki-surface-border));
}

.agent-message--user {
  align-items: flex-start;
  display: flex;
  gap: var(--wiki-space-2);
  justify-content: flex-end;
  margin-inline-start: auto;
  width: 100%;
}

.agent-message--user .agent-message__content {
  max-width: min(calc(var(--wiki-space-12) * 12), 76%);
  order: 2;
  width: fit-content;
}

.agent-message--user .agent-message__surface {
  background: color-mix(in srgb, var(--wiki-surface-sunken) 94%, var(--wiki-accent-warm) 6%);
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 24%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  border-end-start-radius: var(--wiki-radius-xs);
  box-shadow: var(--wiki-shadow-inset);
  padding: var(--wiki-space-3) var(--wiki-space-4);
}

.agent-message__identity--user {
  align-items: end;
  display: grid;
  flex: 0 0 auto;
  gap: var(--wiki-space-1);
  order: 1;
  padding-block-start: var(--wiki-space-3);
  text-align: end;
}

.agent-message__identity--user .agent-message__time::before {
  content: none;
}

.agent-message__identity--user .agent-message__status {
  justify-content: flex-end;
}

.agent-message__terminal-copy {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
  margin: 0;
}

.agent-message__waiting {
  align-items: center;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
  display: inline-flex;
  font-size: .86rem;
  gap: var(--wiki-space-2);
  min-height: var(--wiki-space-6);
}

.agent-message__waiting-dots {
  align-items: center;
  display: inline-flex;
  gap: var(--wiki-space-1);
}

.agent-message__waiting-dots > span {
  animation: agentWaitingDot 1.25s var(--wiki-motion-ease) infinite;
  background: var(--wiki-accent-warm);
  border-radius: var(--wiki-radius-pill);
  height: var(--wiki-space-1);
  width: var(--wiki-space-1);
}

.agent-message__waiting-dots > span:nth-child(2) {
  animation-delay: var(--wiki-motion-fast);
}

.agent-message__waiting-dots > span:nth-child(3) {
  animation-delay: calc(var(--wiki-motion-fast) * 2);
}

.agent-message__recovery {
  align-items: center;
  border-block-start: 1px solid var(--wiki-surface-border);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  display: grid;
  gap: var(--wiki-space-3);
  grid-template-columns: auto minmax(0, 1fr) auto;
  margin-block-start: var(--wiki-space-4);
  padding-block-start: var(--wiki-space-3);
}

.agent-message__recovery > .v-icon {
  color: rgb(var(--v-theme-error));
}

.agent-message--cancelled .agent-message__recovery > .v-icon {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
}

.agent-message__recovery strong,
.agent-message__recovery span {
  display: block;
}

.agent-message__recovery strong {
  color: rgb(var(--v-theme-on-surface));
  font-size: .82rem;
  line-height: 1.4;
}

.agent-message__recovery span {
  font-size: .76rem;
  line-height: 1.45;
  margin-block-start: var(--wiki-space-1);
}

.agent-sources {
  background: var(--wiki-surface-sunken);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  margin-block-start: var(--wiki-space-4) !important;
  overflow: hidden;
}

.agent-sources__heading {
  align-items: center;
  background: color-mix(in srgb, var(--wiki-surface-raised) 84%, var(--wiki-surface-sunken));
  border-block-end: 1px solid var(--wiki-surface-border);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  cursor: pointer;
  display: flex;
  font-size: .78rem;
  gap: var(--wiki-space-2);
  list-style: none;
  min-height: var(--wiki-space-10);
  padding-inline: var(--wiki-space-3);
}

.agent-sources__heading::-webkit-details-marker {
  display: none;
}

.agent-sources__heading::after {
  content: '›';
  font-size: 1.25rem;
  margin-inline-start: var(--wiki-space-1);
  transform: rotate(90deg);
  transition: transform var(--wiki-motion-fast) var(--wiki-motion-ease-out);
}

.agent-sources[open] > .agent-sources__heading::after {
  transform: rotate(270deg);
}

.agent-sources__heading > .v-icon {
  color: var(--wiki-accent-warm);
}

.agent-sources__heading strong {
  color: rgb(var(--v-theme-on-surface));
  font-weight: 700;
}

.agent-sources__count {
  align-items: center;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 8%, transparent);
  border-radius: var(--wiki-radius-pill);
  display: inline-flex;
  font-family: var(--wiki-font-mono);
  font-size: var(--wiki-label-size);
  justify-content: center;
  margin-inline-start: auto;
  min-height: var(--wiki-space-5);
  min-width: var(--wiki-space-5);
  padding-inline: var(--wiki-space-1);
}

.agent-sources__groups {
  list-style: none;
  margin: 0;
  padding: 0;
}

.agent-sources__group + .agent-sources__group {
  border-block-start: 1px solid var(--wiki-surface-border);
}

.agent-sources__page,
.agent-sources__sections > li > a,
.agent-sources__sections > li > span {
  align-items: center;
  color: inherit;
  display: grid;
  gap: var(--wiki-space-2);
  grid-template-columns: auto minmax(0, 1fr) auto;
  line-height: 1.45;
  min-height: var(--wiki-space-10);
  padding: var(--wiki-space-2) var(--wiki-space-3);
  text-decoration: none;
}

.agent-sources__page strong {
  font-size: .84rem;
  min-width: 0;
  overflow-wrap: anywhere;
}

.agent-sources__page:hover,
.agent-sources__sections a:hover {
  background: color-mix(in srgb, var(--wiki-ambient-accent) 9%, transparent);
}

.agent-sources__heading:focus-visible,
.agent-sources__page:focus-visible,
.agent-sources__sections a:focus-visible,
.agent-page-links a:focus-visible,
.agent-activity summary:focus-visible,
.artifact-card a:focus-visible {
  border-radius: var(--wiki-radius-xs);
  box-shadow: var(--wiki-focus-ring);
  outline: 2px solid var(--wiki-focus-color);
  outline-offset: var(--wiki-focus-offset);
}

.agent-sources__sections {
  border-block-start: 1px solid var(--wiki-surface-border);
  list-style: none;
  margin: 0;
  padding: var(--wiki-space-1) 0 var(--wiki-space-2) var(--wiki-space-5);
}

[dir='rtl'] .agent-sources__sections {
  padding: var(--wiki-space-1) var(--wiki-space-5) var(--wiki-space-2) 0;
}

.agent-sources__sections li {
  position: relative;
}

.agent-sources__sections li::before {
  background: var(--wiki-surface-border-strong);
  content: '';
  height: 100%;
  inset-block-start: -50%;
  inset-inline-start: calc(var(--wiki-space-3) * -1);
  position: absolute;
  width: 1px;
}

.agent-sources__label {
  min-width: 0;
  overflow-wrap: anywhere;
}

.agent-sources__number {
  align-items: center;
  background: color-mix(in srgb, var(--wiki-accent-warm) 11%, var(--wiki-surface-raised));
  block-size: var(--wiki-space-6);
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 18%, var(--wiki-surface-border));
  border-radius: var(--wiki-radius-pill);
  box-sizing: border-box;
  color: rgb(var(--v-theme-on-surface));
  display: inline-grid;
  font-family: var(--wiki-font-mono);
  font-size: var(--wiki-label-size);
  font-weight: 720;
  inline-size: var(--wiki-space-6);
  justify-items: center;
  justify-self: start;
  line-height: 1;
}

.agent-page-links {
  border-block-start: 1px solid var(--wiki-surface-border);
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  margin-block-start: var(--wiki-space-4) !important;
  padding-block-start: var(--wiki-space-3);
}

.agent-page-links a {
  align-items: center;
  background: var(--wiki-surface-sunken);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  color: rgb(var(--v-theme-primary));
  display: inline-flex;
  gap: var(--wiki-space-2);
  line-height: 1.35;
  min-height: var(--wiki-control-height);
  overflow-wrap: anywhere;
  padding-inline: var(--wiki-space-3);
  text-decoration: none;
  transition:
    background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.agent-page-links a:hover {
  background: color-mix(in srgb, var(--wiki-ambient-accent) 11%, var(--wiki-surface-sunken));
  border-color: var(--wiki-surface-border-strong);
}

.agent-activity {
  border-block-start: 1px solid var(--wiki-surface-border);
  margin-block-start: var(--wiki-space-4) !important;
  padding-block-start: var(--wiki-space-2);
}

.agent-activity summary {
  align-items: center;
  border-radius: var(--wiki-radius-xs);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 74%, transparent);
  cursor: pointer;
  display: flex;
  font-size: .82rem;
  font-weight: 650;
  gap: var(--wiki-space-2);
  list-style: none;
  min-height: var(--wiki-control-height);
}

.agent-activity summary::-webkit-details-marker {
  display: none;
}

.agent-activity summary::after {
  content: '›';
  font-size: 1.25rem;
  margin-inline-start: auto;
  transform: rotate(90deg);
  transition: transform var(--wiki-motion-fast) var(--wiki-motion-ease-out);
}

.agent-activity[open] summary::after {
  transform: rotate(270deg);
}

.agent-activity__list {
  display: grid;
  gap: var(--wiki-space-3);
  list-style: none;
  margin-block: var(--wiki-space-3) 0;
  padding: 0;
}

.agent-activity__list li {
  align-items: start;
  display: grid;
  gap: var(--wiki-space-2);
  grid-template-columns: auto minmax(0, 1fr);
}

.agent-activity__list small {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  display: block;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.agent-sources__new-window,
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
  gap: var(--wiki-space-4);
  grid-template-columns: repeat(auto-fit, minmax(min(calc(var(--wiki-space-12) * 6), 100%), 1fr));
  margin-block-start: var(--wiki-space-5) !important;
}

.artifact-card {
  margin: 0;
}

.artifact-card a {
  border-radius: var(--wiki-control-radius);
  display: block;
}

.artifact-card img {
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  box-shadow: var(--wiki-shadow-xs);
  display: block;
  height: auto;
  max-width: 100%;
}

.artifact-card figcaption {
  margin-block-start: var(--wiki-space-2);
}

.agent-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  margin-block-start: var(--wiki-space-5);
}

@keyframes agentStatusPulse {
  0%,
  100% {
    opacity: .4;
    transform: scale(.75);
  }

  50% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes agentWaitingDot {
  0%,
  60%,
  100% {
    opacity: .35;
    transform: translateY(0);
  }

  30% {
    opacity: 1;
    transform: translateY(calc(var(--wiki-space-1) * -.5));
  }
}

@media (max-width: 599.98px) {
  .agent-message {
    margin-block-end: var(--wiki-space-6);
  }

  .agent-message--assistant {
    gap: var(--wiki-space-2);
    grid-template-columns: var(--wiki-space-6) minmax(0, 1fr);
  }

  .agent-message__identity :deep(.v-avatar) {
    height: var(--wiki-space-6) !important;
    min-width: var(--wiki-space-6) !important;
    width: var(--wiki-space-6) !important;
  }

  .agent-message--assistant .agent-message__surface {
    border-inline-start-width: var(--wiki-space-1);
    padding: var(--wiki-space-3);
  }

  .agent-message--user {
    display: grid;
    gap: var(--wiki-space-1);
    justify-items: end;
  }

  .agent-message--user .agent-message__content {
    max-width: calc(100% - var(--wiki-space-8));
    order: 2;
  }

  .agent-message__identity--user {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--wiki-space-2);
    order: 1;
    padding-block-start: 0;
  }

  .agent-message__identity--user .agent-message__time::before {
    content: '·';
    margin-inline-end: var(--wiki-space-2);
  }

  .agent-message--user .agent-message__surface {
    padding: var(--wiki-space-2) var(--wiki-space-3);
  }

  .agent-message__surface {
    font-size: .94rem;
  }

  .agent-message__recovery {
    align-items: start;
    grid-template-columns: auto minmax(0, 1fr);
  }

  .agent-message__recovery :deep(.v-btn) {
    grid-column: 2;
    justify-self: start;
  }

  .agent-sources__sections {
    padding-inline-start: var(--wiki-space-4);
  }

  [dir='rtl'] .agent-sources__sections {
    padding-inline-end: var(--wiki-space-4);
    padding-inline-start: 0;
  }

  .agent-sources__sections li::before {
    inset-inline-start: calc(var(--wiki-space-2) * -1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-sources__heading::after,
  .agent-activity summary::after,
  .agent-page-links a {
    transition: none;
  }

  .agent-message__status-dot,
  .agent-message__waiting-dots > span {
    animation: none !important;
  }
}

@media (forced-colors: active) {
  .agent-thread__empty,
  .agent-message__identity :deep(.v-avatar),
  .agent-message__surface,
  .agent-message__recovery,
  .agent-sources,
  .agent-page-links a,
  .artifact-card img {
    background: Canvas;
    border-color: CanvasText;
    color: CanvasText;
  }

  .agent-message--user .agent-message__surface {
    border-width: 2px;
  }

  .agent-message__status-dot,
  .agent-message__waiting-dots > span,
  .agent-sources__number {
    background: CanvasText;
    color: Canvas;
  }

  .agent-sources__heading:focus-visible,
  .agent-sources__page:focus-visible,
  .agent-sources__sections a:focus-visible,
  .agent-page-links a:focus-visible,
  .agent-activity summary:focus-visible,
  .artifact-card a:focus-visible {
    outline-color: Highlight;
  }
}
</style>
