import asciidoctorModule from 'asciidoctor'
import type { Asciidoctor } from 'asciidoctor'
import * as cheerio from 'cheerio'

interface AsciidocConfig {
  safeMode: string
}

interface AsciidocRendererContext {
  config: AsciidocConfig
  input: string
}
type AsciidoctorFactory = () => Asciidoctor

const isAsciidoctorFactory = (value: unknown): value is AsciidoctorFactory => typeof value === 'function'
const factory: unknown = asciidoctorModule

if (!isAsciidoctorFactory(factory)) {
  throw new TypeError('asciidoctor does not export a factory function')
}


const asciidoctor = factory()

const plugin = {
  async render(this: AsciidocRendererContext): Promise<string> {
    const converted = asciidoctor.convert(this.input, {
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
