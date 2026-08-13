import _ from 'lodash'

import configuration, { validateRows } from './configuration.ts'

const { parseConfig, serializeConfig } = configuration

interface ConfigEntry {
  key: string
  value: string
}

interface RendererRow {
  key: string
  isEnabled: boolean
  config: ConfigEntry[] | Record<string, unknown>
  [key: string]: unknown
}

interface RendererQuery {
  patch(data: Record<string, unknown>): { where(column: string, value: unknown): Promise<unknown> }
}

interface RendererModel {
  getRenderers(): Promise<RendererRow[]>
  query(): RendererQuery
}

const rendererModel = (WIKI.models as { renderers: RendererModel }).renderers
const rendererDefinitions = (WIKI.data as { renderers: Array<Record<string, unknown> & { key: string }> }).renderers

const validRenderer = (renderer: unknown): renderer is RendererRow => Boolean(
  renderer &&
  typeof renderer === 'object' &&
  !Array.isArray(renderer) &&
  typeof Reflect.get(renderer, 'key') === 'string' &&
  typeof Reflect.get(renderer, 'isEnabled') === 'boolean' &&
  Array.isArray(Reflect.get(renderer, 'config'))
)

const listRenderers = async (orderBy?: string): Promise<Array<Record<string, unknown>>> => {
  const renderers = await rendererModel.getRenderers()
  const result = renderers.map(renderer => {
    const definition = _.find(rendererDefinitions, ['key', renderer.key]) ?? {}
    return {
      ...definition,
      ...renderer,
      config: serializeConfig({ config: renderer.config as Record<string, unknown>, definition, knownOnly: true })
    }
  })
  return orderBy ? _.sortBy(result, [orderBy]) : result
}

const updateRenderers = async (renderers: unknown): Promise<void> => {
  validateRows(renderers, validRenderer, 'Invalid renderers payload')
  const updates = renderers.map(renderer => ({
    key: renderer.key,
    isEnabled: renderer.isEnabled,
    config: parseConfig(renderer.config, { errorMessage: 'Invalid renderers payload' })
  }))
  for (const renderer of updates) {
    await rendererModel.query().patch({
      isEnabled: renderer.isEnabled,
      config: renderer.config
    }).where('key', renderer.key)
  }
}

export default { listRenderers, updateRenderers }
