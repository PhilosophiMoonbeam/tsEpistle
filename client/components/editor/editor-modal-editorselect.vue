<template>
  <v-dialog v-model="isShown" max-width="780" scrollable :persistent="templateLoading" :fullscreen="$vuetify.display.smAndDown" aria-labelledby="editor-select-title" no-click-animation>
    <v-card class="editor-select">
      <header class="editor-select__heading"><div><span>New page</span><h2 id="editor-select-title">How would you like to write?</h2></div><v-btn icon="mdi-arrow-left" variant="text" aria-label="Go back" :disabled="templateLoading" @click="goBack" /></header>
      <v-card-text class="editor-select__content">
        <p class="editor-select__intro">Choose an editor for this page. {{ recommendation ? 'Your workspace recommendation is highlighted.' : `Your workspace offers ${availableEditors.length} editors.` }}</p>
        <v-alert v-if="templateError" type="error" variant="tonal" class="mb-4">{{ templateError }}</v-alert>
        <v-progress-linear v-if="templateLoading" indeterminate class="mb-4" aria-label="Checking template editor" />
        <div class="editor-select__grid">
          <button v-for="editor in availableEditors" :key="editor.key" class="editor-select__option" :class="{ 'editor-select__option--recommended': editor.key === recommendation }" :disabled="templateLoading" @click="selectEditor(editor.key)"><div class="editor-select__option-top"><v-icon :icon="editor.icon" size="27" /><span v-if="editor.key === recommendation" class="editor-select__recommendation">Workspace recommendation</span></div><h3>{{ editor.title }}</h3><p>{{ editor.chooserDescription }}</p><span class="editor-select__format">{{ editor.format }} source</span></button>
          <button class="editor-select__option editor-select__option--template" :disabled="templateLoading" @click="fromTemplate"><div class="editor-select__option-top"><v-icon icon="mdi-content-copy" size="27" /></div><h3>From a template</h3><p>Reuse an existing page as a starting point.</p><span class="editor-select__format">Reuse content</span></button>
        </div>
        <p class="editor-select__footnote">The editor determines the page’s source format. You can review format conversions later in page administration.</p>
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
            if (template.editor === undefined) throw new Error('This template does not expose its editor to your current page access.')
            return { editor: template.editor }
          }
        )
        if (sequence !== this.templateSequence) return false
        window.location.assign(location)
        return true
      } catch (error) {
        if (sequence === this.templateSequence) this.templateError = error instanceof Error ? error.message : 'This template could not be opened. Try again.'
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
.editor-select { --editor-choice-border:rgba(var(--v-theme-on-surface),.15); --editor-choice-muted:rgba(var(--v-theme-on-surface),.72); min-height:0; overflow:hidden; border:1px solid var(--editor-choice-border); border-radius:14px!important; }
.editor-select__heading { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; padding:1.7rem 1.7rem 1.3rem; border-bottom:1px solid var(--editor-choice-border); span { display:block; font-size:.65rem; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--editor-choice-muted); } h2 { font-size:1.55rem; line-height:1.25; font-weight:600; letter-spacing:-.035em; margin:.6rem 0 0; } }
.editor-select__content { flex:1 1 auto; min-height:0; overflow-y:auto; padding:1.4rem 1.7rem 1.7rem!important; }
.editor-select__intro { font-size:.82rem; line-height:1.75; color:var(--editor-choice-muted); margin:0 0 1.2rem; }
.editor-select__grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.85rem; }
.editor-select__option { appearance:none; display:block; text-align:left; border:1px solid var(--editor-choice-border); border-radius:9px; padding:1.2rem; background:transparent; color:rgb(var(--v-theme-on-surface)); cursor:pointer; min-width:0; transition:background .15s,border-color .15s; &:hover { background:rgba(var(--v-theme-on-surface),.04); } &:focus-visible { outline:2px solid rgb(var(--v-theme-on-surface)); outline-offset:3px; } &:disabled { opacity:.6; cursor:wait; } &--recommended { border-color:rgba(var(--v-theme-primary),.65); background:rgba(var(--v-theme-primary),.05); } &--template { border-style:dashed; } h3 { font-size:1rem; font-weight:600; margin:.8rem 0 .4rem; } p { font-size:.76rem; line-height:1.6; color:var(--editor-choice-muted); margin:0 0 1rem; } }
.editor-select__option-top { display:flex; align-items:center; justify-content:space-between; gap:.7rem; .v-icon { color:rgb(var(--v-theme-primary)); } }
.editor-select__recommendation { font-size:.6rem; line-height:1.5; text-align:right; max-width:105px; color:var(--editor-choice-muted); }
.editor-select__format { display:inline-block; border:1px solid var(--editor-choice-border); border-radius:4px; padding:.2rem .5rem; font-size:.64rem; color:var(--editor-choice-muted); }
.editor-select__footnote { border-top:1px solid var(--editor-choice-border); padding-top:1rem; margin:1.2rem 0 0; font-size:.7rem; line-height:1.8; color:var(--editor-choice-muted); }
@media(max-width:600px) { .editor-select { border:0; border-radius:0!important; } .editor-select__heading { padding:1.4rem 1.2rem 1rem; h2 { font-size:1.4rem; } } .editor-select__content { padding:1.2rem!important; } .editor-select__grid { grid-template-columns:1fr; } .editor-select__option { padding:1rem; } }
@media(prefers-reduced-motion:reduce) { .editor-select__option { transition:none; } }
</style>
