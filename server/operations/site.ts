import _ from 'lodash'

import errors from './errors.ts'

const { ApplicationError } = errors

const saveKeys = ['host', 'title', 'company', 'contentLicense', 'footerOverride', 'seo', 'logoUrl', 'pageExtensions', 'auth', 'editShortcuts', 'features', 'security', 'uploads']

interface SiteConfig extends Record<string, unknown> {
  host: string
  title: string
  company: string
  contentLicense: unknown
  footerOverride: unknown
  logoUrl: string
  pageExtensions: string[]
  seo: Record<string, unknown>
  editShortcuts: Record<string, unknown>
  features: Record<string, unknown>
  security: Record<string, unknown>
  auth: Record<string, unknown>
  uploads: Record<string, unknown>
}

const config = WIKI.config as SiteConfig
const configService = WIKI.configSvc as { saveToDb(keys: string[]): Promise<unknown> }

const getConfig = () => ({
  host: config.host,
  title: config.title,
  company: config.company,
  contentLicense: config.contentLicense,
  footerOverride: config.footerOverride,
  logoUrl: config.logoUrl,
  pageExtensions: config.pageExtensions.join(', '),
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
  if (Object.prototype.hasOwnProperty.call(args, 'host')) {
    config.host = _.trim(args.host as string).replace(/\/$/, '')
  }
  for (const field of ['title', 'company', 'logoUrl']) {
    if (Object.prototype.hasOwnProperty.call(args, field)) config[field] = _.trim(args[field] as string)
  }
  for (const field of ['contentLicense', 'footerOverride']) {
    if (Object.prototype.hasOwnProperty.call(args, field)) config[field] = args[field]
  }
  if (Object.prototype.hasOwnProperty.call(args, 'pageExtensions')) {
    config.pageExtensions = _.trim(args.pageExtensions as string).split(',').map((value: string) => value.trim().toLowerCase()).filter(Boolean)
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
  const app = WIKI.app as { enable(setting: string): void, disable(setting: string): void }
  if (config.security.securityTrustProxy) app.enable('trust proxy')
  else app.disable('trust proxy')
}

export default { getConfig, updateConfig }
