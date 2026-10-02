import moment from 'moment'
import { PAGE_EDITOR_DEFINITIONS } from './page-editors.ts'

export type RevisionTime = {
  /** Short, localized label with the time, for example "Today at 2:02 PM". */
  readonly short: string
  /** Full localized date and time for tooltips and assistive text. */
  readonly full: string
  /** Machine-readable value for `<time datetime>`. */
  readonly iso: string
}

const CALENDAR_RANGE_DAYS = 6

/**
 * Formats a revision date so that edits on the same day can be told apart.
 * Dates within the last week use the locale calendar ("Yesterday at 9:15
 * AM"); older dates show the date and the time.
 */
export const formatRevisionTime = (value: string | null | undefined, now: moment.MomentInput = undefined): RevisionTime | null => {
  if (!value) return null
  const date = moment(value)
  if (!date.isValid()) return null
  const reference = moment(now)
  const days = Math.abs(reference.clone().startOf('day').diff(date.clone().startOf('day'), 'days'))
  const short = days <= CALENDAR_RANGE_DAYS ? date.calendar(reference, { sameElse: 'll LT' }) : date.format('ll LT')
  return { short, full: date.format('LLLL'), iso: date.toISOString() }
}

/** Returns the reader-facing editor name, or an empty string when unknown. */
export const friendlyEditorName = (key: string | null | undefined): string => {
  if (!key) return ''
  return PAGE_EDITOR_DEFINITIONS.find(definition => definition.key === key)?.title ?? ''
}

export type TranslatedPart = { readonly text: string, readonly value?: string }

const PART_MARK = '\u2063'

/**
 * Splits a translated sentence into text and value parts, so the template can
 * isolate or emphasize values (author names, paths) without HTML in the
 * translation. `translate` must interpolate `{{name}}` placeholders.
 */
export const translatedParts = (
  translate: (values: Record<string, string>) => string,
  values: Record<string, string>
): TranslatedPart[] => {
  const markers: Record<string, string> = {}
  for (const name of Object.keys(values)) markers[name] = `${PART_MARK}${name}${PART_MARK}`
  const text = translate(markers)
  const parts: TranslatedPart[] = []
  const segments = text.split(PART_MARK)
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? ''
    if (index % 2 === 1 && Object.hasOwn(values, segment)) {
      parts.push({ text: values[segment] ?? '', value: segment })
    } else if (segment) {
      parts.push({ text: segment })
    }
  }
  return parts
}
