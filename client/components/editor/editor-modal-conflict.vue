<template lang='pug'>
  v-card.editor-modal-conflict.animated.fadeIn(flat, tile)
    .pa-4
      v-toolbar.radius-7(flat, color='indigo', style='border-bottom-left-radius: 0; border-bottom-right-radius: 0;', dark)
        v-icon.mr-3 mdi-merge
        .subtitle-1 {{$t('editor:conflict.title')}}
        v-spacer
        v-btn(outlined, color='white', @click='useLocal', :title='$t(`editor:conflict.useLocalHint`)')
          v-icon(left) mdi-alpha-l-box
          span {{$t('editor:conflict.useLocal')}}
        v-dialog(
          v-model='isRemoteConfirmDiagShown'
          width='500'
          )
          template(v-slot:activator='{ props }')
            v-btn.ml-3(outlined, color='white', v-bind='props', :title='$t(`editor:conflict.useRemoteHint`)')
              v-icon(left) mdi-alpha-r-box
              span {{$t('editor:conflict.useRemote')}}
          v-card
            .dialog-header.is-short.is-indigo
              v-icon.mr-3(color='white') mdi-alpha-r-box
              span {{$t('editor:conflict.overwrite.title')}}
            v-card-text.pa-4
              i18next.body-2(tag='div', path='editor:conflict.overwrite.description')
                strong(place='refEditsLost') {{$t('editor:conflict.overwrite.editsLost')}}
            div.v-card-chin
              v-spacer
              v-btn(outlined, color='indigo', @click='isRemoteConfirmDiagShown = false')
                v-icon(left) mdi-close
                span {{$t('common:actions.cancel')}}
              v-btn(@click='useRemote', color='indigo', dark)
                v-icon(left) mdi-check
                span {{$t('common:actions.confirm')}}
        v-divider.mx-3(vertical)
        v-btn(outlined, color='indigo lighten-4', @click='close')
          v-icon(left) mdi-close
          span {{$t('common:actions.cancel')}}
      v-row.indigo.darken-1.body-2(no-gutters)
        v-col.pa-4
          v-icon.mr-3(color='white') mdi-alpha-l-box
          i18next.white--text(tag='span', path='editor:conflict.localVersion')
            em.indigo--text.text--lighten-4(place='refEditable') {{$t('editor:conflict.editable')}}
        v-divider(vertical)
        v-col.pa-4
          v-icon.mr-3(color='white') mdi-alpha-r-box
          i18next.white--text(tag='span', path='editor:conflict.remoteVersion')
            em.indigo--text.text--lighten-4(place='refReadOnly') {{$t('editor:conflict.readonly')}}
      v-row.grey.lighten-2.body-2(no-gutters)
        v-col.px-4.py-2
          i18next.grey--text.text--darken-2(tag='em', path='editor:conflict.leftPanelInfo')
            span(place='date', :title='$helpers.formatMoment(checkoutDateActive, `LLL`)') {{ $helpers.formatMoment(checkoutDateActive, 'from') }}
        v-divider(vertical)
        v-col.px-4.py-2
          i18next.grey--text.text--darken-2(tag='em', path='editor:conflict.rightPanelInfo')
            strong(place='authorName') {{latest.authorName}}
            span(place='date', :title='$helpers.formatMoment(latest.updatedAt, `LLL`)') {{ $helpers.formatMoment(latest.updatedAt, 'from') }}
      v-row.grey.lighten-3.grey--text.text--darken-3(no-gutters)
        v-col.pa-4
          .body-2
            strong.indigo--text {{$t('editor:conflict.pageTitle')}}
            strong.pl-2 {{title}}
          .caption
            strong.indigo--text {{$t('editor:conflict.pageDescription')}}
            span.pl-2 {{description}}
        v-divider(vertical, light)
        v-col.pa-4
          .body-2
            strong.indigo--text {{$t('editor:conflict.pageTitle')}}
            strong.pl-2 {{latest.title}}
          .caption
            strong.indigo--text {{$t('editor:conflict.pageDescription')}}
            span.pl-2 {{latest.description}}
      v-card.radius-7(:light='!$vuetify.theme.current.dark', :dark='$vuetify.theme.current.dark')
        div(ref='cm')
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
      this.checkoutDateActive = this.latest.updatedAt
      emitEditorConflictResolved()
      this.close()
    },
    useLocal () {
      wikiStore.editor.content = this.cm!.getValue()
      this.overwriteAndClose()
    },
    useRemote () {
      wikiStore.editor.content = this.latest.content
      this.overwriteAndClose()
    }
  },
  async mounted () {
    let language: Extension = html()
    if (this.editorKey === 'markdown') {
      language = markdown()
    }

    let resp
    try {
      resp = await fetchPageConflictLatest(window.fetch.bind(window), wikiStore.page.id)
    } catch (err) {
      resp = null
    }

    if (!resp) {
      return showNotification(wikiStore, {
        message: 'Failed to fetch latest version.',
        style: 'warning',
        icon: 'warning'
      })
    }
    this.latest = resp

    const container = this.$refs.cm as HTMLElement
    container.style.height = 'calc(100vh - 265px)'
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
  },
  beforeUnmount () {
    this.cm?.destroy()
    this.cm = null
  }
}
</script>

<style lang='scss'>
.editor-modal-conflict {
  position: fixed !important;
  top: 0;
  left: 0;
  z-index: 10;
  width: 100%;
  height: 100vh;
  background-color: rgba(0, 0, 0, .9) !important;
  overflow: auto;
}
</style>
