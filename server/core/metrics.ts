import _ from 'lodash'
import { collectDefaultMetrics, Gauge, register } from 'prom-client'
import type { Response } from 'express'

interface Query { count(expression: string): Query; first(): Promise<{ total: unknown }> }
interface WikiContext {
  INSTANCE_ID: string
  config: { metrics: { isEnabled: boolean } }
  logger: { info(message: string): void }
  models: Record<'groups' | 'pages' | 'tags' | 'users', { query(): Query }>
}
const wiki = WIKI as unknown as WikiContext

const metrics = {
  customMetrics: {} as Record<string, Gauge>,
  async init() {
    if (wiki.config.metrics.isEnabled) {
      wiki.logger.info('Initializing metrics...')
      register.clear()
      register.setDefaultLabels({ WIKI_INSTANCE: wiki.INSTANCE_ID })
      collectDefaultMetrics({ register })
      for (const name of ['groups', 'pages', 'tags', 'users'] as const) {
        this.customMetrics[`${name}Total`] = new Gauge({
          name: `wiki_${name}_total`,
          help: `Total number of ${name}`,
          async collect() {
            const total = await wiki.models[name].query().count('* as total').first()
            this.set(_.toSafeInteger(total.total))
          }
        })
      }
      wiki.logger.info('Metrics ready [ OK ]')
    } else {
      this.customMetrics = {}
      register.clear()
    }
    return this
  },
  async render(res: Response) {
    try {
      res.contentType(register.contentType)
      res.send(await register.metrics())
    } catch (error) {
      res.status(500).end(error instanceof Error ? error.message : String(error))
    }
  }
}

export default metrics
