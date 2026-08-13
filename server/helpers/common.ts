import type { ModulePropInput, ParsedModuleProp } from '../models/moduleTypes.ts'
import _ from 'lodash'
import { DateTime } from 'luxon'

interface CommonHelper {
  getTypeDefaultValue: (type: string) => string | number | boolean | undefined
  parseModuleProps: (props: Record<string, ModulePropInput>) => Record<string, ParsedModuleProp>
  getCookieOpts: () => { expires: Date, secure?: true }
}

const commonHelper: CommonHelper = {
  getTypeDefaultValue (type: string) {
    switch (type.toLowerCase()) {
      case 'string': return ''
      case 'number': return 0
      case 'boolean': return false
    }
  },
  parseModuleProps (props: Record<string, ModulePropInput>) {
    const result: Record<string, ParsedModuleProp> = {}
    for (const [key, value] of Object.entries(props)) {
      const definition = typeof value === 'string' ? null : value
      const type = typeof value === 'string' ? value : value.type
      const defaultValue = definition && !_.isNil(definition.default) ? definition.default : this.getTypeDefaultValue(type)
      _.set(result, key, {
        default: defaultValue, type: type.toLowerCase(), title: definition?.title || _.startCase(key),
        hint: definition?.hint || false, enum: definition?.enum || false, multiline: definition?.multiline || false,
        sensitive: definition?.sensitive || false, maxWidth: definition?.maxWidth || 0, order: definition?.order || 100
      })
    }
    return result
  },
  getCookieOpts () {
    const wiki = WIKI as unknown as { config: { host: string } }
    return { expires: DateTime.utc().plus({ days: 365 }).toJSDate(), ...(wiki.config.host.startsWith('https://') ? { secure: true as const } : {}) }
  }
}

export default commonHelper
