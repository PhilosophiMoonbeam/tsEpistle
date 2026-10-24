<template>
  <div class="agent-answer-actions">
    <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" :disabled="!currentOwner" @click="copyAnswer">{{ copied ? $t('common:agentAnswerActions.copied') : $t('common:agentAnswerActions.copyAnswer') }}</v-btn>
    <v-btn size="small" variant="text" prepend-icon="mdi-file-document-plus-outline" :disabled="!currentOwner" @click="openDraft">{{ $t('common:agentAnswerActions.saveWikiDraft') }}</v-btn>
    <span class="agent-answer-actions__feedback" role="status">{{ feedback }}</span>
    <v-dialog content-class="agent-owned-overlay" v-model="draftOpen" max-width="860" scrollable :fullscreen="smAndDown" :persistent="saving" aria-labelledby="agent-save-draft-title">
      <v-card class="agent-answer-draft">
        <v-card-title class="agent-answer-draft__heading"><div><span class="agent-answer-draft__eyebrow">{{ $t('common:agentAnswerActions.answerKnowledge') }}</span><h2 id="agent-save-draft-title">{{ $t('common:agentAnswerActions.keepUsefulThought') }}</h2></div><v-btn icon="mdi-close" variant="text" :aria-label="$t('common:agentAnswerActions.closeWikiDraftReview')" :disabled="saving" @click="draftOpen = false" /></v-card-title>
        <v-card-text>
          <v-alert v-if="!currentOwner" type="warning" variant="tonal" role="status">{{ tx('identityRequired', 'Draft review is unavailable for this account. Your Markdown is kept in memory for the original account, not shown to another account.') }}</v-alert>
          <template v-else>
            <p class="agent-answer-draft__intro">{{ $t('common:agentAnswerActions.reviewEditAnswerBefore') }} {{ tx('snapshotNotice', 'Creates a separate private, unpublished page. It does not update this answer or stay in sync with it.') }}</p>
            <section class="agent-answer-draft__receipts" :aria-label="tx('receiptHeading', 'Created while reviewing this answer')">
              <h3>{{ tx('receiptHeading', 'Created while reviewing this answer') }}</h3>
              <p>{{ tx('receiptOriginNotice', 'These receipts record where drafts were created from this review, not an exact match to the answer or its current text.') }}</p>
              <p v-if="inventoryLoading" role="status">{{ tx('loadingReceipts', 'Checking earlier drafts…') }}</p>
              <p v-else-if="inventoryLoaded && !receipts.length">{{ tx('noReceipts', 'No earlier committed drafts were returned. This is not proof that an uncertain attempt failed.') }}</p>
              <article v-for="item in receipts" :key="item.requestId" class="agent-answer-draft__receipt">
                <p><strong>{{ committedLabel(item.sourceRevision) }}</strong></p>
                <template v-if="item.destination && !accessBlocked && online">
                  <p>{{ item.destination.title }} · {{ item.destination.locale }}/{{ item.destination.path }}</p>
                  <p>{{ audience(item.destination) }} {{ item.destination.isPublished ? tx('published', 'Published') : tx('unpublished', 'Unpublished') }}</p>
                  <p>{{ currentRevisionLabel(item.destination.sourceRevision) }}</p>
                  <v-btn size="small" variant="tonal" :href="wikiSourceHref(item.destination)" target="_blank" rel="noopener noreferrer" append-icon="mdi-open-in-new">{{ $t('common:agentAnswerActions.openDraft') }}<span class="agent-answer-actions__new-window"> {{ $t('common:agentAnswerActions.newTab') }}</span></v-btn>
                </template>
                <p v-else>{{ tx('committedUnavailable', 'Creation is confirmed, but the destination is not currently available to open.') }}</p>
              </article>
              <v-btn v-if="nextCursor" size="small" variant="text" :loading="inventoryLoading" :disabled="!canRead || checking" @click="loadInventory(true)">{{ tx('moreDrafts', 'Load more drafts') }}</v-btn>
              <v-btn size="small" variant="text" :loading="inventoryLoading" :disabled="!currentOwner || !online || checking || saving" @click="loadInventory(false)">{{ tx('refreshReceipts', 'Refresh earlier drafts') }}</v-btn>
              <p v-if="inventoryError" role="alert">{{ inventoryError }}</p>
            </section>
            <v-alert v-if="attempt?.state === 'committed'" type="success" variant="tonal" class="mb-3" role="status">{{ confirmedLabel }}</v-alert>
            <v-alert v-else-if="attempt?.state === 'unknown'" type="warning" variant="tonal" class="mb-3" role="status">{{ tx('creationUnknown', 'Creation is not confirmed. Do not submit again: the page may already exist. Check creation status without writing another page. A missing receipt is not a rejection.') }}</v-alert>
            <v-alert v-else-if="attempt?.state === 'rejected'" type="warning" variant="tonal" class="mb-3" role="status">{{ tx('creationRejected', 'The Wiki rejected this attempt. Correct the draft or destination, then deliberately create a new draft with a new request identity.') }}</v-alert>
            <p v-if="!online || accessBlocked" role="status">{{ tx('accessRequired', 'A live connection and current access are required to check receipts or create a draft. Your Markdown remains available to edit or copy.') }}</p>
            <v-btn v-if="attempt && attempt.state !== 'rejected'" class="mb-3" variant="text" :loading="checking" :disabled="!canRead || saving || inventoryLoading" @click="checkCreationStatus">{{ tx('checkStatus', 'Check creation status') }}</v-btn>
            <v-btn v-if="attempt?.state === 'committed'" class="mb-3" variant="tonal" :disabled="!canRead || saving || checking || inventoryLoading" @click="prepareAnotherDraft">{{ tx('prepareAnother', 'Prepare another private draft') }}</v-btn>
            <v-text-field v-model="title" :label="$t('common:agentAnswerActions.pageTitle')" variant="outlined" :disabled="saving" maxlength="255" />
            <div class="agent-answer-draft__location"><v-text-field v-model="locale" :label="$t('common:agentAnswerActions.languageCode')" variant="outlined" :disabled="saving" /><v-text-field v-model="path" :label="$t('common:agentAnswerActions.pagePath')" :hint="$t('common:agentAnswerActions.newPageExistingPages')" persistent-hint variant="outlined" :disabled="saving" /></div>
            <div class="agent-answer-draft__tabs" role="group" :aria-label="$t('common:agentAnswerActions.draftView')"><v-btn size="small" :variant="preview ? 'tonal' : 'text'" :aria-pressed="preview" @click="preview = true">{{ $t('common:actions.preview') }}</v-btn><v-btn size="small" :variant="!preview ? 'tonal' : 'text'" :aria-pressed="!preview" @click="preview = false">{{ $t('common:agentAnswerActions.editMarkdown') }}</v-btn></div>
            <div v-if="preview" class="agent-answer-draft__preview"><AgentMarkdown :content="markdown" /></div>
            <v-textarea v-else v-model="markdown" :label="$t('common:agentAnswerActions.draftMarkdown')" variant="outlined" rows="12" :disabled="saving" />
            <v-btn size="small" variant="text" :disabled="!markdown" @click="copyDraft">{{ tx('copyReviewedMarkdown', 'Copy reviewed Markdown') }}</v-btn>
            <p role="status">{{ draftFeedback }}</p>
            <v-alert v-if="saveError" type="error" variant="tonal" class="mt-3" role="alert">{{ saveError }}</v-alert>
          </template>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn :disabled="saving" @click="draftOpen = false">{{ $t('common:agentAnswerActions.done') }}</v-btn><v-btn v-if="currentOwner && (!attempt || attempt.state === 'rejected')" class="agent-answer-draft__create" variant="tonal" :loading="saving" :disabled="!canRead || !inventoryLoaded || inventoryLoading || checking || !title.trim() || !path.trim() || !markdown.trim() || !locale.trim()" prepend-icon="mdi-lock-outline" @click="saveDraft">{{ $t('common:agentAnswerActions.createPrivateDraft') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useDisplay } from 'vuetify'
import type { AgentCitation, AgentGoogleSearchGrounding } from '../../../shared/agents/contracts.ts'
import { wikiSourceHref } from '../../../shared/wiki-source.ts'
import { createPage } from '../../helpers/pages-api.ts'
import { listAgentAnswerCreations, readPageCreationStatus } from '../../helpers/page-creation-api.ts'
import type { PageCreationCommitted } from '../../../shared/page-creation.ts'
import { describePageVisibility } from '../editor/common/page-visibility.ts'
import { wikiStore } from '../../store/index.ts'
import { pwaState } from '../../helpers/pwa.ts'
import { copyTextToClipboard } from '../../helpers/clipboard.ts'
import { createAgentCitationResolver, formatAgentCitationMarkers } from './agent-citations.ts'
import AgentMarkdown from './agent-markdown.vue'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const { smAndDown } = useDisplay()
const props = defineProps<{ sessionId: string; messageId: string; content: string; citations: readonly AgentCitation[]; googleSearchGrounding?: AgentGoogleSearchGrounding; defaultLocale?: string }>()
const tx = (key: string, defaultValue: string, values: Record<string, unknown> = {}): string => t(`common:agentAnswerActions.${key}`, { defaultValue, ...values })
const fetcher: typeof fetch = (...args) => window.fetch(...args)
const sourceOwner = ref(wikiStore.user.id)
let sourceOrigin = `${props.sessionId}:${props.messageId}`
const currentOwner = computed(() => wikiStore.user.authenticated && wikiStore.user.id > 0 && sourceOwner.value === wikiStore.user.id ? wikiStore.user.id : null)
const online = computed(() => pwaState.connectionState === 'online')
const accessBlocked = ref(false)
const canRead = computed(() => Boolean(currentOwner.value) && online.value && !accessBlocked.value)
const identity = (): string => JSON.stringify([wikiStore.user.id, wikiStore.user.authenticated, wikiStore.user.authVersion, wikiStore.offlineIdentityEpoch, window.siteConfig.agentCsrfToken, wikiStore.user.permissions, props.sessionId, props.messageId])
type Attempt = { requestId: string; state: 'unknown' | 'committed' | 'rejected' }
type DraftRecovery = { title: string; locale: string; path: string; markdown: string; attempt: Attempt | null }
const recoveries = new Map<string, DraftRecovery>()
const draftKey = (): string => `${currentOwner.value}:${props.sessionId}:${props.messageId}`
let activeDraftKey = draftKey()
let generation = 0
let disposed = false
let inventoryController: AbortController | null = null
let statusController: AbortController | null = null
const inventory = ref<PageCreationCommitted[]>([])
const receipt = ref<PageCreationCommitted | null>(null)
const attempt = ref<Attempt | null>(null)
const written = ref<Awaited<ReturnType<typeof createPage>> | null>(null)
const inventoryLoading = ref(false)
const inventoryLoaded = ref(false)
const inventoryError = ref('')
const nextCursor = ref<string | null>(null)
const checking = ref(false)
const draftFeedback = ref('')
const receipts = computed(() => receipt.value ? [receipt.value, ...inventory.value.filter(item => item.requestId !== receipt.value?.requestId)] : inventory.value)
const audience = (destination: NonNullable<PageCreationCommitted['destination']>): string => {
  const summary = describePageVisibility(destination)
  return t(summary.summaryKey, summary.values)
}
const committedLabel = (revision: string): string => tx('committedRevision', 'Created revision {{revision}}', { revision })
const currentRevisionLabel = (revision: string): string => tx('currentRevision', 'Current destination revision {{revision}}; access rules are current, not the original snapshot.', { revision })
const confirmedLabel = computed(() => written.value
  ? tx('writeConfirmed', 'The Wiki confirmed creation at revision {{revision}}. The receipt is checked separately for current destination access.', { revision: written.value.sourceRevision })
  : tx('creationConfirmed', 'Creation is confirmed. The saved page is independent of this conversation.'))
const draftOpen = ref(false)
const saving = ref(false)
const preview = ref(true)
const title = ref('')
const locale = ref('en')
const path = ref('')
const markdown = ref('')
const saveError = ref('')
const rememberDraft = (): void => {
  if (markdown.value) recoveries.set(activeDraftKey, { title: title.value, locale: locale.value, path: path.value, markdown: markdown.value, attempt: attempt.value ? { ...attempt.value } : null })
}
const copied = ref(false)
const feedback = ref('')
let copyTimer: ReturnType<typeof setTimeout> | undefined
const exportedAnswer = (): string => {
  const resolveCitation = createAgentCitationResolver(props.citations)
  const resolveExportCitation = (evidenceId: string) => {
    const citation = resolveCitation(evidenceId)
    if (!citation?.href) return citation
    try { return { ...citation, href: new URL(citation.href, window.location.origin).href } }
    catch { return { ...citation, href: null } }
  }
  const body = formatAgentCitationMarkers(props.content, resolveExportCitation)
  const referencedIds = new Set<string>()
  const wikiReferences = props.citations.flatMap(citation => {
    if (referencedIds.has(citation.evidenceId)) return []
    referencedIds.add(citation.evidenceId)
    const resolved = resolveExportCitation(citation.evidenceId)
    if (!resolved?.href) return []
    return [`- [${resolved.number}] [${resolved.label.replace(/[\\[\]]/g, '\\$&')}](${resolved.href.replaceAll('(', '%28').replaceAll(')', '%29')})`]
  })
  const googleReferences = (props.googleSearchGrounding?.citations ?? []).flatMap((citation, index) => {
    try {
      const url = new URL(citation.url)
      if (!['http:', 'https:'].includes(url.protocol)) return []
      return [`${index + 1}. [${citation.title.replace(/[\\[\]]/g, '\\$&')}](${url.href.replaceAll('(', '%28').replaceAll(')', '%29')})`]
    } catch { return [] }
  })
  return [
    body,
    ...(wikiReferences.length ? [`## Wiki sources\n\n${wikiReferences.join('\n')}`] : []),
    ...(googleReferences.length ? [`## Web sources (Google Search)\n\n${googleReferences.join('\n')}`] : [])
  ].join('\n\n')
}
const copyAnswer = async (): Promise<void> => {
  if (!currentOwner.value) return
  const epoch = identity()
  try { await copyTextToClipboard(exportedAnswer()); if (epoch !== identity() || disposed) return; copied.value = true; feedback.value = t('common:agentAnswerActions.answerSourceLinksCopied') }
  catch { if (epoch !== identity() || disposed) return; copied.value = false; feedback.value = t('common:agentAnswerActions.copyUnavailableOpenDraft') }
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copied.value = false; feedback.value = '' }, 3000)
}
const copyDraft = async (): Promise<void> => {
  if (!currentOwner.value) return
  const epoch = identity()
  try { await copyTextToClipboard(markdown.value); if (epoch === identity() && !disposed) draftFeedback.value = tx('reviewedMarkdownCopied', 'Reviewed Markdown copied.') }
  catch { if (epoch === identity() && !disposed) draftFeedback.value = tx('reviewedMarkdownCopyFailed', 'Copy failed. Select the Markdown text and copy it manually.') }
}
const openDraft = (): void => {
  if (!currentOwner.value) return
  if (!markdown.value) {
    markdown.value = exportedAnswer()
    title.value = props.content.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').replace(/\[\[cite:[^\]]+\]\]/g, '').replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2').replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,!?;:]|$)/g, '$1$2').trim().slice(0, 100) || t('common:agentAnswerActions.agentNotes')
    locale.value = props.defaultLocale || document.documentElement.lang || 'en'
    path.value = newDraftPath()
  }
  draftOpen.value = true
}
const newDraftPath = (): string => `agent-notes/${title.value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 70) || 'note'}-${crypto.randomUUID().slice(0, 8)}`
const responseStatus = (value: unknown): number | null => typeof value === 'object' && value !== null && typeof Reflect.get(value, 'status') === 'number' ? Reflect.get(value, 'status') as number : null
const alreadyCommitted = (value: unknown): boolean => typeof value === 'object' && value !== null && Reflect.get(value, 'code') === 'PAGE_CREATION_ALREADY_COMMITTED'
const isCurrent = (epoch: string, version: number): boolean => !disposed && identity() === epoch && generation === version
const clearProjection = (clearWritten = false): void => {
  inventoryController?.abort(); inventoryController = null
  statusController?.abort(); statusController = null
  inventory.value = []; receipt.value = null
  if (clearWritten) written.value = null
  inventoryLoaded.value = false; inventoryLoading.value = false; checking.value = false; nextCursor.value = null
}
const loseAccess = (): void => {
  clearProjection(true)
  accessBlocked.value = true
}
const acceptReceipt = (value: PageCreationCommitted): void => {
  if (attempt.value?.requestId === value.requestId) {
    attempt.value = { requestId: value.requestId, state: 'committed' }
    receipt.value = value
    rememberDraft()
  }
}
const loadInventory = async (append = false): Promise<void> => {
  const owner = currentOwner.value
  if (!owner || !online.value || saving.value || checking.value || inventoryLoading.value || (append && !nextCursor.value)) return
  // An explicit refresh can recheck access after a definite denial.
  accessBlocked.value = false
  const epoch = identity(), version = generation
  const controller = new AbortController()
  inventoryController?.abort(); inventoryController = controller
  const cursor = append ? nextCursor.value : null
  if (!append) { inventory.value = []; receipt.value = null; inventoryLoaded.value = false }
  inventoryLoading.value = true; inventoryError.value = ''
  try {
    const result = await listAgentAnswerCreations(fetcher, owner, props.sessionId, props.messageId, cursor, controller.signal)
    if (!isCurrent(epoch, version) || controller.signal.aborted || inventoryController !== controller) return
    inventory.value = append ? [...inventory.value, ...result.items.filter(item => !inventory.value.some(previous => previous.requestId === item.requestId))] : result.items
    nextCursor.value = result.hasMore ? result.nextCursor : null
    inventoryLoaded.value = true
    for (const item of result.items) acceptReceipt(item)
    if (!attempt.value && result.items[0]) {
      attempt.value = { requestId: result.items[0].requestId, state: 'committed' }
      receipt.value = result.items[0]
      rememberDraft()
    }
  } catch (value) {
    if (!isCurrent(epoch, version) || controller.signal.aborted || inventoryController !== controller) return
    if (responseStatus(value) === 401 || responseStatus(value) === 403) loseAccess()
    else { inventory.value = []; receipt.value = null; nextCursor.value = null; inventoryLoaded.value = false }
    inventoryError.value = tx('inventoryFailed', 'Earlier drafts could not be checked or access changed. No new page was written. Refresh earlier drafts to check again.')
  } finally {
    if (isCurrent(epoch, version) && inventoryController === controller) { inventoryLoading.value = false; inventoryController = null }
  }
}
const checkCreationStatus = async (): Promise<void> => {
  const owner = currentOwner.value, current = attempt.value
  if (!owner || !current || !canRead.value || saving.value || checking.value || inventoryLoading.value) return
  const epoch = identity(), version = generation
  const controller = new AbortController()
  statusController?.abort(); statusController = controller
  checking.value = true; saveError.value = ''; receipt.value = null
  // Do not leave an old authorized destination visible during a recheck.
  inventory.value = inventory.value.filter(item => item.requestId !== current.requestId)
  try {
    const result = await readPageCreationStatus(fetcher, owner, current.requestId, controller.signal)
    if (!isCurrent(epoch, version) || controller.signal.aborted || statusController !== controller || attempt.value?.requestId !== current.requestId) return
    if (result.status === 'committed') acceptReceipt(result)
    else saveError.value = tx('statusUnknown', 'No committed receipt was returned. The result remains unknown; this does not mean the creation was rejected. Do not submit this attempt again.')
  } catch (value) {
    if (!isCurrent(epoch, version) || controller.signal.aborted || statusController !== controller) return
    if (responseStatus(value) === 401 || responseStatus(value) === 403) loseAccess()
    saveError.value = tx('statusFailed', 'Creation status could not be confirmed or access changed. No page was written by this check. Keep the Markdown and check again when access is available.')
  } finally {
    if (isCurrent(epoch, version) && statusController === controller) { checking.value = false; statusController = null }
  }
}
const prepareAnotherDraft = (): void => {
  if (attempt.value?.state !== 'committed' || !canRead.value || saving.value || checking.value || inventoryLoading.value) return
  if (receipt.value && !inventory.value.some(item => item.requestId === receipt.value?.requestId)) inventory.value.unshift(receipt.value)
  attempt.value = null; receipt.value = null; written.value = null; saveError.value = ''
  path.value = newDraftPath()
  rememberDraft()
}
const saveDraft = async (): Promise<void> => {
  const owner = currentOwner.value
  if (!owner || !canRead.value || !inventoryLoaded.value || inventoryLoading.value || checking.value || saving.value || (attempt.value && attempt.value.state !== 'rejected') || !title.value.trim() || !path.value.trim() || !markdown.value.trim() || !locale.value.trim()) return
  const epoch = identity(), version = generation
  const requestId = crypto.randomUUID()
  const input = { content: markdown.value, title: title.value.trim(), description: '', editor: 'markdown', visibility: 'private' as const, isPublished: false, locale: locale.value.trim(), path: path.value.trim(), publishStartDate: '', publishEndDate: '', scriptCss: '', scriptJs: '', tags: [], creationRequestId: requestId, creationOrigin: { kind: 'agent-answer' as const, sessionId: props.sessionId, messageId: props.messageId } }
  attempt.value = { requestId, state: 'unknown' }
  rememberDraft()
  saving.value = true; saveError.value = ''; written.value = null; receipt.value = null
  let reconcile = false
  try {
    const result = await createPage(fetcher, input, t('common:agentAnswerActions.draftCouldNotCreated'), owner)
    if (!isCurrent(epoch, version)) return
    written.value = result
    attempt.value = { requestId, state: 'committed' }
    reconcile = true
  } catch (value) {
    if (!isCurrent(epoch, version)) return
    const status = responseStatus(value)
    if (alreadyCommitted(value)) {
      // A repeat request is not a rejection and must never enable another POST.
      attempt.value = { requestId, state: 'committed' }
      reconcile = true
    } else if (status !== null && status >= 400 && status < 500 && status !== 404 && typeof value === 'object' && value !== null && Reflect.get(value, 'responseRejected') === true) {
      attempt.value = { requestId, state: 'rejected' }
      if (status === 401 || status === 403) loseAccess()
      saveError.value = tx('writeRejected', 'The Wiki rejected creation. Review the title, language, path and current permissions before deliberately trying a corrected new draft.')
    } else {
      saveError.value = tx('writeUncertain', 'The creation response was lost or could not be confirmed. Keep the Markdown and use Check creation status; creating again could duplicate a page.')
    }
  } finally {
    if (isCurrent(epoch, version)) { saving.value = false; rememberDraft() }
  }
  if (isCurrent(epoch, version) && reconcile) await checkCreationStatus()
}
watch(identity, () => {
  rememberDraft()
  const origin = `${props.sessionId}:${props.messageId}`
  if (origin !== sourceOrigin) { sourceOrigin = origin; sourceOwner.value = wikiStore.user.id }
  generation++
  clearProjection(true)
  saving.value = false; attempt.value = null; accessBlocked.value = false
  title.value = ''; path.value = ''; locale.value = 'en'; markdown.value = ''
  saveError.value = ''; inventoryError.value = ''; draftFeedback.value = ''; feedback.value = ''; copied.value = false
  clearTimeout(copyTimer)
  activeDraftKey = draftKey()
  const recovered = currentOwner.value ? recoveries.get(activeDraftKey) : null
  if (recovered) {
    title.value = recovered.title; path.value = recovered.path; locale.value = recovered.locale; markdown.value = recovered.markdown
    attempt.value = recovered.attempt ? { ...recovered.attempt } : null
  }
  if (draftOpen.value && currentOwner.value) void loadInventory()
}, { flush: 'sync' })
watch(draftOpen, open => {
  if (open) void loadInventory()
  else { rememberDraft(); clearProjection() }
})
watch(online, connected => {
  if (!connected) clearProjection()
  else if (draftOpen.value && currentOwner.value) void loadInventory()
})
onBeforeUnmount(() => { disposed = true; generation++; clearProjection(true); clearTimeout(copyTimer); recoveries.clear() })
</script>
<style scoped>
.agent-answer-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .2rem; margin-top: .8rem; opacity: .85; }
.agent-answer-actions__feedback { font-size: .72rem; }
.agent-answer-actions__new-window { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.agent-answer-draft__heading { display: flex; justify-content: space-between; align-items: flex-start; padding: 1.5rem !important; gap: 1rem; white-space: normal; }
.agent-answer-draft__create { color: color-mix(in srgb, rgb(var(--v-theme-primary)) 35%, rgb(var(--v-theme-on-surface))); }
.agent-answer-draft__eyebrow { display: block; font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; color: color-mix(in srgb, rgb(var(--v-theme-primary)) 35%, rgb(var(--v-theme-on-surface))); margin-bottom: .5rem; }
.agent-answer-draft h2 { margin: 0; line-height: 1.15; font-family: var(--wiki-font-display, 'Newsreader', serif); font-size: 2rem; font-weight: 500; }
.agent-answer-draft__intro { font-size: .88rem; opacity: .75; margin-bottom: 1.5rem; line-height: 1.6; }
.agent-answer-draft__location { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: 1rem; }
.agent-answer-draft__tabs { display: flex; gap: .5rem; margin: .75rem 0; }
.agent-answer-draft__preview { padding: 1.2rem; border: 1px solid rgba(var(--v-theme-on-surface), .14); border-radius: 1rem; }
.agent-answer-draft__receipts { margin-bottom: 1.5rem; font-size: .88rem; line-height: 1.6; }
.agent-answer-draft__receipts h3 { font-size: 1rem; }
.agent-answer-draft__receipt { padding: .8rem 0; border-bottom: 1px solid rgba(var(--v-theme-on-surface), .14); overflow-wrap: anywhere; }
.agent-answer-draft :deep(.v-card-text) { min-height: 0; overflow-y: auto; }
.agent-answer-draft :deep(.v-card-actions) { flex: 0 0 auto; flex-wrap: wrap; gap: .25rem; }
@media(max-width: 480px) { .agent-answer-draft h2 { font-size: 1.55rem; } .agent-answer-draft__heading { padding: 1.25rem !important; } .agent-answer-draft__location { grid-template-columns: 1fr; gap: 0; } }
</style>
