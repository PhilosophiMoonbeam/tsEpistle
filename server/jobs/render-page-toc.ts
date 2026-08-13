import * as cheerio from 'cheerio'
import type { Element } from 'domhandler'
import _ from 'lodash'

export interface TocNode {
  title: string
  anchor: string | undefined
  children: TocNode[]
}

export function buildTocFromHtml (html: string): TocNode[] {
  const $ = cheerio.load(html)
  const isStrict = $('h1').length > 0
  const toc: { root: TocNode[] } = { root: [] }

  $('h1,h2,h3,h4,h5,h6').each((_index, element) => {
    const heading = element as Element
    const depth = _.toSafeInteger(heading.name.substring(1)) - (isStrict ? 1 : 2)
    let leafPathError = false
    const leafPath = _.reduce(_.times(depth), currentPath => {
      if (_.has(toc, currentPath)) {
        const leaves = _.get(toc, currentPath) as TocNode[]
        const lastLeafIndex = leaves.length - 1
        if (lastLeafIndex >= 0) return `${currentPath}[${lastLeafIndex}].children`
        leafPathError = true
      }
      return currentPath
    }, 'root')
    if (leafPathError) return

    const leafSlug = $('.toc-anchor', heading).first().attr('href')
    $('.toc-anchor', heading).remove()
    const leaves = _.get(toc, leafPath) as TocNode[]
    leaves.push({
      title: _.trim($(heading).text()),
      anchor: leafSlug,
      children: []
    })
  })
  return toc.root
}

export default buildTocFromHtml
