<template>
  <section class="general-panel" aria-labelledby="admin-notification-settings-title">
    <h2 id="admin-notification-settings-title">{{ nt('title') }}</h2>
    <p id="admin-notification-settings-help">{{ nt('help') }}</p>
    <p v-if="loading" role="status">{{ nt('loading') }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <form v-if="saved" :aria-busy="saving ? 'true' : undefined" @submit.prevent="save">
      <div v-for="category in NOTIFICATION_CEILING_CATEGORIES" :key="category" class="my-4">
        <label :for="`admin-notification-${category}`">{{ nt(`categories.${category}`) }}</label>
        <select :id="`admin-notification-${category}`" v-model="draft[category]" class="d-block pa-2" :disabled="saving" aria-describedby="admin-notification-settings-help">
          <option value="off">{{ nt('modes.off') }}</option>
          <option value="in-app-only">{{ nt('modes.inAppOnly') }}</option>
          <option value="existing-consented-channels">{{ nt('modes.existingConsentedChannels') }}</option>
        </select>
      </div>
      <div class="d-flex flex-wrap ga-3">
        <v-btn type="submit" :disabled="!dirty || saving" :loading="saving">{{ nt('save') }}</v-btn>
        <v-btn variant="text" :disabled="!dirty || saving" @click="cancel">{{ nt('cancel') }}</v-btn>
      </div>
    </form>
    <v-btn class="mt-3" variant="text" :disabled="dirty || loading || saving" @click="load">{{ nt('reload') }}</v-btn>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { wikiStore } from '../../store/index.ts'
import { sameOriginJsonFetch } from '../../helpers/json-transport.ts'
import { confirmDiscard } from '../common/confirm-dialog.ts'
import { useTranslate } from '../../helpers/use-translate.ts'
import {
  NOTIFICATION_CEILING_CATEGORIES, NOTIFICATION_CEILING_MODES, defaultNotificationCeilings,
  type NotificationSettingsResponse
} from '../../../shared/site-notifications.ts'

const nt = useTranslate('admin:notificationSettings')
const saved = ref<NotificationSettingsResponse | null>(null)
const draft = ref(defaultNotificationCeilings())
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const dirty = computed(() => saved.value !== null && NOTIFICATION_CEILING_CATEGORIES.some(category => draft.value[category] !== saved.value?.ceilings[category]))
let controller: AbortController | undefined
let generation = 0
let disposed = false
const request = async (signal: AbortSignal, body?: NotificationSettingsResponse): Promise<NotificationSettingsResponse> => {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), '/_api/site/notification-settings', {
    credentials: 'same-origin', cache: 'no-store', signal,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { method: 'PUT', body: JSON.stringify(body) } : {})
  })
  const result: unknown = await response.json()
  if (!response.ok) throw new Error(result && typeof result === 'object' && typeof Reflect.get(result, 'error') === 'string' ? Reflect.get(result, 'error') : nt('requestFailed'))
  if (!result || typeof result !== 'object' || typeof Reflect.get(result, 'fingerprint') !== 'string') throw new Error(nt('invalidResponse'))
  const ceilings: unknown = Reflect.get(result, 'ceilings')
  if (!ceilings || typeof ceilings !== 'object' || !NOTIFICATION_CEILING_CATEGORIES.every(category => NOTIFICATION_CEILING_MODES.some(mode => mode === Reflect.get(ceilings, category)))) throw new Error(nt('invalidResponse'))
  return result as NotificationSettingsResponse
}
const load = async (): Promise<void> => {
  if (disposed || dirty.value || loading.value || saving.value || !wikiStore.user.authenticated) return
  const currentGeneration = generation
  const abort = new AbortController()
  controller = abort
  loading.value = true
  error.value = ''
  try {
    const result = await request(abort.signal)
    if (disposed || currentGeneration !== generation || abort.signal.aborted) return
    saved.value = result
    draft.value = { ...result.ceilings }
  } catch (cause) {
    if (!disposed && currentGeneration === generation && !abort.signal.aborted) error.value = cause instanceof Error ? cause.message : nt('loadFailed')
  } finally {
    if (currentGeneration === generation) { loading.value = false; controller = undefined }
  }
}
const cancel = (): void => {
  if (!saved.value || saving.value) return
  draft.value = { ...saved.value.ceilings }
  notice.value = ''
}
const save = async (): Promise<void> => {
  if (!saved.value || !dirty.value || saving.value || disposed) return
  const currentGeneration = generation
  const abort = new AbortController()
  controller = abort
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await request(abort.signal, { ceilings: { ...draft.value }, fingerprint: saved.value.fingerprint })
    if (disposed || currentGeneration !== generation || abort.signal.aborted) return
    saved.value = result
    draft.value = { ...result.ceilings }
    notice.value = nt('saved')
  } catch (cause) {
    if (!disposed && currentGeneration === generation && !abort.signal.aborted) error.value = cause instanceof Error ? cause.message : nt('saveFailed')
  } finally {
    if (currentGeneration === generation) { saving.value = false; controller = undefined }
  }
}
watch(() => [wikiStore.user.id, wikiStore.user.authenticated, wikiStore.user.authVersion, wikiStore.offlineIdentityEpoch], () => {
  generation += 1
  controller?.abort()
  controller = undefined
  saved.value = null
  draft.value = defaultNotificationCeilings()
  loading.value = false
  saving.value = false
  error.value = ''
  notice.value = ''
  void load()
}, { immediate: true, flush: 'sync' })
onBeforeRouteLeave(async () => !saving.value && (!dirty.value || await confirmDiscard(nt('discardConfirm'))))
const beforeUnload = (event: BeforeUnloadEvent): void => {
  if (!dirty.value && !saving.value) return
  event.preventDefault()
  event.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => { disposed = true; generation += 1; controller?.abort(); window.removeEventListener('beforeunload', beforeUnload) })
</script>
