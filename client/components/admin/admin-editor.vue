<template lang='pug'>
  v-container.admin-editor(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-web-design.svg', alt='', width='80', height='80')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft Editors
            .text-body-large.text-medium-emphasis.animated.fadeInLeft.wait-p2s Choose which editors authors can use when creating pages
          v-spacer
          v-chip(v-if='hasChanges', color='warning', variant='tonal', size='small') Unsaved changes
          v-btn.animated.fadeInRight(
            color='success'
            variant='flat'
            size='large'
            :loading='saving'
            :disabled='loading || saving || !hasChanges'
            @click='save'
          )
            v-icon(start) mdi-check
            span Save changes

    v-row.pt-3
      v-col(cols='12', lg='8')
        v-card.animated.fadeInUp
          v-toolbar(color='primary', density='compact')
            v-icon.ml-4 mdi-pencil-ruler
            v-toolbar-title.text-body-large Available for new pages
            v-chip.mr-3(
              color='white'
              variant='outlined'
              size='small'
            ) {{ selectionSummary }}
          v-card-text
            .d-flex.flex-wrap.align-center.ga-2.mb-5
              .text-body-medium.text-medium-emphasis.flex-grow-1
                | Hidden editors disappear from the new-page chooser. Existing pages keep their current editor and remain editable.
              v-btn(
                size='small'
                variant='text'
                prepend-icon='mdi-select-all'
                :disabled='loading || allEditorsAvailable'
                @click='makeAllAvailable'
              ) Select all
              v-btn(
                size='small'
                variant='text'
                prepend-icon='mdi-undo-variant'
                :disabled='loading || !hasChanges'
                @click='restoreSaved'
              ) Restore saved

            v-skeleton-loader(v-if='loading', type='list-item-avatar-three-line@3')
            .editor-grid(v-else)
              v-card.editor-choice(
                v-for='editor in editors'
                :key='editor.key'
                :class='{ "editor-choice--available": isAvailable(editor.key) }'
                variant='outlined'
                :aria-disabled='isOnlyAvailable(editor.key) ? "true" : undefined'
                @click='!isOnlyAvailable(editor.key) && toggleEditor(editor.key)'
              )
                v-card-text.editor-choice__body
                  .editor-choice__icon
                    img(:src='editor.image', alt='')
                  .editor-choice__content
                    .d-flex.align-center.ga-2
                      .text-title-medium {{ editor.title }}
                    .text-body-small.text-medium-emphasis.mt-1 {{ editor.description }}
                  v-switch.editor-choice__switch(
                    :model-value='isAvailable(editor.key)'
                    :disabled='isOnlyAvailable(editor.key)'
                    color='success'
                    hide-details
                    inset
                    :aria-label='`${editor.title} availability`'
                    @click.stop
                    @update:model-value='setAvailability(editor.key, Boolean($event))'
                    :aria-describedby='isOnlyAvailable(editor.key) ? "editor-required-hint" : undefined'
                  )
                .editor-choice__status(:class='{ "editor-choice__status--available": isAvailable(editor.key) }')
                  span {{ isAvailable(editor.key) ? 'Available' : 'Hidden' }}

      v-col(cols='12', lg='4')
        v-card.animated.fadeInUp.wait-p1s
          v-toolbar(color='primary', density='compact')
            v-icon.ml-4 mdi-lightbulb-outline
            v-toolbar-title.text-body-large A focused authoring experience
          v-card-text
            .text-body-medium
              | Offer the formats your organization supports. A smaller set makes page creation faster and keeps source conventions consistent.
            v-list.mt-3(lines='two')
              v-list-item
                template(v-slot:prepend)
                  v-avatar(color='primary', variant='tonal')
                    v-icon mdi-shield-check-outline
                v-list-item-title Existing content is safe
                v-list-item-subtitle Changing this setting never converts or disables existing pages.
              v-list-item
                template(v-slot:prepend)
                  v-avatar(color='primary', variant='tonal')
                    v-icon mdi-cursor-default-click-outline
                v-list-item-title One editor, no extra step
                v-list-item-subtitle When only one editor is available, new pages open it immediately.
              v-list-item
                template(v-slot:prepend)
                  v-avatar(color='primary', variant='tonal')
                    v-icon mdi-lock-outline
                v-list-item-title At least one required
                v-list-item-subtitle The final available editor cannot be hidden.

        v-alert#editor-required-hint.mt-3(
          type='info'
          variant='tonal'
          icon='mdi-information-outline'
          density='comfortable'
        )
          .text-body-small
            | At least one editor must remain available. Existing pages keep their current editor.
</template>

<script setup lang='ts'>
import { computed, onMounted, ref } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { PAGE_EDITOR_DEFINITIONS } from '../../helpers/page-editors.ts'
import { fetchSiteConfig, saveSiteConfig } from '../../helpers/site-api.ts'
import { loadingStart, loadingStop, pushGraphError, showNotification } from '../../helpers/root-ui-store.ts'
import { defaultAvailableEditors, normalizeAvailableEditors, type PageEditorKey } from '../../../shared/page-editors.ts'

const editors = PAGE_EDITOR_DEFINITIONS
const availableEditors = ref<PageEditorKey[]>(defaultAvailableEditors())
const persistedEditors = ref<PageEditorKey[]>(defaultAvailableEditors())
const loading = ref(true)
const saving = ref(false)

const hasChanges = computed(() => availableEditors.value.join('|') !== persistedEditors.value.join('|'))
const allEditorsAvailable = computed(() => availableEditors.value.length === editors.length)
const selectionSummary = computed(() => `${availableEditors.value.length} of ${editors.length} available`)

const isAvailable = (editor: PageEditorKey): boolean => availableEditors.value.includes(editor)
const isOnlyAvailable = (editor: PageEditorKey): boolean => isAvailable(editor) && availableEditors.value.length === 1

const setAvailability = (editor: PageEditorKey, available: boolean): void => {
  const selected = new Set(availableEditors.value)
  if (available) selected.add(editor)
  else if (selected.size > 1) selected.delete(editor)
  availableEditors.value = editors.map(candidate => candidate.key).filter(key => selected.has(key))
}

const toggleEditor = (editor: PageEditorKey): void => {
  setAvailability(editor, !isAvailable(editor))
}

const makeAllAvailable = (): void => {
  availableEditors.value = editors.map(editor => editor.key)
}

const restoreSaved = (): void => {
  availableEditors.value = [...persistedEditors.value]
}

const loadConfig = async (): Promise<void> => {
  loadingStart(wikiStore, 'admin-editors-refresh')
  try {
    const config = await fetchSiteConfig(window.fetch.bind(window), 'Editor configuration response is invalid')
    const selected = normalizeAvailableEditors(config.availableEditors)
    availableEditors.value = selected
    persistedEditors.value = [...selected]
  } catch (error) {
    pushGraphError(wikiStore, error)
  } finally {
    loading.value = false
    loadingStop(wikiStore, 'admin-editors-refresh')
  }
}

const save = async (): Promise<void> => {
  if (loading.value || saving.value || !hasChanges.value) return
  saving.value = true
  loadingStart(wikiStore, 'admin-editors-save')
  try {
    const selected = [...availableEditors.value]
    await saveSiteConfig(window.fetch.bind(window), { availableEditors: selected }, 'Editor configuration update failed')
    persistedEditors.value = selected
    siteConfig.availableEditors = [...selected]
    showNotification(wikiStore, {
      message: 'Editor availability saved successfully.',
      style: 'success',
      icon: 'check'
    })
  } catch (error) {
    pushGraphError(wikiStore, error)
  } finally {
    saving.value = false
    loadingStop(wikiStore, 'admin-editors-save')
  }
}

onMounted(() => { void loadConfig() })
</script>

<style lang='scss' scoped>
.admin-editor {
  max-width: 1680px;
}

.editor-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.editor-choice {
  position: relative;
  overflow: hidden;
  cursor: pointer;
  border-color: rgba(var(--v-border-color), var(--v-border-opacity));
  transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;

  &:hover,
  &:focus-visible {
    border-color: rgba(var(--v-theme-primary), .55);
    box-shadow: 0 6px 18px rgba(var(--v-theme-on-surface), .08);
    transform: translateY(-1px);
    outline: none;
  }

  &--available {
    border-color: rgba(var(--v-theme-primary), .65);
    background: linear-gradient(135deg, rgba(var(--v-theme-primary), .08), rgba(var(--v-theme-surface), 0) 58%);
  }

  &__body {
    display: grid;
    grid-template-columns: 52px minmax(0, 1fr) auto;
    gap: 14px;
    align-items: start;
    min-height: 132px;
    padding-bottom: 42px;
  }

  &__icon {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border-radius: 12px;
    background: rgba(var(--v-theme-primary), .1);

    img {
      width: 34px;
      height: 34px;
    }
  }

  &__switch {
    margin-top: -6px;
  }

  &__status {
    position: absolute;
    inset: auto 0 0;
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 8px 16px;
    color: rgb(var(--v-theme-medium-emphasis));
    background: rgba(var(--v-theme-on-surface), .035);
    font-size: .75rem;
    font-weight: 600;
    letter-spacing: .02em;

    &--available {
      color: rgb(var(--v-theme-success));
      background: rgba(var(--v-theme-success), .08);
    }
  }
}

@media (max-width: 959px) {
  .editor-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 599px) {
  .editor-choice__body {
    grid-template-columns: 44px minmax(0, 1fr) auto;
    gap: 10px;
  }

  .editor-choice__icon {
    width: 44px;
    height: 44px;

    img {
      width: 30px;
      height: 30px;
    }
  }
}
</style>
