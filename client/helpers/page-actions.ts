function buildPageActionPath (baseRoute: 'd' | 's', locale: string, path: string, versionId = 0): string {
  const basePath = `/${baseRoute}/${locale}/${path}`

  if (versionId > 0) {
    return `${basePath}?v=${versionId}`
  }

  return basePath
}

export function getPageDownloadPath (locale: string, path: string, versionId = 0): string {
  return buildPageActionPath('d', locale, path, versionId)
}

export function getPageSourcePath (locale: string, path: string, versionId = 0): string {
  return buildPageActionPath('s', locale, path, versionId)
}
