<template>
  <span ref="root" class="cited-copy-action" :data-copy-state="state">
    <button
      type="button"
      class="cited-copy-action__button"
      :disabled="disabled || !source || !text.trim()"
      :aria-label="t('copy')"
      :title="`${t('copy')} — ${keyHint}`"
      :aria-describedby="hintId"
      :aria-busy="state === 'copying'"
      @click.stop="copy"
    >
      <v-icon size="18" aria-hidden="true">{{ state === 'copied' ? 'mdi-check' : 'mdi-content-copy' }}</v-icon>
      <span>{{ state === 'copied' ? t('copied') : t('copy') }}</span>
    </button>
    <span :id="hintId" class="cited-copy-action__hint">{{ keyHint }}</span>
    <span class="cited-copy-action__receipt" role="status" aria-live="polite" aria-atomic="true">{{ feedback }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import type { WikiSource } from '../../../shared/wiki-source.ts'
import { CitedCopyError, copyCitedSnippet, type CitedCopyContext } from '../../helpers/cited-copy.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

/**
 * Consumer contract: one action inside a .wiki-cited-copy-owner[data-cited-copy-owner]
 * row/block. Supply only its current authorized readable plain snippet, canonical
 * WikiSource, window.location.origin and (if known) its existing raw source block id.
 * Change identity on account/access epoch or selected block changes; update text/source
 * together. Null source/disabled revokes this action. Never pass a whole row's DOM text.
 * Native selected-text copy is untouched; the key hint describes that native action.
 */
const props = defineProps<{
  text: string
  source: WikiSource | null
  context: CitedCopyContext
  identity: string | number
  blockAnchor?: string
  disabled?: boolean
  /** Required to be unique in the document when mounted in an independent render root. */
  hintId?: string
}>()
const emit = defineEmits<{
  copied: [receipt: { identity: string | number; citationHref: string }]
  failed: [reason: 'invalid-text' | 'invalid-source' | 'clipboard-failed']
}>()
const t = useTranslate('common:citedCopy')
const root = ref<HTMLElement | null>(null)
const generatedHintId = `cited-copy-hint-${useId()}`
const hintId = computed(() => props.hintId ?? generatedHintId)
const state = ref<'idle' | 'copying' | 'copied' | 'failed'>('idle')
const feedback = ref('')
const keyHint = computed(() => t('selectedTextHint', {
  shortcut: typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? '⌘C' : 'Ctrl+C'
}))
let generation = 0
let disposed = false
let stopSweep: (() => void) | undefined
let receiptTimer: number | undefined

const clearSweep = (): void => {
  stopSweep?.()
  stopSweep = undefined
}

const sweep = (): void => {
  clearSweep()
  const owner = root.value?.closest<HTMLElement>('.wiki-cited-copy-owner[data-cited-copy-owner]')
  if (!owner || typeof window.matchMedia !== 'function') return
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  if (motion.matches) return
  const beam = document.createElement('span')
  beam.className = 'wiki-cited-copy-sweep'
  beam.setAttribute('aria-hidden', 'true')
  const cleanup = (): void => {
    beam.removeEventListener('animationend', end)
    beam.removeEventListener('animationcancel', end)
    motion.removeEventListener('change', preferenceChanged)
    beam.remove()
    if (stopSweep === cleanup) stopSweep = undefined
  }
  const end = (event: AnimationEvent): void => {
    if (event.target === beam && event.animationName === 'wiki-attractor-sweep') cleanup()
  }
  const preferenceChanged = (): void => { if (motion.matches) cleanup() }
  beam.addEventListener('animationend', end)
  beam.addEventListener('animationcancel', end)
  motion.addEventListener('change', preferenceChanged)
  stopSweep = cleanup
  owner.append(beam)
}

const invalidate = (): void => {
  generation++
  clearSweep()
  if (receiptTimer !== undefined) window.clearTimeout(receiptTimer)
  receiptTimer = undefined
  state.value = 'idle'
  feedback.value = ''
}
watch(() => [props.identity, props.text, props.source, props.context.origin, props.blockAnchor, props.disabled], invalidate, { deep: true, flush: 'sync' })

const copy = async (): Promise<void> => {
  if (props.disabled || !props.source || !props.text.trim()) return
  // Each deliberate activation replaces feedback/sweep; old async results cannot
  // label another source, revision, selected snippet or authorization epoch copied.
  invalidate()
  const operation = generation
  const identity = props.identity
  const input = {
    text: props.text,
    source: props.source,
    context: { origin: props.context.origin },
    blockAnchor: props.blockAnchor
  }
  state.value = 'copying'
  const current = (): boolean => !disposed && generation === operation && Boolean(root.value?.isConnected)
  let receipt: Awaited<ReturnType<typeof copyCitedSnippet>>
  try {
    receipt = await copyCitedSnippet(input)
  } catch (error) {
    if (!current()) return
    const reason = error instanceof CitedCopyError ? error.code : 'clipboard-failed'
    state.value = 'failed'
    feedback.value = t(reason === 'invalid-text' ? 'invalidText' : reason === 'invalid-source' ? 'invalidSource' : 'failed')
    emit('failed', reason)
    return
  }
  if (!current()) return
  state.value = 'copied'
  feedback.value = t('copied')
  sweep()
  receiptTimer = window.setTimeout(invalidate, 5000)
  emit('copied', { identity, citationHref: receipt.citationHref })
}
onBeforeUnmount(() => { disposed = true; invalidate() })
</script>

<style scoped lang="scss">
.cited-copy-action {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: .25rem .5rem;
  max-width: 100%;

  &__button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: .375rem;
    min-width: 44px;
    min-height: 44px;
    padding: .375rem .625rem;
    border: 1px solid currentColor;
    border-radius: .5rem;
    color: rgb(var(--v-theme-on-surface));
    background: rgb(var(--v-theme-surface));
    font: inherit;
    font-size: .8125rem;
    cursor: pointer;

    &:focus-visible {
      outline: 2px solid rgb(var(--v-theme-primary));
      outline-offset: 3px;
    }

    &:disabled { cursor: not-allowed; opacity: .5; }
  }

  &__hint {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  &__receipt {
    font-size: .8125rem;
    overflow-wrap: anywhere;
  }
}

@media (hover: hover) and (pointer: fine) {
  .wiki-cited-copy-owner:not(:hover):not(:focus-within) .cited-copy-action[data-copy-state='idle'] .cited-copy-action__button {
    opacity: 0;
  }
}
</style>
