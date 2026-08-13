import type { MarkdownIt } from 'markdown-it'
import type { UnknownRecord } from '../../types.ts'
import * as mdImsizeModule from 'markdown-it-imsize'

type ImageSizePlugin = (markdown: MarkdownIt) => void

const isImageSizePlugin = (value: unknown): value is ImageSizePlugin => typeof value === 'function'

const moduleValue: unknown = mdImsizeModule
const mdImsize = typeof moduleValue === 'object' &&
  moduleValue !== null &&
  'default' in moduleValue &&
  isImageSizePlugin(moduleValue.default)
  ? moduleValue.default
  : isImageSizePlugin(moduleValue)
    ? moduleValue
    : null

if (!mdImsize) {
  throw new TypeError('markdown-it-imsize does not export a plugin function')
}

// ------------------------------------
// Markdown - Image Size
// ------------------------------------

const plugin = {
  init (md: MarkdownIt, _conf: UnknownRecord): void {
    void _conf
    md.use(mdImsize)
  }
}

export default plugin
