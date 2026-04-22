const _ = require('lodash')
const cheerio = require('cheerio')

function buildTocFromHtml (html) {
  const $ = cheerio.load(html)
  const isStrict = $('h1').length > 0
  const toc = { root: [] }

  $('h1,h2,h3,h4,h5,h6').each((idx, el) => {
    const depth = _.toSafeInteger(el.name.substring(1)) - (isStrict ? 1 : 2)
    let leafPathError = false

    const leafPath = _.reduce(_.times(depth), (curPath) => {
      if (_.has(toc, curPath)) {
        const lastLeafIdx = _.get(toc, curPath).length - 1
        if (lastLeafIdx >= 0) {
          return `${curPath}[${lastLeafIdx}].children`
        }
        leafPathError = true
      }
      return curPath
    }, 'root')

    if (leafPathError) {
      return
    }

    const leafSlug = $('.toc-anchor', el).first().attr('href')
    $('.toc-anchor', el).remove()

    _.get(toc, leafPath).push({
      title: _.trim($(el).text()),
      anchor: leafSlug,
      children: []
    })
  })

  return toc.root
}

module.exports = {
  buildTocFromHtml
}
