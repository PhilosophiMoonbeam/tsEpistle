<template lang="pug">
v-container.admin-theme(fluid)
  AdminHero(
    :title='$t(`admin:theme.title`)'
    :description='$t(`admin:theme.subtitle`)'
    icon='/_assets/svg/icon-paint-palette.svg'
    eyebrow='Interface presentation'
    heading-id='admin-theme-title'
  )
    template(#status)
      v-chip(
        :color='!loaded && !initialLoading ? `error` : dirty ? `warning` : loaded ? `success` : undefined'
        variant='tonal'
        size='small'
        :prepend-icon='initialLoading ? `mdi-progress-clock` : !loaded ? `mdi-alert-circle-outline` : dirty ? `mdi-circle-edit-outline` : `mdi-check-circle-outline`'
      ) {{ initialLoading ? 'Loading theme' : !loaded ? 'Theme status unavailable' : dirty ? 'Unsaved changes' : 'Theme up to date' }}
    template(#actions)
      v-btn(
        color='success'
        variant='flat'
        :loading='saving'
        :disabled='!loaded || initialLoading || saving || !dirty || !configValid'
        @click='save'
      )
        v-icon(start) mdi-check
        span {{ $t('common:actions.apply') }}

  v-form#theme-form.pt-3(
    @submit.prevent='save'
    :disabled='initialLoading || !loaded || saving'
  )
    v-row
      v-col(cols='12', lg='4')
        v-card.animated.fadeInUp
          v-toolbar(color='primary', density='compact')
            v-icon.ml-4 mdi-theme-light-dark
            v-toolbar-title.text-body-large Appearance
          v-card-text
            .theme-shell-summary
              .theme-shell-summary__mark
                v-icon mdi-archive-outline
              div
                .text-label-large Luminous Archive
                .text-body-small.text-medium-emphasis
                  | Interface shell · Create and manage independent color themes in the palette studio.
            v-select.mt-3(
              v-model='config.iconset'
              :items='iconsets'
              item-title='text'
              item-value='value'
              variant='outlined'
              prepend-inner-icon='mdi-shape-outline'
              :label='$t(`admin:theme.iconset`)'
              persistent-hint
              :hint='$t(`admin:theme.iconsetHint`)'
            )
            v-divider.my-4
            appearance-selector
            v-select.mt-3(
              v-model='config.tocPosition'
              :items='tocPositions'
              item-title='text'
              item-value='value'
              variant='outlined'
              prepend-inner-icon='mdi-table-of-contents'
              label='Table of contents position'
              persistent-hint
              hint='Shown on wide screens; compact screens use the page navigation menu.'
            )

      v-col(cols='12', lg='8')
        v-card.animated.fadeInUp.wait-p1s
          v-toolbar(color='primary', density='compact')
            v-icon.ml-4 mdi-format-color-fill
            v-toolbar-title.text-body-large Color themes
            v-chip.mr-2(size='small', variant='tonal') {{ config.palettes.length }}
            v-btn.mr-2(
              size='small'
              variant='tonal'
              prepend-icon='mdi-plus'
              :disabled='config.palettes.length >= MAX_THEME_PALETTES'
              @click='createPalette'
            ) New theme
          v-card-text
            .theme-library
              v-select.theme-library__select(
                v-model='config.activePaletteId'
                :items='paletteOptions'
                item-title='title'
                item-value='value'
                label='Active color theme'
                prepend-inner-icon='mdi-palette-swatch-outline'
                hide-details
              )
              v-text-field.theme-library__name(
                v-model='activePalette.name'
                label='Theme name'
                prepend-inner-icon='mdi-form-textbox'
                :rules='paletteNameRules'
                maxlength='80'
                hide-details='auto'
              )
              v-btn.theme-library__delete(
                variant='outlined'
                color='error'
                prepend-icon='mdi-delete-outline'
                :disabled='config.palettes.length <= 1'
                @click='deletePaletteDialog = true'
              ) Delete

            .theme-mode-bar.mt-5
              .theme-mode-bar__copy
                .text-label-large {{ activePalette.name }}
                .text-body-small.text-medium-emphasis
                  | Edit semantic colors for {{ previewMode }} mode. Readable foregrounds are generated automatically.
              v-btn-toggle(
                v-model='previewMode'
                mandatory
                density='compact'
                variant='outlined'
                divided
                aria-label='Palette mode'
              )
                v-btn(value='light', aria-label='Edit light palette')
                  v-icon(start) mdi-white-balance-sunny
                  span.d-none.d-sm-inline Light
                v-btn(value='dark', aria-label='Edit dark palette')
                  v-icon(start) mdi-weather-night
                  span.d-none.d-sm-inline Dark

            .d-flex.flex-wrap.align-center.ga-2.my-4
              v-btn(
                size='small'
                variant='text'
                prepend-icon='mdi-restore'
                :disabled='!dirty || initialLoading'
                @click='restoreSaved'
              ) Restore saved
              v-btn(
                size='small'
                variant='text'
                prepend-icon='mdi-backup-restore'
                :disabled='initialLoading || saving'
                @click='resetActivePalette'
              ) Reset {{ previewMode }}
              v-btn(
                size='small'
                variant='text'
                prepend-icon='mdi-palette-outline'
                :disabled='initialLoading || saving'
                @click='resetActiveTheme'
              ) Reset theme

            .theme-palette-grid
              theme-color-field(
                v-for='field in paletteFields'
                :key='`${config.activePaletteId}:${previewMode}:${field.key}`'
                v-model='activePalette.colors[previewMode][field.key]'
                :label='field.label'
              )
            v-divider.my-5
            .text-label-large.mb-2 Live preview
            v-theme-provider(:theme='previewMode', with-background)
              .theme-preview
                .theme-preview__heading
                  div
                    .text-title-medium Knowledge that feels at home
                    .text-body-small.text-medium-emphasis Palette preview · {{ previewMode }} mode
                  v-chip(color='secondary', variant='tonal', size='small') Updated
                .text-body-medium.mt-3
                  | Primary actions, status colors, surfaces, and readable foregrounds update as you edit.
                .d-flex.flex-wrap.ga-2.mt-4
                  v-btn(color='primary', variant='flat') Primary action
                  v-btn(color='secondary', variant='tonal') Secondary
                  v-btn(color='accent', variant='outlined') Accent
                .theme-preview__statuses.mt-4
                  v-chip(color='info', variant='tonal', size='small') Info
                  v-chip(color='success', variant='tonal', size='small') Success
                  v-chip(color='warning', variant='tonal', size='small') Warning
                  v-chip(color='error', variant='tonal', size='small') Error

      v-col(cols='12')
        v-card.animated.fadeInUp.wait-p2s
          v-toolbar(color='primary', density='compact')
            v-icon.ml-4 mdi-pillar
            v-toolbar-title.text-body-large Reading gutters
            v-chip.mr-3(size='small', color='secondary', variant='tonal') Wide screens
          v-card-text
            .gutter-section-heading
              div
                .text-title-medium Marginalia for the reading surface
                .text-body-medium.text-medium-emphasis.mt-1
                  | Choose a restrained ornament for the open space to the right of article text. Decorations recede automatically when the reading gutter narrows.
              v-chip(size='small', variant='outlined', color='primary') Article pages only
            .gutter-style-grid.mt-5(role='group', aria-label='Reading gutter ornament')
              button.gutter-style-option(
                v-for='option in gutterStyles'
                :key='option.value'
                type='button'
                :aria-pressed='config.gutterStyle === option.value'
                :class='{ "is-selected": config.gutterStyle === option.value }'
                :disabled='initialLoading || !loaded || saving'
                @click='config.gutterStyle = option.value'
              )
                .gutter-style-option__canvas
                  .gutter-style-option__paper
                    span
                    span
                    span
                    span
                  .wiki-gutter-art.gutter-style-option__art.gutter-style-option__art--right(
                    :class='`wiki-gutter-art--${option.value}`'
                    :style='gutterPreviewStyle(option.value)'
                    aria-hidden='true'
                  )
                    page-gutter-column(v-if='option.value === `columns`')
                .gutter-style-option__label
                  span.text-label-large {{ option.title }}
                  v-icon(v-if='config.gutterStyle === option.value', color='primary', size='18') mdi-check-circle
                .text-body-small.text-medium-emphasis {{ option.description }}
            v-expand-transition
              .gutter-custom-editor.mt-5(v-if='config.gutterStyle === `custom`')
                v-textarea.is-monospaced(
                  v-model='config.gutterCustomCss'
                  label='Custom gutter CSS declarations'
                  variant='outlined'
                  color='primary'
                  persistent-hint
                  hint='Applied only to the right gutter ornament. Enter declarations without a selector, braces, or @-rules.'
                  placeholder='background: radial-gradient(circle, rgba(99, 102, 241, .16), transparent 68%); opacity: .7;'
                  :maxlength='PAGE_GUTTER_CUSTOM_CSS_MAX_LENGTH'
                  :counter='PAGE_GUTTER_CUSTOM_CSS_MAX_LENGTH'
                  :rules='gutterCustomCssRules'
                  auto-grow
                  rows='3'
                )
                .d-flex.flex-wrap.ga-2.mt-2
                  v-chip(size='small', variant='tonal') background
                  v-chip(size='small', variant='tonal') border
                  v-chip(size='small', variant='tonal') opacity
                  v-chip(size='small', variant='tonal') filter

      v-col(cols='12')
        v-card.animated.fadeInUp.wait-p2s
          v-toolbar(color='primary', density='compact')
            v-icon.ml-4 mdi-code-tags
            v-toolbar-title.text-body-large {{ $t('admin:theme.codeInjection') }}
          v-card-text
            v-row
              v-col(cols='12', lg='6')
                v-textarea.is-monospaced(
                  v-model='config.injectCSS'
                  :label='$t(`admin:theme.cssOverride`)'
                  variant='outlined'
                  color='primary'
                  persistent-hint
                  :hint='$t(`admin:theme.cssOverrideHint`)'
                  auto-grow
                )
                i18next.text-body-small.pl-2.ml-1(path='admin:theme.cssOverrideWarning', tag='div')
                  strong(place='caution' class='text-error') {{ $t('admin:theme.cssOverrideWarningCaution') }}
                  code(place='cssClass' class='text-error') .contents
              v-col(cols='12', lg='6')
                v-textarea.is-monospaced(
                  v-model='config.injectHead'
                  :label='$t(`admin:theme.headHtmlInjection`)'
                  variant='outlined'
                  color='primary'
                  persistent-hint
                  :hint='$t(`admin:theme.headHtmlInjectionHint`)'
                  auto-grow
                )
                v-textarea.is-monospaced.mt-2(
                  v-model='config.injectBody'
                  :label='$t(`admin:theme.bodyHtmlInjection`)'
                  variant='outlined'
                  color='primary'
                  persistent-hint
                  :hint='$t(`admin:theme.bodyHtmlInjectionHint`)'
                  auto-grow
                )
  .d-flex.flex-wrap.justify-end.ga-2.mt-5.sticky-action-row
    v-btn(
      type='submit'
      form='theme-form'
      color='success'
      variant='flat'
      size='large'
      :loading='saving'
      :disabled='!loaded || initialLoading || saving || !dirty || !configValid'
    )
      v-icon(start) mdi-check
      span {{ $t('common:actions.apply') }}
  v-dialog(v-model='deletePaletteDialog', max-width='520', aria-labelledby='delete-palette-title')
    v-card
      v-card-title#delete-palette-title Delete color theme?
      v-card-text
        | {{ activePalette.name }} will be removed. Pages immediately use the next available color theme after you apply changes.
      v-card-actions
        v-spacer
        v-btn(variant='text', @click='deletePaletteDialog = false') Cancel
        v-btn(color='error', variant='flat', prepend-icon='mdi-delete-outline', @click='deleteActivePalette') Delete theme
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useTheme } from 'vuetify'
import { wikiStore } from '@/store/index.ts'
import ThemeColorField from './theme-color-field.vue'
import AppearanceSelector from '../common/appearance-selector.vue'
import PageGutterColumn from '../common/page-gutter-column.vue'
import { fetchThemeConfig, saveThemeConfig, type ThemeConfig } from '../../helpers/theming-api.ts'
import { applyWikiThemeColors, resolveThemeName } from '../../helpers/theme.ts'
import { loadingStart, loadingStop, pushGraphError, showNotification } from '../../helpers/root-ui-store.ts'
import {
  PAGE_GUTTER_CUSTOM_CSS_MAX_LENGTH,
  PageGutterCustomCssSchema,
  type PageGutterStyle
} from '../../../shared/page-gutters.ts'
import { cloneThemeColors, DEFAULT_THEME_COLORS, isThemeColors, normalizeThemeColors, type ThemeColorKey } from '../../../shared/theme-colors.ts'
import {
  cloneThemePalettes,
  createDefaultThemePalette,
  MAX_THEME_PALETTES,
  normalizeThemePalettes,
  ThemePalettesSchema,
  type ThemePalette
} from '../../../shared/theme-palettes.ts'
type PaletteMode = 'light' | 'dark'

const createAbortableFetch = (signal: AbortSignal) => (
  input: RequestInfo | URL,
  init?: RequestInit
) => window.fetch(input, { ...init, signal })

const createConfig = (): ThemeConfig => {
  const colors = normalizeThemeColors(siteConfig.themeColors)
  const palettes = normalizeThemePalettes(undefined, colors)
  return {
    theme: 'default',
    iconset: 'mdi',
    darkMode: siteConfig.darkMode,
    colors,
    palettes,
    activePaletteId: palettes[0]?.id ?? 'luminous-archive',
    tocPosition: siteConfig.tocPosition,
    gutterStyle: siteConfig.gutterStyle,
    gutterCustomCss: siteConfig.gutterCustomCss,
    injectCSS: '',
    injectHead: '',
    injectBody: ''
  }
}

const theme = useTheme()
const config = reactive<ThemeConfig>(createConfig())
const persistedConfig = ref<ThemeConfig>(createConfig())
const previewMode = ref<PaletteMode>(theme.current.value?.dark ? 'dark' : 'light')
const initialLoading = ref(true)
const loaded = ref(false)
const saving = ref(false)
const deletePaletteDialog = ref(false)
let loadController: AbortController | null = null
let saveController: AbortController | null = null
let isUnmounted = false
const activePalette = computed<ThemePalette>(() =>
  config.palettes.find(palette => palette.id === config.activePaletteId) ?? createDefaultThemePalette(config.colors)
)
const paletteOptions = computed(() => config.palettes.map(palette => ({ title: palette.name, value: palette.id })))
const dirty = computed(() => JSON.stringify(config) !== JSON.stringify(persistedConfig.value))
const configValid = computed(() =>
  isThemeColors(config.colors) &&
  ThemePalettesSchema.safeParse(config.palettes).success &&
  config.palettes.some(palette => palette.id === config.activePaletteId) &&
  PageGutterCustomCssSchema.safeParse(config.gutterCustomCss).success
)
const iconsets = [
  { text: 'Material Design Icons (default)', value: 'mdi' },
  { text: 'Font Awesome 5', value: 'fa' },
  { text: 'Font Awesome 4', value: 'fa4' }
]
const tocPositions = [
  { text: 'Left (default)', value: 'left' },
  { text: 'Right', value: 'right' },
  { text: 'Hidden', value: 'off' }
]
const gutterStyles: Array<{ value: PageGutterStyle; title: string; description: string }> = [
  { value: 'columns', title: 'Attic columns', description: 'Fine fluting and measured capitals; the classical default.' },
  { value: 'orbits', title: 'Celestial orbits', description: 'Quiet circles and axes echo the geometry of the page title.' },
  { value: 'laurel', title: 'Laurel cadence', description: 'A spare botanical rhythm drawn along a central stem.' },
  { value: 'aurora', title: 'Aurora wash', description: 'Soft color fields for a warmer, contemporary margin.' },
  { value: 'none', title: 'Unadorned', description: 'Preserve the open reading space without ornament.' },
  { value: 'custom', title: 'Custom study', description: 'Apply your own declaration block to the right gutter region.' }
]
const gutterCustomCssRules = [
  (value: string): true | string => value.length <= PAGE_GUTTER_CUSTOM_CSS_MAX_LENGTH || `Use no more than ${PAGE_GUTTER_CUSTOM_CSS_MAX_LENGTH} characters.`,
  (value: string): true | string => !/[{}@]/.test(value) || 'Enter declarations only; selectors, braces, and @-rules are not allowed.'
]
const paletteNameRules = [
  (value: string): true | string => value.trim().length > 0 || 'Enter a theme name.',
  (value: string): true | string => value.trim().length <= 80 || 'Use no more than 80 characters.'
]
const gutterPreviewStyle = (style: PageGutterStyle): string | undefined => style === 'custom' ? config.gutterCustomCss : undefined
const paletteFields: Array<{ key: ThemeColorKey; label: string }> = [
  { key: 'background', label: 'Page background' },
  { key: 'surface', label: 'Cards and surfaces' },
  { key: 'primary', label: 'Primary' },
  { key: 'secondary', label: 'Secondary' },
  { key: 'accent', label: 'Accent' },
  { key: 'info', label: 'Information' },
  { key: 'success', label: 'Success' },
  { key: 'warning', label: 'Warning' },
  { key: 'error', label: 'Error' }
]

const copyConfig = (source: ThemeConfig): ThemeConfig => ({
  ...source,
  colors: cloneThemeColors(source.colors),
  palettes: cloneThemePalettes(source.palettes)
})

const assignConfig = (source: ThemeConfig): void => {
  Object.assign(config, copyConfig(source))
}


const syncActivePalette = (): void => {
  const palette = config.palettes.find(item => item.id === config.activePaletteId)
  if (!palette) return
  config.colors = cloneThemeColors(palette.colors)
  applyWikiThemeColors(theme, config.colors)
}

watch([() => config.activePaletteId, () => activePalette.value.colors], syncActivePalette, { deep: true })

const loadConfig = async (): Promise<void> => {
  loadController?.abort()
  const controller = new AbortController()
  loadController = controller
  initialLoading.value = true
  loaded.value = false
  loadingStart(wikiStore, 'admin-theme-refresh')
  try {
    const loadedConfig = await fetchThemeConfig(
      createAbortableFetch(controller.signal),
      'Theme config response is invalid'
    )
    if (controller.signal.aborted) return
    persistedConfig.value = copyConfig(loadedConfig)
    assignConfig(loadedConfig)
    loaded.value = true
  } catch (error) {
    if (!controller.signal.aborted) {
      pushGraphError(wikiStore, error)
    }
  } finally {
    if (loadController === controller) {
      loadController = null
      if (!isUnmounted) {
        initialLoading.value = false
      }
    }
    loadingStop(wikiStore, 'admin-theme-refresh')
  }
}

const restoreSaved = (): void => {
  if (persistedConfig.value) assignConfig(persistedConfig.value)
}

const createPalette = (): void => {
  if (config.palettes.length >= MAX_THEME_PALETTES) return
  let sequence = config.palettes.length + 1
  let id = `custom-theme-${sequence}`
  while (config.palettes.some(palette => palette.id === id)) {
    sequence += 1
    id = `custom-theme-${sequence}`
  }
  config.palettes.push({
    id,
    name: `Custom theme ${sequence}`,
    colors: cloneThemeColors(activePalette.value.colors)
  })
  config.activePaletteId = id
}

const resetActivePalette = (): void => {
  activePalette.value.colors[previewMode.value] = { ...DEFAULT_THEME_COLORS[previewMode.value] }
}

const resetActiveTheme = (): void => {
  activePalette.value.colors = cloneThemeColors(DEFAULT_THEME_COLORS)
}

const deleteActivePalette = (): void => {
  if (config.palettes.length <= 1) return
  const index = config.palettes.findIndex(palette => palette.id === config.activePaletteId)
  if (index < 0) return
  config.palettes.splice(index, 1)
  config.activePaletteId = config.palettes[Math.min(index, config.palettes.length - 1)]?.id ?? config.palettes[0]!.id
  deletePaletteDialog.value = false
}

const save = async (): Promise<void> => {
  if (!loaded.value || initialLoading.value || saving.value || !dirty.value || !configValid.value) return
  const controller = new AbortController()
  saveController = controller
  saving.value = true
  loadingStart(wikiStore, 'admin-theme-save')
  try {
    const payload = copyConfig(config)
    payload.colors = cloneThemeColors(activePalette.value.colors)
    await saveThemeConfig(
      createAbortableFetch(controller.signal),
      payload,
      'Theme config update failed'
    )
    if (controller.signal.aborted) return
    persistedConfig.value = payload
    siteConfig.darkMode = payload.darkMode
    siteConfig.themeColors = cloneThemeColors(payload.colors)
    siteConfig.gutterStyle = payload.gutterStyle
    siteConfig.gutterCustomCss = payload.gutterCustomCss
    wikiStore.site.gutterStyle = payload.gutterStyle
    wikiStore.site.gutterCustomCss = payload.gutterCustomCss
    wikiStore.site.dark = payload.darkMode
    showNotification(wikiStore, {
      message: 'Theme settings updated successfully.',
      style: 'success',
      icon: 'check'
    })
  } catch (error) {
    if (!controller.signal.aborted) {
      pushGraphError(wikiStore, error)
    }
  } finally {
    if (saveController === controller) {
      saveController = null
      if (!isUnmounted) {
        saving.value = false
      }
    }
    loadingStop(wikiStore, 'admin-theme-save')
  }
}

onMounted(() => { void loadConfig() })

onBeforeUnmount(() => {
  isUnmounted = true
  loadController?.abort()
  saveController?.abort()
  applyWikiThemeColors(theme, persistedConfig.value.colors)
  void theme.change(resolveThemeName(wikiStore.user.appearance, persistedConfig.value.darkMode), false)
})
</script>

<style lang="scss" scoped>
.admin-theme {
  max-width: 1680px;
}

.theme-shell-summary {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-radius-sm);
  background:
    radial-gradient(circle at 0 0, color-mix(in srgb, rgb(var(--v-theme-primary)) 13%, transparent), transparent 55%),
    var(--wiki-surface-soft);

  &__mark {
    display: grid;
    width: 2.75rem;
    height: 2.75rem;
    flex: 0 0 auto;
    place-items: center;
    border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 24%, transparent);
    border-radius: var(--wiki-radius-xs);
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, transparent);
    color: rgb(var(--v-theme-primary));
  }
}

.theme-library {
  display: grid;
  grid-template-columns: minmax(13rem, 1fr) minmax(13rem, 1fr) auto;
  gap: var(--wiki-space-3);
  align-items: start;
  padding: var(--wiki-space-4);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-radius-md);
  background: var(--wiki-surface-soft);
}

.theme-mode-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-4);

  &__copy {
    min-width: 0;
  }
}

.theme-palette-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.theme-preview {
  padding: 20px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 12px;
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));

  &__heading {
    display: flex;
    gap: 16px;
    justify-content: space-between;
    align-items: flex-start;
  }

  &__statuses {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
}

.gutter-section-heading {
  display: flex;
  gap: 24px;
  align-items: flex-start;
  justify-content: space-between;
}

.gutter-style-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.gutter-style-option {
  display: flex;
  min-width: 0;
  flex-direction: column;
  padding: 10px 10px 14px;
  border: 1px solid rgba(var(--v-border-color), .14);
  border-radius: 16px;
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 96%, rgb(var(--v-theme-background)));
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  font: inherit;
  text-align: start;
  transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease;

  &:not(:disabled):hover {
    border-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 42%, transparent);
    box-shadow: 0 12px 28px rgba(15, 23, 42, .08);
    transform: translateY(-2px);
  }

  &:disabled {
    cursor: default;
    opacity: .6;
  }

  &:focus-visible {
    outline: 3px solid rgba(var(--v-theme-primary), .2);
    outline-offset: 3px;
  }

  &.is-selected {
    border-color: rgb(var(--v-theme-primary));
    box-shadow:
      0 0 0 1px rgb(var(--v-theme-primary)),
      0 14px 30px rgba(15, 23, 42, .09);
  }

  &__canvas {
    position: relative;
    overflow: hidden;
    height: 116px;
    border: 1px solid rgba(var(--v-border-color), .09);
    border-radius: 11px;
    background:
      radial-gradient(circle at 82% 12%, rgba(var(--v-theme-primary), .09), transparent 45%),
      rgb(var(--v-theme-background));
  }

  &__art {
    position: absolute;
    inset-block: 8px;
    width: 44%;

    &--right {
      right: 2%;
      transform: scaleX(-1);
    }
  }

  &__paper {
    position: absolute;
    inset: 10px auto 10px 4%;
    width: 48%;
    flex-direction: column;
    gap: 8px;
    padding: 16px 12px;
    border: 1px solid rgba(var(--v-border-color), .1);
    border-radius: 8px;
    background: rgb(var(--v-theme-surface));
    box-shadow: 0 5px 16px rgba(15, 23, 42, .05);

    span {
      width: 100%;
      height: 3px;
      border-radius: 999px;
      background: rgba(var(--v-theme-on-surface), .13);

      &:nth-child(2) {
        width: 82%;
      }

      &:nth-child(3) {
        width: 92%;
      }

      &:nth-child(4) {
        width: 64%;
      }
    }
  }

  &__label {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    margin: 12px 3px 3px;
  }

  > .text-body-small {
    min-height: 2.5rem;
    margin-inline: 3px;
    line-height: 1.35;
  }
}

.gutter-custom-editor {
  padding: 18px 18px 14px;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 24%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 4%, rgb(var(--v-theme-surface)));
}

.is-monospaced :deep(textarea) {
  font-family: 'Roboto Mono', 'Courier New', Courier, monospace;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}

@include until($desktop) {
  .theme-palette-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .gutter-style-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@include until($tablet) {
  .theme-palette-grid {
    grid-template-columns: 1fr;
  }

  .theme-library {
    grid-template-columns: 1fr;

    > .theme-library__delete {
      justify-self: stretch;
    }
  }

  .theme-mode-bar {
    align-items: stretch;
    flex-direction: column;
  }

  .gutter-section-heading {
    flex-direction: column;
    gap: 12px;
  }

  .gutter-style-grid {
    grid-template-columns: 1fr;
  }


  .theme-preview {
    padding: 16px;

    &__heading {
      align-items: flex-start;
      flex-direction: column;
    }
  }
}
</style>
