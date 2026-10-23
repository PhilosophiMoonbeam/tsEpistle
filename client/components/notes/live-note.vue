<template>
  <v-app class="live-note-app">
    <nav-header />
    <v-main>
      <div class="live-note" :aria-busy="loading">
        <header class="live-note__header">
          <div><a href="/p/notes">{{ t('inventory', 'My live notes') }}</a><h1>{{ note?.title || t('untitled', 'Untitled note') }}</h1><code v-if="note">{{ note.key }}</code></div>
          <div class="live-note__actions" v-if="note">
            <button v-if="note.canEdit" type="button" @click="setMode(mode === 'read' ? 'edit' : 'read')">{{ mode === 'read' ? t('editor', 'Editor') : t('reader', 'Reader') }}</button>
            <button type="button" @click="download">{{ t('download', 'Download Markdown') }}</button>
            <button type="button" :disabled="busy || !accepted" @click="loadHistory(false)">{{ t('history', 'History') }}</button>
            <button v-if="canPublish" type="button" :disabled="!settled || busy || publicationUncertain" @click="openPublication">{{ t('publish', 'Publish as page') }}</button>
          </div>
        </header>
        <p role="status" aria-live="polite">{{ statusText }}</p>
        <p v-if="loading">{{ t('loading', 'Loading live note…') }}</p>
        <div v-if="error || connectionError" class="live-note__error" role="alert">
          <p>{{ error || connectionError }}</p>
          <button v-if="!loading" type="button" @click="refresh(false)">{{ t('refresh', 'Refresh current access') }}</button>
          <button v-if="collaboration?.state === 'blocked'" type="button" @click="reopen">{{ t('reopen', 'Reopen note') }}</button>
        </div>
        <p v-if="note && !note.canEdit">{{ t('readOnly', 'You have read-only access to this note.') }}</p>
        <p v-if="pending">{{ t('pendingHelp', 'Unsaved changes remain in this tab. Keep it open until saved, or download your Markdown before leaving.') }}</p>
        <p v-if="publicationUncertain && !publication" role="alert">{{ publishError }}</p>
        <div v-if="note" class="live-note__workspace">
          <section v-show="mode === 'edit' && note.canEdit" :aria-label="t('editor', 'Editor')"><div ref="editorHost" class="live-note__editor" /></section>
          <article v-show="mode === 'read' || !note.canEdit" ref="previewHost" class="contents live-note__preview" :aria-label="t('reader', 'Reader')" v-html="previewHtml" />
        </div>
        <details v-if="note?.canManage" class="live-note__management">
          <summary>{{ t('manage', 'Manage note') }}</summary>
          <form class="live-note__form" @submit.prevent="saveAccess">
            <label>{{ t('access', 'Sharing access') }}<select v-model="access" :disabled="busy || !settled"><option value="private">{{ t('private', 'Private — owner only') }}</option><option value="read">{{ t('read', 'Read — eligible wiki readers') }}</option><option value="edit">{{ t('edit', 'Edit — eligible wiki collaborators') }}</option></select></label>
            <p>{{ t('sharingHelp', 'The link is an address, not a credential. Wiki note permissions and asset permissions still apply.') }}</p>
            <button type="submit" :disabled="busy || !settled || access === note.access">{{ t('saveAccess', 'Save access') }}</button>
            <button type="button" class="live-note__danger" :disabled="busy || !settled" @click="remove">{{ t('delete', 'Delete note') }}</button>
          </form>
        </details>
        <section v-if="historyOpen" class="live-note__history" aria-labelledby="note-history-title">
          <header class="live-note__actions"><h2 id="note-history-title">{{ t('history', 'History') }}</h2><button type="button" @click="historyOpen = false">{{ t('close', 'Close') }}</button></header>
          <p v-if="historyLoading" role="status">{{ t('loadingHistory', 'Loading history…') }}</p>
          <p v-if="historyError" role="alert">{{ historyError }}</p>
          <ol><li v-for="item in historyItems" :key="item.revision"><button type="button" :disabled="busy || historyLoading" @click="viewRevision(item.revision)">{{ item.title || t('untitled', 'Untitled note') }} · {{ item.revision }} · {{ formatDate(item.createdAt) }}</button></li></ol>
          <button v-if="historyCursor" type="button" :disabled="historyLoading" @click="loadHistory(true)">{{ t('loadMore', 'Load more') }}</button>
          <div v-if="historical"><h3>{{ t('revision', 'Revision') }} {{ historical.revision }}</h3><pre class="live-note__snapshot">{{ historicalText }}</pre><button v-if="note?.canManage" type="button" :disabled="busy || !settled || historical.revision === note.revision" @click="restore">{{ t('restore', 'Restore this revision') }}</button></div>
        </section>
        <section v-if="publication" class="live-note__publication" aria-labelledby="note-publish-title">
          <h2 id="note-publish-title" tabindex="-1">{{ t('publish', 'Publish as page') }}</h2>
          <p>{{ t('publishHelp', 'Creates a normal wiki page from the captured revision. Later note edits are not included, and the note is kept.') }} {{ t('revision', 'Revision') }} {{ publication.revision }}</p>
          <form class="live-note__form" @submit.prevent="publish">
            <label>{{ t('title', 'Page title') }}<input v-model="publishTitle" required maxlength="255" :disabled="publishing || publicationAttempted" /></label>
            <label>{{ t('path', 'Page path') }}<input v-model="publishPath" required pattern="[^?#]+" :disabled="publishing || publicationAttempted" /></label>
            <label>{{ t('locale', 'Locale') }}<select v-model="publishLocale" required :disabled="publishing || publicationAttempted"><option v-for="locale in locales" :key="locale.code" :value="locale.code">{{ locale.name || locale.code }}</option></select></label>
            <label>{{ t('pageVisibility', 'Page visibility') }}<select v-model="publishVisibility" :disabled="publishing || publicationAttempted"><option value="public">{{ t('publicPage', 'Public') }}</option><option value="private">{{ t('privatePage', 'Private') }}</option></select></label>
            <label class="live-note__check"><input v-model="publishPublished" type="checkbox" :disabled="publishing || publicationAttempted" />{{ t('published', 'Published (unchecked creates a draft)') }}</label>
            <details><summary>{{ t('capturedBody', 'Captured page body') }}</summary><pre class="live-note__snapshot">{{ publication.content }}</pre></details>
            <p v-if="publishError" role="alert">{{ publishError }}</p>
            <p v-if="publishedHref" role="status"><a :href="publishedHref">{{ t('openPage', 'Open created page') }}</a></p>
            <button type="submit" :disabled="publishing || publicationAttempted || !canPublish">{{ publishing ? t('publishing', 'Creating page…') : t('createPage', 'Create page once') }}</button>
            <button type="button" :disabled="publishing" @click="closePublication">{{ t('close', 'Close') }}</button>
          </form>
        </section>
      </div>
    </v-main>
    <nav-footer /><notify /><search-results /><confirm-dialog-host />
  </v-app>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { yCollab, ySyncAnnotation } from 'y-codemirror.next'
import * as Y from 'yjs'
import { wikiStore } from '../../store/index.ts'
import { translate } from '../../modules/localization.ts'
import { createLiveNotesApi, LiveNotesApiError } from '../../helpers/live-notes-api.ts'
import { LiveNoteHistory } from '../../helpers/live-note-history.ts'
import { LiveNoteCollaboration, decodeNoteState } from '../../helpers/live-note-collaboration.ts'
import { captureNotePublication, type NotePublicationCapture } from '../../helpers/live-note-publication.ts'
import { createPage } from '../../helpers/pages-api.ts'
import { notifyReloadSafetyChanged, setReloadSafetyProvider } from '../../helpers/pwa.ts'
import { createWikiMarkdownRenderer, sanitizeWikiMarkdownHtml, enhanceWikiMarkdownPreview } from '../editor/markdown/preview.ts'
import { requestConfirmation } from '../common/confirm-dialog.ts'
import ConfirmDialogHost from '../common/confirm-dialog-host.vue'
import { LIVE_NOTE_MAX_TEXT_BYTES, type LiveNoteAccess, type LiveNoteView, type LiveNoteHistoryItem } from '../../../shared/live-notes.ts'

const textEncoder = new TextEncoder()
const noteKey = decodeURIComponent(window.location.pathname.split('/')[3] || '')
const t = (key: string, defaultValue: string) => translate(`common:liveNotes.${key}`, { defaultValue })
const identity = () => `${wikiStore.user.id}:${wikiStore.user.authVersion}:${wikiStore.offlineIdentityEpoch}:${siteConfig.agentCsrfToken}`
const api = createLiveNotesApi((...args) => window.fetch(...args), () => siteConfig.agentCsrfToken)
const collaboration = shallowRef<LiveNoteCollaboration | null>(null)
const note = shallowRef<LiveNoteView | null>(null)
const editorHost = ref<HTMLElement | null>(null), previewHost = ref<HTMLElement | null>(null)
const mode = ref<'read' | 'edit'>(new URLSearchParams(window.location.search).get('mode') === 'edit' ? 'edit' : 'read')
const loading = ref(false), busy = ref(false), accepted = ref(false), error = ref(''), tick = ref(0)
const access = ref<LiveNoteAccess>('private')
const historyOpen = ref(false), historyLoading = ref(false), historyError = ref(''), historyItems = ref<LiveNoteHistoryItem[]>([]), historyCursor = ref<string | null>(null)
const historical = shallowRef<LiveNoteView | null>(null), historicalText = ref('')
const publication = shallowRef<NotePublicationCapture | null>(null)
const publishTitle = ref(''), publishPath = ref(''), publishLocale = ref(siteConfig.lang), publishVisibility = ref<'public' | 'private'>('public'), publishPublished = ref(false)
const publishing = ref(false), publicationAttempted = ref(false), publicationUncertain = ref(false), publishError = ref(''), publishedHref = ref('')
const locales = typeof siteLangs !== 'undefined' && siteLangs.length ? siteLangs : [{ code: siteConfig.lang, name: siteConfig.lang }]
const source = ref('')
const renderer = createWikiMarkdownRenderer()
const previewHtml = computed(() => sanitizeWikiMarkdownHtml(renderer.render(source.value)))
const connectionError = computed(() => { void tick.value; return collaboration.value?.error || '' })
const pending = computed(() => { void tick.value; return collaboration.value?.pendingCount ?? 0 })
const settled = computed(() => { void tick.value; return accepted.value && collaboration.value?.state === 'connected' && !pending.value })
const canPublish = computed(() => { void tick.value; return note.value?.canEdit && actor === identity() && accepted.value && wikiStore.user.authenticated && (wikiStore.user.permissions.includes('write:pages') || wikiStore.user.permissions.includes('manage:system')) && collaboration.value?.state !== 'blocked' })
const dirtyAccess = computed(() => Boolean(note.value?.canManage && access.value !== note.value.access))
const unsafeExit = computed(() => Boolean(pending.value || busy.value || publishing.value || dirtyAccess.value || (publication.value && !publicationAttempted.value)))
const statusText = computed(() => {
  void tick.value
  if (!collaboration.value) return ''
  if (collaboration.value.state === 'blocked') return t('blocked', 'Connection stopped — local recovery is available.')
  if (collaboration.value.state === 'offline') return t('offline', 'Disconnected — reconnecting. Changes are not yet saved.')
  if (collaboration.value.state === 'connecting') return t('connecting', 'Connecting…')
  return pending.value ? t('saving', 'Saving changes…') : t('saved', 'All changes saved')
})
let editor: EditorView | null = null
let history: LiveNoteHistory | null = null
const editable = new Compartment()
let disposed = false, generation = 0, actor = ''
let controller = new AbortController()
const current = (epoch: number, capturedActor: string) => !disposed && epoch === generation && capturedActor === identity()
const formatDate = (value: string) => new Date(value).toLocaleString()
function changed() {
  const live = collaboration.value
  if (!live) return
  tick.value++
  const accessWasClean = !note.value || access.value === note.value.access
  note.value = live.note
  if (accessWasClean) access.value = live.note.access
  source.value = live.text.toString()
  // Yjs also emits inside CodeMirror's update cycle; reconfigure on the next tick.
  void nextTick(() => {
    if (!disposed) editor?.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(!live.canEdit), EditorView.editable.of(live.canEdit)]) })
  })
  if (!live.note.canEdit && mode.value === 'edit') setMode('read')
}
function setMode(value: 'read' | 'edit', push = true) {
  mode.value = value === 'edit' && !note.value?.canEdit ? 'read' : value
  const url = new URL(window.location.href)
  url.searchParams.set('mode', mode.value)
  if (push) window.history.pushState(window.history.state, '', url)
  else window.history.replaceState(window.history.state, '', url)
  void nextTick(() => { editor?.requestMeasure(); if (mode.value === 'edit') editor?.focus() })
}
function popMode() { setMode(new URLSearchParams(window.location.search).get('mode') === 'edit' ? 'edit' : 'read', false) }
function beforeLeave(event: BeforeUnloadEvent) {
  if (unsafeExit.value) { event.preventDefault(); event.returnValue = '' }
}
function download() {
  const blob = new Blob([source.value], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = `${noteKey}.md`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function reopen() { window.location.reload() }
async function refresh(preserveDraft = false) {
  if (loading.value || !actor || actor !== identity()) return
  if (!collaboration.value) { window.location.reload(); return }
  const epoch = generation, accessWasDirty = dirtyAccess.value
  loading.value = true; error.value = ''; accepted.value = false
  try {
    const value = await api.read(noteKey, controller.signal)
    if (!current(epoch, actor)) return
    collaboration.value?.accept(value)
    if (!preserveDraft || !accessWasDirty) access.value = value.access
    accepted.value = true
  } catch (caught) {
    if (!current(epoch, actor)) return
    error.value = caught instanceof Error ? caught.message : t('loadFailed', 'The note could not be loaded.')
    if (caught instanceof LiveNotesApiError && [401, 403, 404].includes(caught.status)) collaboration.value?.block(error.value)
  } finally { if (current(epoch, actor)) loading.value = false }
}
async function manage(operation: (value: LiveNoteView) => Promise<LiveNoteView | boolean>) {
  if (!note.value?.canManage || !settled.value || busy.value || actor !== identity()) return
  const epoch = generation, capturedActor = actor, baseline = note.value
  busy.value = true; error.value = ''
  try {
    const result = await operation(baseline)
    if (!current(epoch, capturedActor)) return
    if (result === true) { busy.value = false; access.value = baseline.access; window.location.assign('/p/notes'); return }
    if (typeof result !== 'boolean') { collaboration.value?.accept(result); access.value = result.access }
  } catch (caught) {
    if (!current(epoch, capturedActor)) return
    accepted.value = false
    error.value = caught instanceof LiveNotesApiError && caught.status === 409 ? t('stale', 'The note changed elsewhere. Refresh current access and review before trying again.') : caught instanceof Error ? caught.message : t('writeFailed', 'The change could not be saved. Refresh before trying again.')
    if (caught instanceof LiveNotesApiError && [401, 403, 404].includes(caught.status)) collaboration.value?.block(error.value)
  } finally { if (current(epoch, capturedActor)) busy.value = false }
}
async function saveAccess() { const nextAccess = access.value; await manage(value => api.access(noteKey, value.revision, nextAccess, controller.signal)) }
async function remove() {
  const epoch = generation, capturedActor = actor, revision = note.value?.revision
  if (!await requestConfirmation({ title: t('delete', 'Delete note'), message: t('deleteConfirm', 'Permanently delete this note and its history? All collaborators will be disconnected.'), confirmLabel: t('delete', 'Delete note') })) return
  if (!current(epoch, capturedActor)) return
  if (note.value?.revision !== revision) { error.value = t('stale', 'The note changed elsewhere. Refresh current access and review before trying again.'); return }
  await manage(value => api.remove(noteKey, value.revision, controller.signal))
}
async function loadHistory(more: boolean) {
  if (historyLoading.value || actor !== identity() || !accepted.value) return
  historyOpen.value = true; historyLoading.value = true; historyError.value = ''
  const epoch = generation, capturedActor = actor
  try {
    const result = await api.history(noteKey, more ? historyCursor.value : null, controller.signal)
    if (!current(epoch, capturedActor)) return
    historyItems.value = more ? [...historyItems.value, ...result.items] : result.items; historyCursor.value = result.nextCursor
  } catch (caught) {
    if (!current(epoch, capturedActor)) return
    historyError.value = caught instanceof Error ? caught.message : t('historyFailed', 'History could not be loaded.')
    if (caught instanceof LiveNotesApiError && [401, 403, 404].includes(caught.status)) { accepted.value = false; collaboration.value?.block(historyError.value) }
  }
  finally { if (current(epoch, capturedActor)) historyLoading.value = false }
}
async function viewRevision(revision: number) {
  if (actor !== identity() || historyLoading.value || !accepted.value) return
  const epoch = generation, capturedActor = actor
  historyLoading.value = true; historyError.value = ''
  try {
    const value = await api.revision(noteKey, revision, controller.signal)
    if (!current(epoch, capturedActor)) return
    const doc = new Y.Doc()
    try { Y.applyUpdate(doc, decodeNoteState(value.state)); historicalText.value = doc.getText('content').toString(); historical.value = value } finally { doc.destroy() }
  } catch (caught) {
    if (!current(epoch, capturedActor)) return
    historyError.value = caught instanceof Error ? caught.message : t('historyFailed', 'History could not be loaded.')
    if (caught instanceof LiveNotesApiError && [401, 403, 404].includes(caught.status)) { accepted.value = false; collaboration.value?.block(historyError.value) }
  }
  finally { if (current(epoch, capturedActor)) historyLoading.value = false }
}
async function restore() {
  const target = historical.value, baseline = note.value?.revision, epoch = generation, capturedActor = actor
  if (!target || !await requestConfirmation({ title: t('restore', 'Restore this revision'), message: t('restoreConfirm', 'Replace the live text with this revision? This creates a new revision for every collaborator.'), confirmLabel: t('restore', 'Restore this revision') })) return
  if (!current(epoch, capturedActor) || note.value?.revision !== baseline) { error.value = t('stale', 'The note changed elsewhere. Refresh current access and review before trying again.'); return }
  await manage(value => api.restore(noteKey, target.revision, value.revision, controller.signal))
  if (accepted.value) await loadHistory(false)
}
function openPublication() {
  if (publication.value) { document.getElementById('note-publish-title')?.focus(); return }
  if (!settled.value || !canPublish.value || !note.value || publicationUncertain.value) return
  publication.value = captureNotePublication(source.value, note.value.revision)
  publishTitle.value = publication.value.title; publishPath.value = ''; publishError.value = ''; publishedHref.value = ''; publicationAttempted.value = false
  void nextTick(() => document.getElementById('note-publish-title')?.focus())
}
async function closePublication() {
  if (publishing.value) return
  if (!publicationAttempted.value && !await requestConfirmation({ title: t('closePublication', 'Close publication form?'), message: t('closePublicationHelp', 'The note is kept, but these page destination choices will be discarded.'), confirmLabel: t('close', 'Close') })) return
  publication.value = null
}
async function publish() {
  if (!publication.value || !canPublish.value || publicationAttempted.value || publishing.value || actor !== identity()) return
  const capturedActor = actor, epoch = generation, capture = publication.value
  const destination = { locale: publishLocale.value, path: publishPath.value.replace(/^\/+|\/+$/gu, ''), visibility: publishVisibility.value }
  if (!publishTitle.value.trim() || !destination.path || !destination.locale) return
  publishing.value = true; publicationAttempted.value = true; publishError.value = ''
  try {
    await createPage((input, init) => window.fetch(input, { ...init, signal: controller.signal }), {
      content: capture.content, title: publishTitle.value.trim(), description: '', editor: 'markdown', visibility: destination.visibility,
      isPublished: publishPublished.value, locale: destination.locale, path: destination.path, publishEndDate: '', publishStartDate: '', scriptCss: '', scriptJs: '', tags: []
    })
    if (!current(epoch, capturedActor)) return
    publishedHref.value = `${destination.visibility === 'private' ? '/_private' : ''}/${encodeURIComponent(destination.locale)}/${destination.path.split('/').map(encodeURIComponent).join('/')}`
  } catch (caught) {
    if (current(epoch, capturedActor)) {
      publicationUncertain.value = true
      publishError.value = `${caught instanceof Error ? caught.message : t('publishFailed', 'Page creation could not be confirmed.')} ${t('noRetry', 'This request will not be retried. Check your pages for the destination before starting another publication.')}`
    }
  } finally { if (current(epoch, capturedActor)) publishing.value = false }
}
watch([identity, () => wikiStore.authRefreshOutcome, () => wikiStore.user.permissions.join(',')], () => {
  if (!actor) return
  if (actor !== identity()) {
    generation++; controller.abort(); accepted.value = false; busy.value = false; loading.value = false; publishing.value = false
    historical.value = null; historicalText.value = ''; historyItems.value = []; historyOpen.value = false; publication.value = null
    collaboration.value?.invalidateIdentity()
    return
  }
  // Verification readiness is reversible; only an actual actor/session boundary
  // permanently stops this document. Never retry uncertain REST mutations.
  generation++; controller.abort(); controller = new AbortController()
  accepted.value = false; busy.value = false; loading.value = false; historyLoading.value = false
  if (publishing.value) {
    publicationUncertain.value = true
    publishError.value = t('noRetry', 'This request will not be retried. Check your pages for the destination before starting another publication.')
  }
  publishing.value = false
  collaboration.value?.setAuthorizationReady(false)
  if (collaboration.value && ['authenticated', 'anonymous'].includes(wikiStore.authRefreshOutcome ?? '')) {
    void refresh(true).then(() => {
      if (accepted.value && actor === identity()) collaboration.value?.setAuthorizationReady(true)
    })
  }
}, { flush: 'sync' })
watch(previewHtml, async () => { await nextTick(); if (previewHost.value) enhanceWikiMarkdownPreview(previewHost.value) })
let safetyRevision = 0
watch([tick, unsafeExit, publishTitle, publishPath, publishLocale, publishVisibility, publishPublished], () => { safetyRevision++; notifyReloadSafetyChanged() }, { flush: 'sync' })
onMounted(async () => {
  window.addEventListener('beforeunload', beforeLeave); window.addEventListener('popstate', popMode)
  setReloadSafetyProvider(() => ({ safe: !unsafeExit.value, revision: `live-note:${safetyRevision}`, actorEpoch: wikiStore.offlineIdentityEpoch }))
  loading.value = true
  await wikiStore.waitForAuthRefresh()
  if (disposed) return
  actor = identity()
  const epoch = generation
  try {
    const value = await api.read(noteKey, controller.signal)
    if (!current(epoch, actor)) return
    const live = new LiveNoteCollaboration({ note: value, api, identity, onChange: changed })
    collaboration.value = live; accepted.value = true; access.value = value.access; changed()
    await nextTick()
    if (!current(epoch, actor)) return
    const noteHistory = new LiveNoteHistory(live.text, () => live.canEdit, () => { error.value = t('historyLimit', 'This undo/redo is too large for one live update. Use note history to restore a saved revision; no change was applied.') })
    history = noteHistory
    if (editorHost.value) editor = new EditorView({ parent: editorHost.value, state: EditorState.create({ doc: live.text.toString(), extensions: [
      lineNumbers(), markdown(), EditorView.lineWrapping, noteHistory.extension, keymap.of([...defaultKeymap, indentWithTab]), yCollab(live.text, null, { undoManager: noteHistory.manager }),
      editable.of([EditorState.readOnly.of(!live.canEdit), EditorView.editable.of(live.canEdit)]),
      EditorView.contentAttributes.of({ 'aria-label': t('markdown', 'Note Markdown') }),
      EditorState.transactionFilter.of(transaction => {
        if (!transaction.docChanged || transaction.annotation(ySyncAnnotation)) return transaction
        if (!live.canEdit) return []
        if (textEncoder.encode(transaction.newDoc.toString()).byteLength > LIVE_NOTE_MAX_TEXT_BYTES) { error.value = t('textLimit', 'Notes are limited to 1 MiB of Markdown. This edit was not applied.'); return [] }
        let inserted = 0
        transaction.changes.iterChanges((_from, _to, _newFrom, _newTo, text) => { inserted += textEncoder.encode(text.toString()).byteLength })
        if (inserted > 32 * 1024) { error.value = t('pasteLimit', 'Paste at most 32 KiB at a time so each collaborative update fits safely. This edit was not applied.'); return [] }
        noteHistory.track(transaction)
        return transaction
      })
    ] }) })
    setMode(mode.value, false)
    if (previewHost.value) enhanceWikiMarkdownPreview(previewHost.value)
    void live.connect()
  } catch (caught) { if (current(epoch, actor)) error.value = caught instanceof Error ? caught.message : t('loadFailed', 'The note could not be loaded.') }
  finally { if (current(epoch, actor)) loading.value = false }
})
onBeforeUnmount(() => {
  disposed = true; generation++; controller.abort(); editor?.destroy(); history?.destroy(); collaboration.value?.destroy()
  setReloadSafetyProvider(null)
  window.removeEventListener('beforeunload', beforeLeave); window.removeEventListener('popstate', popMode)
})
</script>

<style scoped>
.live-note { max-width: 78rem; margin: 0 auto; padding: clamp(1rem, 3vw, 2.5rem); color: rgb(var(--v-theme-on-surface)); }
.live-note__header, .live-note__actions { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .75rem; }
.live-note h1 { font-size: clamp(1.5rem, 4vw, 2.2rem); line-height: 1.25; margin: .75rem 0; overflow-wrap: anywhere; }
.live-note p { margin-block: .75rem; }
.live-note button, .live-note input, .live-note select { font: inherit; color: inherit; border: 1px solid var(--wiki-surface-border); border-radius: .4rem; background: rgb(var(--v-theme-surface)); padding: .65rem .85rem; min-height: 44px; }
.live-note button { cursor: pointer; }
.live-note button:disabled { opacity: .55; cursor: not-allowed; }
.live-note :is(button, input, select, a, summary):focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: 3px; }
.live-note__workspace { border: 1px solid var(--wiki-surface-border); border-radius: .5rem; overflow: hidden; min-height: 55vh; }
.live-note__editor :deep(.cm-editor) { min-height: 55vh; background: rgb(var(--v-theme-surface)); color: rgb(var(--v-theme-on-surface)); }
.live-note__editor :deep(.cm-content) { font-family: var(--wiki-font-mono, monospace); padding-block: 1rem; caret-color: currentColor; }
.live-note__editor :deep(.cm-scroller) { overflow: auto; }
.live-note__editor :deep(.cm-gutters) { background: rgb(var(--v-theme-surface)); color: rgb(var(--v-theme-on-surface)); border-color: var(--wiki-surface-border); }
.live-note__preview { padding: clamp(1rem, 3vw, 2rem); max-width: 54rem; margin: auto; overflow-wrap: anywhere; }
.live-note__preview :deep(img) { max-width: 100%; height: auto; }
.live-note__preview :deep(pre) { overflow-x: auto; }
.live-note__management, .live-note__history, .live-note__publication { padding: 1rem; margin-block: 1rem; border: 1px solid var(--wiki-surface-border); border-radius: .5rem; }
.live-note summary { cursor: pointer; min-height: 44px; padding-block: .5rem; }
.live-note__form { display: grid; gap: 1rem; max-width: 44rem; margin-top: 1rem; }
.live-note__form label { display: grid; gap: .4rem; }
.live-note__form .live-note__check { display: flex; align-items: center; }
.live-note__form input, .live-note__form select { width: 100%; min-width: 0; }
.live-note__check input { width: 1.25rem; }
.live-note__error, .live-note__danger { color: rgb(var(--v-theme-error)); }
.live-note__snapshot { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 24rem; overflow-y: auto; padding: 1rem; background: rgb(var(--v-theme-surface)); }
.live-note__history li { margin: .5rem 0 .5rem 1.5rem; }
@media (max-width: 600px) { .live-note__actions { width: 100%; justify-content: flex-start; } .live-note__actions button { flex: 1 1 auto; } }
</style>
