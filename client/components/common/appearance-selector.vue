<template lang='pug'>
section.appearance-selector(:aria-busy='saving ? `true` : `false`')
  .appearance-selector__heading
    .text-label-large {{ props.label }}
    .text-body-small.text-medium-emphasis(:id='descriptionId') {{ props.description }}
  v-btn-toggle(
    :model-value='selectedAppearance'
    class='appearance-selector__options'
    role='group'
    mandatory
    divided
    density='compact'
    variant='outlined'
    :disabled='saving'
    :aria-label='props.label'
    :aria-describedby='descriptionId'
    @update:model-value='selectAppearance'
  )
    v-btn(
      v-for='option in appearanceOptions'
      :key='option.value'
      :value='option.value'
      :aria-pressed='selectedAppearance === option.value'
    )
      v-icon(start, size='18') {{ option.icon }}
      span {{ option.label }}
  v-progress-linear(
    v-if='saving'
    indeterminate
    color='primary'
    height='2'
    class='appearance-selector__progress'
    aria-label='Saving appearance preference'
  )
  .appearance-selector__status(
    role='status'
    aria-live='polite'
    aria-atomic='true'
  ) {{ statusMessage }}
</template>

<script setup lang='ts'>
import { computed, ref, useId } from 'vue'
import Cookies from 'js-cookie'
import { useTheme } from 'vuetify'
import { wikiStore } from '@/store/index.ts'
import { updateProfilePreferences } from '../../helpers/users-api.ts'
import { resolveThemeName, type WikiThemeName } from '../../helpers/theme.ts'

/* global siteConfig */

type Appearance = Extract<WikiThemeName, 'system' | 'light' | 'dark'>

type AppearanceOption = {
  value: Appearance
  label: string
  icon: string
}

const props = withDefaults(defineProps<{
  label?: string
  description?: string
}>(), {
  label: 'Appearance',
  description: 'System follows your device until Light or Dark is chosen.'
})

const theme = useTheme()
const selectedAppearance = computed<Appearance>(() => normalizeAppearance(wikiStore.user.appearance))
const saving = computed(() => (wikiStore.loadingCounts['profile-preferences-save'] ?? 0) > 0)
const descriptionId = useId()
const statusMessage = ref('')
const appearanceOptions: readonly AppearanceOption[] = [
  { value: 'system', label: 'System', icon: 'mdi-theme-light-dark' },
  { value: 'light', label: 'Light', icon: 'mdi-white-balance-sunny' },
  { value: 'dark', label: 'Dark', icon: 'mdi-weather-night' }
]

function normalizeAppearance(value: string | null | undefined): Appearance {
  return resolveThemeName(value, siteConfig.darkMode)
}

async function selectAppearance (next: Appearance): Promise<void> {
  if (saving.value || next === selectedAppearance.value) return
  const selectedOption = appearanceOptions.find(option => option.value === next)
  if (!selectedOption) return

  statusMessage.value = `Saving ${selectedOption.label.toLowerCase()} appearance.`

  const previousAppearance = selectedAppearance.value
  const previousStoreAppearance = wikiStore.user.appearance
  wikiStore.startLoading('profile-preferences-save')

  try {
    wikiStore.user.appearance = next
    await theme.change(next, false)
    const token = await updateProfilePreferences(
      window.fetch.bind(window),
      { appearance: next },
      'Appearance update failed'
    )
    Cookies.set('jwt', token, { expires: 365, secure: window.location.protocol === 'https:' })
    wikiStore.refreshAuth()
    const effectiveAppearance = normalizeAppearance(wikiStore.user.appearance)
    await theme.change(effectiveAppearance, false)
    statusMessage.value = `${selectedOption.label} appearance saved.`
  } catch (error) {
    wikiStore.user.appearance = previousStoreAppearance
    await theme.change(resolveThemeName(previousAppearance, siteConfig.darkMode), false)
    statusMessage.value = 'Appearance could not be saved. The previous setting was restored.'
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

  &__options {
    width: 100%;

    :deep(.v-btn) {
      flex: 1 1 0;
      min-width: 0;
      padding-inline: var(--wiki-space-2);
      text-transform: none;
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
