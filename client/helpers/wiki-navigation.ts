import { z } from 'zod'
import { decodeBase64Json } from './base64'

const WikiPagePropsSchema = z.object({
  pageId: z.number().int().positive(),
  locale: z.string(),
  path: z.string(),
  title: z.string(),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sourceRevision: z.string(),
  tags: z.array(z.unknown()),
  authorName: z.string(),
  authorId: z.number().int().nonnegative(),
  editor: z.string(),
  isPublished: z.boolean(),
  visibility: z.enum(['public', 'private']),
  toc: z.string(),
  sidebar: z.string(),
  navMode: z.string(),
  navExpandParent: z.boolean(),
  commentsEnabled: z.boolean(),
  effectivePermissions: z.string(),
  commentsExternal: z.boolean(),
  editShortcuts: z.string(),
  filename: z.string()
})

const WikiPagePayloadSchema = z.object({
  version: z.literal(1),
  spaNavigation: z.boolean(),
  props: WikiPagePropsSchema
})

export type WikiPageProps = z.infer<typeof WikiPagePropsSchema>
export type WikiPagePayload = z.infer<typeof WikiPagePayloadSchema>

export interface ParsedWikiNavigation {
  payload: WikiPagePayload
  contentHtml: string
  commentsHtml: string
  documentTitle: string
  description: string
  language: string
  url: URL
}

type WikiNavigationHandler = (url: URL) => void | Promise<void>

let navigationHandler: WikiNavigationHandler | null = null

export const decodeWikiPagePayload = (value: string): WikiPagePayload => WikiPagePayloadSchema.parse(decodeBase64Json<unknown>(value))

export const parseWikiNavigationDocument = (html: string, responseUrl: string | URL): ParsedWikiNavigation | null => {
  const documentNode = new DOMParser().parseFromString(html, 'text/html')
  const shell = documentNode.querySelector<HTMLElement>('wiki-page[data-wiki-page-shell]')
  const encodedPayload = shell?.getAttribute('payload')
  if (!shell || !encodedPayload) return null

  let payload: WikiPagePayload
  try {
    payload = decodeWikiPagePayload(encodedPayload)
  } catch {
    return null
  }
  if (!payload.spaNavigation) return null

  const contentTemplate = shell.querySelector<HTMLTemplateElement>('template[data-wiki-page-contents]')
  const commentsTemplate = shell.querySelector<HTMLTemplateElement>('template[data-wiki-page-comments]')

  return {
    payload,
    contentHtml: contentTemplate?.innerHTML ?? '',
    commentsHtml: commentsTemplate?.innerHTML ?? '',
    documentTitle: documentNode.title,
    description: documentNode.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? '',
    language: documentNode.documentElement.lang,
    url: new URL(responseUrl, window.location.href)
  }
}

export const isWikiNavigationClick = (event: MouseEvent, anchor: HTMLAnchorElement): boolean => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false
  if (anchor.hasAttribute('download') || anchor.dataset.noWikiNavigation !== undefined) return false
  if (anchor.target && anchor.target.toLowerCase() !== '_self') return false

  const destination = new URL(anchor.href, window.location.href)
  if (destination.origin !== window.location.origin || !['http:', 'https:'].includes(destination.protocol)) return false
  if (destination.pathname === window.location.pathname && destination.search === window.location.search && destination.hash) return false
  return true
}

export const installWikiNavigationHandler = (handler: WikiNavigationHandler): (() => void) => {
  navigationHandler = handler
  return () => {
    if (navigationHandler === handler) navigationHandler = null
  }
}

export const navigateToWikiPage = (value: string | URL): void => {
  const destination = new URL(value, window.location.href)
  if (navigationHandler) {
    void navigationHandler(destination)
    return
  }
  window.location.assign(destination.href)
}
