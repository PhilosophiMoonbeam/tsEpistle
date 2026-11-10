<template>
  <section v-if="authenticated" class="page-edit-lock" :aria-label="$t('common:page.editLockTitle')" :aria-busy="busy">
    <p v-if="!ready" role="status">{{ $t('common:page.editLockReconnect') }}</p>
    <p v-else-if="loading" role="status">{{ $t('common:page.editLockLoading') }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="state && ready">
      <p class="page-edit-lock-status" role="status"><v-icon aria-hidden="true" size="18">{{ state.isEditLocked ? 'mdi-lock-outline' : 'mdi-lock-open-variant-outline' }}</v-icon><strong>{{ $t(state.isEditLocked ? 'common:page.editLockLocked' : 'common:page.editLockUnlocked') }}</strong></p>
      <p v-if="state.isEditLocked">{{ $t('common:page.editLockExplanation') }}</p>
      <details v-if="state.canManage">
        <summary>{{ $t('common:page.editLockManage') }}</summary>
        <p>{{ $t('common:page.editLockOverride') }}</p>
        <p v-if="state.reason">{{ $t('common:page.editLockLastReason') }} {{ state.reason }}</p>
        <p v-if="state.updatedAt">{{ $t('common:page.editLockAuditIdentity', { actor: state.updatedBy, version: state.lockVersion }) }} <time :datetime="state.updatedAt">{{ state.updatedAt }}</time></p>
        <form @submit.prevent="save">
          <label :for="reasonId">{{ $t('common:page.editLockReason') }}</label>
          <input :id="reasonId" v-model="reason" type="text" maxlength="500" required :disabled="busy" autocomplete="off" />
          <v-btn type="submit" color="primary" variant="tonal" :loading="busy" :disabled="busy || !validReason">{{ $t(state.isEditLocked ? 'common:page.editLockUnlockAction' : 'common:page.editLockLockAction') }}</v-btn>
        </form>
      </details>
    </template>
    <v-btn v-if="ready" type="button" size="small" variant="text" :disabled="busy || loading" @click="load">{{ $t('common:page.editLockReload') }}</v-btn>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { PageEditLockInputSchema, PageEditLockViewSchema, type PageEditLockView } from '../../shared/page-edit-lock.ts'
import { governanceRequest } from '../helpers/page-governance-api.ts'
import { wikiStore } from '../store/index.ts'

const props = defineProps<{ pageId: number; sourceRevision: string; ready: boolean }>()
const emit = defineEmits<{ change: [locked: boolean | null]; dirty: [value: boolean]; busy: [value: boolean] }>()
const state = ref<PageEditLockView | null>(null), reason = ref(''), error = ref(''), loading = ref(false), busy = ref(false)
const reasonId = useId()
const authenticated = computed(() => wikiStore.authRefreshSettled && !wikiStore.authRefreshPending && wikiStore.authRefreshOutcome === 'authenticated' && wikiStore.user.authenticated)
const identity = computed(() => JSON.stringify([props.pageId, props.sourceRevision, props.ready, authenticated.value, wikiStore.user.id, wikiStore.user.authVersion, wikiStore.offlineIdentityEpoch, wikiStore.user.permissions]))
const validReason = computed(() => PageEditLockInputSchema.safeParse({ isEditLocked: false, expectedLockVersion: state.value?.lockVersion ?? '0', reason: reason.value }).success)
let generation = 0, controller: AbortController | null = null, disposed = false
async function load() {
  const current = ++generation; controller?.abort(); state.value = null; error.value = ''; emit('change', null)
  if (!props.ready || !authenticated.value || props.pageId < 1) { loading.value = false; return }
  loading.value = true; controller = new AbortController()
  try {
    const loaded = await governanceRequest(fetch, `/_api/pages/${props.pageId}/edit-lock`, PageEditLockViewSchema, { signal: controller.signal })
    if (!disposed && current === generation) { state.value = loaded; emit('change', loaded.isEditLocked) }
  } catch (cause) { if (!disposed && current === generation && !(cause instanceof Error && cause.name === 'AbortError')) error.value = cause instanceof Error ? cause.message : 'Edit-lock state is unavailable.' }
  finally { if (!disposed && current === generation) loading.value = false }
}
async function save() {
  if (busy.value || !props.ready || !state.value?.canManage || !validReason.value) return
  const current = generation, owner = identity.value
  const command = PageEditLockInputSchema.parse({ isEditLocked: !state.value.isEditLocked, expectedLockVersion: state.value.lockVersion, reason: reason.value })
  busy.value = true; emit('busy', true); error.value = ''
  try {
    const updated = await governanceRequest(fetch, `/_api/pages/${props.pageId}/edit-lock`, PageEditLockViewSchema, { method: 'PUT', body: command })
    if (!disposed && current === generation && owner === identity.value) { state.value = updated; reason.value = ''; emit('change', updated.isEditLocked) }
  } catch (cause) {
    if (!disposed && current === generation && owner === identity.value) { state.value = null; error.value = cause instanceof Error ? cause.message : 'The edit-lock outcome is unknown. Reload current policy before trying again.' }
  } finally { if (!disposed && current === generation) { busy.value = false; emit('busy', false) } }
}
function protectUnload(event: BeforeUnloadEvent) { if (reason.value.trim() || busy.value) { event.preventDefault(); event.returnValue = '' } }
window.addEventListener('beforeunload', protectUnload)
watch(reason, value => emit('dirty', value.length > 0))
watch(identity, () => { reason.value = ''; busy.value = false; emit('busy', false); void load() }, { immediate: true })
onBeforeUnmount(() => { disposed = true; generation++; controller?.abort(); window.removeEventListener('beforeunload', protectUnload); emit('dirty', false); emit('busy', false) })
</script>
<style scoped>
.page-edit-lock { padding: .75rem 1rem; border: 1px solid rgba(var(--v-theme-on-surface), .16); border-radius: .5rem; margin-block: .75rem; }
.page-edit-lock p { margin-block: .4rem; }
.page-edit-lock-status { display: flex; align-items: center; gap: .5rem; }
summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; font-weight: 600; }
form { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; margin-block: .75rem; }
label { flex-basis: 100%; font-weight: 600; }
input { flex: 1 1 15rem; min-width: 0; padding: .65rem; border: 1px solid rgba(var(--v-theme-on-surface), .4); border-radius: .25rem; }
input:focus-visible, summary:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }
</style>
