<template lang='pug'>
  v-card.editor-modal-drawio.animated.fadeIn(
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
        aria-label='Back to editor'
        @click='close'
      )
      v-toolbar-title#drawio-editor-title Draw.io
    iframe(
      v-if='!loadError'
      ref='drawio'
      :key='frameVersion'
      src='https://embed.diagrams.net/?embed=1&proto=json&spin=1&saveAndExit=1&noSaveBtn=1&noExitBtn=0'
      title='Diagram editor'
    )
    async-state.editor-modal-drawio__state(
      v-if='loading && !loadError'
      state='loading'
      title='Loading diagram editor'
    )
    async-state.editor-modal-drawio__state(
      v-if='loadError'
      state='error'
      title='Diagram editor unavailable'
      :message='loadError'
      retry-label='Retry'
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
          this.showError('The diagram editor did not finish loading.')
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
        this.showError('The diagram editor is unavailable.')
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
              this.showError('The diagram could not be exported.')
              break
            }
            const svgDataStart = msg.data.indexOf('base64,')
            if (svgDataStart < 0) {
              this.showError('The diagram export was invalid.')
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
            this.showError(typeof msg.message === 'string' ? msg.message : 'The diagram editor reported an error.')
            break
          case 'exit':
            this.close()
            break
        }
      } catch {
        this.showError('The diagram editor returned an invalid response.')
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
      const root = this.$refs.modalRoot as HTMLElement | undefined
      if (!root) return
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
  z-index: 10;
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
