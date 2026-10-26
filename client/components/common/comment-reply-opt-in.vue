<template>
  <section class="comment-reply-opt-in" :aria-label="t('title', 'Reply notifications')" :aria-busy="loading || saving">
    <h3 class="text-title-small">{{ t('title', 'Reply notifications') }}</h3>
    <p class="text-body-small mt-2">{{ t('scope', 'Optional account setting: In-app — Replies in your discussions (commentReply). This applies to discussions you participate in, not just this page. Email and the per-page watch bell are unchanged.') }}</p>
    <p v-if="loading" class="text-body-small mt-2" role="status">{{ t('loading', 'Loading your current notification preferences…') }}</p>
    <p v-else-if="success" class="text-body-small mt-2" role="status">{{ success }}</p>
    <p v-else-if="alreadyEnabled" class="text-body-small mt-2" role="status">{{ t('alreadyEnabled', 'In-app replies in your discussions are already enabled. No settings were changed.') }}</p>
    <template v-else-if="loaded && !blocked">
      <v-checkbox :model-value="selected" :label="t('choice', 'Enable In-app: Replies in your discussions')" :disabled="saving" hide-details density="compact" @update:model-value="setSelected" />
      <p class="text-body-small">{{ t('consent', 'This choice starts unchecked. Checking it only prepares a change; Save explicitly enables this category and channel. Not now leaves all preferences unchanged.') }}</p>
      <v-btn class="mt-2" type="button" size="small" variant="outlined" :disabled="!selected || saving || !currentAuthority" :loading="saving" @click="save">{{ t('save', 'Save reply notification choice') }}</v-btn>
    </template>
    <p v-if="error" class="text-body-small mt-2" role="alert">{{ error }}</p>
    <p v-if="blocked" class="text-body-small mt-2">{{ t('fallback', 'No new change is confirmed here. In Notifications, review In-app: Replies in your discussions and explicitly Save preferences if you want to enable it.') }}</p>
    <div class="d-flex flex-wrap ga-2 mt-2">
      <a href="/p/notifications" class="text-body-small">{{ t('settings', 'Review reply delivery in Notifications') }}</a>
      <v-btn type="button" size="small" variant="text" :disabled="saving" @click="emit('dismiss')">{{ success || alreadyEnabled ? t('dismiss', 'Dismiss') : t('decline', 'Not now — leave preferences unchanged') }}</v-btn>
    </div>
  </section>
</template>

<script setup lang="ts">
import i18next from 'i18next'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { wikiStore } from '../../store/index.ts'
import { OFFLINE_SESSION_INVALIDATED_EVENT } from '../../helpers/offline-session.ts'
import { fetchNotificationPreferences, updateNotificationPreferences } from '../../helpers/site-notifications-api.ts'

const props = defineProps<{ pageId: number; contributionId: number; authorized: boolean }>()
const emit = defineEmits<{ dismiss: [] }>()
const t = (key: string, defaultValue: string): string => i18next.t(`common:comments.replyOptIn.${key}`, { defaultValue })
const selected = ref(false)
const setSelected = (value: boolean | null): void => {
  if (value !== null) selected.value = value
}
const loaded = ref(false)
const loading = ref(false)
const saving = ref(false)
const blocked = ref(false)
const alreadyEnabled = ref(false)
const success = ref('')
const error = ref('')
let generation = 0
let controller: AbortController | null = null
let disposed = false
let invalidated = false

const currentAuthority = computed(() => props.authorized && wikiStore.page.id === props.pageId &&
  wikiStore.page.effectivePermissions.comments.read && wikiStore.page.effectivePermissions.comments.write &&
  wikiStore.user.authenticated === true && Number.isSafeInteger(wikiStore.user.id) &&
  wikiStore.user.id > 0 && wikiStore.user.id !== 2 && wikiStore.user.email !== 'api@localhost' &&
  wikiStore.authRefreshSettled === true && wikiStore.authRefreshOutcome === 'authenticated' && wikiStore.authRefreshPending === false)
const contextKey = computed(() => `${props.pageId}:${props.contributionId}:${wikiStore.user.id}:${wikiStore.user.authVersion}:${wikiStore.offlineIdentityEpoch}:${currentAuthority.value}`)
const clear = (): void => {
  generation += 1
  controller?.abort()
  controller = null
  selected.value = false
  loaded.value = false
  loading.value = false
  saving.value = false
  alreadyEnabled.value = false
  success.value = ''
  error.value = ''
}
const invalidate = (): void => {
  invalidated = true
  clear()
  blocked.value = true
  error.value = t('sessionChanged', 'Your session changed. Review the setting in your profile before making a change.')
}
const load = async (): Promise<void> => {
  if (!currentAuthority.value || invalidated || disposed) return
  const owner = wikiStore.user.id
  const key = contextKey.value
  const requestGeneration = generation
  const request = new AbortController()
  controller = request
  loading.value = true
  const current = (): boolean => !disposed && !invalidated && !request.signal.aborted &&
    generation === requestGeneration && currentAuthority.value && contextKey.value === key && wikiStore.user.id === owner
  try {
    const response = await fetchNotificationPreferences(owner, request.signal)
    if (!current()) return
    alreadyEnabled.value = response.preferences.commentReply.inApp
    loaded.value = true
  } catch {
    if (!current()) return
    blocked.value = true
    error.value = t('loadError', 'Current reply preferences could not be verified. No settings were changed here.')
  } finally {
    if (current()) {
      loading.value = false
      controller = null
    }
  }
}
const save = async (): Promise<void> => {
  if (!selected.value || !loaded.value || blocked.value || alreadyEnabled.value || saving.value ||
    !currentAuthority.value || invalidated || disposed) return
  const owner = wikiStore.user.id
  const key = contextKey.value
  const requestGeneration = generation
  const request = new AbortController()
  controller = request
  saving.value = true
  error.value = ''
  const current = (): boolean => !disposed && !invalidated && !request.signal.aborted &&
    generation === requestGeneration && currentAuthority.value && contextKey.value === key && wikiStore.user.id === owner
  try {
    // Recheck reply delivery before explicit consent; never replay this snapshot in the patch.
    const latest = await fetchNotificationPreferences(owner, request.signal)
    if (!current()) return
    if (latest.preferences.commentReply.inApp) {
      alreadyEnabled.value = true
      selected.value = false
      return
    }
    const response = await updateNotificationPreferences(owner, { commentReply: { inApp: true } }, request.signal)
    if (!current()) return
    if (!response.preferences.commentReply.inApp) throw new Error('Reply notification change was not confirmed')
    selected.value = false
    success.value = t('saved', 'In-app replies in your discussions are enabled. Other categories, Email, and per-page watches were not changed by this choice.')
  } catch {
    if (!current()) return
    blocked.value = true
    selected.value = false
    error.value = t('saveError', 'The reply notification change could not be confirmed. Review the current setting in Notifications; do not assume it was saved.')
  } finally {
    if (current()) {
      saving.value = false
      controller = null
    }
  }
}
watch(contextKey, () => {
  clear()
  blocked.value = invalidated
  void load()
}, { immediate: true, flush: 'sync' })
onMounted(() => window.addEventListener(OFFLINE_SESSION_INVALIDATED_EVENT, invalidate))
onBeforeUnmount(() => {
  disposed = true
  clear()
  window.removeEventListener(OFFLINE_SESSION_INVALIDATED_EVENT, invalidate)
})
</script>

<style scoped>
.comment-reply-opt-in { padding: 1rem; border: 1px solid var(--wiki-surface-border); border-radius: .5rem; }
.comment-reply-opt-in a { align-self: center; overflow-wrap: anywhere; }
.comment-reply-opt-in :deep(.v-btn) { max-width: 100%; min-width: 0; min-height: 44px; height: auto; padding-block: 8px; white-space: normal; text-align: start; }
.comment-reply-opt-in :deep(.v-btn__content) { white-space: normal; overflow-wrap: anywhere; }
.comment-reply-opt-in :deep(.v-label) { white-space: normal; }
</style>
