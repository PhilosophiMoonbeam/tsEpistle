<template>
  <section class="agent-thread" :aria-label="$t('common:agentThread.agentConversation')">
    <div :key="liveSummaryRevision" class="sr-status" aria-live="polite" aria-atomic="true">{{ liveSummary }}</div>
    <aside v-if="thread.historyWindow.hasOlderMessages || thread.historyWindow.hasOlderRuns" class="agent-history-window" role="note">
      <v-icon icon="mdi-history" size="20" aria-hidden="true" />
      <div>
        <strong>{{ $t('common:agentThread.historyWindowTitle', { defaultValue: 'Recent conversation window' }) }}</strong>
        <p v-if="thread.historyWindow.hasOlderMessages">{{ $t('common:agentThread.historyWindowMessages', { limit: thread.historyWindow.messageLimit, defaultValue: `Showing the latest ${thread.historyWindow.messageLimit} messages. Older messages are not included in this view.` }) }}</p>
        <p v-if="thread.historyWindow.hasOlderRuns">{{ $t('common:agentThread.historyWindowRuns', { limit: thread.historyWindow.runLimit, defaultValue: `Showing activity for the latest ${thread.historyWindow.runLimit} runs. Older run activity is not included in this view.` }) }}</p>
      </div>
    </aside>
    <template v-for="entry in threadProjection.orderedMessages" :key="entry.message.id">
      <article
        class="agent-message"
        :class="[`agent-message--${entry.message.role}`, `agent-message--${entry.message.status}`]"
        :aria-busy="entry.message.status === 'pending' || entry.message.status === 'streaming'"
        :aria-label="entry.ariaLabel"
      >
        <div v-if="entry.message.role === 'assistant'" class="agent-message__identity" aria-hidden="true">
          <span class="agent-message__assistant-mark">
            <v-icon icon="mdi-robot-outline" size="18" aria-hidden="true" />
          </span>
        </div>
        <header v-else class="agent-message__identity agent-message__identity--user">
          <div class="agent-message__user-details">
            <span class="agent-message__role">{{ $t('common:agentThread.you') }}</span>
            <time
              class="agent-message__time"
              :datetime="entry.message.createdAt"
              :title="entry.temporal.timestamp"
            >{{ entry.temporal.time }}</time>
            <span
              v-if="entry.statusLabel"
              class="agent-message__status"
              :class="`agent-message__status--${entry.message.status}`"
            >
              <StatusIndicator
                aria-hidden="true"
                role="presentation"
                aria-live="off"
                :aria-atomic="false"
                :active="entry.message.status === 'streaming'"
                :intermediary="entry.message.status === 'pending'"
                :negative="entry.message.status === 'failed'"
                :pulse="entry.message.status === 'pending' || entry.message.status === 'streaming'"
                :label="entry.statusLabel"
              />
              {{ entry.statusLabel }}
            </span>
          </div>
          <v-avatar
            v-if="userPicture.kind === 'image'"
            class="agent-message__user-avatar"
            size="28"
            aria-hidden="true"
          >
            <v-img :src="userPicture.url" alt="" />
          </v-avatar>
          <v-avatar
            v-else
            class="agent-message__user-avatar"
            color="primary"
            size="28"
            aria-hidden="true"
          >
            <span class="agent-message__user-initials">{{ userPicture.initials }}</span>
          </v-avatar>
        </header>
        <div class="agent-message__content">
          <header v-if="entry.message.role === 'assistant'" class="agent-message__meta text-body-small">
            <span class="agent-message__role">{{ $t('common:agentThread.wikiAgent') }}</span>
            <time
              class="agent-message__time"
              :datetime="entry.message.createdAt"
              :title="entry.temporal.timestamp"
            >{{ entry.temporal.time }}</time>
            <span
              v-if="entry.statusLabel"
              class="agent-message__status"
              :class="`agent-message__status--${entry.message.status}`"
            >
              <StatusIndicator
                aria-hidden="true"
                role="presentation"
                aria-live="off"
                :aria-atomic="false"
                :active="entry.message.status === 'streaming'"
                :intermediary="entry.message.status === 'pending'"
                :negative="entry.message.status === 'failed'"
                :pulse="entry.message.status === 'pending' || entry.message.status === 'streaming'"
                :label="entry.statusLabel"
              />
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
              source-previews
              @preview-source="previewSelector = $event"
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
              <span>{{ entry.message.role === 'user' ? $t('common:agentThread.sendingMessage') : $t('common:agentThread.composingResponse') }}</span>
            </div>
            <p v-else-if="entry.message.status === 'complete' && !entry.message.media?.length" class="agent-message__terminal-copy">
              {{ $t('common:agentThread.noResponseContentWas') }}
            </p>
            <div v-if="entry.message.media?.length" class="agent-message__media" :aria-label="$t('common:agentThread.messageAttachments')">
              <figure v-for="media in entry.message.media" :key="media.id">
                <a v-if="media.available && media.mimeType.startsWith('image/')" :href="agentMediaContentUrl(media.id)" target="_blank" rel="noopener noreferrer" :aria-label="$t('common:agentThread.open', { filename: media.filename, interpolation: { escapeValue: false } })">
                  <img :src="agentMediaContentUrl(media.id)" :alt="media.kind === 'generated-image' ? $t('common:agentThread.imageCreatedWikiAgent') : media.filename" loading="lazy" decoding="async" fetchpriority="low" />
                </a>
                <video v-if="media.available && media.kind === 'generated-video'" :src="agentMediaContentUrl(media.id)" controls preload="metadata" playsinline :aria-label="media.filename" />
                <audio v-if="media.available && media.kind === 'generated-audio'" :src="agentMediaContentUrl(media.id)" controls preload="metadata" :aria-label="media.filename" />
                <figcaption>
                  <span v-if="!media.available">{{ $t('common:agentThread.noLongerAvailable', { filename: media.filename, interpolation: { escapeValue: false } }) }}</span>
                  <template v-else-if="media.detached && media.kind === 'attachment'">
                    <span class="agent-message__media-detached">
                      <v-icon icon="mdi-file-remove-outline" size="16" aria-hidden="true" />
                      <span>{{ $t('common:agentThread.detachedContext', { filename: media.filename, interpolation: { escapeValue: false } }) }}</span>
                    </span>
                    <template v-if="reattachConfirmId === media.id">
                      <span class="agent-message__media-confirm">{{ $t('common:agentThread.addFileNextMessage') }}</span>
                      <v-btn variant="text" size="small" color="primary" prepend-icon="mdi-paperclip-plus" @click="confirmReattach(media)">{{ $t('common:agentThread.reAttach') }}</v-btn>
                      <v-btn variant="text" size="small" @click="cancelReattach">{{ $t('common:actions.cancel') }}</v-btn>
                    </template>
                    <v-btn v-else variant="text" size="small" prepend-icon="mdi-paperclip-plus" @click="requestReattach(media)">{{ $t('common:agentThread.reAttach') }}</v-btn>
                  </template>
                  <a v-else :href="agentMediaContentUrl(media.id)" :download="media.filename">{{ media.filename }} <span>{{ $t('common:agentThread.download') }}</span></a>
                  <v-btn v-if="media.kind === 'generated-image' && media.available && imageEditingEnabled" variant="text" size="small" prepend-icon="mdi-image-edit-outline" :disabled="canSubmit === false || networkBlocked" @click="emit('editImage', media)">{{ $t('common:agentThread.editImage') }}</v-btn>
                </figcaption>
              </figure>
            </div>
            <aside
              v-if="entry.recovery"
              class="agent-message__recovery"
              role="region"
              :aria-label="$t('common:agentThread.recoveryRegion')"
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
                :disabled="canSubmit === false || networkBlocked"
                prepend-icon="mdi-reload"
                @click="emit('suggest', entry.retryPrompt)"
              >
                {{ $t('common:agentThread.reviewRequest') }}
              </v-btn>
            </aside>
            <div v-if="entry.message.role === 'user' && entry.message.knowledgeContext" class="agent-message__source-context" :aria-label="$t('common:agentThread.sourceContextUsedMessage')">
              <span>{{ $t('common:agentThread.search', { value: entry.message.knowledgeContext.scope.kind === 'selected' ? $t('common:agentThread.selectedPages') : entry.message.knowledgeContext.scope.kind === 'section' ? entry.message.knowledgeContext.scope.path : entry.message.knowledgeContext.scope.kind === 'locale' ? entry.message.knowledgeContext.scope.locale.toUpperCase() : $t('common:agentThread.allWiki'), interpolation: { escapeValue: false } }) }}</span>
              <v-btn v-for="source in entry.message.knowledgeContext.sources" :key="source.id" size="x-small" variant="text" prepend-icon="mdi-file-document-outline" :aria-label="$t('common:agentThread.preview', { pageLabel: source.title, interpolation: { escapeValue: false } })" @click="previewSelector = { id: source.id }">{{ $t('common:agentThread.revision', { title: source.title, sourceRevision: source.sourceRevision, interpolation: { escapeValue: false } }) }}</v-btn>
            </div>
            <AgentAnswerActions v-if="entry.message.role === 'assistant' && entry.message.status === 'complete' && entry.message.content" :content="entry.message.content" :citations="entry.message.citations" :google-search-grounding="entry.message.googleSearchGrounding" />
            <details v-if="entry.googleSearchCitations?.length" class="agent-sources agent-web-sources mt-3" :aria-label="$t('common:agentThread.googleSearchSources')">
              <summary class="agent-sources__heading">
                <v-icon icon="mdi-web" size="18" aria-hidden="true" />
                <strong>{{ $t('common:agentThread.webSources') }}</strong>
                <span class="agent-sources__origin">{{ $t('common:agentThread.googleSearch') }}</span>
                <span class="agent-sources__count">{{ entry.googleSearchCitations?.length }}</span>
              </summary>
              <ol class="agent-web-sources__list">
                <li v-for="(item, index) in entry.googleSearchCitations" :key="`${item.citation.url}:${item.citation.startIndex}:${item.citation.endIndex}`">
                  <a v-if="item.safeHref" :href="item.safeHref" target="_blank" rel="noopener noreferrer">
                    <span class="agent-sources__number">{{ index + 1 }}</span>
                    <strong>{{ item.citation.title }}</strong>
                    <v-icon icon="mdi-open-in-new" size="14" aria-hidden="true" />
                    <span class="agent-sources__new-window"> {{ $t('common:agentThread.opensNewTab') }}</span>
                  </a>
                  <span v-else>
                    <span class="agent-sources__number">{{ index + 1 }}</span>
                    <strong>{{ item.citation.title }}</strong>
                  </span>
                  <blockquote v-if="item.quote">{{ item.quote }}</blockquote>
                </li>
              </ol>
            </details>
            <details v-if="entry.message.citations.length" class="agent-sources mt-3" :aria-label="$t('common:agentThread.sources')">
              <summary class="agent-sources__heading">
                <v-icon icon="mdi-book-open-page-variant-outline" size="18" aria-hidden="true" />
                <strong>{{ $t('common:agentThread.sources') }}</strong>
                <span class="agent-sources__count">{{ entry.message.citations.length }}</span>
              </summary>
              <ol class="agent-sources__groups">
                <li
                  v-for="group in entry.citationGroups"
                  :key="group.key"
                  class="agent-sources__group"
                >
                  <component
                    :is="group.safeHref ? 'a' : 'div'"
                    class="agent-sources__page"
                    :href="group.safeHref"
                    :target="group.safeHref && !group.previewSelector ? '_blank' : undefined"
                    :rel="group.safeHref ? 'noopener noreferrer' : undefined"
                    @click="previewCitation($event, group.previewSelector)"
                  >
                    <span v-if="group.pageCitation" class="agent-sources__number">{{ group.pageCitation.number }}</span>
                    <v-icon v-else icon="mdi-file-document-outline" size="18" aria-hidden="true" />
                    <strong>{{ group.pageLabel }}</strong>
                    <v-icon v-if="group.safeHref" :icon="group.previewSelector ? 'mdi-text-box-search-outline' : 'mdi-open-in-new'" size="15" aria-hidden="true" />
                    <span v-if="group.safeHref" class="agent-sources__new-window">{{ group.previewSelector ? ` ${$t('common:agentThread.previewSource')}` : ` ${$t('common:agentThread.opensNewTab')}` }}</span>
                  </component>
                  <v-btn v-if="group.previewSelector" class="agent-sources__preview" size="small" variant="text" prepend-icon="mdi-text-box-search-outline" :aria-label="$t('common:agentThread.preview', { pageLabel: group.pageLabel, interpolation: { escapeValue: false } })" @click="previewSelector = group.previewSelector">{{ $t('common:agentThread.previewSource2') }}</v-btn>
                  <ol v-if="group.sections.length" class="agent-sources__sections">
                    <li
                      v-for="citationEntry in group.sections"
                      :key="citationEntry.citation.evidenceId"
                    >
                      <component
                        :is="citationEntry.safeHref ? 'a' : 'span'"
                        :href="citationEntry.safeHref"
                        :target="citationEntry.safeHref && !citationEntry.previewSelector ? '_blank' : undefined"
                        :rel="citationEntry.safeHref ? 'noopener noreferrer' : undefined"
                        :aria-label="$t('common:agentThread.citation', { number: citationEntry.number, label: citationEntry.citation.label, value: citationEntry.previewSelector ? ` ${$t('common:agentThread.previewSource')}` : citationEntry.safeHref ? ` ${$t('common:agentThread.opensNewTab')}` : '', interpolation: { escapeValue: false } })"
                        @click="previewCitation($event, citationEntry.previewSelector)"
                      >
                        <span class="agent-sources__number">{{ citationEntry.number }}</span>
                        <span class="agent-sources__label">{{ citationEntry.sectionLabel }}</span>
                        <v-icon v-if="citationEntry.safeHref" :icon="citationEntry.previewSelector ? 'mdi-text-box-search-outline' : 'mdi-open-in-new'" size="14" aria-hidden="true" />
                      </component>
                    </li>
                  </ol>
                </li>
              </ol>
            </details>
            <AgentSearchSuggestions
              v-if="entry.message.role === 'assistant' && entry.message.runId && googleSearchSuggestions?.runId === entry.message.runId && googleSearchSuggestions.suggestions.length"
              :suggestions="googleSearchSuggestions.suggestions"
            />
            <nav
              v-if="entry.message.role === 'assistant' && entry.run?.pageLinks.length"
              class="agent-page-links mt-3"
              :aria-label="$t('common:agentThread.changedPages')"
            >
              <component
                :is="link.safeHref ? 'a' : 'span'"
                v-for="link in entry.run?.pageLinks"
                :key="link.href"
                :href="link.safeHref"
                :title="link.safeHref ? $t('common:agentThread.open2', { label: link.label, interpolation: { escapeValue: false } }) : undefined"
              >
                <v-icon icon="mdi-file-link-outline" size="18" aria-hidden="true" />
                <span>{{ link.label }}</span>
              </component>
            </nav>
            <details
              v-if="entry.message.role === 'assistant' && entry.run?.activity.length"
              class="agent-activity mt-3"
              :open="activityOpen(entry)"
              @toggle="handleActivityToggle($event, entry)"
            >
              <summary @click="markActivityToggle(entry)">
                <v-icon icon="mdi-format-list-checks" size="18" aria-hidden="true" />
                <span>{{ entry.run?.activityLabel }}</span>
              </summary>
              <ul class="agent-activity__list">
                <li v-for="tool in entry.run?.activity" :key="tool.id">
                  <v-icon :icon="toolStateIcon(tool.state)" :color="toolStateColor(tool.state)" size="18" aria-hidden="true" />
                  <span>
                    <strong>{{ tool.title }}</strong>
                    <small>{{ toolStateLabel(tool.state) }}</small>
                    <span v-if="tool.summary">{{ tool.summary }}</span>
                  </span>
                </li>
              </ul>
            </details>
            <AgentArtifactGrid
              v-if="artifactPlacement.byMessage.get(entry.message.id)?.length"
              :artifacts="artifactPlacement.byMessage.get(entry.message.id) ?? []"
              :label="$t('common:agentThread.browserScreenshotsResponse')"
              :format-time="artifactTimeLabel"
            />
          </div>
        </div>
      </article>
      <template v-if="entry.message.role === 'assistant' && entry.run">
        <AgentToolCard
          v-for="proposalEntry in entry.run.proposals"
          :key="proposalEntry.tool.id"
          :tool="proposalEntry.tool"
          :proposal="proposalEntry.proposal"
          :busy="Boolean(decidingApprovalId)"
          :network-blocked="networkBlocked"
          @decision="forwardDecision"
        />
      </template>
    </template>
    <AgentArtifactGrid
      v-if="artifactPlacement.unplaced.length"
      :artifacts="artifactPlacement.unplaced"
      :label="$t('common:agentThread.browserScreenshots')"
      :format-time="artifactTimeLabel"
    />
    <div v-if="thread.suggestions.length" class="agent-suggestions" role="group" :aria-label="$t('common:agentThread.followUpSuggestions')">
      <v-btn
        v-for="suggestion in thread.suggestions"
        :key="suggestion.id"
        variant="tonal"
        size="small"
        append-icon="mdi-arrow-top-right"
        :disabled="canSubmit === false || networkBlocked"
        @click="emit('suggest', suggestion.prompt)"
      >{{ suggestion.label }}</v-btn>
    </div>
    <WikiSourcePreview v-if="previewSelector" :selector="previewSelector" :can-ask="canSubmit !== false && !networkBlocked" @close="previewSelector = null" @ask="source => { previewSelector = null; emit('askSource', source) }" />
  </section>
</template>

<script setup lang="ts">
import type { AgentGoogleSearchCitation, AgentMediaView, AgentToolState, AgentThreadState } from '../../../shared/agents/contracts.ts'
import { agentMediaContentUrl } from '../../helpers/agents-api.ts'
import { computed, onUnmounted, ref, watch } from 'vue'
import i18next from 'i18next'
import type { UserPicture } from '../../helpers/user-picture.ts'
import StatusIndicator from '../common/status-indicator.vue'
import AgentMarkdown from './agent-markdown.vue'
import AgentAnswerActions from './agent-answer-actions.vue'
import AgentSearchSuggestions from './agent-search-suggestions.vue'
import WikiSourcePreview from '../common/wiki-source-preview.vue'
import { wikiSourceSelectorFromHref, type WikiSource, type WikiSourceSelector } from '../../../shared/wiki-source.ts'
import AgentTaskProgress from './agent-task-progress.vue'
import AgentToolCard from './agent-tool-card.vue'
import AgentArtifactGrid from './agent-artifact-grid.vue'
import {
  agentLiveAnnouncement,
  buildAgentThreadPresentation,
  placeAgentArtifacts,
  type AgentCitationEntry,
  type AgentCitationGroup,
  type AgentLocalizedText,
  type AgentMessagePresentation,
  type AgentRunPresentation,
  type AgentThreadPresentation
} from './agent-thread-presentation.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const localeRevision = ref(0)
const refreshLocale = (): void => { localeRevision.value += 1 }
i18next.on('languageChanged', refreshLocale)
i18next.on('loaded', refreshLocale)
onUnmounted(() => {
  i18next.off('languageChanged', refreshLocale)
  i18next.off('loaded', refreshLocale)
})
const localizedText = (text: AgentLocalizedText): string => t(text.key, { ...text.params, interpolation: { escapeValue: false } })

const props = defineProps<{
  thread: AgentThreadState
  connection: string
  userPicture: UserPicture
  decidingApprovalId?: string | null
  canSubmit?: boolean
  imageEditingEnabled?: boolean
  networkBlocked?: boolean
  googleSearchSuggestions?: { readonly runId: string; readonly suggestions: readonly string[] } | null
}>()
const emit = defineEmits<{
  editImage: [media: AgentMediaView]
  reattach: [media: AgentMediaView]
  askSource: [source: WikiSource]
  suggest: [prompt: string]
  decision: [proposalId: string, approvalId: string, decision: 'approved' | 'denied', confirmationPath?: string]
}>()
const forwardDecision = (
  proposalId: string,
  approvalId: string,
  decision: 'approved' | 'denied',
  confirmationPath?: string
): void => emit('decision', proposalId, approvalId, decision, confirmationPath)

// Detached attachments keep downloading while the session lives, but re-attaching
// re-uploads a copy as a new pending composer attachment, so require confirmation.
const reattachConfirmId = ref<string | null>(null)
const requestReattach = (media: AgentMediaView): void => { reattachConfirmId.value = media.id }
const cancelReattach = (): void => { reattachConfirmId.value = null }
const confirmReattach = (media: AgentMediaView): void => {
  if (reattachConfirmId.value !== media.id) return
  reattachConfirmId.value = null
  emit('reattach', media)
}
const previewSelector = ref<WikiSourceSelector | null>(null)
const previewCitation = (event: MouseEvent, selector: WikiSourceSelector | null): void => {
  if (!selector || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  previewSelector.value = selector
}
const sourceSelector = (href: string | null): WikiSourceSelector | null => {
  if (!href) return null
  const origin = typeof window === 'undefined' ? 'https://wiki.invalid' : window.location.origin
  return wikiSourceSelectorFromHref(href, origin)
}
const messageFormats = computed(() => {
  void localeRevision.value
  const locale = i18next.resolvedLanguage || i18next.language || undefined
  return {
    time: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }),
    timestamp: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  }
})
interface MessageTemporalMetadata {
  readonly time: string
  readonly timestamp: string
}
const safeNavigableHref = (href: string | null): string | undefined => {
  if (!href) return undefined
  try {
    const url = new URL(href, 'https://wiki.invalid')
    return url.protocol === 'http:' || url.protocol === 'https:' ? href : undefined
  } catch {
    return undefined
  }
}
const googleCitationQuote = (content: string, citation: AgentGoogleSearchCitation): string => {
  if (citation.startIndex < 0 || citation.endIndex <= citation.startIndex || citation.endIndex > content.length) return ''
  return content.slice(citation.startIndex, citation.endIndex)
}
const temporalMetadataFor = (createdAt: string): MessageTemporalMetadata => {
  const date = new Date(createdAt)
  return Number.isNaN(date.valueOf())
    ? { time: '', timestamp: createdAt }
    : { time: messageFormats.value.time.format(date), timestamp: messageFormats.value.timestamp.format(date) }
}
interface LinkPresentationMetadata {
  readonly safeHref: string | undefined
  readonly previewSelector: WikiSourceSelector | null
}
const emptyLinkPresentationMetadata: LinkPresentationMetadata = { safeHref: undefined, previewSelector: null }
interface CachedThreadPresentation {
  readonly sessionId: string
  readonly presentation: AgentThreadPresentation
}
const threadPresentationCache = computed<CachedThreadPresentation>(previous => {
  const sessionId = props.thread.session.id
  return {
    sessionId,
    presentation: buildAgentThreadPresentation(
      props.thread.messages,
      props.thread.tools,
      props.thread.tasks,
      props.thread.proposals,
      previous?.sessionId === sessionId ? previous.presentation : undefined,
      props.thread.session.currentRun
    )
  }
})
const threadPresentation = computed(() => threadPresentationCache.value.presentation)
/* Screenshots sit under the response that captured them instead of after the whole thread. */
const artifactPlacement = computed(() => placeAgentArtifacts(props.thread.messages, props.thread.artifacts))
const artifactTimeLabel = (createdAt: string): string => {
  const metadata = temporalMetadataFor(createdAt)
  return metadata.time ? metadata.timestamp : ''
}
type ProjectedCitationEntry = Omit<AgentCitationEntry, 'sectionLabel'> & LinkPresentationMetadata & { readonly sectionLabel: string }
type ProjectedCitationGroup = Omit<AgentCitationGroup, 'sections'> & LinkPresentationMetadata & {
  readonly sections: readonly ProjectedCitationEntry[]
}
type ProjectedRun = Omit<AgentRunPresentation, 'pageLinks' | 'activityLabel'> & {
  readonly activityLabel: string
  readonly pageLinks: readonly (AgentRunPresentation['pageLinks'][number] & LinkPresentationMetadata)[]
}
interface ProjectedGoogleSearchCitation {
  readonly citation: AgentGoogleSearchCitation
  readonly safeHref: string | undefined
  readonly quote: string
}
type ProjectedMessage = Omit<AgentMessagePresentation, 'run' | 'citationGroups' | 'statusLabel' | 'ariaLabel' | 'recovery'> & {
  readonly run: ProjectedRun | null
  readonly citationGroups: readonly ProjectedCitationGroup[]
  readonly statusLabel: string
  readonly ariaLabel: string
  readonly recovery: { readonly title: string; readonly description: string } | null
  readonly temporal: MessageTemporalMetadata
  readonly googleSearchCitations: readonly ProjectedGoogleSearchCitation[]
}
interface ThreadProjection {
  readonly orderedMessages: readonly ProjectedMessage[]
}
interface CachedProjectedMessage {
  readonly source: AgentMessagePresentation
  readonly value: ProjectedMessage
}
let projectionSessionId = ''
let projectionLocaleRevision = -1
let projectionOrigin = ''
let projectedMessages = new Map<string, CachedProjectedMessage>()
let projectedRuns = new Map<AgentRunPresentation, ProjectedRun>()
let projectedCitationGroups = new Map<AgentCitationGroup, ProjectedCitationGroup>()
let projectedPageLinks = new Map<AgentRunPresentation['pageLinks'], ProjectedRun['pageLinks']>()
let hrefMetadata = new Map<string, LinkPresentationMetadata>()
let temporalMetadata = new Map<string, MessageTemporalMetadata>()
const threadProjection = computed<ThreadProjection>(() => {
  const sessionId = props.thread.session.id
  const revision = localeRevision.value
  const origin = typeof window === 'undefined' ? 'https://wiki.invalid' : window.location.origin
  if (sessionId !== projectionSessionId || revision !== projectionLocaleRevision || origin !== projectionOrigin) {
    projectedMessages.clear()
    projectedRuns.clear()
    projectedCitationGroups.clear()
    projectedPageLinks.clear()
    hrefMetadata.clear()
    temporalMetadata.clear()
    projectionSessionId = sessionId
    projectionLocaleRevision = revision
    projectionOrigin = origin
  }
  const nextMessages = new Map<string, CachedProjectedMessage>()
  const nextRuns = new Map<AgentRunPresentation, ProjectedRun>()
  const nextGroups = new Map<AgentCitationGroup, ProjectedCitationGroup>()
  const nextPageLinks = new Map<AgentRunPresentation['pageLinks'], ProjectedRun['pageLinks']>()
  const nextHrefs = new Map<string, LinkPresentationMetadata>()
  const nextTimes = new Map<string, MessageTemporalMetadata>()
  const metadataForHref = (href: string | null): LinkPresentationMetadata => {
    if (!href) return emptyLinkPresentationMetadata
    const cached = hrefMetadata.get(href) ?? nextHrefs.get(href)
    if (cached) {
      nextHrefs.set(href, cached)
      return cached
    }
    const safeHref = safeNavigableHref(href)
    const metadata = { safeHref, previewSelector: safeHref ? sourceSelector(safeHref) : null }
    nextHrefs.set(href, metadata)
    return metadata
  }
  const metadataForTime = (createdAt: string): MessageTemporalMetadata => {
    const metadata = temporalMetadata.get(createdAt) ?? nextTimes.get(createdAt) ?? temporalMetadataFor(createdAt)
    nextTimes.set(createdAt, metadata)
    return metadata
  }
  const projectGroup = (group: AgentCitationGroup): ProjectedCitationGroup => {
    const pageMetadata = metadataForHref(group.pageHref)
    for (const section of group.sections) metadataForHref(section.citation.href)
    let projected = projectedCitationGroups.get(group)
    if (!projected) {
      projected = {
        ...group,
        ...pageMetadata,
        sections: group.sections.map(section => ({
          ...section,
          ...metadataForHref(section.citation.href),
          sectionLabel: section.sectionLabel ?? t('common:agentThread.pageOverview')
        }))
      }
    }
    nextGroups.set(group, projected)
    return projected
  }
  const projectRun = (run: AgentRunPresentation): ProjectedRun => {
    let pageLinks = projectedPageLinks.get(run.pageLinks) ?? nextPageLinks.get(run.pageLinks)
    if (!pageLinks) pageLinks = run.pageLinks.map(link => ({ ...link, ...metadataForHref(link.href) }))
    else for (const link of run.pageLinks) metadataForHref(link.href)
    nextPageLinks.set(run.pageLinks, pageLinks)
    const projected = projectedRuns.get(run) ?? nextRuns.get(run) ?? {
      ...run,
      pageLinks,
      activityLabel: run.activityLabel.map(localizedText).join(' · ')
    }
    nextRuns.set(run, projected)
    return projected
  }
  const orderedMessages = threadPresentation.value.orderedMessages.map(entry => {
    const temporal = metadataForTime(entry.message.createdAt)
    const cached = projectedMessages.get(entry.message.id)
    let projected = cached?.source === entry ? cached.value : undefined
    if (projected) {
      for (const group of entry.citationGroups) projectGroup(group)
      if (entry.run) projectRun(entry.run)
    }
    if (!projected) {
      const citationGroups = entry.citationGroups.map(projectGroup)
      const run = entry.run ? projectRun(entry.run) : null
      const statusLabel = entry.statusLabel ? localizedText(entry.statusLabel) : ''
      const googleSearchCitations = (entry.message.googleSearchGrounding?.citations ?? []).map((citation, index) => {
        const previous = cached?.value.googleSearchCitations[index]
        const quote = googleCitationQuote(entry.message.content, citation)
        if (previous && previous.quote === quote
          && previous.citation.url === citation.url && previous.citation.title === citation.title
          && previous.citation.startIndex === citation.startIndex && previous.citation.endIndex === citation.endIndex) return previous
        return { citation, safeHref: safeNavigableHref(citation.url), quote }
      })
      projected = {
        ...entry,
        statusLabel,
        ariaLabel: t(entry.ariaLabel.key, { status: statusLabel || t('common:agentThread.complete'), interpolation: { escapeValue: false } }),
        temporal,
        recovery: entry.recovery ? { title: localizedText(entry.recovery.title), description: localizedText(entry.recovery.description) } : null,
        citationGroups,
        googleSearchCitations: cached && googleSearchCitations.length === cached.value.googleSearchCitations.length
          && googleSearchCitations.every((citation, index) => citation === cached.value.googleSearchCitations[index])
          ? cached.value.googleSearchCitations
          : googleSearchCitations,
        run
      }
    }
    nextMessages.set(entry.message.id, cached?.source === entry && cached.value === projected ? cached : { source: entry, value: projected })
    return projected
  })
  projectedMessages = nextMessages
  projectedRuns = nextRuns
  projectedCitationGroups = nextGroups
  projectedPageLinks = nextPageLinks
  hrefMetadata = nextHrefs
  temporalMetadata = nextTimes
  return { orderedMessages }
})
const activityPreferences = ref(new Map<string, boolean>())
const pendingActivityToggles = new Set<string>()
const activityKey = (entry: ProjectedMessage): string => entry.message.runId ?? entry.message.id
const activityOpen = (entry: ProjectedMessage): boolean => {
  const preference = activityPreferences.value.get(activityKey(entry))
  if (preference !== undefined) return preference
  const activity = entry.run?.activity ?? []
  const active = props.thread.session.currentRun?.id === entry.message.runId
  const exceptional = entry.message.runOutcome?.status === 'partial' || entry.message.runOutcome?.status === 'failed' || entry.message.runOutcome?.status === 'cancelled'
    || entry.message.status === 'failed' || entry.message.status === 'cancelled'
    || activity.some(tool => tool.state === 'failed' || tool.state === 'cancelled' || tool.state === 'denied' || tool.state === 'omitted' || tool.state === 'not_executed')
  return exceptional || (active && (
    activity.some(tool => tool.state === 'preparing' || tool.state === 'running' || tool.state === 'awaitingApproval')
    || entry.run?.proposals.some(({ tool }) => tool.state === 'preparing' || tool.state === 'running' || tool.state === 'awaitingApproval') === true
  ))
}
const markActivityToggle = (entry: ProjectedMessage): void => { pendingActivityToggles.add(activityKey(entry)) }
const handleActivityToggle = (event: Event, entry: ProjectedMessage): void => {
  const key = activityKey(entry)
  const target = event.currentTarget as HTMLDetailsElement | null
  if (!target || !pendingActivityToggles.delete(key)) return
  activityPreferences.value.set(key, target.open)
}
watch(() => props.thread.session.id, () => {
  activityPreferences.value.clear()
  pendingActivityToggles.clear()
})
watch(() => threadProjection.value.orderedMessages, entries => {
  const currentKeys = new Set(entries.map(activityKey))
  for (const key of activityPreferences.value.keys()) if (!currentKeys.has(key)) activityPreferences.value.delete(key)
  for (const key of pendingActivityToggles) if (!currentKeys.has(key)) pendingActivityToggles.delete(key)
})
const stateLabelKeys: Record<AgentToolState, string> = {
  preparing: 'common:agentThread.preparing',
  running: 'common:agentThread.running',
  awaitingApproval: 'common:agentThread.awaitingApproval',
  complete: 'common:agentThread.complete',
  failed: 'common:agentThread.failed',
  denied: 'common:agentThread.denied',
  cancelled: 'common:agentThread.cancelled',
  omitted: 'common:agentThread.resultOmitted',
  not_executed: 'common:agentThread.notExecuted'
}
const stateIcons: Record<AgentToolState, string> = {
  preparing: 'mdi-dots-horizontal',
  running: 'mdi-progress-clock',
  awaitingApproval: 'mdi-shield-alert-outline',
  complete: 'mdi-check-circle-outline',
  failed: 'mdi-alert-circle-outline',
  denied: 'mdi-cancel',
  cancelled: 'mdi-stop-circle-outline',
  omitted: 'mdi-eye-off-outline',
  not_executed: 'mdi-minus-circle-outline'
}
const toolStateLabel = (state: AgentToolState): string => {
  void localeRevision.value
  return t(stateLabelKeys[state])
}
const toolStateIcon = (state: AgentToolState): string => stateIcons[state]
const toolStateColor = (state: AgentToolState): string | undefined => {
  if (state === 'complete') return 'success'
  if (state === 'failed' || state === 'denied') return 'error'
  if (state === 'cancelled' || state === 'omitted' || state === 'not_executed') return undefined
  return 'primary'
}
const currentLiveAnnouncement = computed(() => {
  void localeRevision.value
  if (props.connection === 'reconnecting') {
    return { key: 'connection:reconnecting', message: t('common:agentThread.connectionInterruptedReconnecting') }
  }
  const announcement = agentLiveAnnouncement(props.thread.messages, props.thread.tools, props.thread.session.currentRun)
  return announcement ? { key: announcement.key, message: localizedText(announcement.message) } : null
})
const liveSummary = ref('')
const liveSummaryRevision = ref(0)
watch(
  [() => props.thread.session.id, currentLiveAnnouncement],
  ([sessionId, announcement], previous) => {
    const previousSessionId = previous?.[0]
    const previousAnnouncement = previous?.[1]
    if (sessionId !== previousSessionId) previewSelector.value = null
    if (sessionId === previousSessionId && announcement?.key === previousAnnouncement?.key && announcement?.message === previousAnnouncement?.message) return
    liveSummary.value = announcement?.message ?? ''
    liveSummaryRevision.value += 1
  },
  { immediate: true }
)
</script>

<style scoped>
.agent-thread { color: rgb(var(--v-theme-on-surface)); font-family: var(--wiki-font-body); margin-inline: auto; width: 100%; min-width: 0; }
.agent-history-window { display: flex; align-items: start; gap: var(--wiki-space-3); margin-block-end: var(--wiki-space-5); padding: var(--wiki-space-3) var(--wiki-space-4); background: var(--wiki-surface-sunken); border: 1px solid var(--wiki-surface-border-strong); border-radius: var(--wiki-control-radius); font-size: .85rem; line-height: 1.5; }
.agent-history-window p { margin: var(--wiki-space-1) 0 0; color: var(--wiki-text-muted); }
.agent-message { margin-block-end: var(--wiki-space-5); max-width: 100%; min-width: 0; overflow-wrap: anywhere; }
.agent-message--assistant { display: grid; grid-template-columns: 32px minmax(0, 1fr); align-items: start; gap: var(--wiki-space-3); }
.agent-message__content, .agent-message__identity { min-width: 0; }
.agent-message__meta, .agent-message__user-details { display: flex; align-items: center; flex-wrap: wrap; gap: var(--wiki-space-2); min-height: 28px; color: var(--wiki-text-muted); font-size: .8rem; }
.agent-message__meta { margin-block-end: var(--wiki-space-2); }
.agent-message__role { color: rgb(var(--v-theme-on-surface)); font-weight: 700; font-size: .85rem; }
.agent-message__time { color: var(--wiki-text-muted); font-size: .75rem; }
.agent-message__status { display: inline-flex; align-items: center; flex-wrap: wrap; gap: var(--wiki-space-1); font-size: .75rem; color: var(--wiki-text-muted); }
.agent-message__status--failed { color: rgb(var(--v-theme-error)); }
.agent-message__assistant-mark { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; box-sizing: border-box; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-sunken); color: var(--wiki-primary-ink); }
.agent-message__surface { min-width: 0; font-size: .96rem; line-height: var(--wiki-leading-body); }
.agent-message--assistant .agent-message__surface { padding: var(--wiki-space-4); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); background: var(--wiki-surface-raised); }
.agent-message--assistant.agent-message--pending .agent-message__surface, .agent-message--assistant.agent-message--streaming .agent-message__surface { border-inline-start: 3px solid var(--wiki-primary-ink); }
.agent-message--failed .agent-message__surface { border-inline-start: 3px solid rgb(var(--v-theme-error)); }
.agent-message--cancelled .agent-message__surface { border-inline-start: 3px solid var(--wiki-surface-border-strong); }
.agent-message--user { display: grid; grid-template-columns: minmax(0, 1fr); margin-inline-start: 44px; }
.agent-message__identity--user { display: flex; align-items: center; gap: var(--wiki-space-2); margin-block-end: var(--wiki-space-2); }
.agent-message__user-avatar { order: -1; flex: 0 0 28px; border: 1px solid var(--wiki-surface-border); }
.agent-message__user-initials { font-size: .75rem; font-weight: 700; }
.agent-message--user .agent-message__surface { padding: var(--wiki-space-3) var(--wiki-space-4); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); background: var(--wiki-surface-sunken); }
.agent-message__terminal-copy { color: var(--wiki-text-muted); margin: 0; }
.agent-message__waiting { display: inline-flex; align-items: center; gap: var(--wiki-space-2); color: var(--wiki-text-muted); min-height: 28px; font-size: .85rem; }
.agent-message__waiting-dots { display: inline-flex; align-items: center; gap: 3px; }
.agent-message__waiting-dots > span { width: 4px; height: 4px; border-radius: 50%; background: var(--wiki-primary-ink); }
.agent-message__media { display: grid; gap: var(--wiki-space-3); margin-block-start: var(--wiki-space-3); }
.agent-message__media figure { margin: 0; min-width: 0; }
.agent-message__media img { display: block; max-width: 100%; max-height: 480px; object-fit: contain; border-radius: var(--wiki-control-radius); }
.agent-message__media video { display: block; width: 100%; max-height: 480px; border-radius: var(--wiki-control-radius); background: var(--wiki-surface-sunken); }
.agent-message__media audio { display: block; width: min(100%, 440px); }
.agent-message__media figcaption { display: flex; align-items: center; flex-wrap: wrap; gap: var(--wiki-space-2); margin-block-start: var(--wiki-space-2); font-size: .8rem; overflow-wrap: anywhere; }
.agent-message__media figcaption a { color: var(--wiki-primary-ink); }
.agent-message__media-detached { display: inline-flex; align-items: center; gap: var(--wiki-space-1); color: var(--wiki-text-muted); }
.agent-message__media-confirm { color: var(--wiki-text-muted); }
.agent-message__recovery { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: var(--wiki-space-3); margin-block-start: var(--wiki-space-4); padding-block-start: var(--wiki-space-3); border-top: 1px solid var(--wiki-surface-border); }
.agent-message__recovery > .v-icon { color: rgb(var(--v-theme-error)); }
.agent-message--cancelled .agent-message__recovery > .v-icon { color: var(--wiki-text-muted); }
.agent-message__recovery strong, .agent-message__recovery span { display: block; font-size: .85rem; }
.agent-message__recovery span { color: var(--wiki-text-muted); margin-block-start: var(--wiki-space-1); }
.agent-message__source-context { display: flex; flex-wrap: wrap; align-items: start; gap: var(--wiki-space-2); margin-block-start: var(--wiki-space-3); padding-block-start: var(--wiki-space-3); border-top: 1px solid var(--wiki-surface-border); color: var(--wiki-text-muted); font-size: .8rem; }
.agent-message__source-context > span { flex-basis: 100%; }
.agent-message__source-context .v-btn { max-width: 100%; height: auto; min-height: 36px; color: var(--wiki-primary-ink); }
.agent-message__source-context :deep(.v-btn__content) { white-space: normal; overflow-wrap: anywhere; text-align: start; }
.agent-sources, .agent-activity { border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); margin-block-start: var(--wiki-space-4) !important; background: var(--wiki-surface-sunken); overflow: hidden; }
.agent-sources__heading, .agent-activity summary { display: flex; align-items: center; flex-wrap: wrap; gap: var(--wiki-space-2); min-height: 44px; padding: var(--wiki-space-2) var(--wiki-space-3); list-style: none; cursor: pointer; color: rgb(var(--v-theme-on-surface)); font-size: .85rem; }
.agent-sources[open] > summary, .agent-activity[open] > summary { border-bottom: 1px solid var(--wiki-surface-border); }
.agent-sources__heading::-webkit-details-marker, .agent-activity summary::-webkit-details-marker { display: none; }
.agent-sources__heading::after, .agent-activity summary::after { content: '›'; margin-inline-start: auto; font-size: 1.25rem; transform: rotate(90deg); }
.agent-sources[open] > summary::after, .agent-activity[open] > summary::after { transform: rotate(270deg); }
.agent-sources__heading > .v-icon { color: var(--wiki-primary-ink); }
.agent-sources__origin { color: var(--wiki-text-muted); font-size: .75rem; }
.agent-sources__count { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; min-height: 24px; padding-inline: var(--wiki-space-1); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-raised); font-size: .75rem; }
.agent-sources__groups, .agent-sources__sections, .agent-web-sources__list, .agent-activity__list { list-style: none; margin: 0; padding: 0; }
.agent-sources__group + .agent-sources__group { border-top: 1px solid var(--wiki-surface-border); }
.agent-sources__page, .agent-sources__sections > li > :is(a, span) { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--wiki-space-2); min-height: 44px; padding: var(--wiki-space-2) var(--wiki-space-3); color: inherit; text-decoration: none; line-height: 1.5; }
.agent-sources__page strong, .agent-sources__label { min-width: 0; overflow-wrap: anywhere; font-size: .85rem; }
.agent-sources__sections { border-top: 1px solid var(--wiki-surface-border); padding-inline-start: var(--wiki-space-4); }
.agent-sources__number { display: inline-grid; place-items: center; min-width: 24px; min-height: 24px; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); color: rgb(var(--v-theme-on-surface)); background: var(--wiki-surface-raised); font-family: var(--wiki-font-mono); font-size: .75rem; }
.agent-sources__preview { margin-inline: var(--wiki-space-3); }
.agent-sources a:hover, .agent-page-links a:hover { background: var(--wiki-surface-raised); color: var(--wiki-primary-ink); }
.agent-web-sources__list { padding: var(--wiki-space-3); display: grid; gap: var(--wiki-space-3); }
.agent-web-sources__list > li { min-width: 0; }
.agent-web-sources__list a, .agent-web-sources__list li > span { display: flex; align-items: center; gap: var(--wiki-space-2); color: inherit; text-decoration: none; min-height: 44px; }
.agent-web-sources__list strong { min-width: 0; overflow-wrap: anywhere; }
.agent-web-sources__list a:hover strong { text-decoration: underline; }
.agent-web-sources__list blockquote { margin: var(--wiki-space-2) 0 0; padding-inline-start: var(--wiki-space-3); border-inline-start: 2px solid var(--wiki-surface-border-strong); color: var(--wiki-text-muted); font-size: .85rem; line-height: 1.6; white-space: pre-wrap; }
.agent-page-links { display: flex; flex-wrap: wrap; gap: var(--wiki-space-2); margin-block-start: var(--wiki-space-4) !important; padding-block-start: var(--wiki-space-3); border-top: 1px solid var(--wiki-surface-border); }
.agent-page-links > :is(a, span) { display: inline-flex; align-items: center; gap: var(--wiki-space-2); min-height: 44px; padding: var(--wiki-space-2) var(--wiki-space-3); max-width: 100%; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-sunken); color: var(--wiki-primary-ink); text-decoration: none; overflow-wrap: anywhere; }
.agent-page-links > span { color: rgb(var(--v-theme-on-surface)); }
.agent-page-links > :is(a, span) > span { min-width: 0; }
.agent-activity__list { display: grid; padding: var(--wiki-space-3); gap: var(--wiki-space-3); }
.agent-activity__list li { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: var(--wiki-space-2); font-size: .85rem; }
.agent-activity__list small { display: block; color: var(--wiki-text-muted); line-height: 1.5; }
.agent-sources__heading:focus-visible, .agent-sources a:focus-visible, .agent-page-links a:focus-visible, .agent-activity summary:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: -2px; }
.agent-sources__new-window, .sr-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.agent-suggestions { display: flex; flex-wrap: wrap; gap: var(--wiki-space-2); margin-block-start: var(--wiki-space-4); }
.agent-suggestions :deep(.v-btn) { max-width: 100%; height: auto; min-height: 44px; padding-block: var(--wiki-space-2); border-radius: var(--wiki-control-radius); font-weight: 500; letter-spacing: normal; text-transform: none; }
.agent-suggestions :deep(.v-btn__content) { white-space: normal; overflow-wrap: anywhere; }
@media (max-width: 599.98px) {
  .agent-message--assistant { grid-template-columns: minmax(0, 1fr); gap: var(--wiki-space-2); }
  .agent-message--assistant > .agent-message__identity { display: none; }
  .agent-message--user { margin-inline-start: 0; }
  .agent-message--assistant .agent-message__surface, .agent-message--user .agent-message__surface { padding: var(--wiki-space-3); }
  .agent-message__source-context .v-btn, .agent-message__media :deep(.v-btn) { min-height: 44px; }
  .agent-message__recovery { grid-template-columns: auto minmax(0, 1fr); }
  .agent-message__recovery :deep(.v-btn) { grid-column: 2; justify-self: start; min-height: 44px; }
}
@media (forced-colors: active) {
  .agent-history-window, .agent-message__assistant-mark, .agent-message__surface, .agent-sources, .agent-activity, .agent-page-links > :is(a, span) { background: Canvas; border-color: CanvasText; color: CanvasText; }
  .agent-sources__heading:focus-visible, .agent-sources a:focus-visible, .agent-page-links a:focus-visible, .agent-activity summary:focus-visible { outline-color: Highlight; }
}
</style>
