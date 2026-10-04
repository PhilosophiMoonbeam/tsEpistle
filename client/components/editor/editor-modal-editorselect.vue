<template>
  <v-dialog v-model="isShown" max-width="680" :fullscreen="$vuetify.display.xs" scrollable persistent content-class="editorselect-dialog" aria-labelledby="editor-select-title">
    <v-card class="editor-select">
      <header class="editor-select__heading"><div><span>{{ $t('editor:editorModalEditorselect.newPage') }}</span><h2 id="editor-select-title">{{ $t('editor:editorModalEditorselect.howWouldYouLike') }}</h2></div><v-btn icon="mdi-arrow-left" variant="text" :aria-label="$t('editor:editorModalEditorselect.goBack')" :disabled="templateLoading" @click="goBack" /></header>
      <div class="editor-select__location">/{{ locale }}/{{ path }}</div>
      <v-card-text class="editor-select__content">
        <p class="editor-select__intro">{{ $t('editor:editorModalEditorselect.chooseEditorPage', { availableEditors: recommendation ? $t('editor:editorModalEditorselect.workspaceRecommendationHighlighted') : $t('editor:editorModalEditorselect.workspaceOffersEditors', { availableEditorsCount: availableEditors.length, interpolation: { escapeValue: false } }), interpolation: { escapeValue: false } }) }}</p>
        <v-alert v-if="templateError" type="error" variant="tonal" class="mb-4">{{ templateError }}</v-alert>
        <v-progress-linear v-if="templateLoading" indeterminate class="mb-4" :aria-label="$t('editor:editorModalEditorselect.checkingTemplateEditor')" />
        <div class="editor-select__grid">
          <button v-for="editor in availableEditors" :key="editor.key" class="editor-select__option" :class="{ 'editor-select__option--recommended': editor.key === recommendation }" :disabled="templateLoading" @click="selectEditor(editor.key)"><div class="editor-select__option-top"><v-icon :icon="editor.icon" size="27" /><span v-if="editor.key === recommendation" class="editor-select__recommendation">{{ $t('editor:editorModalEditorselect.workspaceRecommendation') }}</span></div><h3>{{ editor.title }}</h3><p>{{ editor.chooserDescription }}</p><span class="editor-select__format">{{ $t('editor:editorModalEditorselect.source', { format: editor.format, interpolation: { escapeValue: false } }) }}</span></button>
          <button class="editor-select__option editor-select__option--template" :disabled="templateLoading" @click="fromTemplate"><div class="editor-select__option-top"><v-icon icon="mdi-content-copy" size="27" /></div><h3>{{ $t('editor:editorModalEditorselect.template') }}</h3><p>{{ $t('editor:editorModalEditorselect.reuseExistingPageStarting') }}</p><span class="editor-select__format">{{ $t('editor:editorModalEditorselect.reuseContent') }}</span></button>
        </div>
        <p class="editor-select__footnote">{{ $t('editor:editorModalEditorselect.editorDeterminesPagesSource') }}</p>
      </v-card-text>
      <page-selector mode="select" v-model="templateDialogIsShown" :open-handler="fromTemplateHandle" :path="path" :locale="locale" must-exist />
    </v-card>
  </v-dialog>
</template>
<script lang='ts'>
import { fetchPage } from '../../helpers/pages-api.ts'
import { resolveTemplateEditorPath } from '../../helpers/editor-template.ts'
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { getEditorComponentName } from '../../helpers/editor-key.ts'
import { PAGE_EDITOR_DEFINITIONS } from '../../helpers/page-editors.ts'
import { normalizeAvailableEditors, type PageEditorKey } from '../../../shared/page-editors.ts'

export default defineComponent({
  emits: ['update:modelValue'],
  props: {
    modelValue: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      templateDialogIsShown: false,
      templateLoading: false,
      templateError: '',
      templateSequence: 0
    }
  },
  computed: {
    isShown: {
      get() { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    },
    availableEditors() {
      const selected = new Set(normalizeAvailableEditors(siteConfig.availableEditors))
      return PAGE_EDITOR_DEFINITIONS.filter(editor => selected.has(editor.key)).sort((a, b) => Number(b.key === this.recommendation) - Number(a.key === this.recommendation))
    },
    recommendation(): PageEditorKey | null { return siteConfig.recommendedEditor && normalizeAvailableEditors(siteConfig.availableEditors).includes(siteConfig.recommendedEditor) ? siteConfig.recommendedEditor : null },
    locale() {
      return wikiStore.page.locale
    },
    path() {
      return wikiStore.page.path
    }
  },
  methods: {
    selectEditor (name: PageEditorKey) {
      if (this.templateLoading) return
      wikiStore.editor.editor = getEditorComponentName(name)
      this.isShown = false
    },
    goBack () {
      window.history.go(-1)
    },
    fromTemplate () {
      if (this.templateLoading) return
      this.templateError = ''
      this.templateDialogIsShown = true
    },
    async fromTemplateHandle ({ id }: { id: number }) {
      if (this.templateLoading) return false
      const sequence = ++this.templateSequence
      this.templateDialogIsShown = false
      this.templateLoading = true
      this.templateError = ''
      try {
        const location = await resolveTemplateEditorPath(
          { locale: this.locale, path: this.path, visibility: wikiStore.page.visibility, templateId: id },
          this.availableEditors.map(editor => editor.key),
          async templateId => {
            const template = await fetchPage(window.fetch.bind(window), templateId)
            if (template.editor === undefined) throw new Error(this.$t('editor:editorModalEditorselect.templateDoesNotExpose'))
            return { editor: template.editor }
          }
        )
        if (sequence !== this.templateSequence) return false
        window.location.assign(location)
        return true
      } catch (error) {
        if (sequence === this.templateSequence) this.templateError = error instanceof Error ? error.message : this.$t('editor:editorModalEditorselect.templateCouldNotOpened')
        return false
      } finally {
        if (sequence === this.templateSequence) this.templateLoading = false
      }
    }
  },
  beforeUnmount() { this.templateSequence++ }
})
</script>

<style lang="scss" scoped>
.editor-select {
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised);
  color: rgb(var(--v-theme-on-surface));
}
.editor-select__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.25rem;
  span { color: var(--wiki-text-muted); font-size: .8125rem; }
  h2 { margin: .25rem 0 0; font-size: 1.25rem; line-height: 1.4; font-weight: 650; }
}
.editor-select__location {
  padding: .75rem 1.25rem;
  border-block: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);
  color: var(--wiki-text-muted);
  font-size: .8125rem;
  overflow-wrap: anywhere;
}
.editor-select__content { min-height: 0; overflow-y: auto; padding: 1rem 1.25rem !important; }
.editor-select__intro, .editor-select__footnote {
  color: var(--wiki-text-muted);
  font-size: .875rem;
  line-height: 1.6;
  margin: 0 0 1rem;
}
.editor-select__grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: .5rem; }
.editor-select__option {
  appearance: none;
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr) auto;
  gap: .25rem .75rem;
  text-align: start;
  min-width: 0;
  padding: .875rem;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-raised);
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  overflow-wrap: anywhere;
  &:hover { background: var(--wiki-surface-sunken); }
  &:focus-visible { outline: 2px solid var(--wiki-primary-ink); outline-offset: 2px; }
  &:disabled { opacity: .6; cursor: wait; }
  &--recommended { border-color: var(--wiki-primary-ink); }
  h3 { grid-column: 2; grid-row: 1; font-size: 1rem; font-weight: 650; margin: 0; }
  p { grid-column: 2 / -1; font-size: .875rem; line-height: 1.5; color: var(--wiki-text-muted); margin: 0; }
}
.editor-select__option-top {
  display: contents;
  .v-icon { grid-column: 1; grid-row: 1 / 3; color: var(--wiki-primary-ink); }
}
.editor-select__recommendation { grid-column: 2 / -1; grid-row: 3; font-size: .8125rem; color: var(--wiki-primary-ink); }
.editor-select__format { grid-column: 3; grid-row: 1; align-self: center; font-size: .75rem; color: var(--wiki-text-muted); }
.editor-select__footnote { border-top: 1px solid var(--wiki-surface-border); padding-top: 1rem; margin: 1rem 0 0; }
@media (max-width: 600px) {
  .editor-select { border: 0; border-radius: 0 !important; }
  .editor-select__heading, .editor-select__location { padding-inline: 1rem; }
  .editor-select__content { padding: 1rem !important; }
  .editor-select__option { grid-template-columns: 2rem minmax(0, 1fr); }
  .editor-select__format { grid-column: 2; grid-row: 4; }
}
</style>
