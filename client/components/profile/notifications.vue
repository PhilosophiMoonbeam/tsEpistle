<template lang='pug'>
v-container.profile-notification-preferences(fluid)
  AdminHero(:title='$t(`profile:nav.notifications`)', :description='nt(`description`)', icon='mdi-bell-outline', :eyebrow='$t(`profile:workspace`)', heading-id='profile-notifications-title')
    template(#extra)
      p.text-body-small {{ nt('perPageWatchChoices') }}
      p.text-body-small.mt-2(v-if='dirty', id='profile-notifications-reload-help') {{ nt('reloadBlocked') }}
    template(#actions)
      v-btn(variant='text', prepend-icon='mdi-refresh', :disabled='dirty || loading || saving || refreshingIdentity', :loading='loading || refreshingIdentity', :aria-describedby='dirty ? `profile-notifications-reload-help` : undefined', @click='refreshIdentity') {{ $t('profile:pages.reloadShort') }}
  p(v-if='refreshingIdentity || loading', role='status') {{ nt('loading') }}
  p(v-else-if='!ownerId && !error', role='status') {{ nt('signIn') }}
  v-alert.mb-4(v-if='error', type='error', variant='tonal', role='alert')
    div {{ error }}
    v-btn.mt-2(v-if='!saved || blocked', variant='text', :disabled='dirty || loading || saving || refreshingIdentity', @click='refreshIdentity') {{ nt('refresh') }}
  p.text-success.mb-4(v-if='success', role='status') {{ success }}
  form(v-if='saved && !blocked', @submit.prevent='save', :aria-busy='saving ? `true` : undefined')
    p#profile-notifications-ceiling-help.text-body-small.mb-4 {{ nt('ceilingHelp') }}
    p.text-body-small.mb-4(role='status') {{ nt('existingWatches', { limit: ceilingDescription('pageWatch') }) }}
    table.profile-notification-preferences__matrix
      caption.text-title-medium {{ nt('deliveryPreferences') }}
      colgroup
        col
        col.profile-notification-preferences__channel-column
        col.profile-notification-preferences__channel-column
      thead
        tr
          th#profile-notifications-event(scope='col') {{ nt('event') }}
          th#profile-notifications-in-app.profile-notification-preferences__channel-heading(scope='col')
            span#profile-notifications-in-app-label {{ nt('inApp') }}
            input.profile-notification-preferences__bulk(type='checkbox', role='switch', :checked='channelTotals.inApp > 0 && channelCounts.inApp === channelTotals.inApp', :disabled='!canEdit || channelTotals.inApp === 0', :aria-label='nt(`bulkPermittedInApp`)', aria-describedby='profile-notifications-in-app-count profile-notifications-bulk-help', @change='setChannel(`inApp`, $event)')
            span#profile-notifications-in-app-count.profile-notification-preferences__count {{ channelDescription('inApp') }}
          th#profile-notifications-email.profile-notification-preferences__channel-heading(scope='col')
            span#profile-notifications-email-label {{ nt('email') }}
            input.profile-notification-preferences__bulk(type='checkbox', role='switch', :checked='channelTotals.email > 0 && channelCounts.email === channelTotals.email', :disabled='!canEdit || channelTotals.email === 0 || draftStopAllEmail', :aria-label='nt(`bulkPermittedEmail`)', aria-describedby='profile-notifications-email-count profile-notifications-bulk-help', @change='setChannel(`email`, $event)')
            span#profile-notifications-email-count.profile-notification-preferences__count {{ channelDescription('email') }}
      tbody
        tr(v-for='category in categories', :key='category.key')
          th(:id='`profile-notifications-${category.key}`', scope='row')
            span.text-title-small(:id='`profile-notifications-${category.key}-label`') {{ category.label }}
            p.profile-notification-preferences__description.text-body-small.text-medium-emphasis(:id='`profile-notifications-${category.key}-description`') {{ category.description }}
            p.text-body-small(:id='`profile-notifications-${category.key}-ceiling`') {{ ceilingDescription(category.key) }}
          td(:headers='`profile-notifications-${category.key} profile-notifications-in-app`')
            v-checkbox.profile-notification-preferences__toggle(:model-value='channelAllowed(category.key, `inApp`) && draft[category.key].inApp', :aria-labelledby='`profile-notifications-${category.key}-label profile-notifications-in-app-label`', :aria-describedby='`profile-notifications-${category.key}-description profile-notifications-${category.key}-ceiling profile-notifications-ceiling-help`', :disabled='!canEdit || !channelAllowed(category.key, `inApp`)', hide-details, density='comfortable', @update:model-value='setDeliveryPreference(category.key, `inApp`, $event)')
          td(:headers='`profile-notifications-${category.key} profile-notifications-email`')
            v-checkbox.profile-notification-preferences__toggle(:model-value='channelAllowed(category.key, `email`) && draft[category.key].email', :aria-labelledby='`profile-notifications-${category.key}-label profile-notifications-email-label`', :aria-describedby='`profile-notifications-${category.key}-description profile-notifications-${category.key}-ceiling profile-notifications-ceiling-help`', :disabled='!canEdit || !channelAllowed(category.key, `email`) || draftStopAllEmail', hide-details, density='comfortable', @update:model-value='setDeliveryPreference(category.key, `email`, $event)')
    p#profile-notifications-bulk-help.text-body-small.mt-3 {{ nt('bulkHelp') }}
    v-btn.mt-3(variant='text', :disabled='!canEdit', aria-describedby='profile-notifications-stop-email-help', @click='stopAllEmail') {{ nt('stopAllEmail') }}
    p#profile-notifications-stop-email-help.text-body-small {{ nt('stopAllEmailHelp') }}
    p.text-body-small(v-if='draftStopAllEmail', role='status') {{ nt('stopAllEmailDraft') }}
    .d-flex.flex-wrap.ga-3.mt-6
      v-btn(type='submit', variant='tonal', :data-commitment='dirty && canEdit ? `active` : undefined', :disabled='!dirty || !canEdit', :loading='saving') {{ nt('save') }}
      v-btn(variant='text', :disabled='!dirty || saving', @click='cancel') {{ nt('cancel') }}
</template>

<script setup lang='ts'>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AdminHero from '../common/admin-hero.vue'
import { wikiStore } from '../../store/index.ts'
import { useTranslate } from '../../helpers/use-translate.ts'
import { OFFLINE_SESSION_INVALIDATED_EVENT } from '../../helpers/offline-session.ts'
import { fetchNotificationPreferences, notificationIdentityInvalidated, updateNotificationPreferences } from '../../helpers/site-notifications-api.ts'
import { NOTIFICATION_CATEGORIES, defaultNotificationCeilings, type NotificationCategory, type NotificationPreferences, type NotificationPreferencesPatch, type PageNotificationCategory } from '../../../shared/site-notifications.ts'

defineOptions({ name: 'ProfileNotifications' })

const nt = useTranslate('profile:notificationPreferences')
const categories: { key: NotificationCategory; label: string; description: string }[] = NOTIFICATION_CATEGORIES.map(key => ({
  key,
  label: nt(`categories.${key}.label`),
  description: nt(`categories.${key}.description`)
}))
const defaults = (): NotificationPreferences => ({
  pageCreated: { inApp: false, email: false },
  pageDeleted: { inApp: false, email: false },
  watchedPageComment: { inApp: false, email: false },
  commentReply: { inApp: false, email: false },
  mention: { inApp: false, email: false },
  feedbackStatus: { inApp: false, email: false },
  reviewReminder: { inApp: false, email: false },
  pageLifecycle: { inApp: false, email: false }
})
const copy = (preferences: NotificationPreferences): NotificationPreferences => {
  const result = defaults()
  for (const category of NOTIFICATION_CATEGORIES) result[category] = { ...preferences[category] }
  return result
}
const ownerId = computed(() => wikiStore.user.authenticated && Number.isSafeInteger(wikiStore.user.id) && wikiStore.user.id > 0 ? wikiStore.user.id : null)
const draft = ref<NotificationPreferences>(defaults())
const ceilings = ref(defaultNotificationCeilings())
const draftStopAllEmail = ref(false)
const channelAllowed = (category: NotificationCategory, channel: 'inApp' | 'email'): boolean =>
  ceilings.value[category] !== 'off' && (channel === 'inApp' || ceilings.value[category] === 'existing-consented-channels')
const ceilingDescription = (category: PageNotificationCategory): string =>
  nt(ceilings.value[category] === 'off' ? 'ceilingOff' :
    ceilings.value[category] === 'in-app-only' ? 'ceilingInAppOnly' : 'ceilingExistingConsentedChannels')
const stopAllEmail = (): void => {
  if (!canEdit.value) return
  draftStopAllEmail.value = true
  for (const category of NOTIFICATION_CATEGORIES) draft.value[category].email = false
}
const setDeliveryPreference = (category: NotificationCategory, channel: 'inApp' | 'email', value: boolean | null): void => {
  if (!canEdit.value || value === null || !channelAllowed(category, channel) || (channel === 'email' && draftStopAllEmail.value)) return
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
const dirty = computed(() => saved.value !== null && (draftStopAllEmail.value || NOTIFICATION_CATEGORIES.some(category =>
  saved.value?.[category].inApp !== draft.value[category].inApp || saved.value?.[category].email !== draft.value[category].email)))
const canEdit = computed(() => !disposed && !!saved.value && ownerId.value !== null && draftOwner.value === ownerId.value && !blocked.value && !loading.value && !saving.value && !refreshingIdentity.value)
const channelTotals = computed(() => ({
  inApp: categories.filter(category => channelAllowed(category.key, 'inApp')).length,
  email: categories.filter(category => channelAllowed(category.key, 'email')).length
}))
const channelCounts = computed(() => ({
  inApp: categories.filter(category => channelAllowed(category.key, 'inApp') && draft.value[category.key].inApp).length,
  email: categories.filter(category => channelAllowed(category.key, 'email') && draft.value[category.key].email).length
}))
const channelDescription = (channel: 'inApp' | 'email'): string => {
  const selected = channelCounts.value[channel]
  const total = channelTotals.value[channel]
  if (total === 0) return nt('bulkUnavailable')
  const key = selected === total ? 'bulkAll' : selected === 0 ? 'bulkNone' : 'bulkMixed'
  return nt(key, { selected, total })
}
const setChannel = (channel: 'inApp' | 'email', event: Event): void => {
  if (!canEdit.value || !(event.target instanceof HTMLInputElement)) return
  for (const category of categories) setDeliveryPreference(category.key, channel, event.target.checked)
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
  ceilings.value = defaultNotificationCeilings()
  draftStopAllEmail.value = false
  draftOwner.value = null
  loading.value = false
  saving.value = false
  error.value = ''
  success.value = ''
}
const invalidate = (): void => {
  clear()
  blocked.value = true
  error.value = nt('sessionChanged')
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
    ceilings.value = response.ceilings
    draftOwner.value = owner
  } catch (cause) {
    if (!current()) return
    if (notificationIdentityInvalidated(cause)) invalidate()
    error.value = cause instanceof Error ? cause.message : nt('loadFailed')
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
      error.value = nt('accountUnverified')
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
  const preferences: NotificationPreferencesPatch = {}
  for (const category of NOTIFICATION_CATEGORIES) {
    for (const channel of ['inApp', 'email'] as const) {
      if (channelAllowed(category, channel) && draft.value[category][channel] !== saved.value[category][channel])
        (preferences[category] ??= {})[channel] = draft.value[category][channel]
    }
  }
  saving.value = true
  error.value = ''
  success.value = ''
  const current = (): boolean => !disposed && !request.signal.aborted && requestGeneration === generation && owner === ownerId.value && owner === draftOwner.value
  try {
    const response = await updateNotificationPreferences(owner, preferences, request.signal, draftStopAllEmail.value)
    if (!current()) return
    saved.value = copy(response.preferences)
    draft.value = copy(response.preferences)
    ceilings.value = response.ceilings
    draftStopAllEmail.value = false
    success.value = nt('saved')
  } catch (cause) {
    if (!current()) return
    if (notificationIdentityInvalidated(cause)) invalidate()
    error.value = cause instanceof Error ? cause.message : nt('saveFailed')
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
  draftStopAllEmail.value = false
  error.value = ''
  success.value = ''
}
watch(() => [ownerId.value, wikiStore.user.authVersion, wikiStore.offlineIdentityEpoch], () => {
  clear()
  blocked.value = false
  void load()
}, { immediate: true, flush: 'sync' })
watch(draft, () => { success.value = '' }, { deep: true, flush: 'sync' })
onMounted(() => {
  window.addEventListener(OFFLINE_SESSION_INVALIDATED_EVENT, invalidate)
  void refreshIdentity()
})
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
