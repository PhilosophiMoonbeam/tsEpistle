function getPageDownloadPath (locale, path, versionId = 0) {
  const basePath = `/d/${locale}/${path}`

  if (versionId > 0) {
    return `${basePath}?v=${versionId}`
  }

  return basePath
}

module.exports = {
  getPageDownloadPath
}
