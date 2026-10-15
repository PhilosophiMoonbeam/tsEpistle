<template lang='pug'>
v-container.profile-discussions(fluid)
  header.mb-6
    h1.text-headline-medium My discussions
    p.text-body-medium.mt-2 Your contributions on pages you can currently read. Hidden or locked discussions are not included.
  v-alert.mb-4(v-if='error', type='error', variant='tonal', role='alert')
    div {{ error }}
    v-btn.mt-2(variant='text', @click='refreshIdentity', :disabled='loading') Refresh discussions
  p(v-if='!ownerId', role='status') Sign in to see your discussions.
  template(v-else)
    v-btn.mb-4(variant='outlined', @click='restart', :disabled='loading || blocked') Refresh
    p(v-if='loading', role='status') Loading your discussions…
    p(v-if='!loading && !error && !items.length && nextCursor === null', role='status') No readable contributions to show.
    ol.profile-discussions__list(v-if='items.length')
      li.profile-discussions__item(v-for='item in items', :key='item.id')
        article
          h2.text-title-medium
            a(:href='contributionUrl(item)') {{ item.page.title || item.page.path }}
          p.text-body-small.text-medium-emphasis.mt-1
            span {{ item.replyTo > 0 ? 'Reply' : 'Discussion' }} · {{ formatDate(item.createdAt) }}
          p.profile-discussions__content {{ item.content }}
          a.text-body-small(:href='contributionUrl(item)') Open this contribution
    .mt-4(v-if='nextCursor !== null')
      p.text-body-small.mb-2(v-if='!items.length && !loading') More contributions may be available. Continue to check the next window.
      v-btn(variant='outlined', :disabled='loading || blocked', @click='loadMore') {{ items.length ? 'Load more' : 'Check next window' }}
</template>

<script setup lang='ts'>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { wikiStore } from '../../store/index.ts'
import { OFFLINE_SESSION_INVALIDATED_EVENT } from '../../helpers/offline-session.ts'
import { fetchMyDiscussions, notificationIdentityInvalidated, notificationPageHref } from '../../helpers/site-notifications-api.ts'
import type { DiscussionContribution } from '../../../shared/discussion-annotations.ts'

defineOptions({ name: 'ProfileDiscussions' })

const ownerId = computed(() => wikiStore.user.authenticated && Number.isSafeInteger(wikiStore.user.id) && wikiStore.user.id > 0 ? wikiStore.user.id : null)
const items = ref<DiscussionContribution[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const error = ref('')
const blocked = ref(false)
let generation = 0
let controller: AbortController | undefined
let disposed = false

const clear = (): void => {
  generation += 1
  controller?.abort()
  controller = undefined
  items.value = []
  nextCursor.value = null
  loading.value = false
  error.value = ''
}

const load = async (append: boolean): Promise<void> => {
  const owner = ownerId.value
  if (owner === null || blocked.value || loading.value || disposed) return
  const cursor = append ? nextCursor.value : null
  if (append && cursor === null) return
  const requestGeneration = generation
  const request = new AbortController()
  controller = request
  loading.value = true
  error.value = ''
  const current = (): boolean => !disposed && !request.signal.aborted && generation === requestGeneration && ownerId.value === owner
  try {
    const result = await fetchMyDiscussions(owner, cursor, request.signal)
    if (!current()) return
    if (append) {
      const seen = new Set(items.value.map(item => item.id))
      items.value = [...items.value, ...result.items.filter(item => !seen.has(item.id))]
    } else items.value = result.items
    nextCursor.value = result.nextCursor
  } catch (cause) {
    if (!current()) return
    if (notificationIdentityInvalidated(cause)) {
      clear()
      blocked.value = true
    }
    error.value = cause instanceof Error ? cause.message : 'Your discussions could not be loaded.'
  } finally {
    if (current()) {
      loading.value = false
      controller = undefined
    }
  }
}

const restart = (): void => {
  clear()
  void load(false)
}
const loadMore = (): void => { void load(true) }
const invalidate = (): void => {
  clear()
  blocked.value = true
  error.value = 'Your session changed. Refresh discussions to verify your account.'
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
  restart()
}
const contributionUrl = (item: DiscussionContribution): string => notificationPageHref({
  visibility: item.page.visibility, localeCode: item.page.locale, path: item.page.path, commentId: item.id
})
const formatDate = (value: string): string => {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? 'Date unavailable' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
watch(() => [ownerId.value, wikiStore.user.authVersion, wikiStore.offlineIdentityEpoch], () => {
  clear()
  blocked.value = false
  void load(false)
}, { immediate: true, flush: 'sync' })
onMounted(() => window.addEventListener(OFFLINE_SESSION_INVALIDATED_EVENT, invalidate))
onBeforeUnmount(() => {
  disposed = true
  clear()
  window.removeEventListener(OFFLINE_SESSION_INVALIDATED_EVENT, invalidate)
})
</script>

<style scoped lang='scss'>
.profile-discussions { max-width: 70rem; }
.profile-discussions__list { list-style: none; padding: 0; }
.profile-discussions__item { padding-block: 1.5rem; border-block-end: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.profile-discussions__content { white-space: pre-wrap; overflow-wrap: anywhere; margin-block: 1rem; }
</style>
