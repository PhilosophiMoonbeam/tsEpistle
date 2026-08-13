import { Model } from 'objection'
import fs from 'fs-extra'
import path from 'node:path'
import _ from 'lodash'
import * as yaml from 'js-yaml'
import commonHelper from '../helpers/common.ts'
import {
  readModuleDirectories,
  readModuleDefinition,
  type LoadedModuleDefinition,
  type ModuleConfig
} from './moduleTypes.ts'

interface AuthenticationDefinition extends LoadedModuleDefinition {
  title?: string
  useForm?: boolean
}

interface NormalizedAuthentication extends Record<string, unknown> {
  key: string
  domainWhitelist: string[]
  autoEnrollGroups: number[]
}

export default class Authentication extends Model {
  declare key: string
  declare isEnabled: boolean
  declare config: ModuleConfig
  declare selfRegistration: boolean
  declare domainWhitelist: { v?: string[] } | string[]
  declare autoEnrollGroups: { v?: number[] } | number[]
  declare order: number
  declare strategyKey: string
  declare displayName: string

  static override get tableName () { return 'authentication' }
  static override get idColumn () { return 'key' }
  static override get jsonSchema () {
    return {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string' },
        selfRegistration: { type: 'boolean' }
      }
    }
  }
  static override get jsonAttributes () { return ['config', 'domainWhitelist', 'autoEnrollGroups'] }

  static async getStrategy (key: string): Promise<Authentication | undefined> {
    return wiki.models.authentication.query().findOne({ key })
  }

  static async getStrategies (): Promise<NormalizedAuthentication[]> {
    const strategies = await wiki.models.authentication.query().orderBy('order')
    return strategies.map(strategy => ({
      ...strategy,
      domainWhitelist: unwrapArray(strategy.domainWhitelist, (value): value is string => typeof value === 'string'),
      autoEnrollGroups: unwrapArray(strategy.autoEnrollGroups, (value): value is number => typeof value === 'number')
    }))
  }


  static async refreshStrategiesFromDisk (): Promise<void> {
    try {
      const dbStrategies = await wiki.models.authentication.query()
      const authDirs = await readModuleDirectories(path.join(wiki.SERVERPATH, 'modules/authentication'))
      wiki.data.authentication = []
      for (const dir of authDirs) {
        const definitionPath = path.join(wiki.SERVERPATH, 'modules/authentication', dir, 'definition.yml')
        const raw = await fs.readFile(definitionPath, 'utf8')
        const definition = readModuleDefinition(yaml.load(raw), definitionPath)
        wiki.data.authentication.push({
          ...definition,
          props: commonHelper.parseModuleProps(definition.props)
        })
      }

      for (const strategy of dbStrategies) {
        let newProps = false
        const strategyDefinition = _.find(wiki.data.authentication, ['key', strategy.strategyKey])
        if (!strategyDefinition) {
          await wiki.models.authentication.query().delete().where('key', strategy.key)
          wiki.logger.info(`Authentication strategy ${strategy.strategyKey} was removed from disk: [ REMOVED ]`)
          continue
        }
        strategy.config = _.transform(strategyDefinition.props, (result: ModuleConfig, value, key) => {
          if (!_.has(result, key)) {
            _.set(result, key, value.default)
            newProps = true
          }
          return result
        }, strategy.config)
        if (!strategy.displayName) {
          await wiki.models.authentication.query().patch({ displayName: strategyDefinition.title ?? '' }).where('key', strategy.key)
        }
        if (newProps) {
          await wiki.models.authentication.query().patch({ config: strategy.config }).where('key', strategy.key)
        }
      }
      wiki.logger.info(`Loaded ${wiki.data.authentication.length} authentication strategies: [ OK ]`)
    } catch (err) {
      wiki.logger.error('Failed to scan or load new authentication providers: [ FAILED ]')
      wiki.logger.error(err)
    }
  }
}

function unwrapArray<T> (value: unknown, isValue: (entry: unknown) => entry is T): T[] {
  const candidate = Array.isArray(value) ? value : typeof value === 'object' && value !== null ? Reflect.get(value, 'v') : undefined
  return Array.isArray(candidate) && candidate.every(isValue) ? candidate : []
}

const wiki = globalThis.WIKI as unknown as {
  ROOTPATH: string
  SERVERPATH: string
  data: { authentication: AuthenticationDefinition[] }
  logger: { info(message: string): void, error(value: unknown): void }
  models: { authentication: typeof Authentication }
}
