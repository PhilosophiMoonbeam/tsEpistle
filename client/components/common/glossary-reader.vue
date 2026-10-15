<template>
  <glossary-dialog v-if="opened" :key="`${identity}:${pageKey}:${selectedLocale}:${navigationEpoch}`" ref="dialog" :locale="selectedLocale" :term="selectedTerm" :access="access" :host-error="error" @close="navigate(null)" @select="navigate($event)" @locale="changeLocale" @changed="refresh" />
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { GlossaryAccess, GlossaryAutolinkTerm } from '../../../shared/glossary.ts'
import { fetchGlossaryAccess, fetchGlossaryAutolinks, GlossaryApiError } from '../../helpers/glossary-api.ts'
import { onOpenGlossary } from '../../helpers/glossary-events.ts'
import { glossaryHref, glossaryQueryLink, linkGlossaryContent } from '../../helpers/glossary-runtime.ts'
import { glossaryIdentity } from '../../helpers/glossary-session.ts'
import { useWikiStore } from '../../store/index.ts'

const GlossaryDialog = defineAsyncComponent(() => import('./glossary-dialog.vue'))
const props = defineProps<{ locale: string; pageKey: string; contentRoot: HTMLElement | null }>()
const emit = defineEmits<{ access: [value: GlossaryAccess] }>()
const store = useWikiStore()
const opened = ref(false), selectedTerm = ref(''), selectedLocale = ref(props.locale), error = ref('')
const navigationEpoch = ref(0)
const denied = (): GlossaryAccess => ({ enabled: false, locale: selectedLocale.value, canRead: false, canManage: false })
const access = ref<GlossaryAccess>(denied())
const dialog = ref<{ canLeave: () => boolean } | null>(null)
const identity = computed(() => glossaryIdentity(store))
let controller: AbortController | null = null, generation = 0, terms: GlossaryAutolinkTerm[] = []
let cleanup: (() => void) | null = null, observer: MutationObserver | null = null, timer: ReturnType<typeof setTimeout> | undefined
let stopEvents: (() => void) | undefined, disposed = false, currentUrl = '', historyIndex = 0, restoring = false
const historyKey = '__glossaryIndex'
function historyState (index: number): Record<string, unknown> { return { ...(history.state ?? {}), [historyKey]: index } }
function clearLinks (): void { observer?.disconnect(); cleanup?.(); cleanup = null }
function decorate (): void {
  clearLinks()
  const root = props.contentRoot
  if (!root || !access.value.enabled || !access.value.canRead || navigator.onLine === false) return
  cleanup = linkGlossaryContent(root, terms)
  observer?.observe(root, { childList: true, subtree: true, characterData: true })
}
async function refresh (): Promise<void> {
  controller?.abort()
  const request = ++generation, owner = identity.value, locale = selectedLocale.value
  controller = new AbortController()
  const signal = controller.signal
  terms = []; clearLinks(); error.value = ''
  let authorized = false
  if (navigator.onLine === false || store.authRefreshPending || store.authRefreshOutcome === 'unavailable') {
    access.value = denied(); emit('access', access.value)
    error.value = 'The glossary is unavailable offline or while your session is being refreshed.'
    return
  }
  try {
    const result = await fetchGlossaryAccess(locale, signal)
    if (disposed || request !== generation || owner !== identity.value || signal.aborted) return
    access.value = result; emit('access', result)
    authorized = true
    if (!result.enabled || !result.canRead) return
    // Explicit links need no automatic catalog, so install them immediately.
    decorate()
    const catalog = await fetchGlossaryAutolinks(locale, signal)
    if (disposed || request !== generation || owner !== identity.value || signal.aborted) return
    terms = catalog; decorate()
  } catch (failure) {
    if (signal.aborted || request !== generation || disposed) return
    terms = []; clearLinks()
    if (!authorized || failure instanceof GlossaryApiError && ([401, 403].includes(failure.status) || failure.code === 'GLOSSARY_DISABLED')) { access.value = denied(); emit('access', access.value) }
    else decorate()
    error.value = failure instanceof Error ? failure.message : 'Unable to load the glossary.'
  }
}
function canLeave (): boolean { return dialog.value?.canLeave() !== false }
function synchronize (): void {
  const url = new URL(window.location.href)
  opened.value = url.searchParams.has('glossary')
  selectedTerm.value = url.searchParams.get('glossary') ?? ''
  currentUrl = url.href
}
function navigate (term: string | null): void {
  if (!canLeave()) return
  navigationEpoch.value++
  const next = glossaryHref(window.location.href, term)
  if (new URL(next, window.location.origin).href !== window.location.href) {
    historyIndex++
    history.pushState(historyState(historyIndex), '', next)
  }
  synchronize()
  window.dispatchEvent(new CustomEvent('wiki:navigation', { detail: { url: window.location.href } }))
}
function changeLocale (locale: string): void {
  if (!canLeave()) return
  selectedLocale.value = locale
  selectedTerm.value = ''
  navigate('')
  void refresh()
}
function popstate (event: PopStateEvent): void {
  if (restoring) { restoring = false; synchronize(); return }
  const nextIndex: unknown = history.state?.[historyKey]
  if (!canLeave()) {
    event.stopImmediatePropagation()
    if (typeof nextIndex === 'number' && nextIndex !== historyIndex) { restoring = true; history.go(historyIndex - nextIndex) }
    else history.replaceState(historyState(historyIndex), '', currentUrl)
    return
  }
  if (typeof nextIndex === 'number') historyIndex = nextIndex
  synchronize()
}
function navigation (): void { if (window.location.href !== currentUrl) { if (canLeave()) synchronize(); else history.replaceState(historyState(historyIndex), '', currentUrl) } }
function click (event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !(event.target instanceof Element)) return
  const anchor = event.target.closest('a')
  if (!(anchor instanceof HTMLAnchorElement) || anchor.target && anchor.target !== '_self' || anchor.hasAttribute('download')) return
  const name = glossaryQueryLink(anchor, window.location.href)
  if (name === undefined) {
    if (opened.value && !canLeave()) { event.preventDefault(); event.stopImmediatePropagation() }
    return
  }
  event.preventDefault(); event.stopImmediatePropagation(); navigate(name ?? '')
}
watch(() => [props.pageKey, props.locale, identity.value], () => {
  opened.value = false; selectedLocale.value = props.locale; selectedTerm.value = ''; terms = []; access.value = denied(); emit('access', access.value)
  void refresh()
  synchronize()
}, { flush: 'sync' })
watch(() => props.contentRoot, () => decorate())
onMounted(() => {
  currentUrl = window.location.href
  const initial: unknown = history.state?.[historyKey]
  historyIndex = typeof initial === 'number' ? initial : 0
  history.replaceState(historyState(historyIndex), '', window.location.href)
  observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(decorate, 0) })
  stopEvents = onOpenGlossary(input => { if (!canLeave()) return; if (input.locale && input.locale !== selectedLocale.value) { selectedLocale.value = input.locale; void refresh() }; navigate(input.term ?? '') })
  window.addEventListener('popstate', popstate, true)
  window.addEventListener('wiki:navigation', navigation)
  window.addEventListener('online', refresh)
  window.addEventListener('offline', refresh)
  document.addEventListener('click', click, true)
  synchronize(); void refresh()
})
onBeforeUnmount(() => {
  disposed = true; generation++; controller?.abort(); stopEvents?.(); clearTimeout(timer); clearLinks(); terms = []
  window.removeEventListener('popstate', popstate, true); window.removeEventListener('wiki:navigation', navigation)
  window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh)
  document.removeEventListener('click', click, true)
})
</script>
