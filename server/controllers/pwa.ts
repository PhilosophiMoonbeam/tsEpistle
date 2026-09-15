import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import express, { type Request, type Response } from 'express'

import type { LogoIconDescriptor } from '../../shared/site-logo.ts'
import { normalizeThemeColors } from '../../shared/theme-colors.ts'
import type { ActiveBranding } from '../helpers/site-logo-branding.ts'

export const PWA_TOMBSTONE_ENVIRONMENT_VARIABLE = 'TSEPISTLE_PWA_TOMBSTONE' as const

const OFFLINE_DOCUMENT_PATH = '/_offline'
const SERVICE_WORKER_PATH = '/sw.js'
const PWA_MANIFEST_FILE = ['assets', 'manifest-tsepistle.json'] as const
const PWA_BROWSERCONFIG_FILE = ['assets', 'browserconfig.xml'] as const
const OFFLINE_DOCUMENT_FILE = ['assets', 'client', 'offline.html'] as const
const SERVICE_WORKER_FILE = ['assets', 'service-worker.js'] as const
const TOMBSTONE_FILE = ['assets', 'sw-tombstone.js'] as const
const CSP_DOCUMENT_ORIGIN = 'https://tsepistle-offline.invalid'
const CSP_ASSET_PATH = /^\/_assets\//
export const PWA_MODE_META_NAME = 'tsepistle-pwa-mode' as const
export const PWA_RELEASE_META_NAME = 'tsepistle-pwa-release' as const
export const PWA_FAVICON_PATH = '/favicon.ico' as const
export const PWA_BROWSERCONFIG_PATH = '/_assets/browserconfig.xml' as const
export const PWA_MANIFEST_PATH = '/_assets/manifest-tsepistle.json' as const
export const PWA_MODES = ['feature', 'retirement'] as const
export type PwaMode = (typeof PWA_MODES)[number]
const PWA_RELEASE_PATTERN = /^[0-9a-f]{40}$/u

const PACKAGED_ICON_DESCRIPTOR: LogoIconDescriptor = Object.freeze({
  favicon16Url: '/_assets/favicons/favicon-16x16.png',
  favicon32Url: '/_assets/favicons/favicon-32x32.png',
  tile150Url: '/_assets/favicons/mstile-150x150.png',
  apple180Url: '/_assets/favicons/apple-touch-icon.png',
  app192Url: '/_assets/favicons/android-chrome-192x192.png',
  app512Url: '/_assets/favicons/android-chrome-512x512.png',
  maskable512Url: '/_assets/favicons/maskable-512x512.png',
  faviconIcoUrl: '/_assets/favicon.ico'
})

const HASHED_ICON_PATH = /^\/_site-logo\/[0-9a-f]{64}\/icon\.png$/u
const HASHED_ICO_PATH = /^\/_site-logo\/[0-9a-f]{64}\/favicon\.ico$/u

const isManagedIconDescriptor = (icons: LogoIconDescriptor | null | undefined): icons is LogoIconDescriptor =>
  icons !== null &&
  icons !== undefined &&
  HASHED_ICON_PATH.test(icons.favicon16Url) &&
  HASHED_ICON_PATH.test(icons.favicon32Url) &&
  HASHED_ICON_PATH.test(icons.tile150Url) &&
  HASHED_ICON_PATH.test(icons.apple180Url) &&
  HASHED_ICON_PATH.test(icons.app192Url) &&
  HASHED_ICON_PATH.test(icons.app512Url) &&
  HASHED_ICON_PATH.test(icons.maskable512Url) &&
  HASHED_ICO_PATH.test(icons.faviconIcoUrl)

const escapedXml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')

interface PwaConfig {
  readonly host?: string
  readonly title?: string
  readonly description?: string
  readonly theming?: { readonly colors?: unknown }
}

export interface PwaWiki {
  ROOTPATH: string
  config?: PwaConfig
  pwaMode?: PwaMode
  pwaRelease?: string
  resolveBranding?: () => Promise<ActiveBranding>
}

interface Resource {
  readonly body: Buffer
  readonly etag: string
  readonly lastModified: string
}

const resourceFromBody = (body: Buffer, lastModified: string): Resource => {
  const digest = createHash('sha256').update(body).digest('hex')
  return { body, etag: `"${digest}"`, lastModified }
}

const resource = async (filename: readonly string[]): Promise<Resource> => {
  const filePath = path.join(...filename)
  const [body, metadata] = await Promise.all([readFile(filePath), stat(filePath)])
  return resourceFromBody(body, metadata.mtime.toUTCString())
}

const environmentFlagEnabled = (value: string | undefined): boolean => /^(?:1|true|yes|on)$/i.test(value?.trim() ?? '')
export const currentPwaMode = (): PwaMode => (environmentFlagEnabled(process.env[PWA_TOMBSTONE_ENVIRONMENT_VARIABLE]) ? 'retirement' : 'feature')

const configuredOrigin = (host: unknown): string | null => {
  if (typeof host !== 'string' || host.length === 0) return null
  try {
    const parsed = new URL(host)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}

const requestOrigin = (request: Request): string | null => {
  const protocol = request.protocol
  const host = request.get('host')
  if ((protocol !== 'http' && protocol !== 'https') || !host) return null
  try {
    return new URL(`${protocol}://${host}`).origin
  } catch {
    return null
  }
}

const attribute = (tag: string, name: string): string | null => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

const metadataValue = (html: string, name: string): string | null => {
  const tag = (html.match(/<meta\b[^>]*>/gi) ?? []).find(candidate => attribute(candidate, 'name')?.toLowerCase() === name)
  return tag === undefined ? null : attribute(tag, 'content')
}

const replaceMetadataValue = (html: string, name: string, value: string): string | null => {
  let replaced = false
  const contentPattern = /(\bcontent\s*=\s*)(["'])([^"']*)\2/i
  const result = html.replace(/<meta\b[^>]*>/gi, tag => {
    if (attribute(tag, 'name')?.toLowerCase() !== name) return tag
    const content = contentPattern.exec(tag)
    if (!content || !PWA_MODES.includes(content[3] as PwaMode)) return tag
    replaced = true
    return tag.replace(contentPattern, (_match, prefix: string, quote: string) => `${prefix}${quote}${value}${quote}`)
  })
  return replaced ? result : null
}

const assetPath = (value: string): string | null => {
  if (value.startsWith('//')) return null
  try {
    const parsed = new URL(value, `${CSP_DOCUMENT_ORIGIN}${OFFLINE_DOCUMENT_PATH}`)
    if (parsed.origin !== CSP_DOCUMENT_ORIGIN || parsed.search || parsed.hash || !CSP_ASSET_PATH.test(parsed.pathname)) return null
    return parsed.pathname
  } catch {
    return null
  }
}

const offlineAssetPaths = (html: string): { readonly scripts: string[]; readonly styles: string[] } => {
  const scripts: string[] = []
  const styles: string[] = []
  const seenScripts = new Set<string>()
  const seenStyles = new Set<string>()
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) ?? []) {
    if (/^<script\b/i.test(tag)) {
      const source = attribute(tag, 'src')
      const resolved = source === null ? null : assetPath(source)
      if (resolved !== null && !seenScripts.has(resolved)) {
        seenScripts.add(resolved)
        scripts.push(resolved)
      }
      continue
    }
    const rel = attribute(tag, 'rel')
    if (!rel) continue
    const relTokens = rel.split(/\s+/).map(token => token.toLowerCase())
    const isStylesheet = relTokens.includes('stylesheet')
    const isModulePreload = relTokens.includes('modulepreload')
    if (!isStylesheet && !isModulePreload) continue
    const href = attribute(tag, 'href')
    const resolved = href === null ? null : assetPath(href)
    if (resolved === null) continue
    const destination = isModulePreload ? scripts : styles
    const seen = isModulePreload ? seenScripts : seenStyles
    if (seen.has(resolved)) continue
    seen.add(resolved)
    destination.push(resolved)
  }
  return { scripts, styles }
}

const cspSource = (origin: string | null, pathName: string): string => (origin ? `${origin}${pathName}` : pathName)

const offlineContentSecurityPolicy = (request: Request, html: string, host: unknown): string => {
  const paths = offlineAssetPaths(html)
  const origin = requestOrigin(request) ?? configuredOrigin(host)
  const scripts = paths.scripts.map(pathName => cspSource(origin, pathName))
  const styles = paths.styles.map(pathName => cspSource(origin, pathName))
  return [
    "default-src 'none'",
    `script-src ${scripts.length > 0 ? scripts.join(' ') : "'none'"}`,
    `style-src ${styles.length > 0 ? styles.join(' ') : "'none'"}`,
    "connect-src 'self'",
    "img-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "child-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'"
  ].join('; ')
}

const preparedOfflineDocument = (file: Resource, mode: PwaMode, expectedRelease?: string): Resource => {
  const html = file.body.toString('utf8')
  const release = metadataValue(html, PWA_RELEASE_META_NAME)
  if (release === null || !PWA_RELEASE_PATTERN.test(release) || (expectedRelease !== undefined && release !== expectedRelease))
    throw new Error('The neutral offline document belongs to a different or unknown release.')
  const sourceMode = metadataValue(html, PWA_MODE_META_NAME)
  if (sourceMode === null || !PWA_MODES.includes(sourceMode as PwaMode)) throw new Error('The neutral offline document has no valid PWA mode metadata.')
  if (sourceMode === mode) return file
  const rewritten = replaceMetadataValue(html, PWA_MODE_META_NAME, mode)
  if (rewritten === null) throw new Error('The neutral offline document has no replaceable PWA mode metadata.')
  return resourceFromBody(Buffer.from(rewritten, 'utf8'), file.lastModified)
}

const etagMatches = (request: Request, etag: string): boolean => {
  const value = request.get('if-none-match')
  if (!value) return false
  return value.split(',').some(candidate => {
    const tag = candidate.trim()
    return tag === '*' || tag === etag || tag === `W/${etag}`
  })
}

const modifiedSinceMatches = (request: Request, lastModified: string): boolean => {
  if (request.get('if-none-match')) return false
  const since = Date.parse(request.get('if-modified-since') ?? '')
  const modified = Date.parse(lastModified)
  return Number.isFinite(since) && Number.isFinite(modified) && modified <= since
}

const sendResource = (
  request: Request,
  response: Response,
  resourceValue: Resource,
  contentType: string,
  cacheControl: string,
  extraHeaders: Record<string, string> = {}
): void => {
  response.set({
    'Content-Type': contentType,
    'Content-Length': String(resourceValue.body.byteLength),
    'Cache-Control': cacheControl,
    ETag: resourceValue.etag,
    'Last-Modified': resourceValue.lastModified,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  })
  if (etagMatches(request, resourceValue.etag) || modifiedSinceMatches(request, resourceValue.lastModified)) {
    response.status(304).end()
    return
  }
  if (request.method === 'HEAD') {
    response.status(200).end()
    return
  }
  response.status(200).send(resourceValue.body)
}

const unavailable = (response: Response, message: string): void => {
  response.set({
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  })
  response.status(503).send(message)
}
const configuredThemeColors = (config: PwaConfig | undefined): { readonly themeColor: string; readonly backgroundColor: string } | null => {
  if (config?.theming?.colors === undefined) return null
  const colors = normalizeThemeColors(config.theming.colors)
  return { themeColor: colors.light.primary, backgroundColor: colors.light.background }
}

const workspaceTitle = (config: PwaConfig | undefined): string | null => {
  const title = config?.title
  return typeof title === 'string' && title.trim().length > 0 ? title : null
}

const workspaceDescription = (config: PwaConfig | undefined): string | null => {
  const description = config?.description
  return typeof description === 'string' && description.trim().length > 0 ? description : null
}

const dynamicManifest = (file: Resource, config: PwaConfig | undefined, icons: LogoIconDescriptor | null | undefined): Resource => {
  const title = workspaceTitle(config)
  const description = workspaceDescription(config)
  const colors = configuredThemeColors(config)
  const managedIcons = isManagedIconDescriptor(icons) ? icons : null
  if (title === null && description === null && colors === null && managedIcons === null) return file

  let parsed: unknown
  try {
    parsed = JSON.parse(file.body.toString('utf8'))
  } catch {
    return file
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return file

  const manifest = { ...(parsed as Record<string, unknown>) }
  if (title !== null) {
    manifest.name = title
    manifest.short_name = title
  }
  if (description !== null) manifest.description = description
  if (colors !== null) {
    manifest.theme_color = colors.themeColor
    manifest.background_color = colors.backgroundColor
  }
  if (managedIcons !== null) {
    manifest.icons = [
      { src: managedIcons.app192Url, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: managedIcons.app512Url, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: managedIcons.maskable512Url, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  }

  return resourceFromBody(Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'), file.lastModified)
}

const dynamicBrowserConfig = (file: Resource, config: PwaConfig | undefined, icons: LogoIconDescriptor | null | undefined): Resource => {
  const colors = configuredThemeColors(config)
  const managedIcons = isManagedIconDescriptor(icons) ? icons : null
  if (colors === null && managedIcons === null) return file

  const tileUrl = managedIcons?.tile150Url ?? PACKAGED_ICON_DESCRIPTOR.tile150Url
  const themeColor = colors?.themeColor ?? '#4F46E5'
  const body = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>\n<browserconfig>\n  <msapplication>\n    <tile>\n      <square150x150logo src="${escapedXml(tileUrl)}"/>\n      <TileColor>${escapedXml(themeColor)}</TileColor>\n    </tile>\n  </msapplication>\n</browserconfig>\n`,
    'utf8'
  )
  return resourceFromBody(body, file.lastModified)
}

const sendRevalidatingRedirect = (request: Request, response: Response, location: string): void => {
  const etag = `"${createHash('sha256').update(location).digest('hex')}"`
  response.set({
    'Cache-Control': 'public, max-age=0, must-revalidate',
    'Content-Length': '0',
    ETag: etag,
    Location: location,
    'X-Content-Type-Options': 'nosniff'
  })
  if (etagMatches(request, etag)) {
    response.status(304).end()
    return
  }
  response.status(302).end()
}

export default function createPwaController(wiki: PwaWiki): express.Router {
  const router = express.Router()
  const rootPath = path.resolve(wiki.ROOTPATH)
  const mode = wiki.pwaMode ?? currentPwaMode()
  const expectedRelease = wiki.pwaRelease

  const currentBranding = async (): Promise<ActiveBranding | null> => {
    if (!wiki.resolveBranding) return null
    try {
      return await wiki.resolveBranding()
    } catch {
      return null
    }
  }

  const sendFavicon = (request: Request, response: Response): void => {
    void (async () => {
      const branding = await currentBranding()
      const location = isManagedIconDescriptor(branding?.logoIcons) ? branding.logoIcons.faviconIcoUrl : PACKAGED_ICON_DESCRIPTOR.faviconIcoUrl
      sendRevalidatingRedirect(request, response, location)
    })()
  }
  const sendManifest = (request: Request, response: Response): void => {
    void (async () => {
      try {
        const file = await resource([rootPath, ...PWA_MANIFEST_FILE])
        const branding = await currentBranding()
        sendResource(
          request,
          response,
          dynamicManifest(file, wiki.config, branding?.logoIcons),
          'application/manifest+json',
          'public, max-age=0, must-revalidate'
        )
      } catch {
        unavailable(response, 'The PWA manifest is unavailable.')
      }
    })()
  }
  const sendBrowserConfig = (request: Request, response: Response): void => {
    void (async () => {
      try {
        const file = await resource([rootPath, ...PWA_BROWSERCONFIG_FILE])
        const branding = await currentBranding()
        sendResource(
          request,
          response,
          dynamicBrowserConfig(file, wiki.config, branding?.logoIcons),
          'application/xml; charset=utf-8',
          'public, max-age=0, must-revalidate'
        )
      } catch {
        unavailable(response, 'The browser configuration is unavailable.')
      }
    })()
  }
  const sendOfflineDocument = (request: Request, response: Response): void => {
    void (async () => {
      try {
        const file = preparedOfflineDocument(await resource([rootPath, ...OFFLINE_DOCUMENT_FILE]), mode, expectedRelease)
        const html = file.body.toString('utf8')
        sendResource(request, response, file, 'text/html; charset=utf-8', 'public, max-age=0, must-revalidate', {
          'Content-Security-Policy': offlineContentSecurityPolicy(request, html, wiki.config?.host)
        })
      } catch {
        unavailable(response, 'The neutral offline document is unavailable.')
      }
    })()
  }
  const sendServiceWorker = (request: Request, response: Response): void => {
    void (async () => {
      try {
        const file = await resource([rootPath, ...(mode === 'retirement' ? TOMBSTONE_FILE : SERVICE_WORKER_FILE)])
        sendResource(request, response, file, 'application/javascript; charset=utf-8', 'no-cache', {
          'Service-Worker-Allowed': '/'
        })
      } catch {
        unavailable(response, 'The service worker is unavailable.')
      }
    })()
  }

  router.get(PWA_FAVICON_PATH, sendFavicon)
  router.head(PWA_FAVICON_PATH, sendFavicon)
  router.get(PWA_MANIFEST_PATH, sendManifest)
  router.head(PWA_MANIFEST_PATH, sendManifest)
  router.get(PWA_BROWSERCONFIG_PATH, sendBrowserConfig)
  router.head(PWA_BROWSERCONFIG_PATH, sendBrowserConfig)
  router.get(OFFLINE_DOCUMENT_PATH, sendOfflineDocument)
  router.head(OFFLINE_DOCUMENT_PATH, sendOfflineDocument)
  router.get(SERVICE_WORKER_PATH, sendServiceWorker)
  router.head(SERVICE_WORKER_PATH, sendServiceWorker)

  return router
}
