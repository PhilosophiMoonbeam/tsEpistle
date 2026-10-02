<template lang='pug'>
section.appearance-selector(:aria-busy='saving ? `true` : `false`')
  .appearance-selector__heading
    .text-label-large {{ label }}
    .text-body-small.text-medium-emphasis(:id='descriptionId') {{ description }}
  v-btn.appearance-selector__toggle(
    block
    density='comfortable'
    variant='outlined'
    color='primary'
    :disabled='saving'
    :aria-label='toggleAriaLabel'
    :aria-describedby='descriptionId'
    :aria-pressed='selectedAppearance !== `system`'
    @click='toggleAppearance'
  )
    v-icon(start, size='18') {{ effectiveTheme === `dark` ? `mdi-weather-night` : `mdi-white-balance-sunny` }}
    span.appearance-selector__toggle-label {{ effectiveTheme === `dark` ? $t(`common:appearanceSelector.dark`) : $t(`common:appearanceSelector.light`) }}
    span.appearance-selector__toggle-note {{ selectedAppearance === `system` ? $t(`common:appearanceSelector.followsDevice`) : $t(`common:appearanceSelector.override`) }}
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
import { computed, ref, useId } from 'vue'
import { useTheme } from 'vuetify'
import { wikiStore } from '@/store/index.ts'
import { updateProfilePreferences } from '../../helpers/users-api.ts'
import { resolveThemeName, type WikiThemeName } from '../../helpers/theme.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()

/* global siteConfig */

type Appearance = Extract<WikiThemeName, 'system' | 'light' | 'dark'>

const {
  label = t('common:appearanceSelector.appearance'),
  description = t('common:appearanceSelector.oneToggleShowsCurrent')
} = defineProps<{
  label?: string
  description?: string
}>()

const theme = useTheme()
const selectedAppearance = computed<Appearance>(() => normalizeAppearance(wikiStore.user.appearance))
const effectiveTheme = computed<'light' | 'dark'>(() => theme.name.value === 'dark' ? 'dark' : 'light')
const saving = computed(() => (wikiStore.loadingCounts['profile-preferences-save'] ?? 0) > 0)
const descriptionId = useId()
const statusMessage = ref('')

const systemPrefersDark = (): boolean => {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

const toggleAriaLabel = computed(() => {
  const next = effectiveTheme.value === 'dark' ? 'light' : 'dark'
  const system = systemPrefersDark() ? 'dark' : 'light'
  const restore = next === system ? ` ${t('common:appearanceSelector.returnsYouDevicePreference')}` : ''
  return t('common:appearanceSelector.switchTheme', { next, restore, interpolation: { escapeValue: false } })
})

function normalizeAppearance (value: string | null | undefined): Appearance {
  return resolveThemeName(value, siteConfig.darkMode)
}

async function toggleAppearance (): Promise<void> {
  if (saving.value) return
  const nextEffective: Appearance = effectiveTheme.value === 'dark' ? 'light' : 'dark'
  // When the requested theme already matches the device preference, keep the
  // stored value on `system` so the profile keeps tracking device changes.
  const next: Appearance = nextEffective === (systemPrefersDark() ? 'dark' : 'light')
    ? 'system'
    : nextEffective
  const nextLabel = nextEffective === 'dark' ? t('common:appearanceSelector.dark') : t('common:appearanceSelector.light')

  statusMessage.value = t('common:appearanceSelector.savingAppearance', { nextEffective: nextEffective.toLowerCase(), interpolation: { escapeValue: false } })

  const previousAppearance = selectedAppearance.value
  const previousStoreAppearance = wikiStore.user.appearance
  wikiStore.startLoading('profile-preferences-save')

  try {
    wikiStore.user.appearance = next
    await theme.change(next, false)
    await updateProfilePreferences(
      window.fetch.bind(window),
      { appearance: next },
      t('common:appearanceSelector.appearanceUpdateFailed')
    )
    await wikiStore.refreshAuth()
    const effectiveAppearance = normalizeAppearance(wikiStore.user.appearance)
    await theme.change(effectiveAppearance, false)
    statusMessage.value = t('common:appearanceSelector.appearanceSaved', { nextEffective, interpolation: { escapeValue: false } })
  } catch (error) {
    wikiStore.user.appearance = previousStoreAppearance
    await theme.change(resolveThemeName(previousAppearance, siteConfig.darkMode), false)
    statusMessage.value = t('common:appearanceSelector.appearanceCouldNotSaved')
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

  &__heading {
    display: grid;
    gap: 2px;
  }

  &__toggle {
    text-transform: none;

    .appearance-selector__toggle-note {
      color: rgb(var(--v-theme-on-surface-variant));
      font-size: .8125rem;
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
