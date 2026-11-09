<template lang='pug'>
section.account-notifications(:aria-labelledby='section === `all` ? ids.title : undefined')
  h2.account-notifications__title(v-if='section === `all`', :id='ids.title') {{$t('common:accountNotifications.title')}}
  section.account-notifications__group(v-if='section !== `approvals`', :aria-labelledby='ids.changes')
    h3.account-notifications__heading(:id='ids.changes') {{$t('common:accountNotifications.activity', { defaultValue: 'Page and discussion activity' })}}
    p.account-notifications__description {{$t('common:accountNotifications.recentActivity', { defaultValue: 'Recent authorized page changes, replies and mentions.' })}}
    .account-notifications__state(v-if='store.watchesLoading', role='status') {{$t('common:accountNotifications.loadingActivity', { defaultValue: 'Loading activity…' })}}
    .account-notifications__state.account-notifications__state--error(v-if='store.watchesError', role='alert')
      span {{ store.watchesError }}
      v-btn(size='small', variant='text', color='primary', @click='retryWatches') {{ watchErrorAction($t) }}
    .account-notifications__state(v-if='!store.watchesLoading && !store.watchesError && !notificationIdentityReady()', role='status')
      span {{$t('common:accountNotifications.checkingActivity', { defaultValue: 'Activity status is not yet verified.' })}}
      v-btn(size='small', variant='text', color='primary', @click='retryWatches') {{$t('common:actions.refresh')}}
    .account-notifications__state(v-if='!store.watchesLoading && !store.watchesError && notificationIdentityReady() && store.watches.length === 0 && store.watchesNextCursor !== null', role='status')
      span {{$t('common:accountNotifications.moreActivityMayBeAvailable', { defaultValue: 'More activity may be available.' })}}
      v-btn(size='small', variant='text', color='primary', :disabled='store.watchesLoading', @click='loadMoreWatches') {{$t('common:accountNotifications.checkMoreActivity', { defaultValue: 'Check more activity' })}}
    .account-notifications__state(v-if='!store.watchesLoading && !store.watchesError && notificationIdentityReady() && store.watches.length === 0 && store.watchesNextCursor === null', role='status') {{$t('common:accountNotifications.noRecentActivity', { defaultValue: 'No recent activity to show.' })}}
    v-list.account-notifications__list(v-if='notificationIdentityReady() && store.watches.length > 0', lines='two', density='compact')
      v-list-item(
        v-for='item in store.watches'
        :key='item.id'
        :href='pageUrl(item)'
        :class='{ "account-notifications__item--unread": isUnread(item) }'
        :aria-label='watchAriaLabel(item, $t)'
        @click='openWatchPage($event, item)'
      )
        template(v-slot:prepend='{}')
          span.account-notifications__unread-marker(v-if='isUnread(item)', aria-hidden='true')
        v-list-item-title {{ watchAction(item, $t) }} · {{ item.title }}
        v-list-item-subtitle {{ watchSummary(item, $t) }}
        template(v-slot:append='{}')
          span.account-notifications__unread-state(v-if='isUnread(item)') {{$t('common:accountNotifications.unread')}}
    .account-notifications__state(v-if='!store.watchesLoading && !store.watchesError && notificationIdentityReady() && store.watches.length > 0 && store.watchesNextCursor !== null', role='status')
      v-btn(size='small', variant='text', color='primary', :disabled='store.watchesLoading', @click='loadMoreWatches') {{$t('common:accountNotifications.loadMoreActivity', { defaultValue: 'Load more activity' })}}
    v-btn.mt-3(v-if='notificationIdentityReady()', size='small', variant='text', :loading='receiptsLoading', :disabled='receiptsLoading', @click='loadDeliveryReceipts') {{$t('common:accountNotifications.deliveryOutcomes')}}
    p(v-if='receiptsLoading', role='status') {{$t('common:accountNotifications.checkingDeliveryOutcomes')}}
    p(v-if='receiptsLoaded && !receiptsLoading && !receiptsError && deliveryReceipts.length === 0', role='status') {{$t('common:accountNotifications.noDeliveryOutcomes')}}
    p(v-if='receiptsError', role='alert') {{ receiptsError }}
    ul.account-notifications__receipts(v-if='notificationIdentityReady() && deliveryReceipts.length')
      li(v-for='receipt in deliveryReceipts', :key='receipt.id')
        span {{ receipt.title }} · {{$t(`common:accountNotifications.deliveryStatus.${receipt.status}`)}}
        template(v-if='receipt.canResend')
          p {{$t('common:accountNotifications.resendWarning')}}
          label
            input(type='checkbox', :checked='acknowledgedResends.has(receipt.id)', :disabled='receiptsLoading', @change='acknowledgeResend(receipt.id, $event)')
            | {{$t('common:accountNotifications.acknowledgeResend')}}
          v-btn(size='small', variant='text', :disabled='receiptsLoading || !acknowledgedResends.has(receipt.id)', @click='resendDelivery(receipt.id)') {{$t('common:accountNotifications.resendEmail')}}

  v-divider.my-2(v-if='section === `all`')

  section.account-notifications__group(v-if='section !== `changes`', :aria-labelledby='ids.approvals')
    h3.account-notifications__heading(:id='ids.approvals') {{$t('common:accountNotifications.approvals')}}
    .account-notifications__state(v-if='store.approvalsLoading', role='status') {{$t('common:accountNotifications.loadingApprovals')}}
    .account-notifications__state.account-notifications__state--error(v-if='store.approvalsError', role='alert')
      span {{ store.approvalsError }}
      v-btn(size='small', variant='text', color='primary', @click='retryApprovals') {{$t('common:accountNotifications.refreshApprovals')}}
    .account-notifications__state(v-if='!store.approvalsLoading && !store.approvalsError && !notificationIdentityReady() && store.approvals.length === 0', role='status')
      span {{$t('common:accountNotifications.approvalStatusUnknown')}}
      v-btn(size='small', variant='text', color='primary', @click='retryApprovals') {{$t('common:accountNotifications.refreshApprovals')}}
    .account-notifications__state(v-if='!store.approvalsLoading && !store.approvalsError && notificationIdentityReady() && store.approvals.length === 0 && store.approvalsNextCursor === null', role='status') {{$t('common:accountNotifications.noActiveApprovals')}}
    .account-notifications__state(v-if='!store.approvalsLoading && !store.approvalsError && notificationIdentityReady() && store.approvals.length === 0 && store.approvalsNextCursor !== null', role='status')
      span {{$t('common:accountNotifications.moreApprovalsMayBeAvailable')}}
      v-btn(size='small', variant='text', color='primary', :aria-label='$t("common:accountNotifications.checkMoreApprovals")', :disabled='store.approvalsLoading', @click='loadMoreApprovals') {{$t('common:accountNotifications.checkMoreApprovals')}}
    v-list.account-notifications__list(v-if='notificationIdentityReady() && store.approvals.length > 0', lines='two', density='compact')
      v-list-item(
        v-for='item in store.approvals'
        :key='item.id'
        :href='pageUrl(item)'
        @click='openApprovalPage($event, item)'
      )
        v-list-item-title {{ item.title }}
        v-list-item-subtitle {{ approvalSummary(item, $t) }}
    .account-notifications__state(v-if='!store.approvalsLoading && !store.approvalsError && notificationIdentityReady() && store.approvals.length > 0 && store.approvalsNextCursor !== null', role='status')
      v-btn(size='small', variant='text', color='primary', :aria-label='$t("common:accountNotifications.loadMoreApprovals")', :disabled='store.approvalsLoading', @click='loadMoreApprovals') {{$t('common:accountNotifications.loadMoreApprovals')}}
</template>

<script setup lang='ts'>
import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { notificationPageHref, fetchGovernedNotificationReceipts, resendGovernedNotification } from '../../helpers/site-notifications-api.ts'
import { wikiStore } from '../../store/index.ts'
import { OFFLINE_SESSION_INVALIDATED_EVENT } from '../../helpers/offline-session.ts'
import { navigateToWikiPage } from '../../helpers/wiki-navigation.ts'
import { useSiteNotificationsStore } from '../../store/site-notifications.ts'
import type { GovernedNotificationReceiptList, PageApprovalInboxItem, PageWatchNotification } from '../../../shared/site-notifications.ts'

/** `all` shows both groups; the account menu shows each group in its own tab. */
const { section = 'all' } = defineProps<{ section?: 'all' | 'changes' | 'approvals' }>()
// Unique ids: the account menu can mount one instance per tab.
const uid = useId()
const ids = {
  title: `${uid}-account-notifications-title`,
  changes: `${uid}-account-notifications-page-changes-title`,
  approvals: `${uid}-account-notifications-approvals-title`
}

const store = useSiteNotificationsStore()
const pendingWatchReads = new Set<string>()
let identityGeneration = 0
const deliveryReceipts = ref<GovernedNotificationReceiptList['items']>([])
const receiptsLoading = ref(false)
const receiptsLoaded = ref(false)
const receiptsError = ref('')
const acknowledgedResends = ref(new Set<string>())
let receiptController: AbortController | undefined
let disposed = false
const invalidatePendingNavigation = (): void => {
  identityGeneration += 1
  pendingWatchReads.clear()
  receiptController?.abort()
  receiptController = undefined
  deliveryReceipts.value = []
  acknowledgedResends.value = new Set()
  receiptsLoading.value = false
  receiptsLoaded.value = false
  receiptsError.value = ''
}
const invalidateSession = (): void => {
  invalidatePendingNavigation()
  store.reset()
  store.identityStale = true
}
watch(() => [store.ownerId, store.identityStale, wikiStore.user.id, wikiStore.user.authenticated, wikiStore.user.authVersion, wikiStore.offlineIdentityEpoch], invalidatePendingNavigation, { flush: 'sync' })
onMounted(() => window.addEventListener(OFFLINE_SESSION_INVALIDATED_EVENT, invalidateSession))
onBeforeUnmount(() => {
  disposed = true
  invalidatePendingNavigation()
  window.removeEventListener(OFFLINE_SESSION_INVALIDATED_EVENT, invalidateSession)
})

type NotificationPageItem = Pick<PageWatchNotification | PageApprovalInboxItem, 'visibility' | 'localeCode' | 'path'> & { commentId?: number | null }
type Translate = (key: string, options?: Record<string, unknown>) => string

const notificationIdentityReady = (): boolean => store.ownerId !== null && !store.identityStale &&
  wikiStore.user.authenticated && wikiStore.user.id === store.ownerId

const retryWatches = (): void => {
  void store.refreshWatches()
}

const loadMoreWatches = (): void => {
  void store.loadMoreWatches()
}

const isWatchContinuationError = (message: string): boolean => {
  const normalized = message.toLowerCase()
  return /cursor[\s_-]+(?:expired|capacity)/.test(normalized)
}

const watchErrorAction = (t: Translate): string => isWatchContinuationError(store.watchesError)
  ? t('common:accountNotifications.refreshPageChanges')
  : t('common:page.tryAgain')

const retryApprovals = (): void => {
  void store.refreshApprovals()
}

const loadMoreApprovals = (): void => {
  void store.loadMoreApprovals()
}

const pageUrl = (item: NotificationPageItem): string => {
  return notificationPageHref(item)
}

const loadDeliveryReceipts = async (): Promise<void> => {
  if (!notificationIdentityReady() || receiptsLoading.value) return
  const ownerId = store.ownerId!, generation = identityGeneration, controller = new AbortController()
  receiptController = controller
  receiptsLoading.value = true
  receiptsError.value = ''
  try {
    const response = await fetchGovernedNotificationReceipts(ownerId, controller.signal)
    if (!disposed && !controller.signal.aborted && generation === identityGeneration && ownerId === store.ownerId) {
      deliveryReceipts.value = response.items
      receiptsLoaded.value = true
      acknowledgedResends.value = new Set()
    }
  } catch (error) {
    if (!controller.signal.aborted && generation === identityGeneration) receiptsError.value = error instanceof Error ? error.message : 'Delivery outcomes unavailable.'
  } finally {
    if (generation === identityGeneration) { receiptsLoading.value = false; receiptController = undefined }
  }
}
const acknowledgeResend = (id: string, event: Event): void => {
  if (receiptsLoading.value || !(event.target instanceof HTMLInputElement)) return
  const values = new Set(acknowledgedResends.value)
  if (event.target.checked) values.add(id)
  else values.delete(id)
  acknowledgedResends.value = values
}
const resendDelivery = async (id: string): Promise<void> => {
  if (!notificationIdentityReady() || receiptsLoading.value || !acknowledgedResends.value.has(id)) return
  const ownerId = store.ownerId!, generation = identityGeneration, controller = new AbortController()
  receiptController = controller
  receiptsLoading.value = true
  receiptsError.value = ''
  try {
    await resendGovernedNotification(ownerId, id, controller.signal)
    if (!disposed && !controller.signal.aborted && generation === identityGeneration && ownerId === store.ownerId) {
      const receipt = deliveryReceipts.value.find(row => row.id === id)
      if (receipt) { receipt.status = 'pending'; receipt.canResend = false; receipt.attempt++ }
      acknowledgedResends.value = new Set()
    }
  } catch (error) {
    if (!controller.signal.aborted && generation === identityGeneration) receiptsError.value = error instanceof Error ? error.message : 'Resend unavailable.'
  } finally {
    if (generation === identityGeneration) { receiptsLoading.value = false; receiptController = undefined }
  }
}
const isUnread = (item: PageWatchNotification): boolean => item.readAt === null

const watchEventKeys: Record<string, string> = {
  'page.updated': 'common:page.watchEventUpdated',
  updated: 'common:page.watchEventUpdated',
  'page.restored': 'common:page.watchEventRestored',
  restored: 'common:page.watchEventRestored',
  'page.moved': 'common:page.watchEventMoved',
  moved: 'common:page.watchEventMoved',
  'page.deleted': 'common:page.watchEventDeleted',
  deleted: 'common:page.watchEventDeleted',
  'page.visibility-changed': 'common:page.watchEventVisibilityChanged',
  'visibility-changed': 'common:page.watchEventVisibilityChanged',
  'page.ownership-transferred': 'common:page.watchEventOwnershipTransferred',
  'page.lifecycle-result': 'common:accountNotifications.lifecycleResult',
  'page.lifecycle-move-result': 'common:accountNotifications.lifecycleMoved',
  'ownership-transferred': 'common:page.watchEventOwnershipTransferred'
}

const watchActor = (item: PageWatchNotification, t: Translate): string => item.actorName.trim() || t('common:accountNotifications.someone')

const watchAction = (item: PageWatchNotification, t: Translate): string => {
  const categoryLabels = {
    pageCreated: 'Page created',
    pageDeleted: 'Page deleted',
    watchedPageComment: 'Comment on a watched page',
    commentReply: 'Reply in your discussion',
    mention: 'You were mentioned',
    feedbackStatus: 'Feedback status changed',
    reviewReminder: 'Review reminder',
    pageLifecycle: 'Automated lifecycle result'
  }
  if (item.category === 'pageLifecycle') return t(item.eventType === 'page.lifecycle-move-result'
    ? 'common:accountNotifications.lifecycleMoved' : item.eventType === 'page.lifecycle-proposed'
      ? 'common:accountNotifications.lifecycleProposed' : 'common:accountNotifications.lifecycleResult')
  if (item.category !== 'pageWatch') return t(`common:accountNotifications.category.${item.category}`, { defaultValue: categoryLabels[item.category] })
  return t(watchEventKeys[item.eventType] ?? 'common:page.watchEventChanged', { actor: watchActor(item, t) })
}

const watchSummary = (item: PageWatchNotification, t: Translate): string => {
  const actor = item.category === 'reviewReminder' || item.category === 'pageLifecycle'
    ? t('common:accountNotifications.scheduledOrigin') : watchActor(item, t)
  const when = new Date(item.createdAt)
  const date = Number.isNaN(when.valueOf())
    ? t('common:accountNotifications.recently')
    : when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const outcomes = item.outcomes?.map(outcome => `${t(`common:accountNotifications.outcomeKind.${outcome.kind}`)}: ${t(`common:accountNotifications.outcomeState.${outcome.state}`)}`).join('; ')
  return `${actor}${outcomes ? ` · ${outcomes}` : ''} · ${date}`
}

const watchAriaLabel = (item: PageWatchNotification, t: Translate): string => {
  const key = isUnread(item)
    ? 'common:accountNotifications.unreadWatchAriaLabel'
    : 'common:accountNotifications.watchAriaLabel'
  return t(key, {
    action: watchAction(item, t),
    title: item.title,
    ...(isUnread(item) ? { unread: t('common:accountNotifications.unread') } : {})
  })
}

const approvalSummary = (item: PageApprovalInboxItem, t: Translate): string => {
  const stale = item.stale ? ` · ${t('common:page.submittedRevisionStale')}` : ''
  return `${t(`common:page.approvalStatus.${item.status}`)}${stale}`
}

const isOrdinaryActivation = (event: MouseEvent | KeyboardEvent): boolean => {
  if (event.defaultPrevented || ('button' in event && event.button !== 0) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false
  const currentTarget = event.currentTarget
  if (currentTarget && typeof currentTarget === 'object' && 'target' in currentTarget) {
    const target = String(Reflect.get(currentTarget, 'target') || '')
    if (target && target.toLowerCase() !== '_self') return false
  }
  return true
}

const openWatchPage = (event: MouseEvent | KeyboardEvent, item: PageWatchNotification): void => {
  if (!notificationIdentityReady()) {
    event.preventDefault()
    return
  }
  if (!isOrdinaryActivation(event)) return
  event.preventDefault()

  const ownerId = store.ownerId
  const requestGeneration = identityGeneration
  if (ownerId === null || store.identityStale) return
  const destination = pageUrl(item)
  if (!isUnread(item)) {
    navigateToWikiPage(destination)
    return
  }
  if (pendingWatchReads.has(item.id)) return

  pendingWatchReads.add(item.id)
  void (async () => {
    try {
      await store.markWatchRead(item.id)
    } catch {
      // The store normally handles read failures; preserve navigation for this owner if it does not.
    } finally {
      if (requestGeneration === identityGeneration) pendingWatchReads.delete(item.id)
      if (!disposed && requestGeneration === identityGeneration && store.ownerId === ownerId && notificationIdentityReady()) navigateToWikiPage(destination)
    }
  })()
}

const openApprovalPage = (event: MouseEvent | KeyboardEvent, item: PageApprovalInboxItem): void => {
  if (!notificationIdentityReady()) {
    event.preventDefault()
    return
  }
  if (!isOrdinaryActivation(event)) return
  event.preventDefault()
  navigateToWikiPage(pageUrl(item))
}
</script>



<style lang='scss'>
.account-notifications {
  min-width: 0;
  padding: var(--wiki-space-2) 0;
}


.account-notifications__group {
  min-width: 0;
}

.account-notifications__title {
  padding: var(--wiki-space-3);
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.3;
}

.account-notifications__heading {
  padding: var(--wiki-space-2) var(--wiki-space-3);
  margin: 0;
  color: var(--wiki-text-muted);
  font-size: .75rem;
  font-weight: 700;
  letter-spacing: .08em;
  line-height: 1.3;
  text-transform: uppercase;
}

.account-notifications__description {
  padding: 0 var(--wiki-space-3) var(--wiki-space-2);
  margin: 0;
  color: var(--wiki-text-muted);
  font-size: .8125rem;
}

.account-notifications__list {
  padding: 0 !important;

  .v-list-item {
    border-radius: var(--wiki-radius-sm);
    margin: 2px var(--wiki-space-2);
    transition: background-color var(--wiki-motion-fast) var(--wiki-motion-ease);

    &:hover,
    &:focus-visible {
      background-color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 4%, transparent);
    }
  }
}

.account-notifications__item--unread {
  font-weight: 600;
}

.account-notifications__unread-marker {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: .5rem;
  height: .5rem;
  margin-inline-end: .5rem;
  border: 1px solid var(--wiki-purpose-primary-ink);
  background: var(--wiki-purpose-primary-ink);
  border-radius: 999px;
  font-size: .75rem;
  font-weight: 700;
  line-height: 1;
}

.account-notifications__unread-state {
  padding: .125rem .5rem;
  border: 1px solid var(--wiki-purpose-primary-edge);
  background: var(--wiki-purpose-primary-fill);
  color: var(--wiki-purpose-primary-ink);
  border-radius: var(--wiki-radius-pill);
  font-size: .6875rem;
  font-weight: 700;
  letter-spacing: .04em;
  line-height: 1.25;
  text-transform: uppercase;
}

.account-notifications__state {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-3);
  color: var(--wiki-text-muted);
  font-size: .875rem;
}

.account-notifications__state--error {
  color: rgb(var(--v-theme-error));
}
</style>
