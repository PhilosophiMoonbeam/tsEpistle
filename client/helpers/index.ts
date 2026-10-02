import { ref, type App, type Plugin } from 'vue'
import { filesize } from 'filesize'
import deburr from 'lodash/deburr.js'
import kebabCase from 'lodash/kebabCase.js'
import moment, { type MomentInput } from 'moment-timezone'
import { isUserTimeFormat, isUserTimezone, type UserPresentationDefaults } from '../../shared/user-presentation.ts'

// Moment state is not reactive. Every presentation change bumps this revision,
// and formatMoment reads it, so computed date labels render again.
const presentationRevision = ref(0)
// True only while dates use the reader's own saved time zone. Otherwise the
// browser zone is in use and callers can name it.
const readerTimeZoneKnown = ref(false)

const localeDateFormats = new Map<string, Readonly<Pick<moment.LongDateFormatSpec, 'L' | 'LT' | 'LTS'>>>()

export const applyUserPresentation = (presentation: Partial<UserPresentationDefaults>): void => {
  const locale = moment.locale()
  let defaults = localeDateFormats.get(locale)
  if (!defaults) {
    const localeData = moment.localeData(locale)
    defaults = Object.freeze({
      L: localeData.longDateFormat('L'),
      LT: localeData.longDateFormat('LT'),
      LTS: localeData.longDateFormat('LTS')
    })
    localeDateFormats.set(locale, defaults)
  }
  const longDateFormat: Pick<moment.LongDateFormatSpec, 'L' | 'LT' | 'LTS'> = {
    L: presentation.dateFormat || defaults.L,
    LT: defaults.LT,
    LTS: defaults.LTS
  }
  if (isUserTimeFormat(presentation.timeFormat)) {
    if (presentation.timeFormat === '12h') {
      longDateFormat.LT = 'h:mm A'
      longDateFormat.LTS = 'h:mm:ss A'
    } else if (presentation.timeFormat === '24h') {
      longDateFormat.LT = 'HH:mm'
      longDateFormat.LTS = 'HH:mm:ss'
    }
  }
  // Moment merges partial format updates; its declaration requires the full table.
  moment.updateLocale(locale, { longDateFormat: longDateFormat as moment.LongDateFormatSpec })
  if (typeof presentation.timezone === 'string') {
    moment.tz.setDefault(presentation.timezone || undefined)
    readerTimeZoneKnown.value = isUserTimezone(presentation.timezone)
  }
  presentationRevision.value += 1
}
export const helpers = {
  filesize(rawSize: number): string {
    return filesize(rawSize).toUpperCase()
  },
  makeSafePath(rawPath: string): string {
    return rawPath
      .trim()
      .split('/')
      .map(part => kebabCase(deburr(part.trim())))
      .filter(Boolean)
      .join('/')
  },
  resolvePath(rawPath: string): string {
    const path = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath
    return `${siteConfig.path ?? ''}${path}`
  },
  setInputSelection(input: HTMLInputElement | HTMLTextAreaElement, startPos: number, endPos: number): void {
    input.focus()
    input.setSelectionRange(startPos, endPos)
  },
  formatMoment(input: MomentInput | [string, moment.MomentFormatSpecification], method: string): unknown {
    void presentationRevision.value
    const date =
      Array.isArray(input) && typeof input[0] === 'string' && input.length === 2
        ? moment(input[0], input[1] as moment.MomentFormatSpecification, true)
        : typeof input === 'number'
          ? input.toString().length < 12
            ? moment.unix(input)
            : moment(input)
          : moment(input as MomentInput)

    if (input === null || input === undefined || input === '' || !date.isValid()) {
      console.warn('Could not build a valid `moment` object from input.')
      return input
    }
    if (method === 'from') return date.fromNow(false)
    if (method === 'calendar') return date.calendar(moment(), {})
    return date.format(method)
  },
  /** True when dates use the reader's saved time zone, not the browser zone. */
  timeZoneKnown(): boolean {
    void presentationRevision.value
    return readerTimeZoneKnown.value
  },
  /** Short name of the zone that dates are shown in, for example "UTC" or "EST". */
  timeZoneLabel(input: MomentInput = Date.now()): string {
    void presentationRevision.value
    const known = readerTimeZoneKnown.value
    const zone = known ? '' : moment.tz.guess(true)
    const date = known ? moment(input) : moment.tz(input, zone)
    const abbreviation = date.isValid() ? date.format('z') : ''
    // Zones without a common abbreviation format as an offset, such as "+03".
    if (/^[+-]\d/u.test(abbreviation)) return `UTC${abbreviation}`
    return abbreviation || zone || 'UTC'
  }
}

const helpersPlugin: Plugin = {
  install(app: App): void {
    app.config.globalProperties.$helpers = helpers
    app.config.globalProperties.$moment = moment
  }
}

export default helpersPlugin
