import _ from 'lodash'

import errors from './errors.ts'

const { ApplicationError } = errors

interface ParseConfigOptions {
  errorMessage: string
  unwrap?: boolean
  code?: string
}

interface ConfigEntry {
  key: string
  value: string
}

interface DefinitionProperty {
  sensitive?: boolean
  [key: string]: unknown
}

interface ConfigDefinition {
  props?: Record<string, DefinitionProperty>
  [key: string]: unknown
}

interface SerializeConfigOptions {
  config?: Record<string, unknown>
  definition?: ConfigDefinition
  knownOnly?: boolean
  maskSensitive?: boolean
}

const isConfigEntry = (entry: unknown): entry is ConfigEntry => Boolean(
  entry &&
  typeof entry === 'object' &&
  !Array.isArray(entry) &&
  typeof Reflect.get(entry, 'key') === 'string' &&
  typeof Reflect.get(entry, 'value') === 'string'
)

const hasContent = (value: unknown): boolean => {
  if (typeof value === 'string' || Array.isArray(value)) {
    return value.length > 0
  }
  return Boolean(value && typeof value === 'object' && typeof Reflect.get(value, 'length') === 'number' && Reflect.get(value, 'length') > 0)
}

const parseConfig = (
  config: unknown,
  { errorMessage, unwrap = true, code = 'INVALID_CONFIGURATION' }: ParseConfigOptions
): Record<string, unknown> => {
  if (!Array.isArray(config)) {
    throw new ApplicationError(errorMessage, { code })
  }
  return config.reduce<Record<string, unknown>>((result, entry: unknown) => {
    if (!isConfigEntry(entry)) {
      throw new ApplicationError(errorMessage, { code })
    }
    try {
      _.set(result, entry.key, unwrap ? _.get(JSON.parse(entry.value) as unknown, 'v', null) : entry.value)
    } catch {
      throw new ApplicationError(errorMessage, { code })
    }
    return result
  }, {})
}

const serializeConfig = ({
  config = {},
  definition = {},
  knownOnly = false,
  maskSensitive = false
}: SerializeConfigOptions): ConfigEntry[] => {
  const result: ConfigEntry[] = []
  for (const [key, value] of Object.entries(config)) {
    const property = definition.props?.[key]
    if (!knownOnly || property) {
      result.push({
        key,
        value: JSON.stringify({
          ...(property ?? {}),
          value: maskSensitive && property?.sensitive && hasContent(value) ? '********' : value
        })
      })
    }
  }
  return _.sortBy(result, 'key')
}

function validateRows<Row>(
  rows: unknown,
  validate: (row: unknown) => row is Row,
  message: string
): asserts rows is Row[] {
  if (!Array.isArray(rows) || rows.some(row => !validate(row))) {
    throw new ApplicationError(message, { code: 'INVALID_CONFIGURATION' })
  }
}

export { validateRows }
export default { parseConfig, serializeConfig }
