<template lang='pug'>
  v-card.editor-modal-drawio(
    ref='modalRoot'
    flat
    rounded='0'
    role='dialog'
    aria-modal='true'
    aria-labelledby='drawio-editor-title'
  )
    v-toolbar.editor-modal-drawio__toolbar(color='surface', density='comfortable')
      v-btn(
        ref='closeButton'
        icon='mdi-arrow-left'
        variant='text'
        :aria-label='$t(`editor:editorModalDrawio.backEditor`)'
        @click='close'
      )
      v-toolbar-title#drawio-editor-title {{ $t(`editor:editorModalDrawio.drawIo`) }}
    iframe(
      v-if='!loadError'
      ref='drawio'
      :key='frameVersion'
      src='https://embed.diagrams.net/?embed=1&proto=json&spin=1&saveAndExit=1&noSaveBtn=1&noExitBtn=0'
      :title='$t(`editor:editorModalDrawio.diagramEditor`)'
    )
    div.editor-modal-drawio__focus-boundary(
      v-if='!loadError && focusScope && !disposed'
      tabindex='0'
      aria-hidden='true'
      @focus='handleFrameExit'
    )
    async-state.editor-modal-drawio__state(
      v-if='loading && !loadError'
      state='loading'
      :title='$t(`editor:editorModalDrawio.loadingDiagramEditor`)'
    )
    async-state.editor-modal-drawio__state(
      v-if='loadError'
      state='error'
      :title='$t(`editor:editorModalDrawio.diagramEditorUnavailable2`)'
      :message='loadError'
      :retry-label='$t(`editor:editorModalDrawio.retry`)'
      @retry='retry'
    )
</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'
import { emitEditorInsert } from '../../helpers/editor-insert-events'
import { isRecord } from '../../helpers/type-guards'
import AsyncState from '@/components/common/async-state.vue'
import { createModalFocusScope, type ModalFocusScope } from '../common/modal-focus-scope'

const DRAWIO_ORIGIN = 'https://embed.diagrams.net'

type DrawioRequest =
  | {
      action: 'load'
      autosave: 0
      modified: 'unsavedChanges'
      xml: string | null
      title: string
    }
  | {
      action: 'export'
      format: 'xmlsvg'
    }

import { defineComponent } from 'vue'

export default defineComponent({
  components: { AsyncState },
  data() {
    return {
      loading: true,
      loadError: '',
      frameVersion: 0,
      diagramXml: null as string | null,
      loadTimer: null as ReturnType<typeof setTimeout> | null,
      returnFocus: null as HTMLElement | null,
      focusScope: null as ModalFocusScope | null,
      disposed: false
    }
  },
  methods: {
    clearLoadTimer () {
      if (this.loadTimer) {
        clearTimeout(this.loadTimer)
        this.loadTimer = null
      }
    },
    startLoadTimer () {
      this.clearLoadTimer()
      this.loadTimer = setTimeout(() => {
        if (this.loading) {
          this.showError(this.$t('editor:editorModalDrawio.diagramEditorDidNot'))
        }
      }, 15000)
    },
    showError (message: string) {
      this.clearLoadTimer()
      this.loading = false
      this.loadError = message
      this.$nextTick(() => {
        if (!this.disposed) this.focusScope?.focusFirst()
      })
    },
    retry () {
      this.loading = true
      this.loadError = ''
      this.frameVersion += 1
      this.startLoadTimer()
      this.$nextTick(() => {
        if (!this.disposed) this.focusScope?.focusFirst()
      })
    },
    handleFrameExit () {
      if (this.disposed) return
      this.focusScope?.focusFirst()
    },
    close () {
      if (this.disposed) return
      this.disposed = true
      this.clearLoadTimer()
      window.removeEventListener('message', this.receive)
      wikiStore.editor.activeModal = ''
    },
    send (msg: DrawioRequest) {
      const drawio = this.$refs.drawio as HTMLIFrameElement | undefined
      if (!drawio?.contentWindow) {
        this.showError(this.$t('editor:editorModalDrawio.diagramEditorUnavailable'))
        return
      }
      drawio.contentWindow.postMessage(JSON.stringify(msg), DRAWIO_ORIGIN)
    },
    receive (evt: MessageEvent<unknown>) {
      const drawio = this.$refs.drawio as HTMLIFrameElement | undefined
      if (evt.origin !== DRAWIO_ORIGIN || !drawio?.contentWindow || evt.source !== drawio.contentWindow || typeof evt.data !== 'string' || evt.data.length < 1) {
        return
      }
      try {
        const msg: unknown = JSON.parse(evt.data)
        if (!isRecord(msg) || typeof msg.event !== 'string') {
          return
        }
        switch (msg.event) {
          case 'init': {
            this.loading = false
            this.clearLoadTimer()
            this.send({
              action: 'load',
              autosave: 0,
              modified: 'unsavedChanges',
              xml: this.diagramXml,
              title: wikiStore.page.title
            })
            break
          }
          case 'save': {
            if (msg.exit === true) {
              this.send({
                action: 'export',
                format: 'xmlsvg'
              })
            }
            break
          }
          case 'export': {
            if (typeof msg.data !== 'string') {
              this.showError(this.$t('editor:editorModalDrawio.diagramCouldNotExported'))
              break
            }
            const svgDataStart = msg.data.indexOf('base64,')
            if (svgDataStart < 0) {
              this.showError(this.$t('editor:editorModalDrawio.diagramExportWasInvalid'))
              break
            }
            emitEditorInsert({
              kind: 'DIAGRAM',
              text: msg.data.slice(svgDataStart + 7)
            })
            this.close()
            break
          }
          case 'error':
            this.showError(typeof msg.message === 'string' ? msg.message : this.$t('editor:editorModalDrawio.diagramEditorReportedError'))
            break
          case 'exit':
            this.close()
            break
        }
      } catch {
        this.showError(this.$t('editor:editorModalDrawio.diagramEditorReturnedInvalid'))
      }
    }
  },
  mounted () {
    this.diagramXml = typeof wikiStore.editor.activeModalData === 'string'
      ? wikiStore.editor.activeModalData
      : null
    wikiStore.editor.activeModalData = null
    this.returnFocus = document.activeElement as HTMLElement | null
    window.addEventListener('message', this.receive)
    this.startLoadTimer()
    this.$nextTick(() => {
      if (this.disposed) return
      const modalRoot = this.$refs.modalRoot as HTMLElement | { $el?: unknown } | undefined
      const root = modalRoot instanceof HTMLElement ? modalRoot : modalRoot?.$el
      if (!(root instanceof HTMLElement)) return
      this.focusScope = createModalFocusScope({
        root,
        restoreTarget: () => this.returnFocus,
        onEscape: this.close
      })
      const closeButton = this.$refs.closeButton as { $el?: unknown } | undefined
      if (closeButton?.$el instanceof HTMLElement) closeButton.$el.focus()
    })
  },
  beforeUnmount () {
    this.disposed = true
    this.focusScope?.deactivate()
    this.focusScope = null
    this.clearLoadTimer()
    window.removeEventListener('message', this.receive)
  }
})
</script>

<style lang='scss'>
.editor-modal-drawio {
  position: fixed !important;
  top: 0;
  left: 0;
  // Match Vuetify's overlay layer; inert app bars still paint above ordinary content.
  z-index: 2000;
  width: 100%;
  height: 100vh;
  height: 100dvh;
  background-color: rgb(var(--v-theme-surface)) !important;
  display: flex;
  flex-direction: column;
  overflow: hidden;

  &__toolbar {
    position: relative;
    z-index: 2;
    flex: 0 0 auto;
    background-color: rgb(var(--v-theme-surface)) !important;
    color: rgb(var(--v-theme-on-surface));
  }

  &__focus-boundary {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    pointer-events: none;
  }

  &__state {
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: 1;
    width: min(30rem, calc(100% - 2rem));
    transform: translate(-50%, -50%);
  }

  > iframe {
    flex: 1 1 auto;
    width: 100%;
    min-height: 0;
    border: 0;
    padding: 0;
    background-color: rgb(var(--v-theme-surface));
  }
}

@media (prefers-reduced-motion: reduce) {
  .editor-modal-drawio {
    animation: none !important;
  }
}
</style>
