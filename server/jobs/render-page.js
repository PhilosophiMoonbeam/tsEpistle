const _ = require('lodash')
const { buildTocFromHtml } = require('./render-page-toc')

/* global WIKI */

module.exports = async (pageId) => {
  WIKI.logger.info(`Rendering page ID ${pageId}...`)

  try {
    WIKI.models = require('../core/db').init()
    await WIKI.configSvc.loadFromDb()
    await WIKI.configSvc.applyFlags()

    const page = await WIKI.models.pages.getPageFromDb(pageId)
    if (!page) {
      throw new Error('Invalid Page Id')
    }

    await WIKI.models.renderers.fetchDefinitions()
    const pipeline = await WIKI.models.renderers.getRenderingPipeline(page.contentType)

    let output = page.content

    if (_.isEmpty(page.content)) {
      await WIKI.models.knex.destroy()
      WIKI.logger.warn(`Failed to render page ID ${pageId} because content was empty: [ FAILED ]`)
    }

    for (let core of pipeline) {
      const renderer = require(`../modules/rendering/${_.kebabCase(core.key)}/renderer.js`)
      output = await renderer.render.call({
        config: core.config,
        children: core.children,
        page: page,
        input: output
      })
    }

    // Parse TOC
    const toc = buildTocFromHtml(output)

    // Save to DB
    await WIKI.models.pages.query()
      .patch({
        render: output,
        toc: JSON.stringify(toc)
      })
      .where('id', pageId)

    // Save to cache
    await WIKI.models.pages.savePageToCache({
      ...page,
      render: output,
      toc: JSON.stringify(toc)
    })

    await WIKI.models.knex.destroy()

    WIKI.logger.info(`Rendering page ID ${pageId}: [ COMPLETED ]`)
  } catch (err) {
    WIKI.logger.error(`Rendering page ID ${pageId}: [ FAILED ]`)
    WIKI.logger.error(err.message)
    // exit process with error code
    throw err
  }
}
