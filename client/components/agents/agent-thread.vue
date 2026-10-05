<template>
  <section class="agent-thread" :aria-label="$t('common:agentThread.agentConversation')">
    <div :key="liveSummaryRevision" class="sr-status" aria-live="polite" aria-atomic="true">{{ liveSummary }}</div>
    <template v-for="entry in threadProjection.orderedMessages" :key="entry.message.id">
      <article
        class="agent-message"
        :class="[`agent-message--${entry.message.role}`, `agent-message--${entry.message.status}`]"
        :aria-busy="entry.message.status === 'pending' || entry.message.status === 'streaming'"
        :aria-label="entry.ariaLabel"
      >
        <div v-if="entry.message.role === 'assistant'" class="agent-message__identity" aria-hidden="true">
          <span class="agent-message__assistant-mark" :class="{ 'agent-message__assistant-mark--working': entry.message.status === 'pending' || entry.message.status === 'streaming' }">
            <v-icon class="agent-message__assistant-spark" icon="mdi-creation-outline" size="18" aria-hidden="true" />
            <ControlBorderBeam :enabled="entry.message.status === 'pending' || entry.message.status === 'streaming'" :phase-offset-ms="0" />
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
    <section v-if="thread.specialistInvocations.length" class="agent-activity mt-3" aria-label="Agent task activity">
      <h3>Agent task activity</h3>
      <details v-for="invocation in thread.specialistInvocations" :key="invocation.id" :open="invocation.status !== 'completed'">
        <summary>{{ invocation.taskClass }} · {{ invocation.status === 'running' ? 'Agent working' : invocation.status === 'completed' ? 'Task complete' : 'Task failed' }}</summary>
        <p>{{ temporalMetadataFor(invocation.startedAt).timestamp }}</p>
        <p v-if="invocation.status === 'failed'" role="status">The Agent could not complete this task.</p>
        <template v-if="invocation.report !== null"><h4>Task report</h4><p style="white-space: pre-wrap; overflow-wrap: anywhere">{{ invocation.report }}</p></template>
        <p v-else>{{ invocation.status === 'running' ? 'The Agent is working on this task; report pending.' : 'No report returned.' }}</p>
      </details>
    </section>
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
import ControlBorderBeam from '../common/control-border-beam.vue'
import StatusIndicator from '../common/status-indicator.vue'
import AgentMarkdown from './agent-markdown.vue'
import AgentAnswerActions from './agent-answer-actions.vue'
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
.agent-message__media { display: grid; gap: 12px; margin-top: 8px; }
.agent-message__media figure { margin: 0; min-width: 0; }
.agent-message__media img { display: block; max-width: 100%; max-height: 480px; object-fit: contain; border-radius: 12px; }
.agent-message__media video { display: block; width: 100%; max-height: 480px; border-radius: 12px; background: #000; }
.agent-message__media audio { display: block; width: min(100%, 440px); }
.agent-message__media figcaption { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 6px; font-size: .8rem; overflow-wrap: anywhere; }
.agent-message__media figcaption a { color: var(--wiki-primary-ink); }
.agent-message__media figcaption .agent-message__media-detached { align-items: center; color: var(--wiki-text-muted); display: inline-flex; gap: 4px; }
.agent-message__media figcaption .agent-message__media-confirm { color: var(--wiki-text-muted); }

.agent-thread {
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-body);
  margin-inline: auto;
  min-height: calc(var(--wiki-space-12) * 4);
  width: 100%;
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
  display: inline-flex;
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  gap: var(--wiki-space-1);
  letter-spacing: .025em;
  line-height: 1.35;
  white-space: nowrap;
}



.agent-message__status--failed {
  color: rgb(var(--v-theme-error));
}

@keyframes agent-message-spark-shimmer {
  0%, 84%, 100% {
    filter: none;
    opacity: 1;
  }
  88% {
    filter: brightness(1.35) drop-shadow(0 0 7px color-mix(in srgb, var(--agent-mark-color) 70%, transparent));
    opacity: 1;
  }
  91% {
    opacity: .6;
  }
  95% {
    filter: brightness(1.15) drop-shadow(0 0 3px color-mix(in srgb, var(--agent-mark-color) 45%, transparent));
    opacity: 1;
  }
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

.agent-message__assistant-mark {
  position: relative;
  isolation: isolate;
  box-sizing: border-box;
  display: inline-flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 12%, transparent);
  --wiki-control-radius: 50%;
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 72%, transparent);
  /* Palette-aware agent identity: the theme info color, nudged toward the text color for contrast. */
  --agent-mark-color: color-mix(in srgb, rgb(var(--v-theme-info)) 85%, rgb(var(--v-theme-on-surface)));
  --wiki-beam-violet: var(--agent-mark-color);
  --wiki-beam-cool: color-mix(in srgb, var(--agent-mark-color) 62%, rgb(var(--v-theme-surface)));
}

.agent-message__assistant-spark {
  position: relative;
  z-index: 1;
  color: var(--agent-mark-color);
}

.agent-message__assistant-mark--working .agent-message__assistant-spark {
  animation: agent-message-spark-shimmer 7s ease-in-out infinite;
}

.agent-message__user-avatar {
  flex: 0 0 28px;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 24%, var(--wiki-surface-border));
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
}

.agent-message__user-initials {
  font-size: .68rem;
  font-weight: 700;
  letter-spacing: .02em;
}

.agent-message__surface {
  font-size: .96rem;
  line-height: var(--wiki-leading-body);
  min-width: 0;
}

.agent-message--assistant .agent-message__surface {
  background: var(--wiki-surface-raised);
  border: 1px solid var(--wiki-surface-border);
  border-inline-start: 2px solid transparent;
  border-radius: var(--wiki-control-radius);
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
  padding: var(--wiki-space-3) var(--wiki-space-4);
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

.agent-message--user.agent-message--failed .agent-message__surface {
  border-inline-end: 2px solid rgb(var(--v-theme-error));
}

.agent-message--user.agent-message--cancelled .agent-message__surface {
  border-inline-end: 2px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 48%, var(--wiki-surface-border));
}

.agent-message__identity--user {
  align-items: flex-start;
  display: flex;
  flex: 0 0 auto;
  gap: var(--wiki-space-2);
  order: 1;
  padding-block-start: var(--wiki-space-3);
  text-align: end;
}

.agent-message__user-details {
  display: grid;
  gap: var(--wiki-space-1);
  justify-items: end;
}

.agent-message__identity--user .agent-message__time::before {
  content: none;
}

.agent-message__identity--user .agent-message__status {
  justify-content: flex-end;
}

.agent-message__terminal-copy {
  color: var(--wiki-text-muted);
  margin: 0;
}

.agent-message__waiting {
  align-items: center;
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
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
  flex: 0 0 auto;
  font-size: 1.25rem;
  transform: rotate(90deg);
  transition: transform var(--wiki-motion-fast) var(--wiki-motion-ease-out);
}

.agent-sources[open] > .agent-sources__heading::after {
  transform: rotate(270deg);
}

.agent-sources__heading > .v-icon {
  color: var(--wiki-primary-ink);
}

.agent-sources__heading strong {
  color: rgb(var(--v-theme-on-surface));
  font-weight: 700;
}

.agent-sources__origin {
  margin-inline-start: auto;
  font-size: .7rem;
  font-weight: 500;
}

.agent-web-sources__list {
  display: grid;
  gap: var(--wiki-space-3);
  margin: 0;
  padding: var(--wiki-space-3);
  list-style: none;
}

.agent-web-sources__list > li {
  min-width: 0;
}

.agent-web-sources__list a,
.agent-web-sources__list li > span {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-2);
  color: inherit;
  text-decoration: none;
}

.agent-web-sources__list a:hover strong {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.agent-web-sources__list blockquote {
  margin: var(--wiki-space-2) 0 0 calc(var(--wiki-space-6) + var(--wiki-space-1));
  color: var(--wiki-text-muted);
  font-size: .76rem;
  line-height: 1.55;
  white-space: pre-wrap;
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

.agent-web-sources .agent-sources__count {
  margin-inline-start: var(--wiki-space-1);
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

.agent-sources a.agent-sources__page:hover,
.agent-sources__sections a:hover {
  background: color-mix(in srgb, var(--wiki-ambient-accent) 9%, transparent);
}

.agent-sources__heading:focus-visible,
.agent-sources__page:focus-visible,
.agent-sources__sections a:focus-visible,
.agent-page-links a:focus-visible,
.agent-activity summary:focus-visible {
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

.agent-page-links > :is(a, span) {
  align-items: center;
  background: var(--wiki-surface-sunken);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  color: var(--wiki-primary-ink);
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

.agent-page-links > span {
  color: rgb(var(--v-theme-on-surface));
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
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


.agent-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  margin-block-start: var(--wiki-space-5);
}

.agent-suggestions :deep(.v-btn) {
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
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
    grid-template-columns: 28px minmax(0, 1fr);
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

  .agent-message__user-details {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--wiki-space-2);
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

  .agent-message__waiting-dots > span {
    animation: none !important;
  }
  .agent-message__assistant-spark {
    animation: none !important;
    filter: none !important;
  }
}

@media (forced-colors: active) {
  .agent-message__user-avatar,
  .agent-message__assistant-mark,
  .agent-message__surface,
  .agent-message__recovery,
  .agent-sources,
  .agent-page-links a {
    background: Canvas;
    border-color: CanvasText;
    color: CanvasText;
  }
  .agent-message__assistant-spark {
    animation: none !important;
    filter: none !important;
    color: CanvasText !important;
  }

  .agent-message--user .agent-message__surface {
    border-width: 2px;
  }

  .agent-message__waiting-dots > span,
  .agent-sources__number {
    background: CanvasText;
    color: Canvas;
  }

  .agent-sources__heading:focus-visible,
  .agent-sources__page:focus-visible,
  .agent-sources__sections a:focus-visible,
  .agent-page-links a:focus-visible,
  .agent-activity summary:focus-visible {
    outline-color: Highlight;
  }
}
</style>

<style scoped>
.agent-message__source-context { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; margin-top: .75rem; font-size: .68rem; opacity: .75; }
.agent-message__source-context .v-btn { max-width: 100%; }
.agent-message__source-context :deep(.v-btn__content) { overflow: hidden; text-overflow: ellipsis; }
</style>
