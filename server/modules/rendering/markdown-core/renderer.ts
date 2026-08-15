import type { MarkdownIt, MarkdownItOptions } from 'markdown-it'
import type { RendererContext, UnknownRecord } from '../../types.ts'
import * as markdownItModule from 'markdown-it'
import * as mdAttrsModule from 'markdown-it-attrs'
import _ from 'lodash'
import underline from './underline.ts'
import {
  installContentExtensionFenceRule,
  prepareContentExtensionFences
} from '../../../content-extensions/renderer.ts'

interface MarkdownRendererConfig extends UnknownRecord {
  allowHTML: boolean
  linebreaks: boolean
  linkify: boolean
  typographer: boolean
  quotes: string
  underline: boolean
}

interface MarkdownRendererContext extends RendererContext<MarkdownRendererConfig> {
  input: string
}

interface ChildRenderer {
  init(markdown: MarkdownIt, config: UnknownRecord): void | Promise<void>
}

interface ChildRendererModule {
  default: ChildRenderer
}

type MarkdownItFactory = (options?: MarkdownItOptions) => MarkdownIt
type AttributesPlugin = (
  markdown: MarkdownIt,
  options?: {
    leftDelimiter?: string
    rightDelimiter?: string
    allowedAttributes?: Array<string | RegExp>
  }
) => void

const isMarkdownItFactory = (value: unknown): value is MarkdownItFactory => typeof value === 'function'
const isAttributesPlugin = (value: unknown): value is AttributesPlugin => typeof value === 'function'

function resolveCallable<T> (
  moduleValue: unknown,
  isCallable: (value: unknown) => value is T,
  packageName: string
): T {
  if (isCallable(moduleValue)) {
    return moduleValue
  }
  if (
    typeof moduleValue === 'object' &&
    moduleValue !== null &&
    'default' in moduleValue &&
    isCallable(moduleValue.default)
  ) {
    return moduleValue.default
  }
  throw new TypeError(`${packageName} does not export a callable function`)
}

function isChildRendererModule (value: unknown): value is ChildRendererModule {
  if (typeof value !== 'object' || value === null || !('default' in value)) {
    return false
  }
  const renderer = value.default
  return typeof renderer === 'object' &&
    renderer !== null &&
    'init' in renderer &&
    typeof renderer.init === 'function'
}

const createMarkdownIt = resolveCallable(markdownItModule, isMarkdownItFactory, 'markdown-it')
const mdAttrs = resolveCallable(mdAttrsModule, isAttributesPlugin, 'markdown-it-attrs')

const quoteStyles = {
  Chinese: '””‘’',
  English: '“”‘’',
  French: ['«\xA0', '\xA0»', '‹\xA0', '\xA0›'],
  German: '„“‚‘',
  Greek: '«»‘’',
  Japanese: '「」「」',
  Hungarian: '„”’’',
  Polish: '„”‚‘',
  Portuguese: '«»‘’',
  Russian: '«»„“',
  Spanish: '«»‘’',
  Swedish: '””’’'
}

const isQuoteStyle = (value: string): value is keyof typeof quoteStyles => value in quoteStyles

const plugin = {
  async render (this: MarkdownRendererContext): Promise<string> {
    const mkdown = createMarkdownIt({
      html: this.config.allowHTML,
      breaks: this.config.linebreaks,
      linkify: this.config.linkify,
      typographer: this.config.typographer,
      quotes: quoteStyles[isQuoteStyle(this.config.quotes) ? this.config.quotes : 'English'],
      highlight (str: string, lang: string): string {
        if (lang === 'diagram') {
          return `<pre class="diagram">` + Buffer.from(str, 'base64').toString() + `</pre>`
        }
        return `<pre><code class="language-${lang}">${_.escape(str)}</code></pre>`
      }
    })

    if (this.config.underline) {
      mkdown.use(underline)
    }

    mkdown.use(mdAttrs, {
      allowedAttributes: ['id', 'class', 'target']
    })

    for (const child of this.children) {
      // Child renderers are selected from the configured rendering pipeline at runtime.
      const rendererModule: unknown = await import(`../${_.kebabCase(child.key)}/renderer.ts`)
      if (!isChildRendererModule(rendererModule)) {
        throw new TypeError(`Renderer ${child.key} does not export an initializer`)
      }
      await rendererModule.default.init(mkdown, child.config)
    }

    const contentExtensionFences = await prepareContentExtensionFences(mkdown.parse(this.input, {}))
    installContentExtensionFenceRule(mkdown, contentExtensionFences)

    return mkdown.render(this.input)
  }
}

export default plugin
