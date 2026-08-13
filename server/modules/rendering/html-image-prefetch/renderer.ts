import { wiki } from '../../types.ts'
import type { Cheerio, CheerioAPI } from 'cheerio'
import type { Element } from 'domhandler'


const prefetch = async (element: Cheerio<Element>): Promise<void> => {
  const url = element.attr(`src`)
  let response
  try {
    if (typeof url !== 'string') {
      throw new Error('Image prefetch source is missing')
    }
    response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Image prefetch failed with HTTP ${response.status}`)
    }
  } catch (err: unknown) {
    wiki.logger.warn(`Failed to prefetch ${url}`)
    wiki.logger.warn(err instanceof Error ? err.message : String(err))
    return
  }
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
  const image = Buffer.from(await response.arrayBuffer()).toString('base64')
  element.attr('src', `data:${contentType};base64,${image}`)
  element.removeClass('prefetch-candidate')
}

const plugin = {
  async init($: CheerioAPI): Promise<void> {
    const promises = $('img.prefetch-candidate').map((_index, element) => {
      return prefetch($(element))
    }).toArray()
    await Promise.all(promises)
  }
}

export default plugin
