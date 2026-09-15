import type { Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from '../bun-test.mts'
import createPwaController, { PWA_MANIFEST_PATH } from '../../controllers/pwa.ts'

const RELEASE = '0123456789abcdef0123456789abcdef01234567'
const OFFLINE_PATH = '/_offline'
const SERVICE_WORKER_PATH = '/sw.js'

type RunningServer = {
  server: Server
  baseURL: string
}

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
}

const startServer = async (rootPath: string, mode: 'feature' | 'retirement' = 'feature'): Promise<RunningServer> => {
  const app = express()
  app.use(
    '/',
    createPwaController({
      ROOTPATH: rootPath,
      config: { host: 'https://wiki.example.test' },
      pwaMode: mode,
      pwaRelease: RELEASE
    })
  )
  // Keep generic static delivery after the PWA router, matching master.ts.
  app.use('/_assets', express.static(path.join(rootPath, 'assets'), { index: false, maxAge: '7d' }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('PWA fixture server did not bind a TCP port')
  return { server, baseURL: `http://127.0.0.1:${address.port}` }
}

const prepareFixture = async (): Promise<string> => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'tsepistle-pwa-controller-'))
  await mkdir(path.join(rootPath, 'assets', 'client'), { recursive: true })
  await mkdir(path.join(rootPath, 'assets', 'js'), { recursive: true })
  await mkdir(path.join(rootPath, 'assets', 'assets'), { recursive: true })
  await writeFile(path.join(rootPath, 'assets', 'manifest-tsepistle.json'), '{"name":"Fixture","start_url":"/"}\n')
  await writeFile(path.join(rootPath, 'assets', 'service-worker.js'), 'self.addEventListener("install", () => {})\n')
  await writeFile(path.join(rootPath, 'assets', 'sw-tombstone.js'), 'self.addEventListener("activate", () => {})\n')
  await writeFile(path.join(rootPath, 'assets', 'client', 'offline.html'), `<!doctype html>
<html><head>
<meta name="tsepistle-pwa-mode" content="feature">
<meta name="tsepistle-pwa-release" content="${RELEASE}">
<link rel="modulepreload" href="/_assets/js/offline-entry.js">
<link rel="stylesheet" href="/_assets/assets/offline.css">
<script type="module" src="/_assets/js/offline-entry.js"></script>
</head><body>offline fixture</body></html>
`)
  await writeFile(path.join(rootPath, 'assets', 'js', 'offline-entry.js'), 'export default 1\n')
  await writeFile(path.join(rootPath, 'assets', 'assets', 'offline.css'), 'body { color: black; }\n')
  return rootPath
}

describe('mounted PWA delivery', () => {
  let rootPath: string
  let running: RunningServer

  beforeAll(async () => {
    rootPath = await prepareFixture()
    running = await startServer(rootPath)
  })

  afterAll(async () => {
    await closeServer(running.server)
    await rm(rootPath, { recursive: true, force: true })
  })

  it('serves the mounted manifest with refreshable cache metadata and GET/HEAD validators', async () => {
    const get = await fetch(`${running.baseURL}${PWA_MANIFEST_PATH}`)
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toMatch(/^application\/manifest\+json(?:; charset=utf-8)?$/u)
    expect(get.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    expect(get.headers.get('x-content-type-options')).toBe('nosniff')
    expect(get.headers.get('content-length')).toBe(String((await readFile(path.join(rootPath, 'assets', 'manifest-tsepistle.json'))).byteLength))
    const etag = get.headers.get('etag')
    const lastModified = get.headers.get('last-modified')
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/u)
    expect(lastModified).toBeTruthy()
    expect(await get.text()).toContain('"Fixture"')

    const head = await fetch(`${running.baseURL}${PWA_MANIFEST_PATH}`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'))
    expect(head.headers.get('etag')).toBe(etag)
    expect(head.headers.get('last-modified')).toBe(lastModified)

    const notModified = await fetch(`${running.baseURL}${PWA_MANIFEST_PATH}`, { headers: { 'if-none-match': etag! } })
    expect(notModified.status).toBe(304)
    expect(await notModified.text()).toBe('')
  })

  it('serves the neutral offline document with release-bound CSP and GET/HEAD behavior', async () => {
    const get = await fetch(`${running.baseURL}${OFFLINE_PATH}`)
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(get.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    const csp = get.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain(`script-src ${running.baseURL}/_assets/js/offline-entry.js`)
    expect(csp).toContain(`style-src ${running.baseURL}/_assets/assets/offline.css`)
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toContain("'unsafe-inline'")
    expect(await get.text()).toContain('offline fixture')

    const head = await fetch(`${running.baseURL}${OFFLINE_PATH}`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-security-policy')).toBe(csp)
    expect(head.headers.get('etag')).toBe(get.headers.get('etag'))
  })

  it('serves the feature worker with JavaScript MIME, no-cache, and worker scope permission', async () => {
    const get = await fetch(`${running.baseURL}${SERVICE_WORKER_PATH}`)
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
    expect(get.headers.get('cache-control')).toBe('no-cache')
    expect(get.headers.get('service-worker-allowed')).toBe('/')
    expect(get.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await get.text()).toBe('self.addEventListener("install", () => {})\n')

    const head = await fetch(`${running.baseURL}${SERVICE_WORKER_PATH}`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'))
  })

  it('returns 503 no-store when a required mounted artifact is unavailable', async () => {
    const missingRoot = await mkdtemp(path.join(os.tmpdir(), 'tsepistle-pwa-missing-'))
    const missingServer = await startServer(missingRoot)
    try {
      for (const [route, message] of [
        [PWA_MANIFEST_PATH, 'The PWA manifest is unavailable.'],
        [OFFLINE_PATH, 'The neutral offline document is unavailable.'],
        [SERVICE_WORKER_PATH, 'The service worker is unavailable.']
      ] as const) {
        const response = await fetch(`${missingServer.baseURL}${route}`)
        expect(response.status).toBe(503)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        expect(await response.text()).toBe(message)
      }
    } finally {
      await closeServer(missingServer.server)
      await rm(missingRoot, { recursive: true, force: true })
    }
  })

  it('rejects a neutral document from another release instead of serving stale shell bytes', async () => {
    const offlinePath = path.join(rootPath, 'assets', 'client', 'offline.html')
    const original = await readFile(offlinePath)
    await writeFile(offlinePath, original.toString('utf8').replace(RELEASE, 'fedcba9876543210fedcba9876543210fedcba98'))
    try {
      const response = await fetch(`${running.baseURL}${OFFLINE_PATH}`)
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.text()).toBe('The neutral offline document is unavailable.')
    } finally {
      await writeFile(offlinePath, original)
    }
  })

  it('delivers the tombstone artifact in retirement mode while preserving its worker headers', async () => {
    const retirementServer = await startServer(rootPath, 'retirement')
    try {
      const response = await fetch(`${retirementServer.baseURL}${SERVICE_WORKER_PATH}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
      expect(response.headers.get('cache-control')).toBe('no-cache')
      expect(response.headers.get('service-worker-allowed')).toBe('/')
      expect(await response.text()).toBe('self.addEventListener("activate", () => {})\n')
      const offline = await fetch(`${retirementServer.baseURL}${OFFLINE_PATH}`)
      expect(offline.status).toBe(200)
      expect(await offline.text()).toContain('name="tsepistle-pwa-mode" content="retirement"')
    } finally {
      await closeServer(retirementServer.server)
    }
  })
})
