import hljs from 'highlight.js'
import type { CheerioAPI } from 'cheerio'

const plugin = {
  async init(
    $: CheerioAPI,
    _config: Readonly<Record<string, unknown>>
  ): Promise<void> {
    void _config
    $('pre > code').each((_index, element) => {
      const codeClasses = $(element).attr('class') || ''
      if (codeClasses.indexOf('language-') < 0) {
        hljs.highlightAuto($(element).text())
        $(element).addClass('language-')
      }
      $(element).parent().addClass('prismjs line-numbers')
    })
  }
}

export default plugin
