import _ from 'lodash'

const isoDurationReg = /^(-|\+)?P(?:([-+]?[0-9,.]*)Y)?(?:([-+]?[0-9,.]*)M)?(?:([-+]?[0-9,.]*)W)?(?:([-+]?[0-9,.]*)D)?(?:T(?:([-+]?[0-9,.]*)H)?(?:([-+]?[0-9,.]*)M)?(?:([-+]?[0-9,.]*)S)?)?$/

const configHelper = {
  parseConfigValue (cfg: string, requireEnvironment = false): string {
    return _.replace(cfg, /\$\(([A-Z0-9_]+)(?::(.+))?\)/g, (_match: string, name: string, fallback?: string) => {
      const value = process.env[name] || fallback
      if (value === undefined && requireEnvironment) throw new Error(`Missing environment variable ${name}`)
      return value ?? ''
    })
  },
  isValidDurationString (value: string): boolean { return isoDurationReg.test(value) }
}

export default configHelper
