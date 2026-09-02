import fs from 'node:fs/promises'
import { load } from 'js-yaml'

import { beforeEach, describe, expect, it, vi } from '../test/bun-test.mts'

interface LoggerDefinition {
  key: string
  props: Record<string, Record<string, unknown>>
}

interface LoggerRow {
  key: string
  isEnabled: boolean
  level: string
  config: Record<string, unknown>
}

interface ListedLogger {
  key: string
  props: Record<string, Record<string, unknown>>
  config: Array<{ key: string; value: string }>
}

const isListedLogger = (value: unknown): value is ListedLogger => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const key: unknown = Reflect.get(value, 'key')
  const props: unknown = Reflect.get(value, 'props')
  const config: unknown = Reflect.get(value, 'config')
  return (
    typeof key === 'string' &&
    typeof props === 'object' &&
    props !== null &&
    !Array.isArray(props) &&
    Object.keys(props).every(propertyKey => {
      const property: unknown = Reflect.get(props, propertyKey)
      return typeof property === 'object' && property !== null && !Array.isArray(property)
    }) &&
    Array.isArray(config) &&
    config.every((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return false
      }
      return typeof Reflect.get(entry, 'key') === 'string' && typeof Reflect.get(entry, 'value') === 'string'
    })
  )
}

const requireListedLoggers = (values: Array<Record<string, unknown>>): ListedLogger[] =>
  values.map(value => {
    if (!isListedLogger(value)) {
      throw new TypeError('Expected a listed logger')
    }
    return value
  })

const readDefinition = async (logger: string): Promise<LoggerDefinition> => {
  const source = await fs.readFile(new URL(`../modules/logging/${logger}/definition.yml`, import.meta.url), 'utf8')
  return load(source) as LoggerDefinition
}

const definitions = await Promise.all([readDefinition('bugsnag'), readDefinition('loggly')])

let rows: LoggerRow[] = []
const getLoggers = vi.fn(async (): Promise<LoggerRow[]> => rows)
const where = vi.fn(async (_column: string, _value: unknown): Promise<number> => 1)
const patch = vi.fn((_data: Record<string, unknown>) => ({ where }))
const query = vi.fn(() => ({ patch }))
const wiki = {
  data: { loggers: definitions },
  models: { loggers: { getLoggers, query } }
}

Reflect.set(globalThis, 'WIKI', wiki)
// logging.ts reads WIKI.models during module initialization, so the test fixture must be installed first.
const { default: logging } = await import('./logging.ts')

const encodedValue = (value: string): string => JSON.stringify({ v: value })

const decodeConfig = (logger: ListedLogger): Record<string, Record<string, unknown>> =>
  Object.fromEntries(logger.config.map(entry => [entry.key, JSON.parse(entry.value) as Record<string, unknown>]))

const updateInput = (config: Array<{ key: string; value: string }>) => [
  {
    key: 'loggly',
    isEnabled: true,
    level: 'warn',
    config
  }
]

beforeEach(() => {
  rows = []
  vi.clearAllMocks()
  Reflect.set(globalThis, 'WIKI', wiki)
})

describe('logger sensitive configuration', () => {
  it('lists configured credentials as masked values with sensitive metadata', async () => {
    rows = [
      { key: 'bugsnag', isEnabled: true, level: 'warn', config: { key: 'bugsnag-secret' } },
      {
        key: 'loggly',
        isEnabled: true,
        level: 'warn',
        config: { token: 'loggly-secret', subdomain: 'customer-logs' }
      }
    ]

    const listed = requireListedLoggers(await logging.listLoggers())
    const bugsnag = listed.find(logger => logger.key === 'bugsnag')
    const loggly = listed.find(logger => logger.key === 'loggly')

    expect(bugsnag).toBeDefined()
    expect(loggly).toBeDefined()
    if (!bugsnag || !loggly) {
      throw new TypeError('Expected configured loggers')
    }
    expect(bugsnag?.props.key?.sensitive).toBe(true)
    expect(loggly?.props.token?.sensitive).toBe(true)

    const bugsnagConfig = decodeConfig(bugsnag)
    const logglyConfig = decodeConfig(loggly)
    expect(bugsnagConfig.key).toMatchObject({ sensitive: true, value: '********' })
    expect(logglyConfig.token).toMatchObject({ sensitive: true, value: '********' })
    expect(logglyConfig.subdomain).toMatchObject({ value: 'customer-logs' })
    expect(logglyConfig.subdomain?.sensitive).toBeUndefined()
  })

  it('preserves the stored sensitive value when the masked value is submitted', async () => {
    rows = [
      {
        key: 'loggly',
        isEnabled: true,
        level: 'warn',
        config: { token: 'stored-secret', subdomain: 'customer-logs' }
      }
    ]

    await logging.updateLoggers(
      updateInput([
        { key: 'token', value: encodedValue('********') },
        { key: 'subdomain', value: encodedValue('next-logs') }
      ])
    )

    expect(patch).toHaveBeenCalledWith({
      isEnabled: true,
      level: 'warn',
      config: {
        token: 'stored-secret',
        subdomain: encodedValue('next-logs')
      }
    })
    expect(where).toHaveBeenCalledWith('key', 'loggly')
  })

  it.each([
    ['an explicit replacement', 'replacement-secret'],
    ['an explicit empty clear', '']
  ])('keeps %s explicit for a sensitive property', async (_scenario, submittedValue) => {
    rows = [
      {
        key: 'loggly',
        isEnabled: true,
        level: 'warn',
        config: { token: 'stored-secret' }
      }
    ]

    await logging.updateLoggers(updateInput([{ key: 'token', value: encodedValue(submittedValue) }]))

    expect(patch).toHaveBeenCalledWith({
      isEnabled: true,
      level: 'warn',
      config: { token: encodedValue(submittedValue) }
    })
  })

  it('does not treat the mask sentinel as preservation for a non-sensitive property', async () => {
    rows = [
      {
        key: 'loggly',
        isEnabled: true,
        level: 'warn',
        config: { token: 'stored-secret', subdomain: 'stored-subdomain' }
      }
    ]

    await logging.updateLoggers(
      updateInput([
        { key: 'token', value: encodedValue('********') },
        { key: 'subdomain', value: encodedValue('********') }
      ])
    )

    expect(patch).toHaveBeenCalledWith({
      isEnabled: true,
      level: 'warn',
      config: {
        token: 'stored-secret',
        subdomain: encodedValue('********')
      }
    })
  })
})
