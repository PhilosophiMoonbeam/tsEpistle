<template lang="pug">
section.mt-6(v-if='loading || error || children.length', aria-labelledby='folder-children-title', :aria-busy='loading ? `true` : undefined')
  h2#folder-children-title.text-title-large {{ $t('common:sidebar.browse', { defaultValue: 'Browse' }) }}
  v-progress-linear.mt-3(v-if='loading', indeterminate, :aria-label='$t(`common:header.pageLoading`, { defaultValue: `Page loading` })')
  v-alert.mt-3(v-else-if='error', type='error', variant='tonal', role='alert')
    p {{ error }}
    v-btn.mt-2(variant='text', @click='loadChildren') {{ $t('common:actions.retry', { defaultValue: 'Retry' }) }}
  v-list.mt-3(v-else, bg-color='transparent', :aria-label='$t(`common:sidebar.browse`, { defaultValue: `Browse` })')
    v-list-item(v-for='child in children', :key='child.path', :href='childHref(child)', :prepend-icon='child.isFolder ? `mdi-folder-outline` : `mdi-file-document-outline`')
      v-list-item-title {{ child.title }}
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { fetchPageTree, type PageTreeRow } from '../../helpers/pages-api'
import { pwaState } from '../../helpers/pwa.ts'
import { wikiStore } from '../../store/index.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const props = defineProps<{ locale: string; path: string }>()
const t = useTranslate()
const children = ref<PageTreeRow[]>([])
const loading = ref(false)
const error = ref('')
let generation = 0
let controller: AbortController | null = null

// The server supplies this scope only for a genuinely absent public page. Resolve
// its native tree identity first: getTree(path) returns siblings, not children.
const loadChildren = async (): Promise<void> => {
  const request = ++generation
  controller?.abort()
  children.value = []
  error.value = ''
  loading.value = false
  if (!props.locale || !props.path || wikiStore.authRefreshPending || pwaState.connectionState !== 'online' || !pwaState.serverReachable || !pwaState.serverHealthy) return
  const locale = props.locale
  const path = props.path
  const currentController = new AbortController()
  controller = currentController
  const fetchImpl: typeof fetch = (input, init) => window.fetch(input, { ...init, signal: currentController.signal })
  loading.value = true
  try {
    const siblings = await fetchPageTree(fetchImpl, { locale, path, visibility: 'public', includeAncestors: false })
    if (request !== generation) return
    const folder = siblings.find(row => row.visibility === 'public' && row.locale === locale && row.path === path && row.isFolder && row.pageId === null)
    if (!folder) return
    const rows = await fetchPageTree(fetchImpl, { locale, parent: folder.id, visibility: 'public', includeAncestors: false })
    if (request !== generation) return
    const prefix = `${path}/`
    children.value = rows.filter(row => row.visibility === 'public' && row.locale === locale && row.parent === folder.id && row.path.startsWith(prefix) && !row.path.slice(prefix.length).includes('/') && (row.isFolder || row.pageId !== null))
  } catch {
    if (request === generation && !currentController.signal.aborted) error.value = t('common:sidebar.loadError', { defaultValue: 'Unable to load this folder. Please try again.' })
  } finally {
    if (request === generation) loading.value = false
  }
}

const childHref = (child: PageTreeRow): string => `/${encodeURIComponent(child.locale)}/${child.path.split('/').map(encodeURIComponent).join('/')}`

watch(() => [
  props.locale, props.path, wikiStore.user.id, wikiStore.user.authenticated,
  wikiStore.authRefreshPending, wikiStore.authRefreshSettled, wikiStore.authRefreshOutcome,
  wikiStore.offlineIdentityEpoch, pwaState.connectionState, pwaState.serverReachable, pwaState.serverHealthy
], () => { void loadChildren() }, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { generation += 1; controller?.abort() })
</script>
