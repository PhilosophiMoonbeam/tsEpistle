import pageHelper from './page.ts'
import { okfFilePath } from '../okf/format.ts'

export interface StoragePagePathIdentity {
  path: string
  localeCode: string
  contentType: string
}

export interface StoragePagePathOptions {
  defaultLocale: string
  namespaceNonDefaultLocale: boolean
  alwaysNamespace?: boolean
}

/** The physical page filename shared by native export and canonical admission. */
export const storagePagePath = (page: StoragePagePathIdentity, options: StoragePagePathOptions): string => {
  if (page.contentType === 'markdown') return okfFilePath(page.localeCode, page.path)
  const filename = `${page.path}.${pageHelper.getFileExtension(page.contentType)}`
  return options.alwaysNamespace === true || (options.namespaceNonDefaultLocale && options.defaultLocale !== page.localeCode)
    ? `${page.localeCode}/${filename}`
    : filename
}
