function buildPageActionPath (baseRoute, locale, path, versionId = 0) {
  const basePath = `/${baseRoute}/${locale}/${path}`

  if (versionId > 0) {
    return `${basePath}?v=${versionId}`
  }

  return basePath
}

function getPageDownloadPath (locale, path, versionId = 0) {
  return buildPageActionPath('d', locale, path, versionId)
}

function getPageSourcePath (locale, path, versionId = 0) {
  return buildPageActionPath('s', locale, path, versionId)
}

module.exports = {
  getPageDownloadPath,
  getPageSourcePath
}
