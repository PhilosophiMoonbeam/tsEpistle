import type { App, Plugin } from 'vue'
import filesize from 'filesize.js'
import _ from 'lodash'
import moment, { type MomentInput } from 'moment-timezone'

export const helpers = {
  filesize (rawSize: number): string {
    return _.toUpper(filesize(rawSize))
  },
  makeSafePath (rawPath: string): string {
    return _.split(_.trim(rawPath), '/')
      .map(part => _.kebabCase(_.deburr(_.trim(part))))
      .filter(Boolean)
      .join('/')
  },
  resolvePath (rawPath: string): string {
    const path = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath
    return `${siteConfig.path ?? ''}${path}`
  },
  setInputSelection (input: HTMLInputElement | HTMLTextAreaElement, startPos: number, endPos: number): void {
    input.focus()
    input.setSelectionRange(startPos, endPos)
  },
  formatMoment (input: MomentInput | [string, moment.MomentFormatSpecification], method: string): unknown {
    const date = Array.isArray(input) && typeof input[0] === 'string' && input.length === 2
      ? moment(input[0], input[1] as moment.MomentFormatSpecification, true)
      : typeof input === 'number'
        ? input.toString().length < 12 ? moment.unix(input) : moment(input)
        : moment(input as MomentInput)

    if (!input || !date.isValid()) {
      console.warn('Could not build a valid `moment` object from input.')
      return input
    }
    if (method === 'from') return date.fromNow(false)
    if (method === 'calendar') return date.calendar(moment(), {})
    return date.format(method)
  }
}

const helpersPlugin: Plugin = {
  install (app: App): void {
    app.config.globalProperties.$helpers = helpers
    app.config.globalProperties.$moment = moment
  }
}

export default helpersPlugin
