export type PageActionVisibility = 'public' | 'private'

function buildPageActionPath (baseRoute: 'd' | 's', locale: string, path: string, versionId = 0, visibility: PageActionVisibility = 'public'): string {
  const scope = visibility === 'private' ? '/_private' : ''
  const basePath = `/${baseRoute}${scope}/${locale}/${path}`

  if (versionId > 0) {
    return `${basePath}?v=${versionId}`
  }

  return basePath
}

export function getPageDownloadPath (locale: string, path: string, versionId = 0, visibility: PageActionVisibility = 'public'): string {
  return buildPageActionPath('d', locale, path, versionId, visibility)
}

export function getPageSourcePath (locale: string, path: string, versionId = 0, visibility: PageActionVisibility = 'public'): string {
  return buildPageActionPath('s', locale, path, versionId, visibility)
}
