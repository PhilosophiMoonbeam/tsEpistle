<template>
  <div class="agent-answer-actions">
    <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copyAnswer">{{ copied ? 'Copied' : 'Copy answer' }}</v-btn>
    <v-btn size="small" variant="text" prepend-icon="mdi-file-document-plus-outline" @click="openDraft">Save as Wiki draft</v-btn>
    <span class="agent-answer-actions__feedback" role="status">{{ feedback }}</span>
    <v-dialog content-class="agent-owned-overlay" v-model="draftOpen" max-width="860" scrollable :persistent="saving" aria-labelledby="agent-save-draft-title">
      <v-card class="agent-answer-draft">
        <v-card-title class="agent-answer-draft__heading"><div><span class="agent-answer-draft__eyebrow">From answer to knowledge</span><h2 id="agent-save-draft-title">Keep a useful thought.</h2></div><v-btn icon="mdi-close" variant="text" aria-label="Close Wiki draft review" :disabled="saving" @click="draftOpen = false" /></v-card-title>
        <v-card-text>
          <template v-if="savedHref">
            <v-alert type="success" variant="tonal">Your private Wiki draft is ready. Its source links are included.</v-alert>
            <v-btn class="mt-4" :href="savedHref" target="_blank" rel="noopener noreferrer" append-icon="mdi-open-in-new">Open draft<span class="sr-only"> in a new tab</span></v-btn>
          </template>
          <template v-else>
            <p class="agent-answer-draft__intro">Review and edit this answer before creating a private, unpublished page. Source links stay with the text.</p>
            <v-text-field v-model="title" label="Page title" variant="outlined" :disabled="saving" maxlength="255" />
            <div class="agent-answer-draft__location"><v-text-field v-model="locale" label="Language code" variant="outlined" :disabled="saving" /><v-text-field v-model="path" label="Page path" hint="A new page; existing pages are never overwritten." persistent-hint variant="outlined" :disabled="saving" /></div>
            <div class="agent-answer-draft__tabs" role="group" aria-label="Draft view"><v-btn size="small" :variant="preview ? 'tonal' : 'text'" :aria-pressed="preview" @click="preview = true">Preview</v-btn><v-btn size="small" :variant="!preview ? 'tonal' : 'text'" :aria-pressed="!preview" @click="preview = false">Edit Markdown</v-btn></div>
            <div v-if="preview" class="agent-answer-draft__preview"><AgentMarkdown :content="markdown" /></div>
            <v-textarea v-else v-model="markdown" label="Draft Markdown" variant="outlined" rows="12" :disabled="saving" />
            <v-alert v-if="saveError" type="error" variant="tonal" class="mt-3" role="alert">{{ saveError }}</v-alert>
          </template>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn :disabled="saving" @click="draftOpen = false">{{ savedHref ? 'Done' : 'Cancel' }}</v-btn><v-btn v-if="!savedHref" class="agent-answer-draft__create" variant="tonal" :loading="saving" :disabled="!title.trim() || !path.trim() || !markdown.trim() || !locale.trim()" prepend-icon="mdi-lock-outline" @click="saveDraft">Create private draft</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import type { AgentCitation, AgentGoogleSearchGrounding } from '../../../shared/agents/contracts.ts'
import { wikiSourceHref } from '../../../shared/wiki-source.ts'
import { createPage } from '../../helpers/pages-api.ts'
import { formatAgentCitationMarkers } from './agent-citations.ts'
import AgentMarkdown from './agent-markdown.vue'
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
  const citations = props.citations.map(citation => {
    try {
      const url = new URL(citation.href ?? '', window.location.origin)
      return { ...citation, href: citation.href && ['http:', 'https:'].includes(url.protocol) ? url.href : null }
    } catch { return { ...citation, href: null } }
  })
  const body = formatAgentCitationMarkers(props.content, citations)
  const wikiReferences = citations.flatMap((citation, index) => {
    if (!citation.href) return []
    try {
      const url = new URL(citation.href, window.location.origin)
      if (!['http:', 'https:'].includes(url.protocol)) return []
      return [`${index + 1}. [${citation.label.replace(/[\\[\]]/g, '\\$&')}](${url.href.replaceAll('(', '%28').replaceAll(')', '%29')})`]
    } catch { return [] }
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
  try { await navigator.clipboard.writeText(exportedAnswer()); copied.value = true; feedback.value = 'Answer and source links copied.' }
  catch { feedback.value = 'Copy is unavailable. Open the draft review to select the Markdown text.' }
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copied.value = false; feedback.value = '' }, 3000)
}
const openDraft = (): void => {
  if (!markdown.value) {
    markdown.value = exportedAnswer()
    title.value = props.content.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').replace(/\[\[cite:[^\]]+\]\]/g, '').slice(0, 100) || 'Agent notes'
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
  } catch (value) { saveError.value = value instanceof Error ? value.message : 'The draft could not be created.' }
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
