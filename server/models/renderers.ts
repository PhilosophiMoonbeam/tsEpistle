import { Model } from 'objection'
import type { Knex } from 'knex'
import path from 'node:path'
import fs from 'fs-extra'
import _ from 'lodash'
import * as yaml from 'js-yaml'
import { DepGraph } from 'dependency-graph'
import commonHelper from '../helpers/common.ts'
import { readModuleDefinition, type LoadedModuleDefinition, type ModuleConfig } from './moduleTypes.ts'


/**
 * Renderer model
 */
interface RendererDefinition extends LoadedModuleDefinition {
  enabledDefault?: boolean
  dependsOn?: string
  input?: string
  output?: string
  children?: RendererDefinition[]
}

function loadRendererDefinition (value: unknown, source: string): RendererDefinition {
  const definition = readModuleDefinition(value, source)
  const enabledDefault = definition.enabledDefault
  const dependsOn = definition.dependsOn
  const input = definition.input
  const output = definition.output
  if (enabledDefault !== undefined && typeof enabledDefault !== 'boolean') throw new Error(`Invalid renderer enabledDefault: ${source}`)
  if (dependsOn !== undefined && typeof dependsOn !== 'string') throw new Error(`Invalid renderer dependency: ${source}`)
  if (input !== undefined && typeof input !== 'string') throw new Error(`Invalid renderer input: ${source}`)
  if (output !== undefined && typeof output !== 'string') throw new Error(`Invalid renderer output: ${source}`)
  return {
    ...definition,
    props: commonHelper.parseModuleProps(definition.props),
    ...(enabledDefault === undefined ? {} : { enabledDefault }),
    ...(dependsOn === undefined ? {} : { dependsOn }),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output })
  }
}

export default class Renderer extends Model {
  declare key: string
  declare isEnabled: boolean
  declare config: ModuleConfig

  static override get tableName () { return 'renderers' }
  static override get idColumn () { return 'key' }
  static override get jsonSchema () { return { type: 'object', required: ['key', 'isEnabled'], properties: { key: { type: 'string' }, isEnabled: { type: 'boolean' } } } }
  static override get jsonAttributes () { return ['config'] }

  static async getRenderers (): Promise<Renderer[]> {
    return WIKI.models.renderers.query()
  }

  static async fetchDefinitions (): Promise<void> {
    const rendererDirs = await fs.readdir(path.join(WIKI.SERVERPATH, 'modules/rendering'))
    const diskRenderers: RendererDefinition[] = []
    for (const dir of rendererDirs) {
      const definitionPath = path.join(WIKI.SERVERPATH, 'modules/rendering', dir, 'definition.yml')
      diskRenderers.push(loadRendererDefinition(yaml.load(await fs.readFile(definitionPath, 'utf8')), definitionPath))
    }
    WIKI.data.renderers = diskRenderers
  }

  static async refreshRenderersFromDisk (): Promise<void> {
    let trx: Knex.Transaction | undefined
    try {
      const dbRenderers = await WIKI.models.renderers.query()
      await WIKI.models.renderers.fetchDefinitions()
      const newRenderers: Array<Pick<Renderer, 'key' | 'isEnabled' | 'config'>> = []
      for (const renderer of WIKI.data.renderers) {
        if (!_.some(dbRenderers, ['key', renderer.key])) {
          newRenderers.push({
            key: renderer.key,
            isEnabled: renderer.enabledDefault ?? true,
            config: _.transform(renderer.props, (result: ModuleConfig, value, key) => {
              _.set(result, key, value.default)
              return result
            }, {})
          })
        } else {
          const rendererConfig = _.get(_.find(dbRenderers, ['key', renderer.key]), 'config', {})
          await WIKI.models.renderers.query().patch({
            config: _.transform(renderer.props, (result: ModuleConfig, value, key) => {
              if (!_.has(result, key)) _.set(result, key, value.default)
              return result
            }, rendererConfig)
          }).where('key', renderer.key)
        }
      }
      if (newRenderers.length > 0) {
        trx = await WIKI.models.Objection.transaction.start(WIKI.models.knex)
        for (const renderer of newRenderers) await WIKI.models.renderers.query(trx).insert(renderer)
        await trx.commit()
        WIKI.logger.info(`Loaded ${newRenderers.length} new renderers: [ OK ]`)
      } else {
        WIKI.logger.info('No new renderers found: [ SKIPPED ]')
      }
      for (const renderer of dbRenderers) {
        if (!_.some(WIKI.data.renderers, ['key', renderer.key])) {
          await WIKI.models.renderers.query().where('key', renderer.key).del()
          WIKI.logger.info(`Removed renderer ${renderer.key} because it is no longer present in the modules folder: [ OK ]`)
        }
      }
    } catch (err) {
      WIKI.logger.error('Failed to scan or load new renderers: [ FAILED ]')
      WIKI.logger.error(err)
      if (trx) await trx.rollback()
    }
  }

  static async getRenderingPipeline (contentType: string): Promise<RendererDefinition[] | false> {
    const renderersDb = await WIKI.models.renderers.query().where('isEnabled', true)
    if (!renderersDb.length) {
      WIKI.logger.error('Rendering pipeline is empty!')
      return false
    }
    const renderers = renderersDb.map((storedRenderer): RendererDefinition => {
      const definition = _.find(WIKI.data.renderers, ['key', storedRenderer.key])
      if (!definition) throw new Error(`Renderer definition not found: ${storedRenderer.key}`)
      return { ...definition, config: storedRenderer.config }
    })
    const rawCores = renderers.filter(renderer => renderer.dependsOn === undefined).map(core => {
      core.children = renderers.filter(renderer => renderer.dependsOn === core.key)
      return core
    })
    const graph = new DepGraph({ circular: true })
    rawCores.forEach(core => graph.addNode(core.key))
    rawCores.forEach(core => rawCores.forEach(coreTarget => {
      if (core.key !== coreTarget.key && core.output === coreTarget.input) graph.addDependency(core.key, coreTarget.key)
    }))
    let activeCoreKeys = rawCores.filter(core => core.input === contentType).map(core => core.key)
    for (const coreKey of [...activeCoreKeys]) activeCoreKeys = _.union(activeCoreKeys, graph.dependenciesOf(coreKey))
    const activeCores = rawCores.filter(core => activeCoreKeys.includes(core.key))
    const graphActive = new DepGraph({ circular: true })
    activeCores.forEach(core => graphActive.addNode(core.key))
    activeCores.forEach(core => activeCores.forEach(coreTarget => {
      if (core.key !== coreTarget.key && core.output === coreTarget.input) graphActive.addDependency(core.key, coreTarget.key)
    }))
    const orderedCores: RendererDefinition[] = []
    for (const coreKey of graphActive.overallOrder().reverse()) {
      const core = rawCores.find(candidate => candidate.key === coreKey)
      if (core) orderedCores.push(core)
    }
    return orderedCores
  }
}

const WIKI = globalThis.WIKI as unknown as {
  SERVERPATH: string
  data: { renderers: RendererDefinition[] }
  logger: { info(message: string): void, error(value: unknown): void }
  models: {
    renderers: typeof Renderer
    knex: Knex
    Objection: { transaction: { start(knex: Knex): Promise<Knex.Transaction> } }
  }
}
