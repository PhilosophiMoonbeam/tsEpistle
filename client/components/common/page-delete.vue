<template lang='pug'>
  v-dialog(
    ref='dialog'
    v-model='isShown'
    max-width='550'
    scrollable
    :persistent='loading'
    scrim='red-darken-4'
    :opacity='0.7'
    aria-labelledby='page-delete-dialog-title'
    aria-describedby='page-delete-dialog-description'
    @after-enter='focusCancel'
    @after-leave='restoreFocus'
    )
    v-card
      .dialog-header.is-short.is-red
        v-icon.me-2(color='white') mdi-file-document-remove-outline
        span#page-delete-dialog-title {{$t('common:page.delete')}}
      v-card-text#page-delete-dialog-description.pt-5
        localized-rich-text.text-body-large(path='common:page.deleteTitle', tag='div')
          template(#title)
            span.text-red-darken-2 {{pageTitle}}
        .text-body-small {{$t('common:page.deleteSubtitle')}}
        .page-delete__metadata
          v-chip.page-delete__locale(label, color="red-lighten-4", size="small")
            .text-body-small.text-red-darken-2 {{pageLocale.toUpperCase()}}
          v-chip.page-delete__path(label, color="red-lighten-5", size="small", :title='`/${pagePath}`', :aria-label='`/${pagePath}`')
            span.text-red-darken-2 /{{pagePath}}
      v-card-chin
        v-spacer
        v-btn(ref='cancelButton', variant="text", @click='discard', :disabled='loading') {{$t('common:actions.cancel')}}
        v-btn.px-4(color="red-darken-2", @click='deletePage', :loading='loading', :disabled='loading').text-white {{$t('common:actions.delete')}}
</template>

<script lang='ts'>
import { defineComponent, type PropType } from 'vue'
import { wikiStore } from '@/store/index.ts'

import { deletePage as deletePageById } from '../../helpers/pages-api'
import LocalizedRichText from './localized-rich-text'

type DeleteDialogFocus = { contentEl?: HTMLElement, globalTop?: boolean }
type ReturnFocusContext = { href: string, pageId: number, pagePath: string, pageLocale: string }

export default defineComponent({
  components: { LocalizedRichText },
  emits: ['update:modelValue'],
  props: {
    modelValue: {
      type: Boolean,
      default: false
    },
    returnFocusTo: {
      type: Object as PropType<HTMLElement | null>,
      default: null
    }
  },
  data() {
    return {
      loading: false,
      retainPendingClass: false,
      deleteTransitionTimer: undefined as number | undefined,
      redirectTimer: undefined as number | undefined,
      deleteRequestId: 0,
      deleteAbortController: null as AbortController | null,
      disposed: false,
      focusGeneration: 0,
      returnFocusTarget: null as HTMLElement | null,
      returnFocusContext: null as ReturnFocusContext | null,
      leavingDialogContent: null as HTMLElement | null
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
    pageId(): number { return wikiStore.page.id },
    pageSourceRevision(): string { return wikiStore.page.sourceRevision }
  },
  mounted() {
    if (this.isShown) {
      this.rememberFocus()
      document.body.classList.add('page-deleted-pending')
    }
  },
  beforeUnmount() {
    this.disposed = true
    this.focusGeneration += 1
    this.clearReturnFocus()
    this.deleteRequestId += 1
    this.deleteAbortController?.abort()
    this.deleteAbortController = null
    window.clearTimeout(this.deleteTransitionTimer)
    window.clearTimeout(this.redirectTimer)
    document.body.classList.remove('page-deleted-pending', 'page-deleted')
  },
  watch: {
    isShown(newValue: boolean) {
      if (newValue) {
        this.rememberFocus()
        this.retainPendingClass = false
        document.body.classList.add('page-deleted-pending')
      } else {
        const dialog = this.$refs.dialog as DeleteDialogFocus | undefined
        this.leavingDialogContent = dialog?.contentEl ?? null
        if (!this.retainPendingClass) document.body.classList.remove('page-deleted-pending')
      }
    }
  },
  methods: {
    rememberFocus(): void {
      this.focusGeneration += 1
      this.returnFocusTarget = this.returnFocusTo
      this.returnFocusContext = {
        href: window.location.href,
        pageId: this.pageId,
        pagePath: this.pagePath,
        pageLocale: this.pageLocale
      }
      this.leavingDialogContent = null
      document.addEventListener('focusin', this.handleFocusClaim)
    },
    clearReturnFocus(): void {
      this.returnFocusTarget = null
      this.returnFocusContext = null
      this.leavingDialogContent = null
      document.removeEventListener('focusin', this.handleFocusClaim)
    },
    handleFocusClaim(event: FocusEvent): void {
      if (this.isShown || !this.returnFocusTarget) return
      const target = event.target
      const dialog = this.$refs.dialog as DeleteDialogFocus | undefined
      const content = this.leavingDialogContent ?? dialog?.contentEl
      // A new focus owner during leave cancels restoration, even if it later
      // disappears and leaves focus on the body.
      if (target instanceof HTMLElement && target !== document.body && target !== document.documentElement &&
          target !== this.returnFocusTarget && !content?.contains(target)) {
        this.returnFocusTarget = null
      }
    },
    focusCancel(): void {
      const dialog = this.$refs.dialog as DeleteDialogFocus | undefined
      if (this.disposed || !this.isShown || !dialog?.globalTop) return
      const cancel = this.$refs.cancelButton as { $el?: HTMLElement } | undefined
      cancel?.$el?.focus({ preventScroll: true })
    },
    async restoreFocus(): Promise<void> {
      if (this.disposed || this.isShown) return
      const generation = this.focusGeneration
      // Let Vuetify remove its leaving content before inspecting focus.
      await this.$nextTick()
      if (this.disposed || this.isShown || generation !== this.focusGeneration) return
      const target = this.returnFocusTarget
      const context = this.returnFocusContext
      const content = this.leavingDialogContent
      this.clearReturnFocus()
      if (this.retainPendingClass || !context || context.href !== window.location.href ||
          context.pageId !== this.pageId || context.pagePath !== this.pagePath || context.pageLocale !== this.pageLocale ||
          !target?.isConnected || target.matches(':disabled, [aria-disabled="true"]') || target.getClientRects().length === 0 ||
          target.closest('[inert], [aria-hidden="true"], .v-overlay:not(.v-overlay--active)')) return
      const ownerDocument = target.ownerDocument
      const activeElement = ownerDocument.activeElement
      if (activeElement && activeElement !== ownerDocument.body && activeElement !== ownerDocument.documentElement &&
          activeElement !== target && !content?.contains(activeElement)) return
      let topDialog: HTMLElement | null = null
      for (const dialog of ownerDocument.querySelectorAll<HTMLElement>('.v-dialog.v-overlay--active')) {
        if (!topDialog || Number(dialog.style.zIndex) >= Number(topDialog.style.zIndex)) topDialog = dialog
      }
      if (topDialog && !topDialog.contains(target)) return
      target.focus({ preventScroll: true })
    },
    discard(): void {
      document.body.classList.remove('page-deleted-pending')
      this.isShown = false
    },
    async deletePage(): Promise<void> {
      if (this.loading) {
        return
      }
      const requestId = ++this.deleteRequestId
      const controller = new AbortController()
      this.deleteAbortController = controller
      this.loading = true
      wikiStore.startLoading('page-delete')
      try {
        await this.$nextTick()
        if (requestId !== this.deleteRequestId) {
          return
        }
        await deletePageById(
          (url, init) => window.fetch(url, { ...init, signal: controller.signal }),
          this.pageId,
          this.pageSourceRevision,
          this.$t('common:error.unexpected')
        )
        if (requestId !== this.deleteRequestId) {
          return
        }
        this.retainPendingClass = true
        this.clearReturnFocus()
        this.isShown = false
        this.deleteTransitionTimer = window.setTimeout(() => {
          this.deleteTransitionTimer = undefined
          if (requestId !== this.deleteRequestId) {
            return
          }
          document.body.classList.add('page-deleted')
          this.redirectTimer = window.setTimeout(() => {
            this.redirectTimer = undefined
            if (requestId === this.deleteRequestId) {
              window.location.assign('/')
            }
          }, 1200)
        }, 400)
      } catch (err) {
        if (requestId === this.deleteRequestId && !controller.signal.aborted) {
          wikiStore.showError(err)
        }
      } finally {
        wikiStore.stopLoading('page-delete')
        if (this.deleteAbortController === controller) {
          this.deleteAbortController = null
        }
        if (requestId === this.deleteRequestId) {
          this.loading = false
          if (this.isShown) {
            await this.$nextTick()
            this.focusCancel()
          }
        }
      }
    }
  }
})
</script>

<style lang='scss'>
  body.page-deleted-pending {
    perspective: 50vw;
    height: 100vh;
    height: 100dvh;
    overflow: hidden;

    .v-application {
      background-color: rgb(var(--v-theme-background));
    }
    .v-application__wrap {
      transform-style: preserve-3d;
      transform: translateZ(-5vw) rotateX(2deg);
      border-radius: var(--wiki-panel-radius);
      overflow: hidden;
    }
  }
  body.page-deleted {
    perspective: 50vw;

    .v-application__wrap {
      transform-style: preserve-3d;
      transform: translateZ(-1000vw) rotateX(60deg);
      opacity: 0;
    }
  }

  .page-delete__metadata {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    gap: var(--wiki-space-2);
    margin-block-start: var(--wiki-space-3);
  }

  .page-delete__locale,
  .page-delete__path {
    margin: 0;
  }

  .page-delete__path {
    min-width: 0;
    max-width: 100%;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 399.98px) {
    .page-delete__path {
      flex-basis: 100%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    body.page-deleted-pending {
      perspective: none;

      .v-application__wrap {
        transform: none;
        transition: none;
      }
    }

    body.page-deleted {
      perspective: none;

      .v-application__wrap {
        transform: none;
        transition: none;
        opacity: 0;
      }
    }
  }
</style>
