const publicationCalendar = '[0-9]{4}-((01|03|05|07|08|10|12)-(0[1-9]|[12][0-9]|3[01])|(04|06|09|11)-(0[1-9]|[12][0-9]|30)|02-(0[1-9]|1[0-9]|2[0-8]))'
const publicationLeapDay = '([0-9]{2}(0[48]|[2468][048]|[13579][26])|(0[48]|[2468][048]|[13579][26])00)-02-29'
const publicationTime = '([Tt ]([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9]([.][0-9]+){0,1}){0,1}([Zz]|[+-]((0[0-9]|1[0-3]):[0-5][0-9]|14:00)){0,1}){0,1}'

// The same calendar grammar guards PostgreSQL casts and requester/provider admission.
export const publicationTimestampPattern = `^(${publicationCalendar}|${publicationLeapDay})${publicationTime}$`
const publicationTimestamp = new RegExp(publicationTimestampPattern)

/** Empty bounds are open; malformed or unsupported nonempty bounds are NaN. */
export const publicationBoundaryTimestamp = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null
  if (value instanceof Date) {
    const year = value.getUTCFullYear()
    return year >= 1 && year <= 9999 ? value.getTime() : Number.NaN
  }
  // Native adapters and webhook payloads may already carry epoch milliseconds.
  if (typeof value === 'number') return Number.isFinite(value) && value >= -62135596800000 && value < 253402300800000 ? value : Number.NaN
  if (typeof value !== 'string' || value.startsWith('0000') || !publicationTimestamp.test(value)) return Number.NaN
  return Date.parse(value)
}

export const publicationWindowOpen = (page: { readonly publishStartDate?: unknown; readonly publishEndDate?: unknown }, now = Date.now()): boolean => {
  const start = publicationBoundaryTimestamp(page.publishStartDate)
  if (start !== null && (!Number.isFinite(start) || start > now)) return false
  const end = publicationBoundaryTimestamp(page.publishEndDate)
  return end === null || (Number.isFinite(end) && end >= now)
}
