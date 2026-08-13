import type { MarkdownIt } from 'markdown-it'
import * as mdExpandTabsModule from 'markdown-it-expand-tabs'
import _ from 'lodash'

interface ExpandTabsConfig {
  tabWidth: number
}

type ExpandTabsPlugin = (markdown: MarkdownIt, options?: { tabWidth?: number }) => void

const isExpandTabsPlugin = (value: unknown): value is ExpandTabsPlugin => typeof value === 'function'

const moduleValue: unknown = mdExpandTabsModule
const mdExpandTabs = typeof moduleValue === 'object' &&
  moduleValue !== null &&
  'default' in moduleValue &&
  isExpandTabsPlugin(moduleValue.default)
  ? moduleValue.default
  : isExpandTabsPlugin(moduleValue)
    ? moduleValue
    : null

if (!mdExpandTabs) {
  throw new TypeError('markdown-it-expand-tabs does not export a plugin function')
}

// ------------------------------------
// Markdown - Expand Tabs
// ------------------------------------

const plugin = {
  init (md: MarkdownIt, conf: ExpandTabsConfig): void {
    md.use(mdExpandTabs, {
      tabWidth: _.toInteger(conf.tabWidth || 4)
    })
  }
}

export default plugin
