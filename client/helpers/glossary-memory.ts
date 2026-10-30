import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import { AGENT_MEMORY_CHARACTER_LIMITS } from '../../shared/agents/contracts.ts'
import { useAgentsStore } from '../store/agents.ts'
import { useWikiStore } from '../store/index.ts'
import { AgentApiError, createAgentMemory } from './agents-api.ts'
import { glossaryDefinitionText, sanitizeGlossaryDefinition } from './glossary-runtime.ts'
import type { GlossaryPinRequest, GlossaryPinState } from './glossary-runtime.ts'
import { glossaryIdentity } from './glossary-session.ts'
import { currentPwaMode, pwaState } from './pwa.ts'
import { useTranslate } from './use-translate.ts'

export interface GlossaryMemoryPinState extends GlossaryPinState {
  message?: string
}

/** Only the visible definition is eligible; hidden subtrees and link destinations are not memory. */
export function glossaryVisibleDefinitionHtml(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = sanitizeGlossaryDefinition(html)
  for (const element of template.content.querySelectorAll('[hidden],[aria-hidden="true"],template,script,style,noscript')) element.remove()
  return template.innerHTML
}

/** Reject rather than abbreviate a definition or silently alter a credential-bearing visible URL. */
export function glossaryMemoryContent(request: Readonly<GlossaryPinRequest>): { content: string; error?: never } | { content?: never; error: 'unsafe' | 'tooLong' } {
  const definition = glossaryDefinitionText(glossaryVisibleDefinitionHtml(request.definitionHtml))
  const visible = [request.term, request.locale, request.expansion, definition]
  if (!request.term.trim() || !request.locale.trim() || !definition || visible.some(text => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) ||
    visible.some(text => /(?:https?:\/\/[^\s<>]*[?@]|[?&](?:token|auth|key|secret|password|signature|code)=)/iu.test(text))) return { error: 'unsafe' }
  try {
    const source = new URL(request.sourceHref), glossary = new URL(request.glossaryHref)
    if (![source, glossary].every(url => ['http:', 'https:'].includes(url.protocol) && url.origin === window.location.origin && !url.username && !url.password)) return { error: 'unsafe' }
    // Queries/fragments can carry authentication or unrelated private state. Keep only page paths
    // and the explicit public glossary selector, never authored references or documentation.
    const sourceContext = `${source.origin}${source.pathname}`
    const glossaryContext = `${glossary.origin}${glossary.pathname}?glossary=${encodeURIComponent(request.term)}`
    const content = [
      `Term: ${request.term}`,
      `Locale: ${request.locale}`,
      ...(request.expansion ? [`Expansion: ${request.expansion}`] : []),
      `Definition:\n${definition}`,
      `Source: ${sourceContext}`,
      `Glossary: ${glossaryContext}`
    ].join('\n')
    return content.length > AGENT_MEMORY_CHARACTER_LIMITS.user ? { error: 'tooLong' } : { content }
  } catch {
    return { error: 'unsafe' }
  }
}

/** Page-owned, ephemeral Pin state. Selecting/opening a definition never dispatches a write. */
export function useGlossaryMemory(pageKey: () => string, locale: () => string) {
  const store = useWikiStore(), agents = useAgentsStore(), t = useTranslate()
  const selected = shallowRef<{ request: Readonly<GlossaryPinRequest>; signal: AbortSignal; href: string } | null>(null)
  const pending = shallowRef(false), feedback = shallowRef<{ key: string; message: string; complete: boolean } | null>(null)
  const deniedIdentity = shallowRef<{ owner: string; reason: 'signIn' | 'denied' } | null>(null)
  let disposed = false
  // navigator.onLine cannot invalidate a computed value after connectivity returns.
  const browserOnline = shallowRef(typeof navigator === 'undefined' || navigator.onLine !== false)
  const refreshBrowserOnline = (): void => { browserOnline.value = navigator.onLine !== false }
  onMounted(() => {
    refreshBrowserOnline()
    window.addEventListener('online', refreshBrowserOnline)
    window.addEventListener('offline', refreshBrowserOnline)
  })
  const identity = computed(() => glossaryIdentity(store))
  const csrf = (): string => typeof siteConfig.agentCsrfToken === 'string' ? siteConfig.agentCsrfToken : ''
  const unavailableKey = computed(() => {
    if (!browserOnline.value || (currentPwaMode() !== 'retirement' && (pwaState.connectionState !== 'online' || pwaState.serverReachable !== true || pwaState.serverHealthy !== true))) return 'offline'
    if (!store.user.authenticated || !Number.isSafeInteger(store.user.id) || store.user.id <= 0) return 'signIn'
    if (store.authRefreshPending || !store.authRefreshSettled || store.authRefreshOutcome !== 'authenticated' || !store.offlineIdentityReady) return 'session'
    if (!siteConfig.agentsEnabled || !csrf()) return 'unavailable'
    if (deniedIdentity.value?.owner === identity.value) return deniedIdentity.value.reason
    if (!store.user.permissions.some(permission => permission === 'use:agents' || permission === 'manage:system')) return 'denied'
    return null
  })
  const currentSelection = (): boolean => {
    const selection = selected.value
    return !disposed && !!selection && !selection.signal.aborted && selection.request.ownerKey === identity.value &&
      selection.request.pageKey === pageKey() && selection.request.locale === locale() && selection.href === window.location.href
  }
  const pinState = computed<GlossaryMemoryPinState>(() => {
    const selection = selected.value
    const payload = selection && currentSelection() ? glossaryMemoryContent(selection.request) : null
    const reason = unavailableKey.value ?? payload?.error ?? (!payload ? 'unavailable' : null)
    const result = feedback.value?.key === selection?.request.key ? feedback.value : null
    return {
      key: selection?.request.key ?? '', available: !reason && !pending.value && !result?.complete,
      pending: pending.value,
      unavailableReason: reason ? t(`common:glossaryPin.${reason}`) : result?.complete ? result.message : undefined,
      message: reason ? undefined : pending.value ? t('common:glossaryPin.saving') : result?.message ?? t('common:glossaryPin.privateScope')
    }
  })
  const selectPin = (request: Readonly<GlossaryPinRequest> | null, signal?: AbortSignal): void => {
    if (selected.value?.request.key === request?.key) return
    selected.value = request && signal && !signal.aborted ? { request, signal, href: window.location.href } : null
    feedback.value = null
  }
  const requestPin = async (request: Readonly<GlossaryPinRequest>, signal: AbortSignal): Promise<void> => {
    if (navigator.onLine === false || !siteConfig.agentsEnabled || !currentSelection() || selected.value?.request !== request || selected.value.signal !== signal || !pinState.value.available || pending.value) return
    const payload = glossaryMemoryContent(request)
    if (payload.error) return
    const ownerId = store.user.id, owner = identity.value, token = csrf(), selection = selected.value
    const candidate = agents.captureMemoryMutationContext()
    const capture = candidate?.ownerId === ownerId && agents.isMemoryMutationContextCurrent(candidate) ? candidate : null
    const current = (): boolean => navigator.onLine !== false && siteConfig.agentsEnabled && currentSelection() && selected.value === selection && owner === identity.value && ownerId === store.user.id && token === csrf() && !unavailableKey.value && (!capture || agents.isMemoryMutationContextCurrent(capture))
    pending.value = true; feedback.value = null
    try {
      // No workspace initialization, inference, offline queue, retry or duplicate POST.
      const response = await createAgentMemory(window.fetch.bind(window), token, {
        target: 'user', content: payload.content, context: { sessionId: capture?.sessionId ?? null }
      })
      if (!current()) return
      if (response.target !== 'user' || (response.receipt && (response.receipt.ownerId !== ownerId || response.receipt.sessionId !== (capture?.sessionId ?? null) || response.receipt.operation !== 'add' || response.receipt.entryVersion !== 1))) throw new AgentApiError(502, 'Invalid memory receipt')
      if (capture && response.changed && !agents.consumeManualMemoryReceipt(capture, response.receipt, { entryId: null, entryVersion: 1, target: 'user' })) {
        agents.invalidateSavedMemory(capture, ['user'])
      }
      feedback.value = { key: request.key, message: t(`common:glossaryPin.${response.changed ? 'saved' : 'alreadySaved'}`), complete: true }
    } catch (error) {
      if (!current()) return
      let key = 'error'
      if (error instanceof AgentApiError) {
        if (error.status === 401) key = 'signIn'
        else if (error.status === 403) key = 'denied'
        else if (error.code === 'AGENT_MEMORY_FULL') key = 'full'
        else if (error.code === 'INVALID_AGENT_MEMORY') key = 'unsafe'
        else if ([404, 410, 503].includes(error.status)) key = 'unavailable'
        if (error.status === 401 || error.status === 403) deniedIdentity.value = { owner, reason: error.status === 401 ? 'signIn' : 'denied' }
      }
      feedback.value = { key: request.key, message: t(`common:glossaryPin.${key}`), complete: false }
    } finally {
      pending.value = false
    }
  }
  watch(() => [identity.value, pageKey(), locale()], () => { selected.value = null; feedback.value = null }, { flush: 'sync' })
  onBeforeUnmount(() => {
    disposed = true
    window.removeEventListener('online', refreshBrowserOnline)
    window.removeEventListener('offline', refreshBrowserOnline)
    selected.value = null; feedback.value = null
  })
  return { pinState, selectPin, requestPin }
}
