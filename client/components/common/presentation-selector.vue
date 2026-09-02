<template lang='pug'>
section.presentation-selector(:aria-busy='saving ? `true` : `false`')
  fieldset.presentation-selector__group(:disabled='saving' :aria-describedby='fontDescriptionId')
    legend.presentation-selector__legend Typeface
    p.presentation-selector__description.text-body-small.text-medium-emphasis(:id='fontDescriptionId') Choose the reading voice used throughout the wiki.
    .presentation-selector__typefaces
      .presentation-selector__option(v-for='option in fontOptions' :key='option.value')
        input.presentation-selector__radio(
          type='radio'
          name='wiki-font-family'
          :id='fontOptionId(option.value)'
          :value='option.value'
          :checked='selectedFontFamily === option.value'
          :aria-describedby='fontDescriptionId'
          @change='selectFontFamily(option.value)'
        )
        label.presentation-selector__card.presentation-selector__card--typeface(:for='fontOptionId(option.value)')
          span.presentation-selector__specimen(:class='`presentation-selector__specimen--${option.value}`' aria-hidden='true') Ag
          span.presentation-selector__copy
            strong.presentation-selector__name(:class='`presentation-selector__name--${option.value}`') {{ option.label }}
            span.presentation-selector__note {{ option.description }}
          span.presentation-selector__selected(v-if='selectedFontFamily === option.value' aria-hidden='true') Selected

  fieldset.presentation-selector__group(:disabled='saving' :aria-describedby='gutterDescriptionId')
    legend.presentation-selector__legend Reading gutter
    p.presentation-selector__description.text-body-small.text-medium-emphasis(:id='gutterDescriptionId') Choose the study marks framing article pages.
    .presentation-selector__gutters
      .presentation-selector__option(v-for='option in gutterOptions' :key='option.value')
        input.presentation-selector__radio(
          type='radio'
          name='wiki-reading-gutter'
          :id='gutterOptionId(option.value)'
          :value='option.value'
          :checked='selectedReadingGutter === option.value'
          :aria-describedby='gutterDescriptionId'
          @change='selectReadingGutter(option.value)'
        )
        label.presentation-selector__card(:for='gutterOptionId(option.value)')
          span.presentation-selector__copy
            strong.presentation-selector__name {{ option.label }}
            span.presentation-selector__note {{ option.description }}
          span.presentation-selector__selected(v-if='selectedReadingGutter === option.value' aria-hidden='true') Selected

  v-progress-linear.presentation-selector__progress(
    v-if='saving'
    indeterminate
    color='primary'
    height='2'
    aria-label='Saving presentation preference'
  )
  .presentation-selector__status(role='status' aria-live='polite' aria-atomic='true') {{ statusMessage }}
</template>

<script setup lang='ts'>
import { computed, ref, useId } from 'vue'
import Cookies from 'js-cookie'
import { wikiStore } from '@/store/index.ts'
import { updateProfilePreferences } from '../../helpers/users-api.ts'
import { normalizePageGutterStyle, type PageGutterStyle } from '../../../shared/page-gutters.ts'
import {
  isAdminCustomGutterAvailable,
  normalizeUserFontFamily,
  normalizeUserReadingGutter,
  type ProfilePreferencesInput,
  type UserFontFamily,
  type UserReadingGutter
} from '../../../shared/user-presentation.ts'

type FontOption = {
  value: UserFontFamily
  label: string
  description: string
}

type GutterOption = {
  value: UserReadingGutter
  label: string
  description: string
}

const PREFERENCE_LOADING_KEY = 'profile-preferences-save'
const fontDescriptionId = useId()
const gutterDescriptionId = useId()
const fontGroupId = useId()
const gutterGroupId = useId()
const statusMessage = ref('')

const fontOptions: readonly FontOption[] = [
  { value: 'newsreader', label: 'Newsreader', description: 'An editorial serif for long-form reading.' },
  { value: 'roboto-flex', label: 'Roboto Flex', description: 'A precise sans serif with an open rhythm.' }
]

const GUTTER_LABELS: Readonly<Record<PageGutterStyle, string>> = {
  columns: 'Attic columns',
  orbits: 'Celestial orbits',
  laurel: 'Laurel cadence',
  aurora: 'Aurora wash',
  none: 'Unadorned',
  custom: 'Custom study'
}

const presetGutterOptions: readonly GutterOption[] = [
  { value: 'columns', label: 'Attic columns', description: 'Measured editorial rules.' },
  { value: 'orbits', label: 'Celestial orbits', description: 'Concentric study marks.' },
  { value: 'laurel', label: 'Laurel cadence', description: 'A restrained botanical frame.' },
  { value: 'aurora', label: 'Aurora wash', description: 'Soft bands at the page edge.' },
  { value: 'none', label: 'Unadorned', description: 'An unadorned reading canvas.' },
  { value: 'custom', label: 'Custom study', description: 'The study composed by this site.' }
]

const saving = computed(() => (wikiStore.loadingCounts[PREFERENCE_LOADING_KEY] ?? 0) > 0)
const selectedFontFamily = computed<UserFontFamily>(() => normalizeUserFontFamily(wikiStore.user.fontFamily))
const customGutterAvailable = computed(() => isAdminCustomGutterAvailable(wikiStore.site.gutterCustomCss))
const siteGutter = computed<PageGutterStyle>(() => normalizePageGutterStyle(wikiStore.site.gutterStyle))
const selectedReadingGutter = computed<UserReadingGutter>(() => {
  const selected = normalizeUserReadingGutter(wikiStore.user.readingGutter)
  return selected === 'custom' && !customGutterAvailable.value ? 'site' : selected
})
const gutterOptions = computed<readonly GutterOption[]>(() => [
  {
    value: 'site',
    label: 'Site default',
    description: `Currently ${GUTTER_LABELS[siteGutter.value]}.`
  },
  ...presetGutterOptions.filter(option => option.value !== 'custom' || customGutterAvailable.value)
])

const fontOptionId = (value: UserFontFamily): string => `${fontGroupId}-${value}`
const gutterOptionId = (value: UserReadingGutter): string => `${gutterGroupId}-${value}`

function replaceSessionToken (token: string): void {
  Cookies.set('jwt', token, { expires: 365, secure: window.location.protocol === 'https:' })
  wikiStore.refreshAuth()
}

async function savePreference (input: ProfilePreferencesInput): Promise<string> {
  return updateProfilePreferences(
    window.fetch.bind(window),
    input,
    'Presentation preference update failed'
  )
}

async function selectFontFamily (next: UserFontFamily): Promise<void> {
  if (saving.value || next === selectedFontFamily.value) return
  const option = fontOptions.find(candidate => candidate.value === next)
  if (!option) return

  const previousFontFamily = wikiStore.user.fontFamily
  statusMessage.value = `Saving ${option.label} typeface.`
  wikiStore.startLoading(PREFERENCE_LOADING_KEY)

  try {
    wikiStore.user.fontFamily = next
    replaceSessionToken(await savePreference({ fontFamily: next }))
    statusMessage.value = `${option.label} typeface saved.`
  } catch (error) {
    wikiStore.user.fontFamily = previousFontFamily
    statusMessage.value = 'Typeface could not be saved. The previous setting was restored.'
    wikiStore.showError(error)
  } finally {
    wikiStore.stopLoading(PREFERENCE_LOADING_KEY)
  }
}

async function selectReadingGutter (next: UserReadingGutter): Promise<void> {
  if (saving.value || next === selectedReadingGutter.value) return
  const option = gutterOptions.value.find(candidate => candidate.value === next)
  if (!option) return

  const previousReadingGutter = wikiStore.user.readingGutter
  statusMessage.value = `Saving ${option.label.toLowerCase()} reading gutter.`
  wikiStore.startLoading(PREFERENCE_LOADING_KEY)

  try {
    wikiStore.user.readingGutter = next
    replaceSessionToken(await savePreference({ readingGutter: next }))
    statusMessage.value = `${option.label} reading gutter saved.`
  } catch (error) {
    wikiStore.user.readingGutter = previousReadingGutter
    statusMessage.value = 'Reading gutter could not be saved. The previous setting was restored.'
    wikiStore.showError(error)
  } finally {
    wikiStore.stopLoading(PREFERENCE_LOADING_KEY)
  }
}
</script>

<style lang='scss' scoped>
.presentation-selector {
  display: grid;
  min-width: 0;
  gap: var(--wiki-space-4);
}

.presentation-selector__group {
  min-width: 0;
  padding: 0;
  margin: 0;
  border: 0;
}

.presentation-selector__legend {
  padding: 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .075em;
  text-transform: uppercase;
}

.presentation-selector__description {
  margin-block: var(--wiki-space-1) var(--wiki-space-2);
  line-height: 1.45;
}

.presentation-selector__typefaces,
.presentation-selector__gutters {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--wiki-space-2);
}

.presentation-selector__option {
  position: relative;
  min-width: 0;
}

.presentation-selector__radio {
  position: absolute;
  z-index: 1;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  cursor: pointer;
  opacity: 0;
}

.presentation-selector__card {
  display: flex;
  min-height: var(--wiki-space-12);
  align-items: flex-start;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-inset);
  color: rgb(var(--v-theme-on-surface));
  transition:
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    box-shadow var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.presentation-selector__card--typeface {
  align-items: center;
}

.presentation-selector__specimen {
  display: grid;
  width: var(--wiki-space-10);
  height: var(--wiki-space-10);
  flex: 0 0 var(--wiki-space-10);
  place-items: center;
  border-inline-end: 1px solid var(--wiki-surface-border);
  color: var(--wiki-accent-ink);
  font-size: var(--wiki-space-5);
  line-height: 1;
}

.presentation-selector__specimen--newsreader,
.presentation-selector__name--newsreader {
  font-family: var(--wiki-font-newsreader);
}

.presentation-selector__specimen--roboto-flex,
.presentation-selector__name--roboto-flex {
  font-family: var(--wiki-font-roboto-flex);
}

.presentation-selector__copy {
  display: grid;
  min-width: 0;
  flex: 1 1 auto;
  gap: var(--wiki-space-1);
}

.presentation-selector__name,
.presentation-selector__note {
  display: block;
}

.presentation-selector__name {
  font-size: .8125rem;
  font-weight: 680;
  line-height: 1.2;
}

.presentation-selector__note {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
  font-size: var(--wiki-label-size);
  line-height: 1.35;
}

.presentation-selector__selected {
  align-self: flex-start;
  color: var(--wiki-accent-ink);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .04em;
}

.presentation-selector__radio:hover + .presentation-selector__card {
  border-color: color-mix(in srgb, var(--wiki-ambient-accent) 32%, var(--wiki-surface-border));
  background: color-mix(in srgb, var(--wiki-ambient-accent) 5%, var(--wiki-surface-raised));
}

.presentation-selector__radio:checked + .presentation-selector__card {
  border-color: color-mix(in srgb, var(--wiki-accent-spectral) 54%, var(--wiki-surface-border));
  background: color-mix(in srgb, var(--wiki-accent-spectral) 9%, var(--wiki-surface-raised));
  box-shadow: var(--wiki-shadow-inset), inset var(--wiki-space-1) 0 0 var(--wiki-accent-spectral);
}

.presentation-selector__radio:focus-visible + .presentation-selector__card {
  outline: var(--wiki-focus-offset) solid var(--wiki-focus-color);
  outline-offset: var(--wiki-space-1);
}

.presentation-selector__radio:disabled {
  cursor: default;
}

.presentation-selector__group:disabled .presentation-selector__card {
  opacity: .56;
}

.presentation-selector__progress {
  margin-block-start: calc(var(--wiki-space-2) * -1);
}

.presentation-selector__status {
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

@media (max-width: 399.98px) {
  .presentation-selector__typefaces,
  .presentation-selector__gutters {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (forced-colors: active) {
  .presentation-selector__card,
  .presentation-selector__radio:checked + .presentation-selector__card {
    border-color: CanvasText;
  }

  .presentation-selector__radio:checked + .presentation-selector__card {
    outline: 1px solid Highlight;
  }
}

@media (prefers-reduced-motion: reduce) {
  .presentation-selector__card {
    transition-duration: .01ms;
  }
}
</style>
