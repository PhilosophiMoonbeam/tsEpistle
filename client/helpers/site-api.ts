import { type SiteBannerConfig, validateSiteBanner } from '../../shared/site-banner.ts'

type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json?: () => Promise<unknown>
}

type FetchImpl = (url: string, init: {
  method?: 'PUT'
  credentials: 'same-origin'
  headers: {
    Accept: 'application/json'
    'Content-Type'?: 'application/json'
  }
  body?: string
}) => Promise<JsonResponse>

export type SiteConfig = Record<string, unknown> & {
  host?: string
  title?: string
  description?: string
  robots?: string[]
  analyticsService?: string
  analyticsId?: string
  company?: string
  contentLicense?: string
  footerOverride?: string
  banner: SiteBannerConfig
  logoUrl?: string
  featureAnalytics?: boolean
  featurePageRatings?: boolean
  featurePageComments?: boolean
  featurePersonalWikis?: boolean
  featureTinyPNG?: boolean
  pageExtensions?: string
  editFab?: boolean
  editMenuBar?: boolean
  editMenuBtn?: boolean
  editMenuExternalBtn?: boolean
  editMenuExternalName?: string
  editMenuExternalIcon?: string
  editMenuExternalUrl?: string
  uploadMaxFileSize?: number
  uploadMaxFiles?: number
  uploadScanSVG?: boolean
  uploadForceDownload?: boolean
  securityOpenRedirect?: boolean
  securityIframe?: boolean
  securityReferrerPolicy?: boolean
  securityTrustProxy?: boolean
  securitySRI?: boolean
  securityHSTS?: boolean
  securityHSTSDuration?: number
  securityCSP?: boolean
  securityCSPDirectives?: string
  authAutoLogin?: boolean
  authEnforce2FA?: boolean
  authHideLocal?: boolean
  authLoginBgUrl?: string
  authJwtAudience?: string
  authJwtExpiration?: string
  authJwtRenewablePeriod?: string
}

type MessageResponse = {
  message: string
}

async function parseJsonResponse (response: JsonResponse | null | undefined, fallbackMessage: string): Promise<unknown> {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers!.get('content-type') || '' : ''
  let payload: unknown = null

  if (response && contentType.includes('application/json') && typeof response.json === 'function') {
    payload = await response.json()
  }

  if (!response || !response.ok) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as { error?: unknown }).error) {
      throw new Error(String((payload as { error: unknown }).error))
    }
    throw new Error(fallbackMessage)
  }

  return payload
}

function assertPlainObject (payload: unknown, fallbackMessage: string): asserts payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }
}

function assertSiteConfig (payload: Record<string, unknown>, fallbackMessage: string): asserts payload is SiteConfig {
  const stringFields = [
    'host',
    'title',
    'description',
    'analyticsService',
    'analyticsId',
    'company',
    'contentLicense',
    'footerOverride',
    'logoUrl',
    'pageExtensions',
    'editMenuExternalName',
    'editMenuExternalIcon',
    'editMenuExternalUrl',
    'securityCSPDirectives',
    'authLoginBgUrl',
    'authJwtAudience',
    'authJwtExpiration',
    'authJwtRenewablePeriod'
  ]
  const booleanFields = [
    'featureAnalytics',
    'featurePageRatings',
    'featurePageComments',
    'featurePersonalWikis',
    'featureTinyPNG',
    'editFab',
    'editMenuBar',
    'editMenuBtn',
    'editMenuExternalBtn',
    'uploadScanSVG',
    'uploadForceDownload',
    'securityOpenRedirect',
    'securityIframe',
    'securityReferrerPolicy',
    'securityTrustProxy',
    'securitySRI',
    'securityHSTS',
    'securityCSP',
    'authAutoLogin',
    'authEnforce2FA',
    'authHideLocal'
  ]
  const numberFields = [
    'uploadMaxFileSize',
    'uploadMaxFiles',
    'securityHSTSDuration'
  ]

  const bannerValidation = validateSiteBanner(payload.banner)

  if (stringFields.some(field => field in payload && typeof payload[field] !== 'string') ||
    booleanFields.some(field => field in payload && typeof payload[field] !== 'boolean') ||
    numberFields.some(field => field in payload && typeof payload[field] !== 'number') ||
    ('robots' in payload && (!Array.isArray(payload.robots) || payload.robots.some(robot => typeof robot !== 'string'))) ||
    !bannerValidation.ok) {
    throw new Error(fallbackMessage)
  }
}

export async function fetchSiteConfig (fetchImpl: FetchImpl, fallbackMessage = 'Site configuration fetch failed'): Promise<SiteConfig> {
  const response = await fetchImpl('/_api/site/config', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  assertPlainObject(payload, fallbackMessage)
  assertSiteConfig(payload, fallbackMessage)
  return payload
}

export async function saveSiteConfig (fetchImpl: FetchImpl, config: Record<string, unknown>, fallbackMessage = 'Site configuration update failed'): Promise<MessageResponse & Record<string, unknown>> {
  const response = await fetchImpl('/_api/site/config', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(config)
  })
  const payload = await parseJsonResponse(response, fallbackMessage)

  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { message?: unknown }).message !== 'string') {
    throw new Error(fallbackMessage)
  }

  return payload as MessageResponse & Record<string, unknown>
}
