<template lang='pug'>
  v-dialog.editor-modal-conflict-dialog(:model-value='true', fullscreen, scrollable, aria-labelledby='editor-conflict-title', @update:model-value='onDialogModelUpdate')
    v-card.editor-modal-conflict.animated.fadeIn(flat, rounded='0', :aria-busy='isLoading')
      .editor-modal-conflict-header
        v-toolbar.radius-7(flat, color='indigo', style='border-bottom-left-radius: 0; border-bottom-right-radius: 0;')
          v-icon.mr-3 mdi-merge
          .text-body-large#editor-conflict-title {{$t('editor:conflict.title')}}
          v-spacer
          v-progress-circular(v-if='isLoading', indeterminate, size='20', width='2', color='white', aria-label='Loading latest version')
          v-btn(variant="outlined", color="indigo-lighten-4", @click='requestClose')
            v-icon(start) mdi-close
            span {{$t('common:actions.cancel')}}
      template(v-if='isLoading')
        v-sheet.pa-6(color='transparent')
          v-skeleton-loader(type='heading, paragraph, paragraph, paragraph')
      template(v-else-if='loadError')
        v-alert.ma-6(type='error', variant='tonal', role='alert') {{loadError}}
        .editor-modal-conflict-actions
          v-btn(variant='text', @click='requestClose') {{$t('common:actions.cancel')}}
          v-btn(color='indigo', @click='loadConflict') Retry
      template(v-else)
        .editor-modal-conflict-legend
          .editor-modal-conflict-legend-current
            v-icon.mr-2(color='white') mdi-pencil-outline
            span Current draft (editable)
          .editor-modal-conflict-legend-remote
            v-icon.mr-2(color='white') mdi-source-branch
            span Remote original (read-only inserted chunks)
        .editor-modal-conflict-meta
          .editor-modal-conflict-meta-local
            strong Current draft
            span {{title}}
            span {{description}}
          .editor-modal-conflict-meta-remote
            strong Remote version
            span {{latest.title}}
            span {{latest.description}}
            span {{latest.authorName}} · {{ $helpers.formatMoment(latest.updatedAt, 'from') }}
        .editor-modal-conflict-editor
          div(ref='cm')
        .editor-modal-conflict-actions
          v-btn(variant="text", @click='requestClose') {{$t('common:actions.cancel')}}
          v-btn(variant="outlined", color='indigo', :disabled='!cm || !latestLoaded', @click='useLocal')
            v-icon(start) mdi-check
            span {{$t('editor:conflict.useLocal')}}
          v-dialog(
            v-model='isRemoteConfirmDiagShown'
            width='500'
            aria-labelledby='editor-conflict-overwrite-title'
            role='alertdialog'
            aria-describedby='editor-conflict-overwrite-description'
          )
            template(v-slot:activator='{ props }')
              v-btn(
                variant="flat"
                color='indigo'
                v-bind='props'
                :disabled='!cm || !latestLoaded'
                :title='$t(`editor:conflict.useRemoteHint`)'
              )
                v-icon(start) mdi-check
                span {{$t('editor:conflict.useRemote')}}
            v-card
              .dialog-header.is-short.is-indigo
                v-icon.mr-3(color='white') mdi-alpha-r-box
                span#editor-conflict-overwrite-title {{$t('editor:conflict.overwrite.title')}}
              v-card-text.pa-4#editor-conflict-overwrite-description
                i18next.text-body-medium(tag='div', path='editor:conflict.overwrite.description')
                  strong(place='refEditsLost') {{$t('editor:conflict.overwrite.editsLost')}}
              div.v-card-chin
                v-spacer
                v-btn(variant="outlined", color='indigo', @click='isRemoteConfirmDiagShown = false')
                  v-icon(start) mdi-close
                  span {{$t('common:actions.cancel')}}
                v-btn(@click='useRemote', color='indigo')
                  v-icon(start) mdi-check
                  span {{$t('common:actions.confirm')}}
          v-dialog(
            v-model='isDiscardConfirmDiagShown'
            max-width='500'
            role='alertdialog'
            aria-labelledby='editor-conflict-discard-title'
            aria-describedby='editor-conflict-discard-description'
            @after-leave='restoreMergeFocus'
          )
            v-card
              .dialog-header.is-short.is-red
                v-icon.mr-3(color='white', aria-hidden='true') mdi-alert
                span#editor-conflict-discard-title Discard merge edits?
              v-card-text.pa-4#editor-conflict-discard-description
                | Your editable merge has changed. Closing now will discard those edits.
              div.v-card-chin
                v-spacer
                v-btn(variant='outlined', color='indigo', @click='keepEditing') Keep editing
                v-btn(color='red', @click='discardMergeEdits') Discard merge edits
</template>
<script lang='ts'>
import { defineComponent, markRaw } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { emitEditorConflictResolved } from '../../helpers/editor-conflict-events'
import { fetchPageConflictLatest, type PageConflictLatest } from '../../helpers/pages-api'
import { showNotification } from '../../helpers/root-ui-store'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { unifiedMergeView } from '@codemirror/merge'
import type { Extension } from '@codemirror/state'
import { TextEditor, type TextEditorHandle } from './common/text-editor'

/* global siteConfig */


type ConflictLatest = Pick<PageConflictLatest, 'title' | 'description' | 'updatedAt' | 'authorName' | 'content'>
export default defineComponent({
  data() {
    return {
      cm: null as TextEditorHandle | null,
      latest: {
        title: '',
        description: '',
        updatedAt: '',
        authorName: '',
        content: ''
      } as ConflictLatest,
      latestLoaded: false,
      isLoading: true,
      loadError: '',
      isRemoteConfirmDiagShown: false,
      isDiscardConfirmDiagShown: false,
      initialMergeValue: null as string | null,
      mergeValue: '',
      requestController: null as AbortController | null,
      returnFocus: null as HTMLElement | null
    }
  },
  computed: {
    editorKey() {
      return wikiStore.editor.editorKey
    },
    activeModal: {
      get() {
        return wikiStore.editor.activeModal
      },
      set(value: string) {
        wikiStore.editor.activeModal = value
      }
    },
    title() {
      return wikiStore.page.title
    },
    description() {
      return wikiStore.page.description
    },
    isMergeDirty() {
      return this.initialMergeValue !== null && this.mergeValue !== this.initialMergeValue
    },
    checkoutDateActive: {
      get() {
        return wikiStore.editor.checkoutDateActive
      },
      set(value: string) {
        wikiStore.editor.checkoutDateActive = value
      }
    }
  },
  methods: {
    onDialogModelUpdate (isOpen: boolean) {
      if (!isOpen) this.requestClose()
    },
    requestClose () {
      if (this.isMergeDirty) {
        this.isRemoteConfirmDiagShown = false
        this.isDiscardConfirmDiagShown = true
        return
      }
      this.finishClose()
    },
    keepEditing () {
      this.isDiscardConfirmDiagShown = false
    },
    discardMergeEdits () {
      this.isDiscardConfirmDiagShown = false
      this.finishClose()
    },
    restoreMergeFocus () {
      if (this.activeModal === 'editorModalConflict') {
        this.$nextTick(() => this.cm?.focus())
      }
    },
    finishClose () {
      this.requestController?.abort()
      this.requestController = null
      this.isRemoteConfirmDiagShown = false
      this.isDiscardConfirmDiagShown = false
      this.activeModal = ''
    },
    overwriteAndClose() {
      if (!this.latestLoaded) return
      this.checkoutDateActive = this.latest.updatedAt
      emitEditorConflictResolved()
      this.finishClose()
    },
    useLocal () {
      if (!this.cm || !this.latestLoaded) return
      wikiStore.editor.content = this.cm.getValue()
      this.overwriteAndClose()
    },
    useRemote () {
      if (!this.latestLoaded) return
      wikiStore.editor.content = this.latest.content
      this.overwriteAndClose()
    },
    async loadConflict () {
      this.requestController?.abort()
      const requestController = markRaw(new AbortController())
      this.requestController = requestController
      this.isLoading = true
      this.loadError = ''
      this.latestLoaded = false
      this.cm?.destroy()
      this.cm = null
      this.initialMergeValue = null
      this.mergeValue = ''
      let resp: ConflictLatest | null = null
      try {
        resp = await fetchPageConflictLatest(
          (url, init) => window.fetch(url, { ...init, signal: requestController.signal }),
          wikiStore.page.id
        )
      } catch {
        if (requestController.signal.aborted) {
          if (this.requestController === requestController) this.requestController = null
          return
        }
      }
      if (requestController.signal.aborted || this.activeModal !== 'editorModalConflict') {
        if (this.requestController === requestController) this.requestController = null
        return
      }
      if (!resp) {
        if (this.requestController === requestController) this.requestController = null
        this.loadError = 'Failed to fetch the latest version. Retry to try again, or cancel to keep editing locally.'
        showNotification(wikiStore, {
          message: 'Failed to fetch latest version.',
          style: 'warning',
          icon: 'warning'
        })
        this.isLoading = false
        return
      }
      this.latest = resp
      this.isLoading = false
      await this.$nextTick()
      if (requestController.signal.aborted || this.activeModal !== 'editorModalConflict') {
        if (this.requestController === requestController) this.requestController = null
        return
      }
      const language: Extension | undefined = this.editorKey === 'markdown'
        ? markdown()
        : this.editorKey === 'code' || this.editorKey === 'html'
          ? html()
          : undefined
      const container = this.$refs.cm
      if (!(container instanceof HTMLElement)) {
        if (this.requestController === requestController) this.requestController = null
        this.loadError = 'The conflict editor could not be initialized.'
        return
      }
      const initialMergeValue = wikiStore.editor.content
      this.initialMergeValue = initialMergeValue
      this.mergeValue = initialMergeValue
      this.cm = markRaw(new TextEditor({
        parent: container,
        value: initialMergeValue,
        language,
        direction: siteConfig.rtl ? 'rtl' : 'ltr',
        onChange: value => {
          this.mergeValue = value
        },
        extensions: [
          unifiedMergeView({
            original: resp.content,
            mergeControls: false,
            collapseUnchanged: {
              margin: 3,
              minSize: 4
            }
          })
        ]
      }))
      if (this.requestController === requestController) this.requestController = null
      this.latestLoaded = true
      this.isLoading = false
    }
  },
  async mounted () {
    this.returnFocus = document.activeElement as HTMLElement | null
    await this.loadConflict()
  },
  beforeUnmount () {
    const target = this.returnFocus
    queueMicrotask(() => {
      if (target?.isConnected && !target.matches(':disabled') && !target.closest('[inert], [aria-hidden="true"]')) {
        target.focus({ preventScroll: true })
      }
    })
    this.requestController?.abort()
    this.requestController = null
    this.cm?.destroy()
    this.cm = null
  }
})
</script>

<style lang='scss'>
.editor-modal-conflict {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background-color: rgba(0, 0, 0, .9) !important;

  &-header {
    flex: 0 0 auto;
  }

  &-legend,
  &-meta {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    flex: 0 0 auto;
  }

  &-legend-current,
  &-legend-remote {
    padding: var(--wiki-space-3) var(--wiki-space-4);
    color: rgb(var(--v-theme-on-primary));
  }

  &-legend-current {
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 88%, black);
  }

  &-legend-remote {
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 72%, black);
  }

  &-meta-local,
  &-meta-remote {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 16px;
    color: mc('grey', '800');
    background: mc('grey', '200');
  }

  &-meta-remote {
    background: mc('grey', '300');
  }

  &-editor {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    padding: 0 16px;
    background: mc('grey', '900');
    > div {
      height: 100%;
    }
  }

  &-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 12px;
    padding: 12px 16px;
    flex: 0 0 auto;
    background: mc('grey', '900');
  }

  @include until($tablet) {
    &-legend,
    &-meta {
      grid-template-columns: 1fr;
    }

    &-editor {
      padding: 0 8px;
    }

    &-actions {
      justify-content: stretch;
      > .v-btn {
        flex: 1 1 100%;
      }
    }
  }
}
</style>
