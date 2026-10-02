import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const helperUrl = new URL('./index.ts', import.meta.url).href

const runPresentation = (body: string, timezone = 'UTC'): Record<string, string> => {
  const script = `
    import { createRequire } from 'node:module'
    const require = createRequire(${JSON.stringify(new URL('../../package.json', import.meta.url).href)})
    const moment = require('moment-timezone')
    const { applyUserPresentation, helpers } = await import(${JSON.stringify(helperUrl)})
    ${body}
  `
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    env: { ...process.env, TZ: timezone },
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 16_384
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('clears consecutive date and time overrides back to the untouched active locale', () => {
  const output = runPresentation(`
    moment.locale('en')
    const instant = Date.parse('2024-05-06T13:05:09Z') / 1000
    const format = () => helpers.formatMoment(instant, 'L LT LTS')
    const initial = format()
    applyUserPresentation({ dateFormat: 'YYYY-MM-DD', timeFormat: '12h', timezone: 'America/New_York' })
    const first = format()
    applyUserPresentation({ dateFormat: 'DD/MM/YYYY', timeFormat: '24h', timezone: 'UTC' })
    const second = format()
    applyUserPresentation({ timezone: '' })
    const cleared = format()
    applyUserPresentation({ dateFormat: '', timeFormat: 'locale', timezone: '' })
    const explicit = format()
    applyUserPresentation({ dateFormat: '', timeFormat: 'locale' })
    console.log(JSON.stringify({ initial, first, second, cleared, explicit, repeated: format() }))
  `)
  assert.equal(output.first, '2024-05-06 9:05 AM 9:05:09 AM')
  assert.equal(output.second, '06/05/2024 13:05 13:05:09')
  assert.notEqual(output.initial, output.second)
  assert.equal(output.cleared, output.initial)
  assert.equal(output.explicit, output.initial)
  assert.equal(output.repeated, output.initial)
})

test('restores each locale independently without reverting unrelated live locale configuration', () => {
  const output = runPresentation(`
    const instant = Date.parse('2024-05-06T13:05:09Z') / 1000
    moment.defineLocale('presentation-alpha', {
      longDateFormat: { L: 'YYYY.MM.DD', LT: 'HH:mm', LTS: 'HH:mm:ss', LL: 'MMMM D YYYY' }
    })
    moment.defineLocale('presentation-beta', {
      longDateFormat: { L: 'DD-MM-YYYY', LT: 'h:mm A', LTS: 'h:mm:ss A' }
    })
    moment.locale('presentation-alpha')
    applyUserPresentation({ dateFormat: 'MM/DD/YYYY', timeFormat: '12h' })
    const alphaCustom = helpers.formatMoment(instant, 'L LT LTS')
    moment.updateLocale('presentation-alpha', {
      months: ['AlphaJan', 'AlphaFeb', 'AlphaMar', 'AlphaApr', 'AlphaMay', 'AlphaJun', 'AlphaJul', 'AlphaAug', 'AlphaSep', 'AlphaOct', 'AlphaNov', 'AlphaDec'],
      longDateFormat: { LL: '[kept] MMMM D YYYY' }
    })
    moment.locale('presentation-beta')
    applyUserPresentation({ dateFormat: 'YYYY/MM/DD', timeFormat: '24h' })
    const betaCustom = helpers.formatMoment(instant, 'L LT LTS')
    applyUserPresentation({ dateFormat: '', timeFormat: 'locale' })
    const betaReset = helpers.formatMoment(instant, 'L LT LTS')
    moment.locale('presentation-alpha')
    applyUserPresentation({ dateFormat: '', timeFormat: 'locale' })
    console.log(JSON.stringify({
      alphaCustom, betaCustom, betaReset,
      alphaReset: helpers.formatMoment(instant, 'L LT LTS'),
      unrelatedFormat: helpers.formatMoment(instant, 'LL'),
      unrelatedMonth: helpers.formatMoment(instant, 'MMMM')
    }))
  `)
  assert.equal(output.alphaCustom, '05/06/2024 1:05 PM 1:05:09 PM')
  assert.equal(output.betaCustom, '2024/05/06 13:05 13:05:09')
  assert.equal(output.betaReset, '06-05-2024 1:05 PM 1:05:09 PM')
  assert.equal(output.alphaReset, '2024.05.06 13:05 13:05:09')
  assert.equal(output.unrelatedFormat, 'kept AlphaMay 6 2024')
  assert.equal(output.unrelatedMonth, 'AlphaMay')
})

test('retains an omitted timezone and clears an explicit empty timezone to the local zone', () => {
  const output = runPresentation(`
    moment.locale('en')
    const instant = Date.parse('2024-01-01T12:00:00Z') / 1000
    const format = () => helpers.formatMoment(instant, 'YYYY-MM-DD HH:mm Z')
    applyUserPresentation({ timezone: 'UTC' })
    const configured = format()
    applyUserPresentation({ dateFormat: 'YYYY-MM-DD' })
    const omitted = format()
    applyUserPresentation({ timezone: '' })
    console.log(JSON.stringify({ configured, omitted, cleared: format() }))
  `, 'America/Los_Angeles')
  assert.equal(output.configured, '2024-01-01 12:00 +00:00')
  assert.equal(output.omitted, output.configured)
  assert.equal(output.cleared, '2024-01-01 04:00 -08:00')
})

test('formats ISO sync times in the chosen time zone and time format, not the browser zone', () => {
  const output = runPresentation(`
    moment.locale('en')
    const iso = new Date().toISOString()
    applyUserPresentation({ dateFormat: '', timeFormat: '24h', timezone: 'America/New_York' })
    console.log(JSON.stringify({
      formatted: helpers.formatMoment(iso, 'calendar'),
      expected: 'Today at ' + moment.tz(iso, 'America/New_York').format('HH:mm')
    }))
  `)
  assert.equal(output.formatted, output.expected)
})

test('names the browser zone until the reader zone is known, and re-renders computed labels', () => {
  const output = runPresentation(`
    const { computed } = await import('vue')
    moment.locale('en')
    const iso = '2024-01-15T10:03:00Z'
    const label = computed(() => [helpers.formatMoment(iso, 'HH:mm'), helpers.timeZoneKnown(), helpers.timeZoneLabel(iso)].join('|'))
    const browser = label.value
    applyUserPresentation({ dateFormat: '', timeFormat: '24h', timezone: 'Asia/Tokyo' })
    const reader = label.value
    applyUserPresentation({ timezone: '' })
    const cleared = label.value
    console.log(JSON.stringify({ browser, reader, cleared }))
  `, 'America/New_York')
  assert.equal(output.browser, '05:03|false|EST')
  assert.equal(output.reader, '19:03|true|JST')
  assert.equal(output.cleared, '05:03|false|EST')
})

test('labels a browser zone without a common abbreviation by its UTC offset', () => {
  const output = runPresentation(`
    console.log(JSON.stringify({ label: helpers.timeZoneLabel('2024-01-15T10:03:00Z') }))
  `, 'Asia/Dubai')
  assert.equal(output.label, 'UTC+04')
})
