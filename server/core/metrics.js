const _ = require('lodash')
const { collectDefaultMetrics, register, Gauge } = require('prom-client')

/* global WIKI */

module.exports = {
  customMetrics: {},
  async init () {
    if (WIKI.config.metrics.isEnabled) {
      WIKI.logger.info('Initializing metrics...')

      register.clear()
      register.setDefaultLabels({
        WIKI_INSTANCE: WIKI.INSTANCE_ID
      })

      collectDefaultMetrics({ register })

      this.customMetrics.groupsTotal = new Gauge({
        name: 'wiki_groups_total',
        help: 'Total number of groups',
        async collect () {
          const total = await WIKI.models.groups.query().count('* as total').first()
          this.set(_.toSafeInteger(total.total))
        }
      })

      this.customMetrics.pagesTotal = new Gauge({
        name: 'wiki_pages_total',
        help: 'Total number of pages',
        async collect () {
          const total = await WIKI.models.pages.query().count('* as total').first()
          this.set(_.toSafeInteger(total.total))
        }
      })

      this.customMetrics.tagsTotal = new Gauge({
        name: 'wiki_tags_total',
        help: 'Total number of tags',
        async collect () {
          const total = await WIKI.models.tags.query().count('* as total').first()
          this.set(_.toSafeInteger(total.total))
        }
      })

      this.customMetrics.usersTotal = new Gauge({
        name: 'wiki_users_total',
        help: 'Total number of users',
        async collect () {
          const total = await WIKI.models.users.query().count('* as total').first()
          this.set(_.toSafeInteger(total.total))
        }
      })
      WIKI.logger.info('Metrics ready [ OK ]')
    } else {
      this.customMetrics = {}
      register.clear()
    }

    return this
  },
  async render (res) {
    try {
      res.contentType(register.contentType)
      res.send(await register.metrics())
    } catch (err) {
      res.status(500).end(err.message)
    }
  }
}
