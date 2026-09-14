import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import express, { type Request, type Response } from 'express'

export const PWA_TOMBSTONE_ENVIRONMENT_VARIABLE = 'TSEPISTLE_PWA_TOMBSTONE' as const

const OFFLINE_DOCUMENT_PATH = '/_offline'
const SERVICE_WORKER_PATH = '/sw.js'
const OFFLINE_DOCUMENT_FILE = ['assets', 'client', 'offline.html'] as const
const SERVICE_WORKER_FILE = ['assets', 'service-worker.js'] as const
const TOMBSTONE_FILE = ['assets', 'sw-tombstone.js'] as const
const CSP_DOCUMENT_ORIGIN = 'https://tsepistle-offline.invalid'
const CSP_ASSET_PATH = /^\/_assets\//

export interface PwaWiki {
  ROOTPATH: string
  config?: { host?: string }
}

interface Resource {
  readonly body: Buffer
  readonly etag: string
  readonly lastModified: string
}

const resource = async (filename: readonly string[]): Promise<Resource> => {
  const filePath = path.join(...filename)
  const [body, metadata] = await Promise.all([readFile(filePath), stat(filePath)])
  const digest = createHash('sha256').update(body).digest('hex')
  return { body, etag: `"${digest}"`, lastModified: metadata.mtime.toUTCString() }
}

const environmentFlagEnabled = (value: string | undefined): boolean => /^(?:1|true|yes|on)$/i.test(value?.trim() ?? '')

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

export default function createPwaController(wiki: PwaWiki): express.Router {
  const router = express.Router()
  const rootPath = path.resolve(wiki.ROOTPATH)
  // Set TSEPISTLE_PWA_TOMBSTONE=1 (or true/yes/on) only for an approved rollback.
  // The flag is intentionally process-environment-only, defaults to the feature worker,
  // and never falls back to the feature worker when the explicit tombstone artifact is missing.
  const tombstoneSelected = environmentFlagEnabled(process.env[PWA_TOMBSTONE_ENVIRONMENT_VARIABLE])

  const sendOfflineDocument = (request: Request, response: Response): void => {
    void (async () => {
      try {
        const file = await resource([rootPath, ...OFFLINE_DOCUMENT_FILE])
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
        const file = await resource([rootPath, ...(tombstoneSelected ? TOMBSTONE_FILE : SERVICE_WORKER_FILE)])
        sendResource(request, response, file, 'application/javascript; charset=utf-8', 'no-cache', {
          'Service-Worker-Allowed': '/'
        })
      } catch {
        unavailable(response, 'The service worker is unavailable.')
      }
    })()
  }

  router.get(OFFLINE_DOCUMENT_PATH, sendOfflineDocument)
  router.head(OFFLINE_DOCUMENT_PATH, sendOfflineDocument)
  router.get(SERVICE_WORKER_PATH, sendServiceWorker)
  router.head(SERVICE_WORKER_PATH, sendServiceWorker)

  return router
}
