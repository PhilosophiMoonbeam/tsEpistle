import type { CheerioAPI } from 'cheerio'

const plugin = {
  async init(
    $: CheerioAPI,
    _config: Readonly<Record<string, unknown>>
  ): Promise<void> {
    void _config
    $('pre.diagram').each((_index, element) => {
      $(element).children('svg').each((_svgIndex, svg) => {
        $(svg).removeAttr('content')
      })
      $(element).replaceWith($(`<div class="diagram">${$(element).html()}</div>`))
    })
  }
}

export default plugin
