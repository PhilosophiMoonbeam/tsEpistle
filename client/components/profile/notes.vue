<template>
  <section class="profile-notes" aria-labelledby="profile-notes-title">
    <header><div><h1 id="profile-notes-title">{{ t('inventory', 'My live notes') }}</h1><p>{{ t('inventoryHelp', 'Your standalone collaborative Markdown notes. Publishing a page does not remove a note.') }}</p></div><button type="button" :disabled="loading || creating || !ready" @click="load(false)">{{ t('reload', 'Reload') }}</button></header>
    <p v-if="!ready" role="status">{{ t('accountRequired', 'A current signed-in account is required. Reload after signing in again.') }}</p>
    <form v-if="canCreate" class="profile-notes__create" @submit.prevent="create">
      <details><summary>{{ t('customAddress', 'Custom address (optional)') }}</summary>
        <label>{{ t('customKey', 'Custom key (optional)') }}<input v-model="customKey" pattern="[a-z0-9](?:[a-z0-9\-]{1,62}[a-z0-9])" minlength="3" maxlength="64" autocomplete="off" :disabled="creating || creationUncertain" aria-describedby="note-key-help" /></label>
        <p id="note-key-help">{{ t('keyHelp', 'Leave blank for a random address, or use 3–64 lowercase letters, digits and hyphens. A key does not grant access.') }}</p>
      </details>
      <p>{{ t('blankPrivateNote', 'Creates a blank private note on this Wiki. Start writing after it opens; publishing a wiki page is a separate action.') }}</p>
      <button type="submit" :disabled="creating || creationUncertain">{{ creating ? t('creating', 'Creating…') : t('create', 'Create private note') }}</button>
    </form>
    <p v-if="!canCreate && ready">{{ t('createDenied', 'Your current wiki permissions do not allow creating notes.') }}</p>
    <div v-if="error" class="profile-notes__error" role="alert">{{ error }}</div>
    <div v-if="creationUncertain" role="status">
      <p>{{ t('noteCreationUnknown', 'Creation is not confirmed. The captured address is kept in this tab; it will not be created again automatically. A missing or inaccessible note does not prove creation failed.') }}</p>
      <p v-if="attempt && attempt.actor === identity()"><code>{{ attempt.key }}</code></p>
      <button type="button" :disabled="checking || !ready || !attempt || attempt.actor !== identity()" @click="checkCreation">{{ checking ? t('checkingNoteCreation', 'Checking address…') : t('checkNoteCreation', 'Check requested note address') }}</button>
    </div>
    <p v-if="accessibleNote" role="status">{{ t('accessibleNoteFound', 'An accessible note exists at the requested address. This check does not prove this creation attempt made it, especially when a custom address was used.') }} <a :href="`/p/notes/${encodeURIComponent(accessibleNote.key)}?mode=${accessibleNote.canEdit ? 'edit' : 'read'}`">{{ t('openNote', 'Open note') }}</a></p>
    <p v-if="loading" role="status">{{ t('loadingInventory', 'Loading your notes…') }}</p>
    <p v-else-if="loaded && !items.length">{{ t('empty', 'No live notes yet.') }}</p>
    <ul class="profile-notes__list"><li v-for="item in items" :key="item.id"><a :href="`/p/notes/${encodeURIComponent(item.key)}?mode=${item.canEdit ? 'edit' : 'read'}`"><strong>{{ item.title || t('untitled', 'Untitled note') }}</strong><code>{{ item.key }}</code></a><div><span>{{ accessLabel(item.access) }}</span> · <time :datetime="item.updatedAt">{{ new Date(item.updatedAt).toLocaleString() }}</time> · {{ t('revision', 'Revision') }} {{ item.revision }}<span v-if="!item.canEdit"> · {{ t('readOnlyShort', 'Read only') }}</span></div></li></ul>
    <button v-if="cursor" type="button" :disabled="loading || !ready" @click="load(true)">{{ t('loadMore', 'Load more') }}</button>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { wikiStore } from '../../store/index.ts'
import { translate } from '../../modules/localization.ts'
import { createLiveNotesApi, LiveNotesApiError } from '../../helpers/live-notes-api.ts'
import type { LiveNoteAccess, LiveNoteSummary, LiveNoteView } from '../../../shared/live-notes.ts'
import { requestConfirmation } from '../common/confirm-dialog.ts'
import { notifyReloadSafetyChanged, setReloadSafetyProvider } from '../../helpers/pwa.ts'

const t = (key: string, defaultValue: string) => translate(`common:liveNotes.${key}`, { defaultValue })
const identity = () => `${wikiStore.user.id}:${wikiStore.user.authVersion}:${wikiStore.offlineIdentityEpoch}:${siteConfig.agentCsrfToken}`
const ready = computed(() => wikiStore.authRefreshOutcome === 'authenticated' && wikiStore.user.authenticated && wikiStore.user.id > 0)
const canCreate = computed(() => ready.value && (wikiStore.user.permissions.includes('write:notes') || wikiStore.user.permissions.includes('manage:system')))
const api = createLiveNotesApi((...args) => window.fetch(...args), () => siteConfig.agentCsrfToken)
const items = ref<LiveNoteSummary[]>([]), cursor = ref<string | null>(null), loading = ref(false), loaded = ref(false), creating = ref(false), error = ref(''), customKey = ref(''), creationUncertain = ref(false)
const attempt = ref<{ key: string; actor: string; ownerId: number } | null>(null), checking = ref(false), accessibleNote = ref<LiveNoteView | null>(null)
let generation = 0, disposed = false, controller = new AbortController()
const accessLabel = (access: LiveNoteAccess) => access === 'private' ? t('privateShort', 'Private') : access === 'read' ? t('sharedRead', 'Shared for reading') : t('sharedEdit', 'Shared for editing')
async function load(more: boolean) {
  if (!ready.value || loading.value || creating.value) return
  const actor = identity(), epoch = generation
  loading.value = true; error.value = ''
  try {
    const result = await api.list(more ? cursor.value : null, controller.signal)
    if (disposed || generation !== epoch || actor !== identity()) return
    items.value = more ? [...items.value, ...result.items.filter(item => !items.value.some(existing => existing.id === item.id))] : result.items
    cursor.value = result.nextCursor; loaded.value = true
  } catch (caught) { if (!disposed && epoch === generation && actor === identity()) error.value = caught instanceof Error ? caught.message : t('inventoryFailed', 'Your notes could not be loaded.') }
  finally { if (!disposed && epoch === generation && actor === identity()) loading.value = false }
}
async function create() {
  if (!canCreate.value || creating.value || creationUncertain.value) return
  const actor = identity(), epoch = generation
  const capturedKey = customKey.value || crypto.randomUUID()
  attempt.value = { key: capturedKey, actor, ownerId: wikiStore.user.id }; accessibleNote.value = null
  creating.value = true; error.value = ''
  try {
    const note = await api.create(capturedKey, controller.signal)
    if (disposed || epoch !== generation || actor !== identity()) return
    if (note.key !== capturedKey || note.ownerId !== attempt.value?.ownerId) throw new Error(t('noteCreationMismatch', 'The returned note did not confirm this account and requested address. Check the address without creating again.'))
    customKey.value = ''; creating.value = false; attempt.value = null
    window.location.assign(`/p/notes/${encodeURIComponent(note.key)}?mode=edit`)
  } catch (caught) {
    if (disposed || epoch !== generation || actor !== identity()) return
    const definiteRejection = caught instanceof LiveNotesApiError && caught.code !== 'REQUEST_FAILED' && caught.status >= 400 && caught.status < 500
    creationUncertain.value = !definiteRejection
    error.value = `${caught instanceof Error ? caught.message : t('createFailed', 'Note creation could not be confirmed.')}${creationUncertain.value ? ` ${t('noteCreationUnknown', 'Creation is not confirmed. The captured address is kept in this tab; it will not be created again automatically. A missing or inaccessible note does not prove creation failed.')}` : ''}`
  } finally { if (!disposed && epoch === generation && actor === identity()) creating.value = false }
}
async function checkCreation() {
  const capture = attempt.value
  if (!capture || !ready.value || capture.actor !== identity() || capture.ownerId !== wikiStore.user.id || checking.value) return
  const epoch = generation
  checking.value = true; error.value = ''; accessibleNote.value = null
  try {
    const value = await api.read(capture.key, controller.signal)
    if (disposed || epoch !== generation || capture.actor !== identity() || attempt.value !== capture) return
    if (value.key !== capture.key) throw new Error(t('noteAddressMismatch', 'This check did not return the requested note address. Creation remains unknown.'))
    accessibleNote.value = value
  } catch {
    if (disposed || epoch !== generation || capture.actor !== identity()) return
    error.value = t('noteCheckUnknown', 'No accessible note was confirmed by this check. Creation remains unknown; the original request will not be replayed. You may check again.')
  } finally { if (!disposed && epoch === generation && capture.actor === identity()) checking.value = false }
}
function beforeLeave(event: BeforeUnloadEvent) { if (creating.value || customKey.value || creationUncertain.value) { event.preventDefault(); event.returnValue = '' } }
onBeforeRouteLeave(async () => {
  if (!creating.value && !customKey.value && !creationUncertain.value) return true
  return requestConfirmation({ title: t('leaveCreation', 'Leave note creation?'), message: t('leaveCreationRecoveryHelp', 'The captured address and creation choices are only kept in this tab. An uncertain creation may already exist; check the requested address before leaving. Your saved notes are not removed.'), confirmLabel: t('leave', 'Leave') })
})
watch(identity, () => {
  generation++; controller.abort(); controller = new AbortController(); items.value = []; cursor.value = null; loaded.value = false; loading.value = false; checking.value = false; accessibleNote.value = null
  if (creating.value || creationUncertain.value) { creationUncertain.value = true; error.value = t('noteCreationIdentityChanged', 'Account or session changed. The requested address is kept, but this account cannot confirm the original creation attempt. Reopen your notes under the original account. No creation will be replayed.') }
  else error.value = ''
  creating.value = false
  if (ready.value) void load(false)
}, { flush: 'sync' })
watch([ready, () => wikiStore.user.permissions.join(',')], ([value]) => {
  generation++; controller.abort(); controller = new AbortController(); loading.value = false; checking.value = false; accessibleNote.value = null; items.value = []; cursor.value = null; loaded.value = false
  if (creating.value) {
    creationUncertain.value = true
    error.value = t('noteCreationUnknown', 'Creation is not confirmed. The captured address is kept in this tab; it will not be created again automatically. A missing or inaccessible note does not prove creation failed.')
  }
  creating.value = false
  if (value) void load(false)
}, { flush: 'sync' })
let safetyRevision = 0
watch([creating, customKey, creationUncertain], () => { safetyRevision++; notifyReloadSafetyChanged() }, { flush: 'sync' })
onMounted(async () => {
  window.addEventListener('beforeunload', beforeLeave)
  setReloadSafetyProvider(() => ({ safe: !creating.value && !customKey.value && !creationUncertain.value, revision: `note-inventory:${safetyRevision}`, actorEpoch: wikiStore.offlineIdentityEpoch }))
  await wikiStore.waitForAuthRefresh()
  if (!disposed) void load(false)
})
onBeforeUnmount(() => { disposed = true; generation++; controller.abort(); setReloadSafetyProvider(null); window.removeEventListener('beforeunload', beforeLeave) })
</script>
<style scoped>
.profile-notes { max-width: 70rem; padding: clamp(1rem, 3vw, 2.5rem); margin: auto; color: rgb(var(--v-theme-on-surface)); }
.profile-notes header { display: flex; align-items: start; justify-content: space-between; flex-wrap: wrap; gap: 1rem; }
.profile-notes h1 { font-size: 1.8rem; line-height: 1.3; }
.profile-notes p { margin-block: .75rem; }
.profile-notes button, .profile-notes input { font: inherit; color: inherit; background: rgb(var(--v-theme-surface)); border: 1px solid var(--wiki-surface-border); border-radius: .4rem; min-height: 44px; padding: .65rem .85rem; }
.profile-notes button { cursor: pointer; }
.profile-notes button:disabled { opacity: .55; cursor: not-allowed; }
.profile-notes :is(a, button, input, summary):focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: 3px; }
.profile-notes__create { padding: 1rem; margin-block: 1.5rem; border: 1px solid var(--wiki-surface-border); border-radius: .5rem; }
.profile-notes__create label { display: grid; gap: .5rem; max-width: 30rem; }
.profile-notes summary { cursor: pointer; min-height: 44px; padding-block: .5rem; }
.profile-notes__create input { width: 100%; min-width: 0; }
.profile-notes__list { list-style: none; padding: 0; }
.profile-notes__list li { border-block-end: 1px solid var(--wiki-surface-border); padding-block: 1.25rem; }
.profile-notes__list a { display: grid; gap: .25rem; overflow-wrap: anywhere; }
.profile-notes__list code { font-size: .875rem; }
.profile-notes__error { color: rgb(var(--v-theme-error)); }
</style>
