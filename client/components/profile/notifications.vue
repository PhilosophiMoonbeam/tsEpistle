<template lang='pug'>
v-container.profile-notification-preferences(fluid)
  AdminHero(:title='$t(`profile:nav.notifications`)', :description='$t(`profile:notificationPreferences.description`, { defaultValue: `Choose which events appear in your inbox or are sent by email. New categories are off until you enable and save them.` })', icon='mdi-bell-outline', :eyebrow='$t(`profile:workspace`, { defaultValue: `Your workspace` })', heading-id='profile-notifications-title')
    template(#extra)
      p.text-body-small {{ $t('profile:notificationPreferences.existingWatches', { defaultValue: 'These settings do not change your existing per-page watches or approval inbox.' }) }}
      p.text-body-small.mt-2(v-if='dirty', id='profile-notifications-reload-help') {{ $t('profile:notificationPreferences.reloadBlocked', { defaultValue: 'Save or cancel your changes before reloading preferences.' }) }}
    template(#actions)
      v-btn(variant='text', prepend-icon='mdi-refresh', :disabled='dirty || loading || saving || refreshingIdentity', :loading='loading || refreshingIdentity', :aria-describedby='dirty ? `profile-notifications-reload-help` : undefined', @click='refreshIdentity') {{ $t('profile:pages.reloadShort') }}
  p(v-if='!ownerId', role='status') Sign in to manage notifications.
  p(v-else-if='loading', role='status') Loading your notification preferences…
  v-alert.mb-4(v-if='error', type='error', variant='tonal', role='alert')
    div {{ error }}
    v-btn.mt-2(v-if='!saved || blocked', variant='text', :disabled='dirty || loading || saving || refreshingIdentity', @click='refreshIdentity') Refresh preferences
  p.text-success.mb-4(v-if='success', role='status') {{ success }}
  form(v-if='saved && !blocked', @submit.prevent='save', :aria-busy='saving ? `true` : undefined')
    table.profile-notification-preferences__matrix
      caption.text-title-medium {{ $t('profile:notificationPreferences.deliveryPreferences', { defaultValue: 'Delivery preferences' }) }}
      colgroup
        col
        col.profile-notification-preferences__channel-column
        col.profile-notification-preferences__channel-column
      thead
        tr
          th#profile-notifications-event(scope='col') {{ $t('profile:notificationPreferences.event', { defaultValue: 'Event' }) }}
          th#profile-notifications-in-app.profile-notification-preferences__channel-heading(scope='col')
            span#profile-notifications-in-app-label {{ $t('profile:notificationPreferences.inApp', { defaultValue: 'In-App' }) }}
            input.profile-notification-preferences__bulk(type='checkbox', role='switch', :checked='channelCounts.inApp === categories.length', :disabled='!canEdit', :aria-label='$t(`profile:notificationPreferences.bulkInApp`, { defaultValue: `Enable In-App for all displayed events` })', aria-describedby='profile-notifications-in-app-count profile-notifications-bulk-help', @change='setChannel(`inApp`, $event)')
            span#profile-notifications-in-app-count.profile-notification-preferences__count {{ channelDescription('inApp') }}
          th#profile-notifications-email.profile-notification-preferences__channel-heading(scope='col')
            span#profile-notifications-email-label {{ $t('profile:notificationPreferences.email', { defaultValue: 'Email' }) }}
            input.profile-notification-preferences__bulk(type='checkbox', role='switch', :checked='channelCounts.email === categories.length', :disabled='!canEdit', :aria-label='$t(`profile:notificationPreferences.bulkEmail`, { defaultValue: `Enable Email for all displayed events` })', aria-describedby='profile-notifications-email-count profile-notifications-bulk-help', @change='setChannel(`email`, $event)')
            span#profile-notifications-email-count.profile-notification-preferences__count {{ channelDescription('email') }}
      tbody
        tr(v-for='category in categories', :key='category.key')
          th(:id='`profile-notifications-${category.key}`', scope='row')
            span.text-title-small(:id='`profile-notifications-${category.key}-label`') {{ category.label }}
            p.profile-notification-preferences__description.text-body-small.text-medium-emphasis(:id='`profile-notifications-${category.key}-description`') {{ category.description }}
          td(:headers='`profile-notifications-${category.key} profile-notifications-in-app`')
            v-checkbox.profile-notification-preferences__toggle(:model-value='draft[category.key].inApp', :aria-labelledby='`profile-notifications-${category.key}-label profile-notifications-in-app-label`', :aria-describedby='`profile-notifications-${category.key}-description`', :disabled='!canEdit', hide-details, density='comfortable', @update:model-value='setDeliveryPreference(category.key, `inApp`, $event)')
          td(:headers='`profile-notifications-${category.key} profile-notifications-email`')
            v-checkbox.profile-notification-preferences__toggle(:model-value='draft[category.key].email', :aria-labelledby='`profile-notifications-${category.key}-label profile-notifications-email-label`', :aria-describedby='`profile-notifications-${category.key}-description`', :disabled='!canEdit', hide-details, density='comfortable', @update:model-value='setDeliveryPreference(category.key, `email`, $event)')
    p#profile-notifications-bulk-help.text-body-small.mt-3 {{ $t('profile:notificationPreferences.bulkHelp', { defaultValue: 'Header switches change only the displayed events in that channel. Save preferences to apply your changes, or Cancel changes to discard them.' }) }}
    .d-flex.flex-wrap.ga-3.mt-6
      v-btn(type='submit', variant='tonal', :data-commitment='dirty && canEdit ? `active` : undefined', :disabled='!dirty || !canEdit', :loading='saving') Save preferences
      v-btn(variant='text', :disabled='!dirty || saving', @click='cancel') Cancel changes
</template>

<script setup lang='ts'>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AdminHero from '../common/admin-hero.vue'
import { wikiStore } from '../../store/index.ts'
import { translate } from '../../modules/localization.ts'
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
  if (!canEdit.value || value === null) return
  draft.value[category][channel] = value
}
const saved = ref<NotificationPreferences | null>(null)
const draftOwner = ref<number | null>(null)
const loading = ref(false)
const saving = ref(false)
const refreshingIdentity = ref(false)
const blocked = ref(false)
const error = ref('')
const success = ref('')
const dirty = computed(() => saved.value !== null && NOTIFICATION_CATEGORIES.some(category =>
  saved.value?.[category].inApp !== draft.value[category].inApp || saved.value?.[category].email !== draft.value[category].email))
const canEdit = computed(() => !disposed && !!saved.value && ownerId.value !== null && draftOwner.value === ownerId.value && !blocked.value && !loading.value && !saving.value && !refreshingIdentity.value)
const channelCounts = computed(() => ({
  inApp: categories.filter(category => draft.value[category.key].inApp).length,
  email: categories.filter(category => draft.value[category.key].email).length
}))
const channelDescription = (channel: 'inApp' | 'email'): string => {
  const selected = channelCounts.value[channel]
  const key = selected === categories.length ? 'bulkAll' : selected === 0 ? 'bulkNone' : 'bulkMixed'
  const defaultValue = selected === categories.length ? 'All enabled: {{selected}} of {{total}}.' : selected === 0 ? 'None enabled: {{selected}} of {{total}}.' : 'Some enabled: {{selected}} of {{total}}.'
  return translate(`profile:notificationPreferences.${key}`, { defaultValue, selected, total: categories.length })
}
const setChannel = (channel: 'inApp' | 'email', event: Event): void => {
  if (!canEdit.value || !(event.target instanceof HTMLInputElement)) return
  for (const category of categories) draft.value[category.key][channel] = event.target.checked
}
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
  if (disposed || dirty.value || loading.value || saving.value || refreshingIdentity.value) return
  refreshingIdentity.value = true
  try {
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
  } finally {
    refreshingIdentity.value = false
  }
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
.profile-notification-preferences form { max-width: 760px; }
.profile-notification-preferences__matrix {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  text-align: start;
  overflow-wrap: anywhere;
}
.profile-notification-preferences__matrix caption {
  margin-block-end: .75rem;
  text-align: start;
}
.profile-notification-preferences__channel-column { width: 4.75rem; }
.profile-notification-preferences__matrix thead { background: var(--wiki-surface-sunken); }
.profile-notification-preferences__matrix tbody tr:is(:hover, :focus-within) { background: var(--wiki-surface-elevated, var(--wiki-surface-raised)); }
.profile-notification-preferences__bulk {
  display: block;
  inline-size: 2.75rem;
  block-size: 2.75rem;
  margin-inline: auto;
  accent-color: rgb(var(--v-theme-primary));
  cursor: pointer;
  appearance: none;
  border: 0;
  border-radius: .25rem;
  background:
    radial-gradient(circle at 25% 50%, rgb(var(--v-theme-on-surface)) .42rem, transparent .46rem) center / 2.5rem 1.35rem no-repeat,
    linear-gradient(var(--wiki-surface-border), var(--wiki-surface-border)) center / 2.5rem 1.35rem no-repeat;
}
.profile-notification-preferences__bulk:checked {
  background:
    radial-gradient(circle at 75% 50%, rgb(var(--v-theme-on-primary)) .42rem, transparent .46rem) center / 2.5rem 1.35rem no-repeat,
    linear-gradient(rgb(var(--v-theme-primary)), rgb(var(--v-theme-primary))) center / 2.5rem 1.35rem no-repeat;
}
.profile-notification-preferences__bulk:disabled { cursor: not-allowed; opacity: .55; }
.profile-notification-preferences__bulk:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: 2px; }
.profile-notification-preferences__count { display: block; font-weight: 400; }
@media (forced-colors: active) {
  .profile-notification-preferences__bulk,
  .profile-notification-preferences__bulk:checked { appearance: auto; background: none; }
  .profile-notification-preferences__matrix tbody tr:is(:hover, :focus-within) { outline: 1px solid Highlight; outline-offset: -1px; }
}
.profile-notification-preferences__matrix th,
.profile-notification-preferences__matrix td {
  padding: 1rem .25rem;
  border-block-end: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  vertical-align: middle;
  text-align: start;
}
.profile-notification-preferences__matrix th:first-child { padding-inline-start: 0; }
.profile-notification-preferences__matrix thead th {
  padding-block: .75rem;
  font-size: .75rem;
  font-weight: 650;
}
.profile-notification-preferences__matrix .profile-notification-preferences__channel-heading { text-align: center; }
.profile-notification-preferences__description { margin-block-start: .35rem; font-weight: 400; }
.profile-notification-preferences__toggle :deep(.v-selection-control) { justify-content: center; }
</style>
