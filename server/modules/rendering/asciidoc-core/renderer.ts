import { convert } from '@asciidoctor/core'
import * as cheerio from 'cheerio'

interface AsciidocConfig {
  safeMode: string
}

interface AsciidocRendererContext {
  config: AsciidocConfig
  input: string
}

const plugin = {
  async render(this: AsciidocRendererContext): Promise<string> {
    const converted = await convert(this.input, {
      standalone: false,
      safe: this.config.safeMode,
      attributes: {
        showtitle: true,
        icons: 'font'
      }
    })
    if (typeof converted !== 'string') {
      throw new TypeError('Asciidoctor did not return HTML')
    }

    const $ = cheerio.load(converted)

    $('pre.highlight > code.language-diagram').each((_index, element) => {
      const encodedDiagram = $(element).html()
      if (encodedDiagram === null) {
        return
      }
      const diagramContent = Buffer.from(encodedDiagram, 'base64').toString()
      $(element).parent().replaceWith(`<pre class="diagram">${diagramContent}</div>`)
    })

    return $.html()
  }
}

export default plugin
