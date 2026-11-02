<template>
  <section class="agent-context-summary" :aria-label="$t('common:agentContextUi.context')">
    <div class="agent-context-summary__controls">
      <button type="button" class="agent-context-summary__sources" :disabled="sourcesDisabled" :aria-label="sourceLabel" :aria-describedby="`${summaryId}-sources`" aria-haspopup="dialog" @click="openSources">
        <svg class="agent-context-summary__ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
          <circle class="agent-context-summary__track" cx="9" cy="9" r="7" fill="none" stroke-width="2" />
          <circle v-if="sources" class="agent-context-summary__fill" cx="9" cy="9" r="7" fill="none" stroke-width="2" pathLength="8" stroke-dasharray="8 8" :stroke-dashoffset="8 - sources.attachedSources.length" transform="rotate(-90 9 9)" />
        </svg>
        <span>{{ $t('common:agentContextPicker.sources') }} <strong>{{ sources ? sources.attachedSources.length : '—' }}/8</strong></span>
      </button>
      <span class="agent-context-summary__page" :title="pageDescription">
        <v-icon :icon="sources?.currentPage.included ? 'mdi-file-check-outline' : 'mdi-file-hidden'" size="16" aria-hidden="true" />
        {{ pageLabel }}
      </span>
      <button v-for="row in memoryRows" :key="row.target" type="button" class="agent-context-summary__crystal" :class="`agent-context-summary__crystal--${row.target}`" :disabled="memoryDisabled" :aria-label="row.label" :aria-describedby="`${summaryId}-${row.target}`" aria-controls="agent-memory-panel" @click="openMemory(row.target, $event)">
        <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true" focusable="false"><path d="M8 1 14 5 12 13 8 17 4 13 2 5Z" /><path d="m2 5 6 3 6-3M8 1v16M4 13l4-5 4 5" /></svg>
        <span><strong>{{ row.name }}</strong> · {{ row.short }}</span>
        <v-icon v-if="memory?.nextSession[row.target] === 'changed'" class="agent-context-summary__next" icon="mdi-update" size="16" aria-hidden="true" :title="$t('common:agentContextUi.nextChanged')" />
      </button>
    </div>
    <details class="agent-context-summary__details" @toggle="updateDetailScroll">
      <summary :aria-controls="`${summaryId}-details`" :aria-describedby="detailScrollEnd > 0 ? `${summaryId}-scroll-help` : undefined">{{ $t('common:agentContextUi.details') }}</summary>
      <div v-if="detailScrollEnd > 0" ref="detailScrollControls" class="agent-context-summary__scroll-controls">
        <button type="button" :disabled="detailScrollTop <= 0" :aria-label="$t('common:agentContextUi.scrollPrevious')" :aria-controls="`${summaryId}-details`" @click="scrollDetails(-1)"><v-icon icon="mdi-chevron-up" size="18" aria-hidden="true" /></button>
        <button type="button" :disabled="detailScrollTop >= detailScrollEnd" :aria-label="$t('common:agentContextUi.scrollNext')" :aria-controls="`${summaryId}-details`" @click="scrollDetails(1)"><v-icon icon="mdi-chevron-down" size="18" aria-hidden="true" /></button>
        <p :id="`${summaryId}-scroll-help`">{{ $t('common:agentContextUi.detailsScrollHelp') }}</p>
      </div>
      <section :id="`${summaryId}-details`" ref="detailBody" class="agent-context-summary__detail-body" :aria-label="$t('common:agentContextUi.details')" @scroll.passive="updateDetailScroll">
        <div ref="detailContent">
          <p :id="`${summaryId}-sources`">{{ sourceDescription }}</p>
          <p>{{ pageDescription }}</p>
          <p v-if="sources">{{ $t('common:agentContextUi.hints', { count: hintCount, accessible: sources.accessibleIdentities.length }) }} {{ $t('common:agentContextUi.notEvidence') }}</p>
          <ul v-if="sources?.attachedSources.length" class="agent-context-summary__source-list">
            <li v-for="row in sources.attachedSources" :key="agentSourceIdentityKey(row.source)">{{ row.source.title }} · {{ row.source.locale }}/{{ row.source.path }} · {{ stateLabel(row.access) }}</li>
          </ul>
          <p v-if="sources">{{ $t('common:agentContextUi.scope', { scope: scopeLabel, interpolation: { escapeValue: false } }) }}</p>
          <p>{{ $t(memory?.frozen.snapshotId ? 'common:agentContextUi.snapshotLocked' : 'common:agentContextUi.snapshotUnknown') }}</p>
          <button v-if="memory?.frozen.snapshotId" type="button" @click="copyIdentifier(memory.frozen.snapshotId)">{{ $t('common:agentContextUi.copySessionId') }}</button>
          <div v-for="row in memoryRows" :key="row.target" :id="`${summaryId}-${row.target}`">
            <p><strong>{{ row.name }}</strong> — {{ $t('common:agentContextUi.activeFrozen', { state: row.active, interpolation: { escapeValue: false } }) }}</p>
            <meter v-if="row.frozenCapacity" :min="0" :max="row.frozenCapacity.limit" :value="row.frozenCapacity.characters" :aria-label="$t('common:agentContextUi.frozenCapacity', { name: row.name, state: row.active, interpolation: { escapeValue: false } })" />
            <button v-if="row.snapshot" type="button" @click="copyIdentifier(row.snapshot)">{{ $t('common:agentContextUi.copyMemoryId', { name: row.name, interpolation: { escapeValue: false } }) }}</button>
            <p>{{ $t('common:agentContextUi.latestSaved', { state: row.saved, interpolation: { escapeValue: false } }) }}</p>
            <meter v-if="row.savedCapacity" :min="0" :max="row.savedCapacity.limit" :value="row.savedCapacity.characters" :aria-label="$t('common:agentContextUi.savedCapacity', { name: row.name, state: row.saved, interpolation: { escapeValue: false } })" />
            <p>{{ row.next }}</p>
          </div>
          <p class="agent-context-summary__copy-status" role="status" aria-live="polite" aria-atomic="true">{{ copyStatus }}</p>
          <p>{{ $t('common:agentContextUi.memorySemantics') }}</p>
          <p v-if="networkBlocked">{{ $t('common:agentContextUi.disconnected') }}</p>
        </div>
      </section>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import type { AgentMemoryContextProjection } from '../../../shared/agents/contracts.ts'
import { agentSourceIdentityKey, type AgentSourceContextProjection } from '../../../shared/agents/knowledge-context.ts'
import { useTranslate } from '../../helpers/use-translate.ts'
import { copyTextToClipboard } from '../../helpers/clipboard.ts'

const props = defineProps<{
  sources: AgentSourceContextProjection | null
  memory: AgentMemoryContextProjection | null
  loading?: boolean
  networkBlocked?: boolean
  sourcesDisabled?: boolean
  memoryDisabled?: boolean
}>()
const emit = defineEmits<{
  openSources: [opener: HTMLElement]
  openMemory: [target: 'user' | 'agent', opener: HTMLElement]
}>()
const t = useTranslate()
const summaryId = useId()
const detailBody = ref<HTMLElement | null>(null)
const detailContent = ref<HTMLElement | null>(null)
const detailScrollControls = ref<HTMLElement | null>(null)
const detailScrollTop = ref(0)
const detailScrollEnd = ref(0)
let detailObserver: ResizeObserver | null = null
const updateDetailScroll = (): void => {
  const body = detailBody.value
  const details = body?.closest('details')
  const end = body && details?.open ? Math.max(0, body.scrollHeight - body.clientHeight) : 0
  if (!end && detailScrollControls.value?.contains(document.activeElement)) details?.querySelector('summary')?.focus({ preventScroll: true })
  detailScrollEnd.value = end
  detailScrollTop.value = body ? Math.max(0, Math.min(end, body.scrollTop)) : 0
}
const scrollDetails = async (direction: -1 | 1): Promise<void> => {
  const body = detailBody.value
  const controls = detailScrollControls.value
  const focused = document.activeElement
  updateDetailScroll()
  if (!body || !detailScrollEnd.value) return
  body.scrollTop = Math.max(0, Math.min(detailScrollEnd.value, body.scrollTop + direction * Math.max(1, body.clientHeight - 40)))
  updateDetailScroll()
  await nextTick()
  if (controls?.isConnected && controls === detailScrollControls.value && focused instanceof HTMLButtonElement && controls.contains(focused) && focused.disabled) {
    controls.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }
}
onMounted(() => {
  detailObserver = new ResizeObserver(updateDetailScroll)
  if (detailBody.value) detailObserver.observe(detailBody.value)
  if (detailContent.value) detailObserver.observe(detailContent.value)
  updateDetailScroll()
})
const copyStatus = ref('')
let copyGeneration = 0
watch(() => props.memory, () => { copyGeneration += 1; copyStatus.value = '' }, { flush: 'sync' })
onBeforeUnmount(() => { detailObserver?.disconnect(); copyGeneration += 1 })
const copyIdentifier = async (value: string): Promise<void> => {
  const generation = ++copyGeneration
  try {
    await copyTextToClipboard(value)
    if (generation === copyGeneration) copyStatus.value = t('common:agentContextUi.copySuccess')
  } catch {
    if (generation === copyGeneration) copyStatus.value = t('common:agentContextUi.copyFailed')
  }
}
const targets = ['user', 'agent'] as const
const stateLabel = (state: string): string => t(`common:agentContextUi.state.${state}`)
const absentState = computed(() => props.networkBlocked ? stateLabel('offline') : props.loading ? stateLabel('loading') : stateLabel('unknown'))
const sourceLabel = computed(() => props.sources
  ? t('common:agentContextUi.attachedCount', { count: props.sources.attachedSources.length })
  : t('common:agentContextUi.sourcesUnknown', { state: absentState.value }))
const sourceDescription = computed(() => `${sourceLabel.value} ${t('common:agentContextUi.committedOnly')}`)
const pageLabel = computed(() => !props.sources ? absentState.value
  : t(!props.sources.currentPage.hint ? 'common:agentContextUi.noPage' : props.sources.currentPage.included ? 'common:agentContextUi.pageIncluded' : 'common:agentContextUi.pageExcluded'))
const pageDescription = computed(() => {
  const page = props.sources?.currentPage
  if (!page?.hint) return pageLabel.value
  return t('common:agentContextUi.pageHint', {
    state: pageLabel.value, path: `${page.hint.locale}/${page.hint.path}`,
    origin: t(page.origin === 'historical' ? 'common:agentContextUi.historical' : 'common:agentContextUi.navigation'),
    access: stateLabel(page.access), interpolation: { escapeValue: false }
  })
})
const hintCount = computed(() => {
  const sources = props.sources
  if (!sources) return 0
  const identities = new Set(sources.attachedSources.map(row => agentSourceIdentityKey(row.source)))
  if (sources.currentPage.included && sources.currentPage.hint) identities.add(agentSourceIdentityKey(sources.currentPage.hint))
  return identities.size
})
const scopeLabel = computed(() => {
  const scope = props.sources?.scope
  if (!scope) return absentState.value
  if (scope.kind === 'all') return t('common:agentContextPicker.allWiki')
  if (scope.kind === 'selected') return t('common:agentContextPicker.selectedPages')
  if (scope.kind === 'locale') return t('common:agentContextPicker.pages', { locale: scope.locale.toUpperCase() })
  return t('common:agentContextPicker.within', { path: `${scope.locale}/${scope.path}`, interpolation: { escapeValue: false } })
})
type MemoryMetadata = AgentMemoryContextProjection['frozen']['user'] | AgentMemoryContextProjection['frozen']['agent']
const memoryLabel = (metadata: MemoryMetadata | undefined): string => {
  if (!metadata) return absentState.value
  if (metadata.state !== 'available' && metadata.state !== 'stale') return stateLabel(metadata.state)
  const count = t(metadata.characters === 0 ? 'common:agentContextUi.emptyCount' : 'common:agentContextUi.characterCount', { count: metadata.characters, limit: metadata.limit })
  return metadata.state === 'stale' ? t('common:agentContextUi.staleCount', { count, interpolation: { escapeValue: false } }) : count
}
const memoryRows = computed(() => targets.map(target => {
  const frozen = props.memory?.frozen[target]
  const latest = props.memory?.latestSaved[target]
  const name = t(target === 'user' ? 'common:agentMemoryManager.you' : 'common:agentMemoryManager.agent')
  const active = memoryLabel(frozen)
  const short = frozen && (frozen.state === 'available' || frozen.state === 'stale')
    ? `${t('common:agentContextUi.shortCharacters', { count: frozen.characters })}${frozen.state === 'stale' ? ` · ${stateLabel('stale')}` : ''}`
    : active
  const saved = memoryLabel(props.memory?.latestSaved[target])
  const next = t(`common:agentContextUi.next.${props.memory?.nextSession[target] ?? 'unknown'}`)
  return {
    target, name, active, short, saved, next,
    frozenCapacity: frozen && (frozen.state === 'available' || frozen.state === 'stale') ? frozen : null,
    savedCapacity: latest && (latest.state === 'available' || latest.state === 'stale') ? latest : null,
    snapshot: frozen && (frozen.state === 'available' || frozen.state === 'stale') ? frozen.snapshotId : null,
    label: t('common:agentContextUi.openMemory', { name, active, saved, next, interpolation: { escapeValue: false } })
  }
}))
const openSources = (event: MouseEvent): void => {
  if (!props.sourcesDisabled && event.currentTarget instanceof HTMLElement) emit('openSources', event.currentTarget)
}
const openMemory = (target: 'user' | 'agent', event: MouseEvent): void => {
  if (!props.memoryDisabled && event.currentTarget instanceof HTMLElement) emit('openMemory', target, event.currentTarget)
}
</script>

<style scoped>
.agent-context-summary { min-width: 0; width: 100%; color: rgb(var(--v-theme-on-surface)); font-size: var(--wiki-label-size); }
.agent-context-summary__controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--wiki-space-1) var(--wiki-space-2); }
.agent-context-summary button { display: inline-flex; align-items: center; justify-content: center; gap: var(--wiki-space-2); min-height: max(44px, var(--wiki-control-height)); min-width: 44px; max-width: 100%; padding: var(--wiki-space-1) var(--wiki-space-2); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-radius-pill); background: var(--wiki-surface-raised); color: inherit; font: inherit; cursor: pointer; }
.agent-context-summary button:disabled { cursor: not-allowed; opacity: .65; }
.agent-context-summary button > span { overflow-wrap: anywhere; }
.agent-context-summary button:focus-visible, .agent-context-summary summary:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: 2px; }
.agent-context-summary__ring { width: 18px; height: 18px; flex: 0 0 18px; }
.agent-context-summary__track { stroke: var(--wiki-surface-border-strong); }
.agent-context-summary__fill { stroke: var(--wiki-primary-ink); transition: stroke-dashoffset var(--wiki-motion-normal) var(--wiki-motion-ease); }
.agent-context-summary__sources strong { font-variant-numeric: tabular-nums; }
.agent-context-summary__page { display: inline-flex; align-items: center; gap: var(--wiki-space-1); color: var(--wiki-text-muted); }
.agent-context-summary .agent-context-summary__crystal { --crystal-tint: var(--wiki-accent-warm); border-color: color-mix(in oklch, var(--crystal-tint) 32%, var(--wiki-surface-border)); background: linear-gradient(135deg, color-mix(in oklch, var(--crystal-tint) 12%, transparent), transparent), color-mix(in oklch, var(--wiki-surface-raised) 85%, transparent); box-shadow: var(--wiki-specular-border), var(--wiki-shadow-xs); }
.agent-context-summary .agent-context-summary__crystal--agent { --crystal-tint: var(--wiki-accent-spectral); }
.agent-context-summary__crystal svg { flex: 0 0 16px; stroke: currentColor; fill: color-mix(in oklch, var(--crystal-tint) 32%, transparent); stroke-width: 1; }
.agent-context-summary__next { border-inline-start: 1px solid var(--wiki-surface-border-strong); padding-inline-start: var(--wiki-space-2); }
.agent-context-summary__details { margin-block-start: var(--wiki-space-1); }
.agent-context-summary__details summary { width: fit-content; min-height: 44px; align-content: center; cursor: pointer; color: var(--wiki-text-muted); }
.agent-context-summary__scroll-controls { display: flex; align-items: center; gap: var(--wiki-space-1); margin-block: var(--wiki-space-1); }
.agent-context-summary__scroll-controls p { margin: 0; color: var(--wiki-text-muted); }
.agent-context-summary__detail-body { box-sizing: border-box; max-height: min(24rem, 40dvh); overflow-y: auto; padding: var(--wiki-space-2) var(--wiki-space-3); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-raised); overflow-wrap: anywhere; }
.agent-context-summary__detail-body p { margin: 0 0 var(--wiki-space-2); }
.agent-context-summary__source-list { padding-inline-start: var(--wiki-space-4); }
.agent-context-summary meter { display: block; inline-size: min(100%, 24rem); block-size: 1rem; margin-block: var(--wiki-space-1) var(--wiki-space-2); accent-color: var(--wiki-primary-ink); }
@media (prefers-reduced-motion: reduce) { .agent-context-summary__fill { transition: none; } }
@media (prefers-reduced-transparency: reduce) { .agent-context-summary .agent-context-summary__crystal { background: var(--wiki-surface-raised); } }
@media (forced-colors: active) {
  .agent-context-summary button, .agent-context-summary .agent-context-summary__crystal, .agent-context-summary__detail-body { background: Canvas; color: CanvasText; border-color: ButtonText; box-shadow: none; }
  .agent-context-summary__track { stroke: GrayText; }
  .agent-context-summary__fill { stroke: ButtonText; transition: none; }
  .agent-context-summary__crystal svg { fill: Canvas; stroke: ButtonText; }
  .agent-context-summary__page, .agent-context-summary__details summary { color: CanvasText; }
}
</style>
