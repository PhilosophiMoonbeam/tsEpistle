<template>
  <div class="agent-answer-actions">
    <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copyAnswer">{{ copied ? $t('common:agentAnswerActions.copied') : $t('common:agentAnswerActions.copyAnswer') }}</v-btn>
    <v-btn size="small" variant="text" prepend-icon="mdi-file-document-plus-outline" @click="openDraft">{{ $t('common:agentAnswerActions.saveWikiDraft') }}</v-btn>
    <span class="agent-answer-actions__feedback" role="status">{{ feedback }}</span>
    <v-dialog content-class="agent-owned-overlay" v-model="draftOpen" max-width="860" scrollable :persistent="saving" aria-labelledby="agent-save-draft-title">
      <v-card class="agent-answer-draft">
        <v-card-title class="agent-answer-draft__heading"><div><span class="agent-answer-draft__eyebrow">{{ $t('common:agentAnswerActions.answerKnowledge') }}</span><h2 id="agent-save-draft-title">{{ $t('common:agentAnswerActions.keepUsefulThought') }}</h2></div><v-btn icon="mdi-close" variant="text" :aria-label="$t('common:agentAnswerActions.closeWikiDraftReview')" :disabled="saving" @click="draftOpen = false" /></v-card-title>
        <v-card-text>
          <template v-if="savedHref">
            <v-alert type="success" variant="tonal">{{ $t('common:agentAnswerActions.privateWikiDraftReady') }}</v-alert>
            <v-btn class="mt-4" :href="savedHref" target="_blank" rel="noopener noreferrer" append-icon="mdi-open-in-new">{{ $t('common:agentAnswerActions.openDraft') }}<span class="sr-only"> {{ $t('common:agentAnswerActions.newTab') }}</span></v-btn>
          </template>
          <template v-else>
            <p class="agent-answer-draft__intro">{{ $t('common:agentAnswerActions.reviewEditAnswerBefore') }}</p>
            <v-text-field v-model="title" :label="$t('common:agentAnswerActions.pageTitle')" variant="outlined" :disabled="saving" maxlength="255" />
            <div class="agent-answer-draft__location"><v-text-field v-model="locale" :label="$t('common:agentAnswerActions.languageCode')" variant="outlined" :disabled="saving" /><v-text-field v-model="path" :label="$t('common:agentAnswerActions.pagePath')" :hint="$t('common:agentAnswerActions.newPageExistingPages')" persistent-hint variant="outlined" :disabled="saving" /></div>
            <div class="agent-answer-draft__tabs" role="group" :aria-label="$t('common:agentAnswerActions.draftView')"><v-btn size="small" :variant="preview ? 'tonal' : 'text'" :aria-pressed="preview" @click="preview = true">{{ $t('common:actions.preview') }}</v-btn><v-btn size="small" :variant="!preview ? 'tonal' : 'text'" :aria-pressed="!preview" @click="preview = false">{{ $t('common:agentAnswerActions.editMarkdown') }}</v-btn></div>
            <div v-if="preview" class="agent-answer-draft__preview"><AgentMarkdown :content="markdown" /></div>
            <v-textarea v-else v-model="markdown" :label="$t('common:agentAnswerActions.draftMarkdown')" variant="outlined" rows="12" :disabled="saving" />
            <v-alert v-if="saveError" type="error" variant="tonal" class="mt-3" role="alert">{{ saveError }}</v-alert>
          </template>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn :disabled="saving" @click="draftOpen = false">{{ savedHref ? $t('common:agentAnswerActions.done') : $t('common:actions.cancel') }}</v-btn><v-btn v-if="!savedHref" class="agent-answer-draft__create" variant="tonal" :loading="saving" :disabled="!title.trim() || !path.trim() || !markdown.trim() || !locale.trim()" prepend-icon="mdi-lock-outline" @click="saveDraft">{{ $t('common:agentAnswerActions.createPrivateDraft') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import type { AgentCitation, AgentGoogleSearchGrounding } from '../../../shared/agents/contracts.ts'
import { wikiSourceHref } from '../../../shared/wiki-source.ts'
import { createPage } from '../../helpers/pages-api.ts'
import { copyTextToClipboard } from '../../helpers/clipboard.ts'
import { createAgentCitationResolver, formatAgentCitationMarkers } from './agent-citations.ts'
import AgentMarkdown from './agent-markdown.vue'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const props = defineProps<{ content: string; citations: readonly AgentCitation[]; googleSearchGrounding?: AgentGoogleSearchGrounding; defaultLocale?: string }>()
const draftOpen = ref(false)
const saving = ref(false)
const preview = ref(true)
const title = ref('')
const locale = ref('en')
const path = ref('')
const markdown = ref('')
const saveError = ref('')
const savedHref = ref('')
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
  try { await copyTextToClipboard(exportedAnswer()); copied.value = true; feedback.value = t('common:agentAnswerActions.answerSourceLinksCopied') }
  catch { copied.value = false; feedback.value = t('common:agentAnswerActions.copyUnavailableOpenDraft') }
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copied.value = false; feedback.value = '' }, 3000)
}
const openDraft = (): void => {
  if (!markdown.value) {
    markdown.value = exportedAnswer()
    title.value = props.content.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').replace(/\[\[cite:[^\]]+\]\]/g, '').slice(0, 100) || t('common:agentAnswerActions.agentNotes')
    locale.value = props.defaultLocale || document.documentElement.lang || 'en'
    path.value = `agent-notes/${title.value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 70) || 'note'}-${Date.now().toString(36)}`
  }
  draftOpen.value = true
}
const saveDraft = async (): Promise<void> => {
  if (saving.value || savedHref.value) return
  saving.value = true; saveError.value = ''
  try {
    await createPage(window.fetch.bind(window), { content: markdown.value, title: title.value.trim(), description: '', editor: 'markdown', visibility: 'private', isPublished: false, locale: locale.value.trim(), path: path.value.trim(), publishStartDate: '', publishEndDate: '', scriptCss: '', scriptJs: '', tags: [] })
    savedHref.value = wikiSourceHref({ locale: locale.value.trim(), path: path.value.trim(), visibility: 'private' })
  } catch (value) { saveError.value = value instanceof Error ? value.message : t('common:agentAnswerActions.draftCouldNotCreated') }
  finally { saving.value = false }
}
onBeforeUnmount(() => clearTimeout(copyTimer))
</script>
<style scoped>
.agent-answer-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .2rem; margin-top: .8rem; opacity: .85; }
.agent-answer-actions__feedback { font-size: .72rem; }
.agent-answer-draft__heading { display: flex; justify-content: space-between; align-items: flex-start; padding: 1.5rem !important; gap: 1rem; white-space: normal; }
.agent-answer-draft__create { color: color-mix(in srgb, rgb(var(--v-theme-primary)) 35%, rgb(var(--v-theme-on-surface))); }
.agent-answer-draft__eyebrow { display: block; font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; color: color-mix(in srgb, rgb(var(--v-theme-primary)) 35%, rgb(var(--v-theme-on-surface))); margin-bottom: .5rem; }
.agent-answer-draft h2 { margin: 0; line-height: 1.15; font-family: var(--wiki-font-display, 'Newsreader', serif); font-size: 2rem; font-weight: 500; }
.agent-answer-draft__intro { font-size: .88rem; opacity: .75; margin-bottom: 1.5rem; line-height: 1.6; }
.agent-answer-draft__location { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: 1rem; }
.agent-answer-draft__tabs { display: flex; gap: .5rem; margin: .75rem 0; }
.agent-answer-draft__preview { padding: 1.2rem; border: 1px solid rgba(var(--v-theme-on-surface), .14); border-radius: 1rem; }
@media(max-width: 480px) { .agent-answer-draft h2 { font-size: 1.55rem; } .agent-answer-draft__heading { padding: 1.25rem !important; } .agent-answer-draft__location { grid-template-columns: 1fr; gap: 0; } }
</style>
