import path from 'node:path'
import { Script } from 'node:vm'
import * as cheerio from 'cheerio'
import { describe, it, expect } from '../bun-test.mts'
import { analyticsProviderDefinitions, analyticsProviderIssues, compileAnalyticsTemplate, analyticsDestinations } from '../../../shared/analytics-providers.ts'
import { analyticsDraftFromRow, compileAnalyticsSnapshot, readAnalyticsTemplate, type AnalyticsSnapshot } from '../../repositories/analytics-runtime.ts'
import {
  analyticsPolicyFromConfiguration,
  decideAnalyticsCollection,
  AnalyticsPolicySchema,
  type AnalyticsRequestContext
} from '../../../shared/analytics-policy.ts'
const serverPath = path.resolve('server')
const request: AnalyticsRequestContext = {
  method: 'GET',
  reader: true,
  published: true,
  visibility: 'public',
  protected: false,
  path: 'guide/start',
  signedIn: false,
  administrator: false,
  privacySignal: false,
  prefetch: false,
  offline: false
}
const policy = { ...analyticsPolicyFromConfiguration({}), localEnabled: true, externalEnabled: true }
const provider = (key = 'plausible') => ({
  key,
  isEnabled: true,
  config: { domain: 'wiki.example.test', plausibleJsSrc: 'https://stats.example.test/script.js' }
})
describe('Analytics provider contracts and compiled browser code', () => {
  it('compiles every bundled integration into parseable JavaScript with all placeholders resolved', async () => {
    for (const definition of analyticsProviderDefinitions) {
      const config = Object.fromEntries(
        definition.fields.map(field => [
          field.key,
          field.kind === 'url' ? 'https://stats.example.test' : field.kind === 'hostname' ? 'stats.example.test' : field.kind === 'number' ? '1234' : field.kind === 'boolean' ? 'false' : 'example'
        ])
      )
      if (definition.key === 'google') config.propertyTrackingId = 'G-EXAMPLE'
      if (definition.key === 'gtm') config.containerTrackingId = 'GTM-EXAMPLE'
      const draft = { key: definition.key, isEnabled: true, config }
      expect(analyticsProviderIssues(draft)).toEqual([])
      const code = compileAnalyticsTemplate(await readAnalyticsTemplate(serverPath, definition.key), draft)
      expect(JSON.stringify(code)).not.toContain('{{')
      const $ = cheerio.load(Object.values(code).join('\n'))
      for (const script of $('script:not([src])').toArray()) expect(() => new Script($(script).html() ?? '')).not.toThrow()
    }
    expect(analyticsProviderDefinitions).toHaveLength(16)
  })
  it('rejects injection, malformed numeric identifiers and credential-bearing or executable URLs', () => {
    for (const attack of ['</script><script>alert(1)</script>', "x';alert(1);//", '\\', '\n', '\u2028', '" onload="alert(1)']) {
      expect(analyticsProviderIssues({ ...provider(), config: { ...provider().config, domain: attack } }).length).toBeGreaterThan(0)
    }
    for (const url of ['javascript:alert(1)', 'data:text/html,test', 'https://user:password@example.test', 'https://example.test/#fragment'])
      expect(analyticsProviderIssues({ ...provider(), config: { ...provider().config, plausibleJsSrc: url } }).length).toBeGreaterThan(0)
    expect(analyticsProviderIssues({ key: 'hotjar', isEnabled: true, config: { siteId: '1;alert(1)' } }).length).toBeGreaterThan(0)
    expect(analyticsProviderIssues({ key: 'google', isEnabled: true, config: { propertyTrackingId: 'UA-OLD' } })).toContain(
      'Use a Google Analytics G- measurement ID.'
    )
  })
  it('uses literal replacement and reports public destinations without credentials or paths', async () => {
    const draft = provider()
    draft.config.domain = 'dollar$&value'
    const code = compileAnalyticsTemplate(await readAnalyticsTemplate(serverPath, 'plausible'), draft)
    expect(code.head).toContain('dollar$&value')
    expect(analyticsDestinations(draft)).toEqual(['stats.example.test'])
    expect(() => compileAnalyticsTemplate({ head: '{{unknown}}', bodyStart: '', bodyEnd: '' }, draft)).toThrow('unknown field')
    await expect(readAnalyticsTemplate(serverPath, '../outside')).rejects.toThrow('unavailable')
  })
  it('emits an explicit Yandex replay boolean and a version-pinned Elastic loader', async () => {
    const yandex = { key: 'yandex', isEnabled: true, config: { tagNumber: '42', webvisor: 'false' } }
    const replayOff = compileAnalyticsTemplate(await readAnalyticsTemplate(serverPath, 'yandex'), yandex)
    expect(replayOff.head).toContain('webvisor:false')
    expect(replayOff.head).not.toContain('webvisor:true')

    yandex.config.webvisor = 'true'
    expect(compileAnalyticsTemplate(await readAnalyticsTemplate(serverPath, 'yandex'), yandex).head).toContain('webvisor:true')
    expect(analyticsProviderIssues({ ...yandex, config: { ...yandex.config, webvisor: 'yes' } })).toContain('Session replay must be true or false.')

    const elastic = analyticsProviderDefinitions.find(definition => definition.key === 'elasticapm')!
    const elasticDraft = {
      key: elastic.key,
      isEnabled: true,
      config: Object.fromEntries(elastic.fields.map(field => [field.key, field.default || (field.kind === 'url' ? 'https://apm.example.test' : 'example')]))
    }
    const elasticCode = compileAnalyticsTemplate(await readAnalyticsTemplate(serverPath, elastic.key), elasticDraft)
    expect(elasticCode.head).toContain('https://unpkg.com/@elastic/apm-rum@5.17.5/dist/bundles/elastic-apm-rum.umd.min.js')
    expect(elasticCode.head).not.toContain('@elastic/apm-rum/dist/')
  })
  it('normalizes saved numeric and boolean defaults without admitting prototype or unknown configuration fields', () => {
    expect(
      analyticsDraftFromRow({ key: 'matomo', isEnabled: false, config: { siteId: 1, serverHost: 'https://stats.example.test', unknown: 'discard' } }).config
    ).toEqual({ siteId: '1', serverHost: 'https://stats.example.test' })
    expect(analyticsDraftFromRow({ key: 'yandex', isEnabled: true, config: { tagNumber: 42, webvisor: false } }).config).toEqual({
      tagNumber: '42',
      webvisor: 'false'
    })
    expect(analyticsProviderIssues({ ...provider(), config: { ...provider().config, unexpected: 'x' } })).toContain('Unknown configuration field: unexpected.')
  })
  it('isolates an invalid integration and enforces current availability and request policy before compiling', async () => {
    const rows = [
      provider(),
      { key: 'hotjar', isEnabled: true, config: { siteId: 'invalid' } },
      { key: 'umami2', isEnabled: true, config: { websiteID: 'example', url: 'https://unavailable.example.test' } }
    ]
    const snapshot: AnalyticsSnapshot = { rows, settings: [], configuration: {}, policy, offline: false, revision: 'current' }
    const result = await compileAnalyticsSnapshot(snapshot, request, serverPath, new Set(['plausible', 'hotjar']))
    expect(result.code.head).toContain('stats.example.test')
    expect(result.skipped).toEqual(['hotjar', 'umami2'])
    const excluded = await compileAnalyticsSnapshot(snapshot, { ...request, protected: true }, serverPath, new Set(['plausible']))
    expect(excluded.hasExternalCode).toBe(false)
    expect(excluded.decision.local).toBe(false)
  })
})
describe('Analytics collection decisions', () => {
  it('defaults to no local collection and preserves an existing external enablement decision', () => {
    expect(analyticsPolicyFromConfiguration({}).externalEnabled).toBe(false)
    expect(analyticsPolicyFromConfiguration({}, true)).toMatchObject({
      externalEnabled: true,
      localEnabled: false,
      excludeAdministrators: true,
      respectPrivacySignals: true
    })
  })
  it('excludes administrative surfaces, drafts, personal/protected pages, prefetch, non-GET and privacy signals', () => {
    for (const patch of [
      { reader: false },
      { published: false },
      { visibility: 'private' as const },
      { protected: true },
      { prefetch: true },
      { method: 'HEAD' },
      { privacySignal: true },
      { administrator: true }
    ])
      expect(decideAnalyticsCollection(policy, { ...request, ...patch })).toMatchObject({ local: false, external: false })
  })
  it('applies audience and literal path boundaries, and lets offline workspaces retain local counts', () => {
    expect(decideAnalyticsCollection({ ...policy, audience: 'signed-in' }, request).local).toBe(false)
    expect(decideAnalyticsCollection({ ...policy, audience: 'anonymous' }, { ...request, signedIn: true }).local).toBe(false)
    const excluding = { ...policy, excludedPaths: ['guide'] }
    expect(decideAnalyticsCollection(excluding, request).external).toBe(false)
    expect(decideAnalyticsCollection(excluding, { ...request, path: 'guidelines' }).external).toBe(true)
    expect(decideAnalyticsCollection(policy, { ...request, offline: true })).toMatchObject({ local: true, external: false })
    expect(AnalyticsPolicySchema.parse({ ...policy, excludedPaths: ['/guide/', 'guide'] }).excludedPaths).toEqual(['guide'])
    expect(decideAnalyticsCollection(AnalyticsPolicySchema.parse({ ...policy, excludedPaths: ['/'] }), request).local).toBe(false)
  })
})
