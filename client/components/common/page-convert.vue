<template lang='pug'>
  v-dialog(
    v-model='isShown'
    max-width='550'
    scrollable
    :persistent='loading'
    aria-labelledby='page-convert-dialog-title'
    aria-describedby='page-convert-dialog-description'
    @after-enter='focusEditor'
    @after-leave='restoreFocus'
    )
    v-card.page-convert
      .dialog-header
        v-icon.me-2(aria-hidden='true') mdi-file-document-edit-outline
        h2#page-convert-dialog-title {{$t('common:page.convert')}}
      v-card-text
        .page-convert__identity
          strong {{ pageTitle }}
          span.page-convert__path /{{ pageLocale }}/{{ pagePath }}
          span.page-convert__current(v-if='pageVisibility === `private`') {{ $t('common:page.privatePage', { defaultValue: 'Private page' }) }}
          span.page-convert__current {{ $t('common:pageConvert.currentEditor', { defaultValue: 'Current editor' }) }}: {{ currentEditorTitle }}
        i18next#page-convert-dialog-description.page-convert__description(path='common:page.convertTitle', tag='p')
          strong(place='title') {{pageTitle}}
        v-select.page-convert__editor(
          ref='editorSelect'
          :items='editorOptions'
          variant="outlined"
          density="compact"
          hide-details
          :label='$t(`common:pageConvert.newEditor`)'
          v-model='newEditor'
          :disabled='loading'
        )
        v-alert.page-convert__consequences(
          type='warning'
          variant='tonal'
          density='compact'
        ) {{$t('common:page.convertSubtitle')}}
      v-card-chin
        v-spacer
        v-btn(variant="text", @click='discard', :disabled='loading') {{$t('common:actions.cancel')}}
        v-btn.px-4(
          color="warning"
          variant="flat"
          @click='convertPage'
          :loading='loading'
          :disabled='loading || !canConvert'
        ) {{$t('common:actions.convert')}}
</template>

<script lang='ts'>
import { defineComponent, markRaw } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { convertPage } from '../../helpers/pages-api'

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
      loading: false,
      newEditor: '',
      convertAbortController: null as AbortController | null,
      returnFocusTarget: null as HTMLElement | null
    }
  },
  computed: {
    isShown: {
      get(): boolean { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    },
    pageTitle(): string { return wikiStore.page.title },
    pagePath(): string { return wikiStore.page.path },
    pageLocale(): string { return wikiStore.page.locale },
    pageVisibility(): string { return wikiStore.page.visibility },
    pageId(): number { return wikiStore.page.id },
    pageEditor(): string { return wikiStore.page.editor },
    pageSourceRevision(): string { return wikiStore.page.sourceRevision },
    editorOptions(): { value: string, title: string }[] { return markRaw([
      { value: 'markdown', title: this.$t('common:pageConvert.editorMarkdown') },
      { value: 'visual-markdown', title: this.$t('common:pageConvert.editorVisualMarkdown') },
      { value: 'ckeditor', title: this.$t('common:pageConvert.editorVisualHtml') },
      { value: 'code', title: this.$t('common:pageConvert.editorRawHtml') }
    ]) },
    canConvert(): boolean { return Boolean(this.newEditor) && this.newEditor !== this.pageEditor },
    currentEditorTitle(): string { return this.editorOptions.find(editor => editor.value === this.pageEditor)?.title ?? this.pageEditor }
  },
  watch: {
    isShown: {
      immediate: true,
      handler(newValue: boolean) {
        if (newValue) {
          const activeElement = document.activeElement
          const overlayId = activeElement instanceof HTMLElement
            ? activeElement.closest<HTMLElement>('.v-overlay__content')?.id
            : undefined
          let overlayActivator: HTMLElement | null = null
          if (overlayId) {
            for (const candidate of document.querySelectorAll<HTMLElement>('[aria-controls]')) {
              if (candidate.getAttribute('aria-controls') === overlayId) {
                overlayActivator = candidate
                break
              }
            }
          }
          this.returnFocusTarget = overlayActivator ?? (activeElement instanceof HTMLElement ? activeElement : null)
          this.newEditor = this.pageEditor
        }
      }
    }
  },
  beforeUnmount() {
    this.convertAbortController?.abort()
    this.convertAbortController = null
    this.returnFocusTarget = null
  },
  methods: {
    focusEditor(): void {
      const select = this.$refs.editorSelect as { focus?: () => void } | undefined
      select?.focus?.()
    },
    restoreFocus(): void {
      const target = this.returnFocusTarget
      this.returnFocusTarget = null
      if (target?.isConnected && target.getClientRects().length > 0 && !target.matches(':disabled')) {
        target.focus({ preventScroll: true })
      }
    },
    discard(): void {
      this.isShown = false
    },
    async convertPage(): Promise<void> {
      if (!this.canConvert || this.loading) return

      const controller = new AbortController()
      this.convertAbortController = controller
      this.loading = true
      wikiStore.startLoading('page-convert')
      try {
        await convertPage(
          (url, init) => window.fetch(url, { ...init, signal: controller.signal }),
          this.pageId,
          this.newEditor,
          this.pageSourceRevision
        )
        if (controller.signal.aborted || this.convertAbortController !== controller) return
        this.returnFocusTarget = null
        this.isShown = false
        const scope = this.pageVisibility === 'private' ? '/_private' : ''
        window.location.assign(`/e${scope}/${this.pageLocale}/${this.pagePath}`)
      } catch (err) {
        if (this.convertAbortController === controller && !controller.signal.aborted) {
          wikiStore.showError(err)
        }
      } finally {
        wikiStore.stopLoading('page-convert')
        if (this.convertAbortController === controller) {
          this.convertAbortController = null
          this.loading = false
          if (this.isShown) {
            await this.$nextTick()
            this.focusEditor()
          }
        }
      }
    }
  }
})
</script>

<style lang='scss'>
.page-convert {
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  color: rgb(var(--v-theme-on-surface));
  .dialog-header h2 { margin: 0; font-size: 1rem; }
  .v-card-text { padding: 1.25rem; }
  .v-card-chin { border-block-start: 1px solid var(--wiki-surface-border); gap: .5rem; padding: .75rem 1.25rem; background: var(--wiki-surface-raised); }
  .v-btn { min-height: 44px; }
}
.page-convert__identity {
  display: grid;
  gap: .375rem;
  padding: 1rem;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  overflow-wrap: anywhere;
}
.page-convert__path,
.page-convert__current { color: var(--wiki-text-muted); font-size: .8125rem; }
.page-convert__description { margin-block: 1rem; line-height: 1.5; }
.page-convert__consequences { margin-block-start: 1rem; }
@media (max-width: 599.98px) {
  .page-convert .v-card-chin { flex-wrap: wrap; }
  .page-convert .v-card-chin .v-btn { flex: 1 1 auto; }
}
</style>
