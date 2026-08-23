<template lang='pug'>
  v-card.editor-modal-drawio.animated.fadeIn(flat, rounded='0')
    iframe(
      ref='drawio'
      src='https://embed.diagrams.net/?embed=1&proto=json&spin=1&saveAndExit=1&noSaveBtn=1&noExitBtn=0'
      frameborder='0'
    )
</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'
import { emitEditorConflictResolved } from '../../helpers/editor-conflict-events'
import { emitEditorInsert } from '../../helpers/editor-insert-events'
import { isRecord } from '../../helpers/type-guards'

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

// const xmlTest = `<?xml version="1.0" encoding="UTF-8"?>
// <mxfile version="13.4.2">
//   <diagram id="SgbkCjxR32CZT1FvBvkp" name="Page-1">
//     <mxGraphModel dx="2062" dy="1123" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
//       <root>
//         <mxCell id="0" />
//         <mxCell id="1" parent="0" />
//         <mxCell id="5gE3BTvRYS_8FoJnOusC-1" value="" style="whiteSpace=wrap;html=1;aspect=fixed;fillColor=#f8cecc;strokeColor=#b85450;" vertex="1" parent="1">
//           <mxGeometry x="380" y="530" width="80" height="80" as="geometry" />
//         </mxCell>
//       </root>
//     </mxGraphModel>
//   </diagram>
// </mxfile>
// `

export default {
  data() {
    return {
      content: ''
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
    }
  },
  methods: {
    close () {
      this.activeModal = ''
    },
    overwriteAndClose() {
      emitEditorConflictResolved()
      this.close()
    },
    send (msg: DrawioRequest) {
      const drawio = this.$refs.drawio as HTMLIFrameElement
      drawio.contentWindow!.postMessage(JSON.stringify(msg), '*')
    },
    receive (evt: MessageEvent<unknown>) {
      const drawio = this.$refs.drawio as HTMLIFrameElement
      if (evt.source !== drawio.contentWindow || typeof evt.data !== 'string' || evt.data.length < 1) {
        return
      }
      try {
        const msg: unknown = JSON.parse(evt.data)
        if (!isRecord(msg) || typeof msg.event !== 'string') {
          return
        }
        switch (msg.event) {
          case 'init': {
            this.send({
              action: 'load',
              autosave: 0,
              modified: 'unsavedChanges',
              xml: wikiStore.editor.activeModalData as string | null,
              title: wikiStore.page.title
            })
            wikiStore.editor.activeModalData = null
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
              throw new Error('Draw.io export response is missing diagram data.')
            }
            const svgDataStart = msg.data.indexOf('base64,') + 7
            emitEditorInsert({
              kind: 'DIAGRAM',
              text: msg.data.slice(svgDataStart)
              // text: msg.xml.replace(/ agent="(.*?)"/, '').replace(/ host="(.*?)"/, '').replace(/ etag="(.*?)"/, '')
            })
            this.close()
            break
          }
          case 'exit': {
            this.close()
            break
          }
        }
      } catch (err) {
        console.error(err)
      }
    }
  },
  async mounted () {
    window.addEventListener('message', this.receive)
  },
  beforeUnmount () {
    window.removeEventListener('message', this.receive)
  }
}
</script>

<style lang='scss'>
.editor-modal-drawio {
  position: fixed !important;
  top: 0;
  left: 0;
  z-index: 10;
  width: 100%;
  height: 100vh;
  background-color: rgba(255,255,255, 1) !important;
  overflow: hidden;

  > iframe {
    width: 100%;
    height: 100vh;
    border: 0;
    padding: 0;
    background-color: #FFF;
  }
}
</style>
