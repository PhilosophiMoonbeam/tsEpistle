<template>
  <slot :glossary="context" :hover="hoverContext" />
  <glossary-hover-card
    v-if="hoverAnchor"
    ref="hoverCard"
    :id="hoverId"
    :anchor="hoverAnchor"
    :name="hoverName"
    :locale="props.locale"
    :selection-key="hoverKey"
    :definition="definition"
    :loading="hoverLoading"
    :error-key="hoverError"
    :href="hoverHref"
    :pin-state="currentPinState"
    @retain="retainHover"
    @leave-pointer="leavePointer"
    @dismiss="closeHover"
    @leave-focus="leaveCardFocus"
    @pin-request="requestPin"
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
import type { GlossaryAccess, GlossaryAutolinkTerm } from '../../../shared/glossary.ts'
import { fetchGlossaryAccess, fetchGlossaryAutolinks, GlossaryApiError, lookupGlossaryTerm } from '../../helpers/glossary-api.ts'
import type { GlossarySearchContext, GlossarySearchPanel } from '../../helpers/glossary-search.ts'
import { glossaryDefinitionText, glossaryHref, glossaryQueryLink, linkGlossaryContent } from '../../helpers/glossary-runtime.ts'
import type { GlossaryHoverDefinition, GlossaryPinRequest, GlossaryPinRequestHandler } from '../../helpers/glossary-runtime.ts'
import { glossaryVisibleDefinitionHtml, type GlossaryMemoryPinState } from '../../helpers/glossary-memory.ts'
import { glossaryIdentity } from '../../helpers/glossary-session.ts'
import { currentPwaMode, pwaState } from '../../helpers/pwa.ts'
import { useTranslate } from '../../helpers/use-translate.ts'
import { useWikiStore } from '../../store/index.ts'
import GlossaryHoverCard from './glossary-hover-card.vue'

const props = defineProps<{
  locale: string
  pageKey: string
  contentRoot: HTMLElement | null
  requestPin?: GlossaryPinRequestHandler
  pinState?: GlossaryMemoryPinState
}>()
const emit = defineEmits<{ 'pin-selection': [request: Readonly<GlossaryPinRequest> | null, signal?: AbortSignal] }>()
const store = useWikiStore()
const t = useTranslate()
const opened = ref(false), selectedTerm = ref(''), selectedLocale = ref(props.locale), error = ref('')
const denied = (): GlossaryAccess => ({ enabled: false, locale: selectedLocale.value, canRead: false, canManage: false })
const access = ref<GlossaryAccess>(denied())
const readerAccess = ref<GlossaryAccess>(denied())
const panel = ref<GlossarySearchPanel | null>(null)
const identity = computed(() => glossaryIdentity(store))
// Retirement deliberately has no PWA health probe; real glossary GETs establish availability there.
// Browser offline and session authority remain independent gates in unavailable().
const transportReady = computed(() => currentPwaMode() === 'retirement' || (pwaState.connectionState === 'online' && pwaState.serverReachable === true && pwaState.serverHealthy === true))
const sessionReady = computed(() => !store.authRefreshPending && store.authRefreshOutcome !== 'unavailable')
const hoverId = `glossary-hover-${useId()}`
const hoverAnchor = shallowRef<HTMLAnchorElement | null>(null), hoverCard = ref<InstanceType<typeof GlossaryHoverCard> | null>(null)
const hoverName = ref(''), hoverKey = ref(''), definition = shallowRef<GlossaryHoverDefinition | null>(null)
const hoverLoading = ref(false), hoverError = ref('')
const hoverHref = computed(() => glossaryHref(window.location.href, definition.value?.term ?? hoverName.value))
const currentPinState = computed<GlossaryMemoryPinState>(() => ({
  key: hoverKey.value,
  available: !!props.requestPin && props.pinState?.key === hoverKey.value && props.pinState.available && !!definition.value && !unavailable(),
  pending: props.pinState?.key === hoverKey.value && props.pinState.pending,
  unavailableReason: props.pinState?.key === hoverKey.value ? props.pinState.unavailableReason : undefined,
  message: props.pinState?.key === hoverKey.value ? props.pinState.message : undefined
}))
const hoverContext = computed(() => ({ key: hoverKey.value, definition: definition.value, pinState: currentPinState.value, requestPin, close: closeHover }))
const context = computed<GlossarySearchContext>(() => ({
  key: `${identity.value}:${props.pageKey}:${selectedLocale.value}`,
  opened: opened.value,
  locale: selectedLocale.value,
  term: selectedTerm.value,
  access: access.value,
  error: error.value,
  canLeave,
  navigate,
  changeLocale,
  refresh,
  bindPanel
}))
let controller: AbortController | null = null, generation = 0, terms: GlossaryAutolinkTerm[] = []
let hoverController: AbortController | null = null, hoverGeneration = 0, hoverTouch = false
let hoverScope: { owner: string; page: string; locale: string; href: string } | null = null
let cleanup: (() => void) | null = null, observer: MutationObserver | null = null, timer: ReturnType<typeof setTimeout> | undefined
let hideTimer: ReturnType<typeof setTimeout> | undefined, focusTimer: ReturnType<typeof setTimeout> | undefined
let hoverAuthorityTimer: ReturnType<typeof setTimeout> | undefined
let hoverAuthorityDeadline: ReturnType<typeof setTimeout> | undefined
let revalidateHover: (() => Promise<void>) | null = null
let suppressedAnchor: HTMLAnchorElement | null = null
let touchActivation: { anchor: HTMLAnchorElement; time: number; wasOpen: boolean } | null = null
let disposed = false, currentUrl = '', historyIndex = 0, restoring = false
const historyKey = '__glossaryIndex'
function historyState (index: number): Record<string, unknown> { return { ...(history.state ?? {}), [historyKey]: index } }
function retainHover (): void { clearTimeout(hideTimer) }
function closeHover (restoreFocus = false): void {
  retainHover(); clearTimeout(focusTimer); clearTimeout(hoverAuthorityTimer); clearTimeout(hoverAuthorityDeadline); revalidateHover = null
  const anchor = hoverAnchor.value
  hoverGeneration++; hoverController?.abort(); hoverController = null
  hoverScope = null
  definition.value = null; hoverLoading.value = false; hoverError.value = ''; hoverKey.value = ''; hoverName.value = ''
  hoverAnchor.value = null; hoverTouch = false
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'false'); anchor.removeAttribute('aria-controls')
    if (restoreFocus && anchor.isConnected) { suppressedAnchor = anchor; anchor.focus({ preventScroll: true }) }
  }
}
function clearLinks (): void { observer?.disconnect(); closeHover(); cleanup?.(); cleanup = null }
function decorate (): void {
  const root = props.contentRoot
  const focused = ownedAnchor(document.activeElement)
  const focusedName = focused?.dataset.glossaryTerm
  clearLinks()
  if (!root || !readerAccess.value.enabled || !readerAccess.value.canRead || unavailable()) return
  cleanup = linkGlossaryContent(root, terms, window.location.href, {
    locale: props.locale,
    label: (_term, visibleLabel) => t('common:glossaryHover.termLabel', { term: visibleLabel })
  })
  observer?.observe(root, { childList: true, subtree: true, characterData: true })
  if (focusedName) {
    const replacement = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[data-glossary-term]')).find(anchor => anchor.dataset.glossaryTerm === focusedName)
    replacement?.focus({ preventScroll: true })
  }
}
function unavailable (): boolean { return navigator.onLine === false || !transportReady.value || !sessionReady.value }
function retireInline (): void {
  generation++; controller?.abort(); controller = null
  terms = []; readerAccess.value = denied(); clearLinks()
}
function revoke (): void { retireInline(); access.value = denied() }
async function refresh (): Promise<void> {
  retireInline()
  const request = generation, owner = identity.value, locale = selectedLocale.value, pageLocale = props.locale, page = props.pageKey, href = window.location.href
  controller = new AbortController()
  const signal = controller.signal
  error.value = ''
  if (unavailable()) {
    access.value = denied()
    error.value = t('common:glossaryHover.unavailable')
    return
  }
  const current = (): boolean => !disposed && request === generation && owner === identity.value && page === props.pageKey && locale === selectedLocale.value && pageLocale === props.locale && href === window.location.href && !signal.aborted && !unavailable()
  try {
    const result = await fetchGlossaryAccess(locale, signal)
    if (!current()) return
    access.value = result
    const pageAccess = pageLocale === locale ? result : await fetchGlossaryAccess(pageLocale, signal)
    if (!current()) return
    readerAccess.value = pageAccess
    if (!pageAccess.enabled || !pageAccess.canRead) return
    // Inline definitions always use the article locale, independently of the directory's locale picker.
    decorate()
    const catalog = await fetchGlossaryAutolinks(pageLocale, signal)
    if (!current()) return
    terms = catalog; decorate()
  } catch {
    if (!current()) return
    revoke()
    error.value = t('common:glossaryHover.unavailable')
  }
}
function ownedAnchor (target: EventTarget | null): HTMLAnchorElement | null {
  const anchor = target instanceof Element ? target.closest('a[data-glossary-term]') : null
  return anchor instanceof HTMLAnchorElement && props.contentRoot?.contains(anchor) && anchor.closest('[data-glossary-owned]') && anchor.dataset.glossaryLocale === props.locale ? anchor : null
}
function withinHover (target: EventTarget | null): boolean {
  return target instanceof Node && (hoverAnchor.value?.contains(target) === true || hoverCard.value?.contains(target) === true)
}
async function openHover (anchor: HTMLAnchorElement, touch = false): Promise<void> {
  if (unavailable() || !readerAccess.value.enabled || !readerAccess.value.canRead || !anchor.isConnected || anchor === suppressedAnchor) return
  retainHover()
  if (anchor === hoverAnchor.value) { hoverTouch ||= touch; return }
  closeHover()
  const name = anchor.dataset.glossaryTerm, locale = anchor.dataset.glossaryLocale
  if (!name || !locale) return
  const owner = identity.value, page = props.pageKey, href = window.location.href, request = ++hoverGeneration
  const lookup = new AbortController(), signal = lookup.signal
  hoverScope = { owner, page, locale, href }
  hoverController = lookup; hoverAnchor.value = anchor; hoverName.value = name; hoverTouch = touch
  hoverKey.value = JSON.stringify([owner, page, locale, name, request])
  hoverLoading.value = true
  anchor.setAttribute('aria-expanded', 'true'); anchor.setAttribute('aria-controls', hoverId)
  const current = (): boolean => !disposed && !signal.aborted && request === hoverGeneration && owner === identity.value && page === props.pageKey && locale === props.locale && href === window.location.href && anchor === hoverAnchor.value && anchor.isConnected && props.contentRoot?.contains(anchor) === true && !unavailable()
  try {
    // Recheck authority for every opening; neither catalog summaries nor previous reads authorize a definition.
    const result = await fetchGlossaryAccess(locale, signal)
    if (!current()) return
    if (!result.enabled || !result.canRead) { revoke(); return }
    const term = await lookupGlossaryTerm(locale, name, signal)
    if (!current()) return
    const html = glossaryVisibleDefinitionHtml(term.definitionHtml)
    definition.value = { id: term.id, revision: term.revision, term: term.term, expansion: term.expansion, locale: term.locale, definitionHtml: html, definitionText: glossaryDefinitionText(html) }
    hoverLoading.value = false
    const termId = term.id, termRevision = term.revision
    let checkingAuthority = false
    const revalidate = async (): Promise<void> => {
      if (!current() || checkingAuthority) return
      clearTimeout(hoverAuthorityTimer)
      checkingAuthority = true
      const deadline = setTimeout(() => {
        if (current()) { revoke(); error.value = t('common:glossaryHover.unavailable') }
      }, 5000)
      hoverAuthorityDeadline = deadline
      try {
        const permission = await fetchGlossaryAccess(locale, signal)
        if (!current()) return
        if (!permission.enabled || !permission.canRead) { revoke(); return }
        const latest = await lookupGlossaryTerm(locale, name, signal)
        if (!current()) return
        if (latest.id !== termId || latest.revision !== termRevision) closeHover(true)
      } catch {
        if (current()) { revoke(); error.value = t('common:glossaryHover.unavailable') }
      } finally {
        clearTimeout(deadline)
        if (hoverAuthorityDeadline === deadline) hoverAuthorityDeadline = undefined
        checkingAuthority = false
        if (current() && revalidateHover === revalidate && document.visibilityState !== 'hidden') {
          hoverAuthorityTimer = setTimeout(revalidate, 5000)
        }
      }
    }
    // An open definition needs a bounded authority lease even when the app has
    // no auth request in flight. Nothing polls after dismissal or while hidden.
    revalidateHover = revalidate
    if (document.visibilityState !== 'hidden') hoverAuthorityTimer = setTimeout(revalidate, 5000)
  } catch (failure) {
    if (!current()) return
    definition.value = null; hoverLoading.value = false
    if (failure instanceof GlossaryApiError && ([401, 403].includes(failure.status) || failure.code === 'GLOSSARY_DISABLED')) { revoke(); return }
    if (failure instanceof GlossaryApiError && failure.code === 'GLOSSARY_NOT_FOUND') hoverError.value = 'notFound'
    else {
      // Unknown transport/authority failures must not leave a catalog or another private definition resident.
      revoke(); error.value = t('common:glossaryHover.unavailable')
    }
  }
}
function leavePointer (event: PointerEvent): void {
  if (withinHover(event.relatedTarget)) return
  if (suppressedAnchor && event.target instanceof Node && suppressedAnchor.contains(event.target)) suppressedAnchor = null
  retainHover()
  hideTimer = setTimeout(() => { if (!hoverTouch && !withinHover(document.activeElement)) closeHover() }, 180)
}
function pointerover (event: PointerEvent): void {
  if (event.pointerType === 'touch') return
  if (hoverCard.value?.contains(event.target)) { retainHover(); return }
  const anchor = ownedAnchor(event.target)
  if (!anchor || event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return
  suppressedAnchor = null
  void openHover(anchor)
}
function pointerdown (event: PointerEvent): void {
  const anchor = ownedAnchor(event.target)
  if (event.pointerType === 'touch' && anchor) touchActivation = { anchor, time: Date.now(), wasOpen: anchor === hoverAnchor.value }
  else touchActivation = null
  if (hoverAnchor.value && !withinHover(event.target)) closeHover(hoverCard.value?.contains(document.activeElement) === true)
}
function focusin (event: FocusEvent): void {
  if (hoverCard.value?.contains(event.target)) { retainHover(); return }
  const anchor = ownedAnchor(event.target)
  if (anchor) {
    if (touchActivation?.anchor === anchor && Date.now() - touchActivation.time < 1000) return
    void openHover(anchor)
  } else { suppressedAnchor = null; closeHover() }
}
function focusout (): void {
  clearTimeout(focusTimer)
  focusTimer = setTimeout(() => {
    if (!withinHover(document.activeElement)) { suppressedAnchor = null; closeHover() }
  }, 0)
}
function keydown (event: KeyboardEvent): void {
  if (!hoverAnchor.value || event.defaultPrevented) return
  if (event.key === 'Escape') {
    const ownedFocus = withinHover(event.target)
    closeHover(ownedFocus)
    if (ownedFocus) { event.preventDefault(); event.stopPropagation() }
  } else if (event.key === 'Tab' && !event.shiftKey && event.target === hoverAnchor.value && !event.altKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    void nextTick(() => hoverCard.value?.focusFirst())
  }
}
function leaveCardFocus (backward: boolean, event: KeyboardEvent): void {
  const anchor = hoverAnchor.value
  if (!anchor) return
  if (backward) { event.preventDefault(); closeHover(true); return }
  const elements = Array.from(document.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,summary,[tabindex],[contenteditable="true"]'))
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[hidden],[inert]') && element.getClientRects().length > 0 && !hoverCard.value?.contains(element))
  const index = elements.indexOf(anchor), next = index >= 0 ? elements[index + 1] : undefined
  closeHover()
  if (next) { event.preventDefault(); next.focus() }
}
const pinSelection = computed<GlossaryPinRequest | null>(() => {
  const detail = definition.value, scope = hoverScope
  if (!detail || !scope || hoverLoading.value || hoverError.value || !hoverKey.value) return null
  return Object.freeze({
    ...detail, key: hoverKey.value, ownerKey: scope.owner, pageKey: scope.page,
    sourceHref: new URL(glossaryHref(scope.href, null), window.location.origin).href,
    glossaryHref: new URL(hoverHref.value, window.location.origin).href
  })
})
watch(pinSelection, selection => emit('pin-selection', selection, hoverController?.signal), { flush: 'sync' })
function requestPin (): void {
  const payload = pinSelection.value, anchor = hoverAnchor.value, signal = hoverController?.signal, state = currentPinState.value, scope = hoverScope
  if (!payload || !anchor || !signal || signal.aborted || !scope || !props.requestPin || !state.available || state.pending || unavailable() || hoverLoading.value || hoverError.value) return
  if (scope.owner !== identity.value || scope.page !== props.pageKey || scope.locale !== props.locale || scope.href !== window.location.href || !anchor.isConnected) { closeHover(); return }
  // An explicit activation only. The memory consumer owns authorization, CSRF, POST and truthful feedback.
  props.requestPin(payload, signal)
}
function bindPanel (instance: unknown): void {
  const candidate = instance as Partial<GlossarySearchPanel> | null
  panel.value = typeof candidate?.canLeave === 'function' ? candidate as GlossarySearchPanel : null
}
function canLeave (): boolean { return panel.value?.canLeave() !== false }
function synchronize (): void {
  const url = new URL(window.location.href)
  opened.value = url.searchParams.has('glossary')
  selectedTerm.value = url.searchParams.get('glossary') ?? ''
  currentUrl = url.href
}
function navigate (term: string | null): boolean {
  if (!canLeave()) return false
  closeHover()
  const next = glossaryHref(window.location.href, term)
  if (new URL(next, window.location.origin).href !== window.location.href) {
    historyIndex++
    history.pushState(historyState(historyIndex), '', next)
  }
  synchronize()
  window.dispatchEvent(new CustomEvent('wiki:navigation', { detail: { url: window.location.href } }))
  return true
}
function changeLocale (locale: string): void {
  if (!canLeave()) return
  selectedLocale.value = locale
  selectedTerm.value = ''
  navigate('')
}
function popstate (event: PopStateEvent): void {
  retireInline()
  if (restoring) { restoring = false; synchronize(); void refresh(); return }
  const nextIndex: unknown = history.state?.[historyKey]
  if (!canLeave()) {
    event.stopImmediatePropagation()
    if (typeof nextIndex === 'number' && nextIndex !== historyIndex) { restoring = true; history.go(historyIndex - nextIndex) }
    else { history.replaceState(historyState(historyIndex), '', currentUrl); void refresh() }
    return
  }
  if (typeof nextIndex === 'number') historyIndex = nextIndex
  synchronize()
  void refresh()
}
function navigation (): void {
  retireInline()
  if (window.location.href !== currentUrl) {
    if (canLeave()) synchronize()
    else { history.replaceState(historyState(historyIndex), '', currentUrl); void refresh(); return }
  }
  void refresh()
}
function click (event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !(event.target instanceof Element)) return
  const anchor = event.target.closest('a')
  if (!(anchor instanceof HTMLAnchorElement) || anchor.target && anchor.target !== '_self' || anchor.hasAttribute('download')) return
  const touch = touchActivation
  touchActivation = null
  if (touch?.anchor === anchor && Date.now() - touch.time < 1000 && ownedAnchor(anchor)) {
    event.preventDefault(); event.stopImmediatePropagation()
    suppressedAnchor = null
    if (touch.wasOpen) closeHover(true)
    else void openHover(anchor, true)
    return
  }
  const name = glossaryQueryLink(anchor, window.location.href)
  if (name === undefined) {
    if (opened.value && !canLeave()) { event.preventDefault(); event.stopImmediatePropagation() }
    return
  }
  if (ownedAnchor(anchor) || hoverCard.value?.contains(anchor)) selectedLocale.value = props.locale
  event.preventDefault(); event.stopImmediatePropagation(); navigate(name ?? '')
}
watch(() => [props.pageKey, props.locale, identity.value, transportReady.value], () => {
  opened.value = false; selectedLocale.value = props.locale; selectedTerm.value = ''; suppressedAnchor = null; touchActivation = null
  access.value = denied()
  void refresh()
  synchronize()
}, { flush: 'sync' })
watch(() => props.contentRoot, () => decorate(), { flush: 'sync' })
function pointerout (event: PointerEvent): void { if (ownedAnchor(event.target) || hoverCard.value?.contains(event.target)) leavePointer(event) }
function pointercancel (): void { touchActivation = null }
function revalidateVisibleHover (): void {
  clearTimeout(hoverAuthorityTimer)
  if (document.visibilityState !== 'hidden') void revalidateHover?.()
}
onMounted(() => {
  currentUrl = window.location.href
  const initial: unknown = history.state?.[historyKey]
  historyIndex = typeof initial === 'number' ? initial : 0
  history.replaceState(historyState(historyIndex), '', window.location.href)
  observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(decorate, 0) })
  window.addEventListener('popstate', popstate, true)
  window.addEventListener('wiki:navigation', navigation)
  window.addEventListener('hashchange', navigation)
  window.addEventListener('online', refresh)
  window.addEventListener('offline', refresh)
  window.addEventListener('focus', revalidateVisibleHover)
  document.addEventListener('visibilitychange', revalidateVisibleHover)
  document.addEventListener('click', click, true)
  document.addEventListener('pointerover', pointerover, true)
  document.addEventListener('pointerout', pointerout, true)
  document.addEventListener('pointerdown', pointerdown, true)
  document.addEventListener('pointercancel', pointercancel, true)
  document.addEventListener('focusin', focusin, true)
  document.addEventListener('focusout', focusout, true)
  document.addEventListener('keydown', keydown, true)
  synchronize(); void refresh()
})
onBeforeUnmount(() => {
  disposed = true; revoke(); clearTimeout(timer); clearTimeout(hideTimer); clearTimeout(focusTimer); suppressedAnchor = null; touchActivation = null
  window.removeEventListener('popstate', popstate, true); window.removeEventListener('wiki:navigation', navigation)
  window.removeEventListener('hashchange', navigation)
  window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh)
  window.removeEventListener('focus', revalidateVisibleHover)
  document.removeEventListener('visibilitychange', revalidateVisibleHover)
  document.removeEventListener('click', click, true)
  document.removeEventListener('pointerover', pointerover, true)
  document.removeEventListener('pointerout', pointerout, true)
  document.removeEventListener('pointerdown', pointerdown, true)
  document.removeEventListener('pointercancel', pointercancel, true)
  document.removeEventListener('focusin', focusin, true)
  document.removeEventListener('focusout', focusout, true)
  document.removeEventListener('keydown', keydown, true)
})
</script>
