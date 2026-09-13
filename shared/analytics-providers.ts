import type { AnalyticsField, AnalyticsProviderDefinition, AnalyticsProviderDraft } from './analytics-policy.ts'
const field = (key: string, title: string, kind: AnalyticsField['kind'] = 'text', value = '', hint = '', optional = false): AnalyticsField => ({
  key,
  title,
  kind,
  default: value,
  hint,
  optional
})
const legacy = 'Bundled classic integration. Confirm that its API and script match your provider deployment before enabling.'
const definition = (
  key: string,
  title: string,
  description: string,
  website: string,
  category: AnalyticsProviderDefinition['category'],
  capabilities: string[],
  fields: AnalyticsField[],
  compatibility = 'Uses the bundled browser integration. Provider dashboards and delivery are managed outside this workspace.'
): AnalyticsProviderDefinition => ({ key, title, description, website, category, capabilities, fields, compatibility })
export const analyticsProviderDefinitions: AnalyticsProviderDefinition[] = [
  definition(
    'plausible',
    'Plausible Analytics',
    'Site traffic through a hosted or self-hosted script.',
    'https://plausible.io',
    'traffic',
    ['Page views'],
    [
      field('domain', 'Site domain', 'text', '', 'The data-domain value from your tracking snippet.'),
      field('plausibleJsSrc', 'Script URL', 'url', 'https://plausible.io/js/plausible.js', 'Use the exact script URL supplied by your deployment.')
    ]
  ),
  definition(
    'umami2',
    'Umami Analytics v2',
    'Traffic measurement using your Umami installation.',
    'https://umami.is',
    'traffic',
    ['Page views'],
    [field('websiteID', 'Website ID'), field('url', 'Server URL', 'url', '', 'The server base URL; the integration loads /script.js.')]
  ),
  definition(
    'umami',
    'Umami Analytics v1',
    'Classic Umami installation using /umami.js.',
    'https://umami.is',
    'traffic',
    ['Page views'],
    [field('websiteID', 'Website ID'), field('url', 'Server URL', 'url')],
    legacy
  ),
  definition(
    'google',
    'Google Analytics',
    'Traffic reporting through a Google Analytics property.',
    'https://analytics.google.com/',
    'traffic',
    ['Page views', 'Provider-configured measurement'],
    [field('propertyTrackingId', 'Measurement ID', 'text', '', 'Use the G- identifier for your property.')]
  ),
  definition(
    'matomo',
    'Matomo',
    'Page views and link tracking through your Matomo server.',
    'https://matomo.org/',
    'traffic',
    ['Page views', 'Link tracking'],
    [field('siteId', 'Site ID', 'number', '1'), field('serverHost', 'Server URL', 'url', '', 'The base URL of your Matomo deployment.')]
  ),
  definition(
    'fathom',
    'Fathom Classic',
    'The classic self-hosted tracker.js integration.',
    'https://usefathom.com/',
    'traffic',
    ['Page views'],
    [field('host', 'Server URL', 'url'), field('siteId', 'Site ID')],
    legacy
  ),
  definition(
    'countly',
    'Countly',
    'Sessions, page views and interaction events.',
    'https://count.ly/',
    'traffic',
    ['Sessions', 'Page views', 'Clicks and scrolls', 'Links and errors'],
    [field('appKey', 'App key'), field('serverUrl', 'Server URL', 'url')],
    'Bundled integration loads Countly Web SDK 18.8.2. Check compatibility with your Countly server.'
  ),
  definition(
    'statcounter',
    'StatCounter',
    'Page traffic through your StatCounter project.',
    'https://statcounter.com/',
    'traffic',
    ['Page views'],
    [
      field('projectId', 'Project ID', 'number'),
      field('securityToken', 'Public tracking token', 'text', '', 'Embedded in the reader page; this is not a private API credential.')
    ]
  ),
  definition(
    'baidutongji',
    'Baidu Tongji',
    'Traffic reporting through Baidu Tongji.',
    'https://tongji.baidu.com',
    'traffic',
    ['Provider-configured tracking'],
    [field('propertyTrackingId', 'Property tracking ID')]
  ),
  definition(
    'hotjar',
    'Hotjar',
    'Behavioral analysis configured in your Hotjar site.',
    'https://www.hotjar.com',
    'replay',
    ['Session replay and heatmaps, when enabled by provider'],
    [field('siteId', 'Site ID', 'number')]
  ),
  definition(
    'fullstory',
    'FullStory',
    'Session recording through the classic FullStory browser loader.',
    'https://www.fullstory.com',
    'replay',
    ['Session replay'],
    [field('org', 'Organization ID')],
    legacy
  ),
  definition(
    'yandex',
    'Yandex Metrica',
    'Traffic and interaction reporting with optional session replay.',
    'https://metrica.yandex.com',
    'replay',
    ['Page views', 'Click map', 'Link tracking', 'Optional session replay'],
    [
      field('tagNumber', 'Tag number', 'number'),
      field(
        'webvisor',
        'Session replay',
        'boolean',
        'false',
        'Records reader interactions for playback. New configurations default off; existing enabled installations retain their previous setting.'
      )
    ]
  ),
  definition(
    'azureinsights',
    'Azure Application Insights',
    'Client errors and page performance through the bundled SDK v2 loader.',
    'https://azure.microsoft.com/en-us/products/monitor/',
    'performance',
    ['Page views', 'Performance', 'Client errors'],
    [field('instrumentationKey', 'Instrumentation key')],
    legacy
  ),
  definition(
    'elasticapm',
    'Elastic APM RUM',
    'Browser performance reporting to your APM server.',
    'https://www.elastic.co/solutions/apm',
    'performance',
    ['Performance', 'Client errors'],
    [
      field('serverUrl', 'APM server URL', 'url'),
      field('serviceName', 'Service name', 'text', 'tsepistle'),
      field('environment', 'Environment', 'text', '', 'Optional deployment label.', true)
    ],
    'The bundled loader uses the exact @elastic/apm-rum 5.17.5 browser bundle from unpkg.com. Check compatibility with your APM server.'
  ),
  definition(
    'newrelic',
    'New Relic Browser',
    'The bundled classic browser agent and reporting destinations.',
    'https://newrelic.com/products/browser-monitoring',
    'performance',
    ['Performance', 'Client errors', 'Browser interactions'],
    [
      field('licenseKey', 'Browser license key'),
      field('appId', 'Application ID', 'number'),
      field('beacon', 'Beacon hostname', 'hostname', 'bam.nr-data.net'),
      field('errorBeacon', 'Error beacon hostname', 'hostname', 'bam.nr-data.net')
    ],
    legacy
  ),
  definition(
    'gtm',
    'Google Tag Manager',
    'A container that can load additional tracking and custom scripts.',
    'https://tagmanager.google.com',
    'tags',
    ['Defined by the published tag container'],
    [field('containerTrackingId', 'Container ID', 'text', '', 'Use the GTM- identifier.')]
  )
]
export const analyticsDefinition = (key: string) => analyticsProviderDefinitions.find(row => row.key === key)
const forbidden = /[\u2028\u2029<>"'`\\]/
export const analyticsProviderIssues = (provider: AnalyticsProviderDraft): string[] => {
  const definition = analyticsDefinition(provider.key)
  if (!definition) return ['This integration has no supported configuration contract.']
  const issues: string[] = []
  for (const key of Object.keys(provider.config)) if (!definition.fields.some(field => field.key === key)) issues.push(`Unknown configuration field: ${key}.`)
  for (const field of definition.fields) {
    const value = provider.config[field.key] ?? ''
    if (!value) {
      if (!field.optional) issues.push(`${field.title} is required.`)
      continue
    }
    if (
      typeof value !== 'string' ||
      value.length > 2048 ||
      forbidden.test(value) ||
      [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ) {
      issues.push(`${field.title} contains unsupported characters or is too long.`)
      continue
    }
    if (field.kind === 'number' && !/^[1-9][0-9]{0,14}$/.test(value)) issues.push(`${field.title} must be a positive whole-number identifier.`)
    if (field.kind === 'boolean' && !['true', 'false'].includes(value)) issues.push(`${field.title} must be true or false.`)
    if (field.kind === 'hostname' && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(value))
      issues.push(`${field.title} must be a hostname without a scheme or path.`)
    if (field.kind === 'url') {
      try {
        const url = new URL(value)
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || (field.key !== 'plausibleJsSrc' && url.search))
          throw new Error()
      } catch {
        issues.push(`${field.title} must be an HTTP or HTTPS URL without credentials or a fragment.`)
      }
    }
  }
  if (provider.key === 'google' && provider.config.propertyTrackingId && !/^G-[A-Z0-9]+$/.test(provider.config.propertyTrackingId))
    issues.push('Use a Google Analytics G- measurement ID.')
  if (provider.key === 'gtm' && provider.config.containerTrackingId && !/^GTM-[A-Z0-9]+$/.test(provider.config.containerTrackingId))
    issues.push('Use a GTM- container ID.')
  return issues
}
export interface AnalyticsCode {
  head: string
  bodyStart: string
  bodyEnd: string
}
export const emptyAnalyticsCode = (): AnalyticsCode => ({ head: '', bodyStart: '', bodyEnd: '' })
export const compileAnalyticsTemplate = (template: AnalyticsCode, provider: AnalyticsProviderDraft): AnalyticsCode => {
  if (analyticsProviderIssues(provider).length) throw new Error('Analytics provider configuration is not ready.')
  const result = emptyAnalyticsCode()
  for (const section of ['head', 'bodyStart', 'bodyEnd'] as const) {
    result[section] = template[section].replace(/{{([A-Za-z][A-Za-z0-9]*)}}/g, (_token, key: string) => {
      if (!Object.hasOwn(provider.config, key)) throw new Error('Analytics template requires an unknown field.')
      // Quotes, backslashes, controls and tag delimiters are excluded by the field contract.
      // Function replacement preserves literal dollar signs rather than interpreting replacement tokens.
      const value = provider.config[key]!
      return analyticsDefinition(provider.key)?.fields.some(field => field.key === key && field.kind === 'url' && key !== 'plausibleJsSrc')
        ? value.replace(/\/+$/, '')
        : value
    })
    if (result[section].includes('{{')) throw new Error('Analytics template has an unresolved field.')
  }
  return result
}
// These are declared script/configuration hosts, not an exhaustive SDK network trace.
export const analyticsDestinations = (provider: AnalyticsProviderDraft): string[] => {
  const fixed: Record<string, string[]> = {
    google: ['www.googletagmanager.com'],
    gtm: ['www.googletagmanager.com'],
    countly: ['cdnjs.cloudflare.com'],
    hotjar: ['static.hotjar.com'],
    fullstory: ['fullstory.com'],
    yandex: ['mc.yandex.ru'],
    azureinsights: ['az416426.vo.msecnd.net'],
    elasticapm: ['unpkg.com'],
    newrelic: ['js-agent.newrelic.com'],
    statcounter: ['www.statcounter.com', 'c.statcounter.com'],
    baidutongji: ['hm.baidu.com']
  }
  const hosts = [...(fixed[provider.key] ?? [])]
  for (const field of analyticsDefinition(provider.key)?.fields ?? []) {
    const value = provider.config[field.key]
    if (!value) continue
    if (field.kind === 'url') {
      try {
        hosts.push(new URL(value).host.toLowerCase())
      } catch {
        /* Invalid fields are reported by the provider contract. */
      }
    }
    if (field.kind === 'hostname') hosts.push(value.toLowerCase())
  }
  return [...new Set(hosts)].sort()
}
