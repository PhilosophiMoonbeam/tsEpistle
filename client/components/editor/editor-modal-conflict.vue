<template lang='pug'>
  v-dialog.editor-modal-conflict-dialog(:model-value='true', fullscreen, scrollable, @update:model-value='close')
    v-card.editor-modal-conflict.animated.fadeIn(flat, rounded='0')
      .editor-modal-conflict-header
        v-toolbar.radius-7(flat, color='indigo', style='border-bottom-left-radius: 0; border-bottom-right-radius: 0;')
          v-icon.mr-3 mdi-merge
          .text-body-large {{$t('editor:conflict.title')}}
          v-spacer
          v-progress-circular(v-if='isLoading', indeterminate, size='20', width='2', color='white', aria-label='Loading latest version')
          v-btn(variant="outlined", color="indigo-lighten-4", @click='close')
            v-icon(start) mdi-close
            span {{$t('common:actions.cancel')}}
      template(v-if='isLoading')
        v-sheet.pa-6(color='transparent')
          v-skeleton-loader(type='heading, paragraph, paragraph, paragraph')
      template(v-else-if='loadError')
        v-alert.ma-6(type='error', variant='tonal', role='alert') {{loadError}}
        .editor-modal-conflict-actions
          v-btn(variant='text', @click='close') {{$t('common:actions.cancel')}}
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
          v-btn(variant="text", @click='close') {{$t('common:actions.cancel')}}
          v-btn(variant="outlined", color='indigo', :disabled='!cm', @click='useLocal')
            v-icon(start) mdi-check
            span {{$t('editor:conflict.useLocal')}}
          v-dialog(
            v-model='isRemoteConfirmDiagShown'
            width='500'
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
                span {{$t('editor:conflict.overwrite.title')}}
              v-card-text.pa-4
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
</template>
<script lang='ts'>
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
export default {
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
      isRemoteConfirmDiagShown: false
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
    pageId() {
      return wikiStore.page.id
    },
    title() {
      return wikiStore.page.title
    },
    description() {
      return wikiStore.page.description
    },
    updatedAt() {
      return wikiStore.page.updatedAt
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
    close () {
      this.isRemoteConfirmDiagShown = false
      this.activeModal = ''
    },
    overwriteAndClose() {
      if (!this.latestLoaded) return
      this.checkoutDateActive = this.latest.updatedAt
      emitEditorConflictResolved()
      this.close()
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
      this.isLoading = true
      this.loadError = ''
      this.latestLoaded = false
      this.cm?.destroy()
      this.cm = null
      let resp: ConflictLatest | null = null
      try {
        resp = await fetchPageConflictLatest(window.fetch.bind(window), wikiStore.page.id)
      } catch {
        resp = null
      }
      if (this.activeModal !== 'editorModalConflict') return
      if (!resp) {
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
      const language: Extension | undefined = this.editorKey === 'markdown'
        ? markdown()
        : this.editorKey === 'code' || this.editorKey === 'html'
          ? html()
          : undefined
      const container = this.$refs.cm as HTMLElement
      this.cm = new TextEditor({
        parent: container,
        value: wikiStore.editor.content,
        language,
        direction: siteConfig.rtl ? 'rtl' : 'ltr',
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
      })
      this.latestLoaded = true
      this.isLoading = false
    }
  },
  async mounted () {
    await this.loadConflict()
  },
  beforeUnmount () {
    this.cm?.destroy()
    this.cm = null
  }
}
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
    padding: 12px 16px;
    color: #fff;
  }

  &-legend-current {
    background: mc('indigo', '800');
  }

  &-legend-remote {
    background: mc('indigo', '900');
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
