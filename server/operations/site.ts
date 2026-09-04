import type { Knex } from 'knex'
import _ from 'lodash'
import { siteBannerOrDefault, validateSiteBanner } from '../../shared/site-banner.ts'
import { normalizeAvailableEditors, validateAvailableEditors } from '../../shared/page-editors.ts'

import errors from './errors.ts'

const { ApplicationError } = errors

const saveKeys = [
  'host',
  'title',
  'company',
  'contentLicense',
  'footerOverride',
  'banner',
  'seo',
  'pageExtensions',
  'editors',
  'auth',
  'editShortcuts',
  'features',
  'security',
  'uploads'
]

interface SiteConfig extends Record<string, unknown> {
  banner?: unknown
  host: string
  title: string
  company: string
  contentLicense: unknown
  footerOverride: unknown
  logoUrl: string
  pageExtensions: string[]
  editors?: { available?: unknown }
  seo: Record<string, unknown>
  editShortcuts: Record<string, unknown>
  features: Record<string, unknown>
  security: Record<string, unknown>
  auth: Record<string, unknown>
  uploads: Record<string, unknown>
}

const config = WIKI.config as SiteConfig
const configService = WIKI.configSvc as { saveToDb(keys: string[]): Promise<unknown> }
const rejectManagedLogoWrite = async (args: Record<string, unknown>): Promise<void> => {
  if (!Object.hasOwn(args, 'logoUrl')) return
  const runtime = WIKI as unknown as { models?: { knex?: Knex } }
  const knex = runtime.models?.knex
  if (!knex) return
  const state = await knex<{ id: number; desiredRevisionId: string | null; activeRevisionId: string | null }>('siteLogoState')
    .where({ id: 1 })
    .first('desiredRevisionId', 'activeRevisionId')
  if (state && (state.desiredRevisionId !== null || state.activeRevisionId !== null)) {
    throw new ApplicationError('Managed logos can only be replaced through the dedicated logo API.', {
      code: 'MANAGED_LOGO_CONFLICT',
      status: 409
    })
  }
}

const getConfig = () => ({
  host: config.host,
  title: config.title,
  company: config.company,
  contentLicense: config.contentLicense,
  footerOverride: config.footerOverride,
  banner: siteBannerOrDefault(config.banner),
  logoUrl: config.logoUrl,
  pageExtensions: config.pageExtensions.join(', '),
  availableEditors: normalizeAvailableEditors(config.editors?.available),
  ...config.seo,
  ...config.editShortcuts,
  ...config.features,
  ...config.security,
  authAutoLogin: config.auth.autoLogin,
  authEnforce2FA: config.auth.enforce2FA,
  authHideLocal: config.auth.hideLocal,
  authLoginBgUrl: config.auth.loginBgUrl,
  authJwtAudience: config.auth.audience,
  authJwtExpiration: config.auth.tokenExpiration,
  authJwtRenewablePeriod: config.auth.tokenRenewal,
  uploadMaxFileSize: config.uploads.maxFileSize,
  uploadMaxFiles: config.uploads.maxFiles,
  uploadScanSVG: config.uploads.scanSVG,
  uploadForceDownload: config.uploads.forceDownload
})

const updateConfig = async (input: unknown): Promise<void> => {
  if (!_.isPlainObject(input)) {
    throw new ApplicationError('Site configuration payload must be an object.', { code: 'INVALID_SITE_CONFIGURATION' })
  }
  const args = input as Record<string, unknown>
  await rejectManagedLogoWrite(args)
  const requestedHost = Object.hasOwn(args, 'host') ? _.trim(args.host as string).replace(/\/$/, '') : null
  const currentHostProtocol = URL.canParse(config.host) ? new URL(config.host).protocol : null
  const requestedHostProtocol = requestedHost !== null && URL.canParse(requestedHost) ? new URL(requestedHost).protocol : null
  if (requestedHost !== null && currentHostProtocol === 'https:' && requestedHostProtocol !== 'https:') {
    throw new ApplicationError('Changing the site host from HTTPS to a non-HTTPS URL cannot be applied live; restart with the new host configuration.', {
      code: 'SITE_HOST_PROTOCOL_CONFLICT',
      status: 409
    })
  }
  const hasAvailableEditors = Object.hasOwn(args, 'availableEditors')
  const availableEditorsValidation = hasAvailableEditors ? validateAvailableEditors(args.availableEditors) : null
  if (availableEditorsValidation && !availableEditorsValidation.ok) {
    throw new ApplicationError(availableEditorsValidation.message, { code: 'INVALID_EDITOR_CONFIGURATION' })
  }
  if (Object.hasOwn(args, 'banner')) {
    const result = validateSiteBanner(args.banner)
    if (!result.ok) {
      throw new ApplicationError(result.message, { code: 'INVALID_SITE_BANNER' })
    }
    config.banner = result.value
  } else {
    config.banner = siteBannerOrDefault(config.banner)
  }
  if (availableEditorsValidation?.ok) {
    config.editors = {
      ...(config.editors ?? {}),
      available: availableEditorsValidation.value
    }
  }
  if (requestedHost !== null) {
    config.host = requestedHost
  }
  for (const field of ['title', 'company']) {
    if (Object.hasOwn(args, field)) config[field] = _.trim(args[field] as string)
  }
  for (const field of ['contentLicense', 'footerOverride']) {
    if (Object.hasOwn(args, field)) config[field] = args[field]
  }
  if (Object.hasOwn(args, 'pageExtensions')) {
    config.pageExtensions = _.trim(args.pageExtensions as string)
      .split(',')
      .map((value: string) => value.trim().toLowerCase())
      .filter(Boolean)
  }
  config.seo = {
    description: _.get(args, 'description', config.seo.description),
    robots: _.get(args, 'robots', config.seo.robots),
    analyticsService: _.get(args, 'analyticsService', config.seo.analyticsService),
    analyticsId: _.get(args, 'analyticsId', config.seo.analyticsId)
  }
  config.auth = {
    autoLogin: _.get(args, 'authAutoLogin', config.auth.autoLogin),
    enforce2FA: _.get(args, 'authEnforce2FA', config.auth.enforce2FA),
    hideLocal: _.get(args, 'authHideLocal', config.auth.hideLocal),
    loginBgUrl: _.get(args, 'authLoginBgUrl', config.auth.loginBgUrl),
    audience: _.get(args, 'authJwtAudience', config.auth.audience),
    tokenExpiration: _.get(args, 'authJwtExpiration', config.auth.tokenExpiration),
    tokenRenewal: _.get(args, 'authJwtRenewablePeriod', config.auth.tokenRenewal)
  }
  config.editShortcuts = {
    editFab: _.get(args, 'editFab', config.editShortcuts.editFab),
    editMenuBar: _.get(args, 'editMenuBar', config.editShortcuts.editMenuBar),
    editMenuBtn: _.get(args, 'editMenuBtn', config.editShortcuts.editMenuBtn),
    editMenuExternalBtn: _.get(args, 'editMenuExternalBtn', config.editShortcuts.editMenuExternalBtn),
    editMenuExternalName: _.get(args, 'editMenuExternalName', config.editShortcuts.editMenuExternalName),
    editMenuExternalIcon: _.get(args, 'editMenuExternalIcon', config.editShortcuts.editMenuExternalIcon),
    editMenuExternalUrl: _.get(args, 'editMenuExternalUrl', config.editShortcuts.editMenuExternalUrl)
  }
  config.features = {
    featurePageRatings: _.get(args, 'featurePageRatings', config.features.featurePageRatings),
    featurePageComments: _.get(args, 'featurePageComments', config.features.featurePageComments),
    featurePersonalWikis: _.get(args, 'featurePersonalWikis', config.features.featurePersonalWikis)
  }
  config.security = {
    securityOpenRedirect: _.get(args, 'securityOpenRedirect', config.security.securityOpenRedirect),
    securityIframe: _.get(args, 'securityIframe', config.security.securityIframe),
    securityReferrerPolicy: _.get(args, 'securityReferrerPolicy', config.security.securityReferrerPolicy),
    securityTrustProxy: _.get(args, 'securityTrustProxy', config.security.securityTrustProxy),
    securitySRI: _.get(args, 'securitySRI', config.security.securitySRI),
    securityHSTS: _.get(args, 'securityHSTS', config.security.securityHSTS),
    securityHSTSDuration: _.get(args, 'securityHSTSDuration', config.security.securityHSTSDuration),
    securityCSP: _.get(args, 'securityCSP', config.security.securityCSP),
    securityCSPDirectives: _.get(args, 'securityCSPDirectives', config.security.securityCSPDirectives)
  }
  config.uploads = {
    maxFileSize: _.get(args, 'uploadMaxFileSize', config.uploads.maxFileSize),
    maxFiles: _.get(args, 'uploadMaxFiles', config.uploads.maxFiles),
    scanSVG: _.get(args, 'uploadScanSVG', config.uploads.scanSVG),
    forceDownload: _.get(args, 'uploadForceDownload', config.uploads.forceDownload)
  }

  await configService.saveToDb(saveKeys)
  const app = WIKI.app as { set(setting: string, value: number | false): void }
  app.set('trust proxy', config.security.securityTrustProxy ? 1 : false)
}

export default { getConfig, updateConfig }
