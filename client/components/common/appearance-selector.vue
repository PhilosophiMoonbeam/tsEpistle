<template lang='pug'>
section.appearance-selector(:aria-busy='saving ? `true` : `false`')
  .text-label-large(:id='labelId') {{ label }}
  .appearance-selector__segments(
    ref='segments'
    role='radiogroup'
    :aria-labelledby='labelId'
    :aria-disabled='selectionDisabled'
  )
    button.appearance-selector__segment(
      v-for='(option, index) in appearanceOptions'
      :key='option.value'
      type='button'
      role='radio'
      :data-appearance='option.value'
      :aria-checked='selectedAppearance === option.value'
      :aria-disabled='selectionDisabled'
      :tabindex='selectedAppearance === option.value ? 0 : -1'
      @click='selectAppearance(option.value)'
      @keydown='onSegmentKeydown($event, index)'
    )
      v-icon(size='18', aria-hidden='true') {{ option.icon }}
      span {{ $t(`common:appearanceSelector.${option.value}`) }}
  v-progress-linear(
    v-if='saving'
    indeterminate
    color='primary'
    height='2'
    class='appearance-selector__progress'
    :aria-label='$t(`common:appearanceSelector.savingAppearancePreference`)'
  )
  .appearance-selector__status(
    role='status'
    aria-live='polite'
    aria-atomic='true'
  ) {{ statusMessage }}
</template>

<script setup lang='ts'>
import { computed, ref, useId, useTemplateRef, watch } from 'vue'
import { useTheme } from 'vuetify'
import { wikiStore } from '@/store/index.ts'
import { updateProfilePreferences } from '../../helpers/users-api.ts'
import { resolveThemeName, type WikiThemeName } from '../../helpers/theme.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()

/* global siteConfig */

type Appearance = Extract<WikiThemeName, 'system' | 'light' | 'dark'>

const props = defineProps<{
  // biome-ignore lint/correctness/noVueDuplicateKeys: Script-setup label computes a reactive fallback from props.label; it is not a duplicate Options API key.
  label?: string
}>()
const label = computed(() => props.label ?? t('common:appearanceSelector.appearance'))
const appearanceOptions = [
  { value: 'light', icon: 'mdi-white-balance-sunny' },
  { value: 'dark', icon: 'mdi-weather-night' },
  { value: 'system', icon: 'mdi-monitor' }
] as const

const theme = useTheme()
const selectedAppearance = computed<Appearance>(() => normalizeAppearance(wikiStore.user.appearance))
const saving = computed(() => (wikiStore.loadingCounts['profile-preferences-save'] ?? 0) > 0)
const selectionDisabled = computed(() => saving.value || wikiStore.authRefreshPending || wikiStore.authRefreshOutcome !== 'authenticated' || !wikiStore.user.authenticated)
const labelId = useId()
const segments = useTemplateRef<HTMLElement>('segments')
const statusMessage = ref('')
let identityGeneration = 0

watch(
  [
    () => wikiStore.user.id,
    () => wikiStore.user.authenticated,
    () => wikiStore.user.authVersion,
    () => wikiStore.offlineIdentityEpoch
  ],
  () => {
    identityGeneration++
    statusMessage.value = ''
    void theme.change(normalizeAppearance(wikiStore.user.appearance), false)
  },
  { flush: 'sync' }
)

function normalizeAppearance (value: string | null | undefined): Appearance {
  return resolveThemeName(value, siteConfig.darkMode)
}

function onSegmentKeydown (event: KeyboardEvent, index: number): void {
  let nextIndex: number
  switch (event.key) {
    case 'ArrowRight':
      nextIndex = (index + (siteConfig.rtl ? 2 : 1)) % appearanceOptions.length
      break
    case 'ArrowLeft':
      nextIndex = (index + (siteConfig.rtl ? 1 : 2)) % appearanceOptions.length
      break
    case 'ArrowDown':
      nextIndex = (index + 1) % appearanceOptions.length
      break
    case 'ArrowUp':
      nextIndex = (index + appearanceOptions.length - 1) % appearanceOptions.length
      break
    case 'Home':
      nextIndex = 0
      break
    case 'End':
      nextIndex = appearanceOptions.length - 1
      break
    default:
      return
  }
  event.preventDefault()
  if (selectionDisabled.value) return
  const next = appearanceOptions[nextIndex]
  if (!next) return
  segments.value?.querySelector<HTMLButtonElement>(`[data-appearance="${next.value}"]`)?.focus()
  void selectAppearance(next.value)
}

async function selectAppearance (next: Appearance): Promise<void> {
  if (selectionDisabled.value || next === wikiStore.user.appearance) return
  const accountId = wikiStore.user.id
  const identityEpoch = wikiStore.offlineIdentityEpoch
  const authVersion = wikiStore.user.authVersion
  const generation = identityGeneration
  const isCurrentAccount = (): boolean => wikiStore.user.authenticated &&
    wikiStore.user.id === accountId &&
    wikiStore.user.authVersion === authVersion &&
    wikiStore.offlineIdentityEpoch === identityEpoch &&
    identityGeneration === generation
  const nextLabel = t(`common:appearanceSelector.${next}`)
  const previousAppearance = selectedAppearance.value
  const previousStoreAppearance = wikiStore.user.appearance
  let preferenceSaved = false

  statusMessage.value = t('common:appearanceSelector.savingAppearance', { nextEffective: nextLabel, interpolation: { escapeValue: false } })
  wikiStore.startLoading('profile-preferences-save')

  try {
    wikiStore.user.appearance = next
    await theme.change(next, false)
    if (!isCurrentAccount()) return
    await updateProfilePreferences(
      window.fetch.bind(window),
      accountId,
      { appearance: next },
      t('common:appearanceSelector.appearanceUpdateFailed')
    )
    if (!isCurrentAccount()) return
    preferenceSaved = true
    const outcome = await wikiStore.refreshAuth()
    if (!isCurrentAccount()) return
    if (outcome !== 'authenticated' || wikiStore.user.appearance !== next) {
      throw new Error(t('common:appearanceSelector.appearanceConfirmationFailed'))
    }
    await theme.change(next, false)
    if (!isCurrentAccount()) return
    statusMessage.value = t('common:appearanceSelector.appearanceSaved', { nextEffective: nextLabel, interpolation: { escapeValue: false } })
  } catch (error) {
    if (!isCurrentAccount()) return
    wikiStore.user.appearance = previousStoreAppearance
    await theme.change(previousAppearance, false)
    if (!isCurrentAccount()) return
    statusMessage.value = t(preferenceSaved
      ? 'common:appearanceSelector.appearanceCouldNotConfirmed'
      : 'common:appearanceSelector.appearanceCouldNotSaved')
    wikiStore.showError(error)
  } finally {
    wikiStore.stopLoading('profile-preferences-save')
  }
}
</script>

<style lang='scss' scoped>
.appearance-selector {
  display: grid;
  gap: var(--wiki-space-2);
  min-width: 0;

  &__segments {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 2px;
    padding: 3px;
    border: 1px solid rgba(var(--v-theme-on-surface), .24);
    border-radius: 999px;
    background: rgb(var(--v-theme-surface-variant));
  }

  &__segment {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: var(--wiki-space-1);
    min-width: 0;
    min-height: 44px;
    padding: var(--wiki-space-2);
    border: 1px solid transparent;
    border-radius: 999px;
    color: rgb(var(--v-theme-on-surface));
    font: inherit;
    font-size: .875rem;
    line-height: 1.25;
    overflow-wrap: anywhere;
    cursor: pointer;

    &[aria-checked='true'] {
      border-color: currentColor;
      background: rgb(var(--v-theme-primary));
      color: rgb(var(--v-theme-on-primary));
      font-weight: 700;
    }

    &:focus-visible {
      outline: 2px solid rgb(var(--v-theme-focus));
      outline-offset: 2px;
    }

    &[aria-disabled='true'] {
      cursor: default;
      opacity: .65;
    }
  }

  &__status {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  &__progress {
    margin-top: -2px;
  }
}
</style>
