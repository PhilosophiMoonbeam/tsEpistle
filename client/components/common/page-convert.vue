<template lang='pug'>
  v-dialog(
    v-model='isShown'
    max-width='550'
    scrollable
    :persistent='loading'
    scrim='blue-grey-darken-4'
    opacity='.7'
    aria-labelledby='page-convert-dialog-title'
    aria-describedby='page-convert-dialog-description'
    @after-enter='focusEditor'
    @after-leave='restoreFocus'
    )
    v-card
      .dialog-header.is-short.is-dark
        v-icon.mr-2(color='white') mdi-lightning-bolt
        span#page-convert-dialog-title {{$t('common:page.convert')}}
      v-card-text.pt-5
        i18next#page-convert-dialog-description.text-body-medium(path='common:page.convertTitle', tag='div')
          span.text-blue-grey-darken-2(place='title') {{pageTitle}}
        v-select.mt-5(
          ref='editorSelect'
          :items='editorOptions'
          variant="outlined"
          density="compact"
          hide-details
          label='New editor'
          v-model='newEditor'
        )
        v-alert.mt-5(
          color='warning'
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

const editorOptions = markRaw([
  { value: 'markdown', title: 'Markdown' },
  { value: 'visual-markdown', title: 'Visual Markdown' },
  { value: 'ckeditor', title: 'Visual Editor (HTML)' },
  { value: 'code', title: 'Raw HTML' }
])

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
      editorOptions,
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
    canConvert(): boolean { return Boolean(this.newEditor) && this.newEditor !== this.pageEditor }
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
