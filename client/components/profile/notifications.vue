<template lang='pug'>
v-container.profile-notification-preferences(fluid)
  header.mb-6
    h1.text-headline-medium Notifications
    p.text-body-medium.mt-2 Choose which events appear in your inbox or are sent by email. New categories are off until you enable and save them.
    p.text-body-small.mt-2 These settings do not change your existing per-page watches or approval inbox.
  p(v-if='!ownerId', role='status') Sign in to manage notifications.
  p(v-else-if='loading', role='status') Loading your notification preferences…
  v-alert.mb-4(v-if='error', type='error', variant='tonal', role='alert')
    div {{ error }}
    v-btn.mt-2(v-if='!saved || blocked', variant='text', :disabled='loading || saving', @click='refreshIdentity') Refresh preferences
  p.text-success.mb-4(v-if='success', role='status') {{ success }}
  form(v-if='saved && !blocked', @submit.prevent='save', :aria-busy='saving ? `true` : undefined')
    fieldset.profile-notification-preferences__fieldset(:disabled='saving')
      legend.text-title-medium Delivery preferences
      .profile-notification-preferences__category(v-for='category in categories', :key='category.key')
        .profile-notification-preferences__copy
          h2.text-title-small {{ category.label }}
          p.text-body-small.text-medium-emphasis {{ category.description }}
        .profile-notification-preferences__channels
          v-checkbox(:model-value='draft[category.key].inApp', :label='`In-app: ${category.label}`', :disabled='saving', hide-details, density='comfortable', @update:model-value='setDeliveryPreference(category.key, `inApp`, $event)')
          v-checkbox(:model-value='draft[category.key].email', :label='`Email: ${category.label}`', :disabled='saving', hide-details, density='comfortable', @update:model-value='setDeliveryPreference(category.key, `email`, $event)')
    .d-flex.flex-wrap.ga-3.mt-6
      v-btn(type='submit', color='primary', :disabled='!dirty || saving', :loading='saving') Save preferences
      v-btn(variant='text', :disabled='!dirty || saving', @click='cancel') Cancel changes
</template>

<script setup lang='ts'>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { wikiStore } from '../../store/index.ts'
import { OFFLINE_SESSION_INVALIDATED_EVENT } from '../../helpers/offline-session.ts'
import { fetchNotificationPreferences, notificationIdentityInvalidated, updateNotificationPreferences } from '../../helpers/site-notifications-api.ts'
import { NOTIFICATION_CATEGORIES, type NotificationCategory, type NotificationPreferences } from '../../../shared/site-notifications.ts'

defineOptions({ name: 'ProfileNotifications' })

const categories: { key: NotificationCategory; label: string; description: string }[] = [
  { key: 'pageCreated', label: 'Page created', description: 'A page you are allowed to read is created.' },
  { key: 'pageDeleted', label: 'Page deleted', description: 'A page you are allowed to access is deleted.' },
  { key: 'watchedPageComment', label: 'Comment on a watched page', description: 'A new discussion contribution is posted on a page you watch.' },
  { key: 'commentReply', label: 'Replies in your discussions', description: 'Someone replies in a discussion you participate in.' },
  { key: 'mention', label: 'Mention', description: 'Someone mentions you in an authorized discussion.' }
]
const defaults = (): NotificationPreferences => ({
  pageCreated: { inApp: false, email: false },
  pageDeleted: { inApp: false, email: false },
  watchedPageComment: { inApp: false, email: false },
  commentReply: { inApp: false, email: false },
  mention: { inApp: false, email: false }
})
const copy = (preferences: NotificationPreferences): NotificationPreferences => {
  const result = defaults()
  for (const category of NOTIFICATION_CATEGORIES) result[category] = { ...preferences[category] }
  return result
}
const ownerId = computed(() => wikiStore.user.authenticated && Number.isSafeInteger(wikiStore.user.id) && wikiStore.user.id > 0 ? wikiStore.user.id : null)
const draft = ref<NotificationPreferences>(defaults())
const setDeliveryPreference = (category: NotificationCategory, channel: 'inApp' | 'email', value: boolean | null): void => {
  if (value !== null) draft.value[category][channel] = value
}
const saved = ref<NotificationPreferences | null>(null)
const draftOwner = ref<number | null>(null)
const loading = ref(false)
const saving = ref(false)
const blocked = ref(false)
const error = ref('')
const success = ref('')
const dirty = computed(() => saved.value !== null && NOTIFICATION_CATEGORIES.some(category =>
  saved.value?.[category].inApp !== draft.value[category].inApp || saved.value?.[category].email !== draft.value[category].email))
let generation = 0
let controller: AbortController | undefined
let disposed = false

const clear = (): void => {
  generation += 1
  controller?.abort()
  controller = undefined
  saved.value = null
  draft.value = defaults()
  draftOwner.value = null
  loading.value = false
  saving.value = false
  error.value = ''
  success.value = ''
}
const invalidate = (): void => {
  clear()
  blocked.value = true
  error.value = 'Your session changed. Refresh preferences before making changes.'
}
const load = async (): Promise<void> => {
  const owner = ownerId.value
  if (owner === null || blocked.value || disposed) return
  const requestGeneration = generation
  const request = new AbortController()
  controller = request
  loading.value = true
  const current = (): boolean => !disposed && !request.signal.aborted && requestGeneration === generation && owner === ownerId.value
  try {
    const response = await fetchNotificationPreferences(owner, request.signal)
    if (!current()) return
    saved.value = copy(response.preferences)
    draft.value = copy(response.preferences)
    draftOwner.value = owner
  } catch (cause) {
    if (!current()) return
    if (notificationIdentityInvalidated(cause)) invalidate()
    error.value = cause instanceof Error ? cause.message : 'Notification preferences could not be loaded.'
  } finally {
    if (current()) {
      loading.value = false
      controller = undefined
    }
  }
}
const refreshIdentity = async (): Promise<void> => {
  clear()
  blocked.value = true
  const requestGeneration = generation
  const outcome = await wikiStore.refreshAuth().catch(() => 'unavailable' as const)
  if (disposed || requestGeneration !== generation) return
  if (outcome !== 'authenticated') {
    error.value = 'Your account could not be verified. Sign in or try again.'
    return
  }
  blocked.value = false
  void load()
}
const save = async (): Promise<void> => {
  const owner = draftOwner.value
  if (owner === null || owner !== ownerId.value || !saved.value || !dirty.value || saving.value || blocked.value || disposed) return
  const requestGeneration = generation
  const request = new AbortController()
  controller = request
  const preferences = copy(draft.value)
  saving.value = true
  error.value = ''
  success.value = ''
  const current = (): boolean => !disposed && !request.signal.aborted && requestGeneration === generation && owner === ownerId.value && owner === draftOwner.value
  try {
    const response = await updateNotificationPreferences(owner, preferences, request.signal)
    if (!current()) return
    saved.value = copy(response.preferences)
    draft.value = copy(response.preferences)
    success.value = 'Notification preferences saved.'
  } catch (cause) {
    if (!current()) return
    if (notificationIdentityInvalidated(cause)) invalidate()
    error.value = cause instanceof Error ? cause.message : 'Notification preferences could not be saved. Your changes have not been discarded.'
  } finally {
    if (current()) {
      saving.value = false
      controller = undefined
    }
  }
}
const cancel = (): void => {
  if (!saved.value || saving.value || blocked.value || draftOwner.value !== ownerId.value) return
  draft.value = copy(saved.value)
  error.value = ''
  success.value = ''
}
watch(() => [ownerId.value, wikiStore.user.authVersion, wikiStore.offlineIdentityEpoch], () => {
  clear()
  blocked.value = false
  void load()
}, { immediate: true, flush: 'sync' })
watch(draft, () => { success.value = '' }, { deep: true, flush: 'sync' })
onMounted(() => window.addEventListener(OFFLINE_SESSION_INVALIDATED_EVENT, invalidate))
onBeforeUnmount(() => {
  disposed = true
  clear()
  window.removeEventListener(OFFLINE_SESSION_INVALIDATED_EVENT, invalidate)
})
</script>

<style scoped lang='scss'>
.profile-notification-preferences { max-width: 70rem; }
.profile-notification-preferences__fieldset { border: 0; padding: 0; min-width: 0; }
.profile-notification-preferences__category { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; padding-block: 1.25rem; border-block-end: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.profile-notification-preferences__copy { flex: 1 1 18rem; }
.profile-notification-preferences__channels { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; }
</style>
