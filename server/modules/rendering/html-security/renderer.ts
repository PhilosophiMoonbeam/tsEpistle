import createDOMPurify from 'dompurify'
import jsdomModule from 'jsdom'

const { JSDOM } = jsdomModule

interface SecurityConfig {
  allowDrawIoUnsafe: boolean
  allowIFrames: boolean
  safeHTML: boolean
}

const isParentNode = (node: Node): node is Node & ParentNode => (
  'querySelectorAll' in node
)

const plugin = {
  async init(input: string, config: SecurityConfig): Promise<string> {
    if (config.safeHTML) {
      const window = new JSDOM('').window
      const document = window.document
      if (!document) {
        throw new TypeError('JSDOM did not provide a document')
      }
      const DOMPurify = createDOMPurify(window)

      const allowedAttrs = ['v-pre', 'v-slot:tabs', 'v-slot:content', 'target']
      const allowedTags = ['tabset', 'template']

      if (config.allowDrawIoUnsafe) {
        allowedTags.push('foreignObject')
        DOMPurify.addHook('uponSanitizeElement', (element) => {
          if (!isParentNode(element)) {
            return
          }
          const breaks = element.querySelectorAll('foreignObject br, foreignObject p')
          for (let i = 0; i < breaks.length; i++) {
            const breakNode = breaks[i]
            if (!breakNode?.parentNode) {
              continue
            }
            breakNode.parentNode.replaceChild(
              document.createElement('div'),
              breakNode
            )
          }
        })
      }

      if (config.allowIFrames) {
        allowedTags.push('iframe')
        allowedAttrs.push('allow')
      }

      input = DOMPurify.sanitize(input, {
        ADD_ATTR: allowedAttrs,
        ADD_TAGS: allowedTags,
        HTML_INTEGRATION_POINTS: { foreignobject: true }
      })
    }
    return input
  }
}

export default plugin
