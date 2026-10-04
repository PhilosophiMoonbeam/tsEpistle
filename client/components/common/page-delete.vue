<template lang='pug'>
  v-dialog(
    v-model='isShown'
    max-width='550'
    scrollable
    :persistent='loading'
    scrim='surface'
    aria-labelledby='page-delete-dialog-title'
    aria-describedby='page-delete-dialog-description'
    @after-enter='focusCancel'
    @after-leave='restoreFocus'
    )
    v-card.page-delete
      .dialog-header
        v-icon.me-2(color='error', aria-hidden='true') mdi-file-document-remove-outline
        h2#page-delete-dialog-title {{$t('common:page.delete')}}
      v-card-text#page-delete-dialog-description
        .page-delete__identity
          strong {{ pageTitle }}
          span.page-delete__path /{{ pageLocale }}/{{ pagePath }}
          span.page-delete__path(v-if='pageVisibility === `private`') {{ $t('common:page.privatePage', { defaultValue: 'Private page' }) }}
        .page-delete__consequences
          i18next.text-body-large(path='common:page.deleteTitle', tag='p')
            strong(place='title') {{pageTitle}}
          p {{$t('common:page.deleteSubtitle')}}
      v-card-chin(ref='dialogActions')
        v-spacer
        v-btn(variant="text", @click='discard', :disabled='loading') {{$t('common:actions.cancel')}}
        v-btn.px-4(color='error', variant='flat', @click='deletePage', :loading='loading', :disabled='loading') {{$t('common:actions.delete')}}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'

import { deletePage as deletePageById } from '../../helpers/pages-api'

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
      deleteRequestId: 0,
      deleteAbortController: null as AbortController | null,
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
    pageId(): number { return wikiStore.page.id },
    pageVisibility(): string { return wikiStore.page.visibility },
    pageSourceRevision(): string { return wikiStore.page.sourceRevision }
  },
  beforeUnmount() {
    this.deleteRequestId += 1
    this.deleteAbortController?.abort()
    this.deleteAbortController = null
    this.returnFocusTarget = null
  },
  watch: {
    isShown(newValue: boolean) {
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
      }
    }
  },
  methods: {
    focusCancel(): void {
      const actions = this.$refs.dialogActions as { $el?: Element } | undefined
      actions?.$el?.querySelector<HTMLElement>('button')?.focus()
    },
    restoreFocus(): void {
      const target = this.returnFocusTarget
      this.returnFocusTarget = null
      if (target?.isConnected && target.getClientRects().length > 0 && !target.matches(':disabled')) {
        target.focus({ preventScroll: true })
      }
    },
    discard(): void {
      if (this.loading) return
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
        this.returnFocusTarget = null
        this.isShown = false
        window.location.assign('/')
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
.page-delete {
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  color: rgb(var(--v-theme-on-surface));
  .dialog-header h2 { margin: 0; font-size: 1rem; }
  .v-card-text { padding: 1.25rem; }
  .v-card-chin { border-block-start: 1px solid var(--wiki-surface-border); gap: .5rem; padding: .75rem 1.25rem; background: var(--wiki-surface-raised); }
  .v-btn { min-height: 44px; }
}
.page-delete__identity {
  display: grid;
  gap: .375rem;
  padding: 1rem;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  overflow-wrap: anywhere;
}
.page-delete__path { color: var(--wiki-text-muted); font-size: .8125rem; overflow-wrap: anywhere; }
.page-delete__consequences {
  margin-block-start: 1rem;
  padding-inline-start: 1rem;
  border-inline-start: 3px solid rgb(var(--v-theme-error));
  p { margin-block: .5rem; line-height: 1.5; }
}
@media (max-width: 599.98px) {
  .page-delete .v-card-chin { flex-wrap: wrap; }
  .page-delete .v-card-chin .v-btn { flex: 1 1 auto; }
}
</style>
