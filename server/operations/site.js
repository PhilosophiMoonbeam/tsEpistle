const _ = require('lodash')

const { ApplicationError } = require('./errors')

/* global WIKI */

const saveKeys = ['host', 'title', 'company', 'contentLicense', 'footerOverride', 'seo', 'logoUrl', 'pageExtensions', 'auth', 'editShortcuts', 'features', 'security', 'uploads']

const getConfig = () => ({
  host: WIKI.config.host,
  title: WIKI.config.title,
  company: WIKI.config.company,
  contentLicense: WIKI.config.contentLicense,
  footerOverride: WIKI.config.footerOverride,
  logoUrl: WIKI.config.logoUrl,
  pageExtensions: WIKI.config.pageExtensions.join(', '),
  ...WIKI.config.seo,
  ...WIKI.config.editShortcuts,
  ...WIKI.config.features,
  ...WIKI.config.security,
  authAutoLogin: WIKI.config.auth.autoLogin,
  authEnforce2FA: WIKI.config.auth.enforce2FA,
  authHideLocal: WIKI.config.auth.hideLocal,
  authLoginBgUrl: WIKI.config.auth.loginBgUrl,
  authJwtAudience: WIKI.config.auth.audience,
  authJwtExpiration: WIKI.config.auth.tokenExpiration,
  authJwtRenewablePeriod: WIKI.config.auth.tokenRenewal,
  uploadMaxFileSize: WIKI.config.uploads.maxFileSize,
  uploadMaxFiles: WIKI.config.uploads.maxFiles,
  uploadScanSVG: WIKI.config.uploads.scanSVG,
  uploadForceDownload: WIKI.config.uploads.forceDownload
})

const updateConfig = async args => {
  if (!_.isPlainObject(args)) {
    throw new ApplicationError('Site configuration payload must be an object.', { code: 'INVALID_SITE_CONFIGURATION' })
  }
  if (Object.prototype.hasOwnProperty.call(args, 'host')) {
    WIKI.config.host = _.trim(args.host).replace(/\/$/, '')
  }
  for (const field of ['title', 'company', 'logoUrl']) {
    if (Object.prototype.hasOwnProperty.call(args, field)) WIKI.config[field] = _.trim(args[field])
  }
  for (const field of ['contentLicense', 'footerOverride']) {
    if (Object.prototype.hasOwnProperty.call(args, field)) WIKI.config[field] = args[field]
  }
  if (Object.prototype.hasOwnProperty.call(args, 'pageExtensions')) {
    WIKI.config.pageExtensions = _.trim(args.pageExtensions).split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  }

  WIKI.config.seo = {
    description: _.get(args, 'description', WIKI.config.seo.description),
    robots: _.get(args, 'robots', WIKI.config.seo.robots),
    analyticsService: _.get(args, 'analyticsService', WIKI.config.seo.analyticsService),
    analyticsId: _.get(args, 'analyticsId', WIKI.config.seo.analyticsId)
  }
  WIKI.config.auth = {
    autoLogin: _.get(args, 'authAutoLogin', WIKI.config.auth.autoLogin),
    enforce2FA: _.get(args, 'authEnforce2FA', WIKI.config.auth.enforce2FA),
    hideLocal: _.get(args, 'authHideLocal', WIKI.config.auth.hideLocal),
    loginBgUrl: _.get(args, 'authLoginBgUrl', WIKI.config.auth.loginBgUrl),
    audience: _.get(args, 'authJwtAudience', WIKI.config.auth.audience),
    tokenExpiration: _.get(args, 'authJwtExpiration', WIKI.config.auth.tokenExpiration),
    tokenRenewal: _.get(args, 'authJwtRenewablePeriod', WIKI.config.auth.tokenRenewal)
  }
  WIKI.config.editShortcuts = {
    editFab: _.get(args, 'editFab', WIKI.config.editShortcuts.editFab),
    editMenuBar: _.get(args, 'editMenuBar', WIKI.config.editShortcuts.editMenuBar),
    editMenuBtn: _.get(args, 'editMenuBtn', WIKI.config.editShortcuts.editMenuBtn),
    editMenuExternalBtn: _.get(args, 'editMenuExternalBtn', WIKI.config.editShortcuts.editMenuExternalBtn),
    editMenuExternalName: _.get(args, 'editMenuExternalName', WIKI.config.editShortcuts.editMenuExternalName),
    editMenuExternalIcon: _.get(args, 'editMenuExternalIcon', WIKI.config.editShortcuts.editMenuExternalIcon),
    editMenuExternalUrl: _.get(args, 'editMenuExternalUrl', WIKI.config.editShortcuts.editMenuExternalUrl)
  }
  WIKI.config.features = {
    featurePageRatings: _.get(args, 'featurePageRatings', WIKI.config.features.featurePageRatings),
    featurePageComments: _.get(args, 'featurePageComments', WIKI.config.features.featurePageComments),
    featurePersonalWikis: _.get(args, 'featurePersonalWikis', WIKI.config.features.featurePersonalWikis)
  }
  WIKI.config.security = {
    securityOpenRedirect: _.get(args, 'securityOpenRedirect', WIKI.config.security.securityOpenRedirect),
    securityIframe: _.get(args, 'securityIframe', WIKI.config.security.securityIframe),
    securityReferrerPolicy: _.get(args, 'securityReferrerPolicy', WIKI.config.security.securityReferrerPolicy),
    securityTrustProxy: _.get(args, 'securityTrustProxy', WIKI.config.security.securityTrustProxy),
    securitySRI: _.get(args, 'securitySRI', WIKI.config.security.securitySRI),
    securityHSTS: _.get(args, 'securityHSTS', WIKI.config.security.securityHSTS),
    securityHSTSDuration: _.get(args, 'securityHSTSDuration', WIKI.config.security.securityHSTSDuration),
    securityCSP: _.get(args, 'securityCSP', WIKI.config.security.securityCSP),
    securityCSPDirectives: _.get(args, 'securityCSPDirectives', WIKI.config.security.securityCSPDirectives)
  }
  WIKI.config.uploads = {
    maxFileSize: _.get(args, 'uploadMaxFileSize', WIKI.config.uploads.maxFileSize),
    maxFiles: _.get(args, 'uploadMaxFiles', WIKI.config.uploads.maxFiles),
    scanSVG: _.get(args, 'uploadScanSVG', WIKI.config.uploads.scanSVG),
    forceDownload: _.get(args, 'uploadForceDownload', WIKI.config.uploads.forceDownload)
  }

  await WIKI.configSvc.saveToDb(saveKeys)
  if (WIKI.config.security.securityTrustProxy) WIKI.app.enable('trust proxy')
  else WIKI.app.disable('trust proxy')
}

module.exports = { getConfig, updateConfig }
