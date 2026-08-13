import type { CheerioAPI } from 'cheerio'

const plugin = {
  init(
    $: CheerioAPI,
    _config: Readonly<Record<string, unknown>>
  ): void {
    void _config
    $('pre.prismjs > code.language-mermaid').each((_index, element) => {
      const mermaidContent = $(element).html()
      if (mermaidContent === null) {
        return
      }
      $(element).parent().replaceWith(`<div class="mermaid">${mermaidContent}</div>`)
    })
  }
}

export default plugin
