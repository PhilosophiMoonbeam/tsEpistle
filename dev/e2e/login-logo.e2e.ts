import { Buffer } from 'node:buffer'
import type { Locator, Page, Request, TestInfo } from '@playwright/test'
import { expect } from '@playwright/test'
import sharp from 'sharp'
import type {
  ParticleBackendKind,
  ParticleBackendRequest
} from '../../client/components/login-logo/particle-renderer.ts'
import type {
  LogoBackendDiagnostic,
  LogoMotionDiagnostics,
  LogoParticlePerformanceHook,
  LogoPerformanceFrame,
  LogoPerformanceHook,
  LogoPerformanceWindow,
  LogoResumeSample
} from './logo-particle-benchmark.ts'
import { responsiveTest as test } from './helpers.ts'

test.use({ serviceWorkers: 'block' })

const LOGO_URL = `/_site-logo/${'a'.repeat(64)}/logo.png`
const SQUARE_PARTICLE_URL = `/_site-logo/${'b'.repeat(64)}/particle.bin`
const SQUARE_STATIC_URL = `/_site-logo/${'c'.repeat(64)}/effect.png`
const WIDE_PARTICLE_URL = `/_site-logo/${'d'.repeat(64)}/particle.bin`
const WIDE_STATIC_URL = `/_site-logo/${'e'.repeat(64)}/effect.png`
const SCENE_REQUEST_PATTERN = /\/LogoParticleScene[^/?]*(?:\.vue|\.js)(?:\?|$)/
const ELIGIBLE_DESKTOP_PROJECTS = [
  'responsive-chromium-desktop',
  'responsive-firefox-desktop',
  'responsive-webkit-desktop',
  'responsive-chromium-wide'
] as const
const STRICT_BACKEND_PROJECTS = ['responsive-chromium-desktop'] as const
const OMITTED_DEVICE_PROJECTS = [
  'responsive-chromium-tablet',
  'responsive-chromium-mobile',
  'responsive-webkit-mobile',
  'responsive-webkit-mobile-landscape'
] as const

const squareEffect = {
  logoUrl: LOGO_URL,
  particleUrl: SQUARE_PARTICLE_URL,
  staticUrl: SQUARE_STATIC_URL,
  pipelineVersion: 5,
  width: 8,
  height: 8,
  aspect: 1,
  count: 2_000,
  medianStroke: 2,
  auraColor: '#336699'
}

const wideEffect = {
  logoUrl: LOGO_URL,
  particleUrl: WIDE_PARTICLE_URL,
  staticUrl: WIDE_STATIC_URL,
  pipelineVersion: 5,
  width: 1200,
  height: 100,
  aspect: 12,
  count: 2_000,
  medianStroke: 12
}

const COLOR_PROBE_LOGO_URL = `/_site-logo/${'f'.repeat(64)}/logo.png`
const COLOR_PROBE_PARTICLE_URL = `/_site-logo/${'1'.repeat(64)}/particle.bin`
const COLOR_PROBE_STATIC_URL = `/_site-logo/${'2'.repeat(64)}/effect.png`
const colorProbeEffect = {
  logoUrl: COLOR_PROBE_LOGO_URL,
  particleUrl: COLOR_PROBE_PARTICLE_URL,
  staticUrl: COLOR_PROBE_STATIC_URL,
  pipelineVersion: 5,
  width: 8,
  height: 8,
  aspect: 1,
  count: 4,
  medianStroke: 2
} as const

type ColorProbeParticle = {
  readonly x: number
  readonly y: number
  readonly color: readonly [number, number, number, number]
  readonly seed: number
  readonly size: number
  readonly kind: 'dust' | 'bead'
}

const colorProbeParticles = [
  { x: -0.68, y: 0.28, color: [54, 163, 217, 238], seed: 20_000, size: 255, kind: 'dust' },
  { x: -0.22, y: 0.28, color: [128, 128, 128, 238], seed: 30_000, size: 255, kind: 'dust' },
  { x: 0.22, y: -0.24, color: [54, 163, 217, 238], seed: 64_000, size: 255, kind: 'bead' },
  { x: 0.68, y: -0.24, color: [128, 128, 128, 238], seed: 62_000, size: 255, kind: 'bead' }
] as const satisfies readonly ColorProbeParticle[]

type ManagedEffect = typeof squareEffect | typeof wideEffect | typeof colorProbeEffect
const PIPELINE_V5_RESERVED_SAMPLES_PER_COMPONENT = 8

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const value of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 0xff]!
  return (crc ^ 0xffffffff) >>> 0
}

interface ParticleFixtureSample {
  readonly component: number
  readonly depth: number
  readonly sequence: number
  readonly size: number
  readonly x: number
  readonly y: number
}

function particleFixtureSample(index: number): ParticleFixtureSample {
  const component = index < 3 * PIPELINE_V5_RESERVED_SAMPLES_PER_COMPONENT ? Math.floor(index / PIPELINE_V5_RESERVED_SAMPLES_PER_COMPONENT) : index % 3
  const sequence = Math.floor(index / 3)
  const u = ((sequence * 73) % 997) / 996
  const v = ((sequence * 193) % 991) / 990
  let x: number
  let y: number
  if (component === 0) {
    x = -0.8 + 0.5 * u
    y = -0.6 + 1.2 * v
  } else if (component === 1) {
    const angle = 2 * Math.PI * v
    const radius = 0.34 * Math.sqrt(u)
    x = 0.04 + radius * Math.cos(angle)
    y = radius * Math.sin(angle)
  } else {
    x = 0.42 + 0.38 * u
    y = -0.5 + v
  }
  return {
    component,
    depth: [-96, 0, 96][sequence % 3]!,
    sequence,
    size: 5 + (sequence % 8),
    x,
    y
  }
}

function createParticleFixture(effect: ManagedEffect): Buffer {
  const headerBytes = 56
  const count = effect.count
  const xyOffset = headerBytes
  const depthOffset = xyOffset + 4 * count
  const rgbaOffset = depthOffset + count
  const sizeOffset = rgbaOffset + 4 * count
  const seedOffset = sizeOffset + count
  const fileLength = seedOffset + 2 * count
  const bytes = Buffer.allocUnsafe(fileLength)

  bytes.write('TSEP', 0, 'ascii')
  bytes[4] = 1
  bytes[5] = 0x07
  bytes.writeUInt16LE(headerBytes, 6)
  bytes.writeUInt32LE(effect.width, 8)
  bytes.writeUInt32LE(effect.height, 12)
  bytes.writeUInt32LE(count, 16)
  bytes.writeUInt32LE(12 * count, 20)
  bytes.writeUInt32LE(0, 24)
  bytes.writeUInt32LE(xyOffset, 28)
  bytes.writeUInt32LE(depthOffset, 32)
  bytes.writeUInt32LE(rgbaOffset, 36)
  bytes.writeUInt32LE(sizeOffset, 40)
  bytes.writeUInt32LE(seedOffset, 44)
  bytes.writeUInt32LE(fileLength, 48)
  bytes.writeUInt32LE(0, 52)

  const componentColors = [
    [54, 163, 217, 238],
    [16, 16, 16, 232],
    [248, 248, 248, 244]
  ] as const
  for (let index = 0; index < count; index += 1) {
    // The first eight records of each meaningful color component are deterministic v5 reservations.
    const sample = particleFixtureSample(index)
    bytes.writeInt16LE(Math.round(sample.x * 32_767), xyOffset + index * 4)
    bytes.writeInt16LE(Math.round(sample.y * 32_767), xyOffset + index * 4 + 2)
    bytes.writeInt8(sample.depth, depthOffset + index)
    const color = componentColors[sample.component]!
    bytes[rgbaOffset + index * 4] = color[0]
    bytes[rgbaOffset + index * 4 + 1] = color[1]
    bytes[rgbaOffset + index * 4 + 2] = color[2]
    bytes[rgbaOffset + index * 4 + 3] = color[3]
    bytes[sizeOffset + index] = sample.size
    bytes.writeUInt16LE(((index * 40_503) % 65_535) + 1, seedOffset + index * 2)
  }
  bytes.writeUInt32LE(crc32(bytes.subarray(headerBytes)), 24)
  return bytes
}

function createColorProbeFixture(): Buffer {
  const headerBytes = 56
  const count = colorProbeParticles.length
  const xyOffset = headerBytes
  const depthOffset = xyOffset + 4 * count
  const rgbaOffset = depthOffset + count
  const sizeOffset = rgbaOffset + 4 * count
  const seedOffset = sizeOffset + count
  const fileLength = seedOffset + 2 * count
  const bytes = Buffer.allocUnsafe(fileLength)

  bytes.write('TSEP', 0, 'ascii')
  bytes[4] = 1
  bytes[5] = 0x07
  bytes.writeUInt16LE(headerBytes, 6)
  bytes.writeUInt32LE(colorProbeEffect.width, 8)
  bytes.writeUInt32LE(colorProbeEffect.height, 12)
  bytes.writeUInt32LE(count, 16)
  bytes.writeUInt32LE(12 * count, 20)
  bytes.writeUInt32LE(0, 24)
  bytes.writeUInt32LE(xyOffset, 28)
  bytes.writeUInt32LE(depthOffset, 32)
  bytes.writeUInt32LE(rgbaOffset, 36)
  bytes.writeUInt32LE(sizeOffset, 40)
  bytes.writeUInt32LE(seedOffset, 44)
  bytes.writeUInt32LE(fileLength, 48)
  bytes.writeUInt32LE(0, 52)

  for (const [index, sample] of colorProbeParticles.entries()) {
    bytes.writeInt16LE(Math.round(sample.x * 32_767), xyOffset + index * 4)
    bytes.writeInt16LE(Math.round(sample.y * 32_767), xyOffset + index * 4 + 2)
    bytes.writeInt8(0, depthOffset + index)
    bytes[rgbaOffset + index * 4] = sample.color[0]
    bytes[rgbaOffset + index * 4 + 1] = sample.color[1]
    bytes[rgbaOffset + index * 4 + 2] = sample.color[2]
    bytes[rgbaOffset + index * 4 + 3] = sample.color[3]
    bytes[sizeOffset + index] = sample.size
    bytes.writeUInt16LE(sample.seed, seedOffset + index * 2)
  }
  bytes.writeUInt32LE(crc32(bytes.subarray(headerBytes)), 24)
  return bytes
}

const colorProbeParticleFixture = createColorProbeFixture()

const squareParticleFixture = createParticleFixture(squareEffect)
const wideParticleFixture = createParticleFixture(wideEffect)

interface ArtifactOptions {
  readonly logoBody?: string | Buffer
  readonly logoStatus?: number
  readonly particleBody?: string | Buffer
  readonly particleStatus?: number
  readonly staticBody?: string | Buffer
  readonly staticStatus?: number
}

interface ArtifactRequests {
  readonly logo: Request[]
  readonly particle: Request[]
  readonly static: Request[]
}
interface ParticleFetchObservation {
  readonly credentials: RequestCredentials
  readonly url: string
}


type StrictParticleBackend = Exclude<ParticleBackendRequest, 'auto'>


interface LogoFramePointerSample {
  readonly clientX: number
  readonly clientY: number
  readonly pointerId?: number
  readonly pointerType?: 'mouse' | 'pen' | 'touch'
  readonly type?: 'pointercancel' | 'pointerdown' | 'pointermove' | 'pointerup'
}

interface LogoResourceTrace {
  activeIdleCallbacks: number
  activeLogoTimers: number
  activeRafs: number
  canvasCreated: number
  idleCallbacksCancelled: number
  idleCallbacksScheduled: number
  logoTimersCleared: number
  logoTimersScheduled: number
  pointerListenersAdded: number
  pointerListenersRemoved: number
  rafCallbacks: number
  rafsCancelled: number
  rafsScheduled: number
}

interface ReducedMotionChangeReport {
  readonly performanceCallbackCount: number
  readonly canvasCount: number
  readonly pointerActive: boolean
  readonly staticOpacity: string | null
  readonly staticTransition: string | null
  readonly trace: LogoResourceTrace
}

interface LogoRenderedFrame {
  readonly capturedAt: number
  readonly dataUrl: string
}

interface LogoFrameCaptureOptions {
  readonly elapsedSeconds?: number
  readonly pointerTimeMilliseconds?: number
}

interface LogoFrameCaptureHook {
  request: ((options?: LogoFrameCaptureOptions) => Promise<LogoRenderedFrame>) | null
}

interface CapturedCanvasPng {
  readonly capturedAt: number
  readonly png: Buffer
}

interface LogoMotionObservation {
  readonly diagnostics: LogoMotionDiagnostics
  readonly keys: string[]
}

interface LogoOpacityTrace {
  readonly values: string[]
}
declare global {
  interface Window {
    __logoParticleFrameCapture?: LogoFrameCaptureHook
    __loginLogoParticleFetches?: ParticleFetchObservation[]
    __readLoginLogoTrace?: () => LogoResourceTrace
    __loginLogoReducedMotionReport?: ReducedMotionChangeReport | null
    __setLogoParticleVisibility?: (visibility: DocumentVisibilityState) => void
    __readLoginLogoOpacityTrace?: () => LogoOpacityTrace
    __loginLogoFrameFreeze?: { restore: () => void }
  }
}

function ordinarySvgFixture(width: number, height: number): string {
  const shortAxis = Math.min(width, height)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g><rect x="${width * 0.1}" y="${height * 0.2}" width="${width * 0.25}" height="${height * 0.6}" rx="${shortAxis * 0.08}" fill="#36a3d9"/><circle cx="${width * 0.52}" cy="${height * 0.5}" r="${shortAxis * 0.24}" fill="#101010"/><rect x="${width * 0.7}" y="${height * 0.25}" width="${width * 0.2}" height="${height * 0.5}" fill="#f8f8f8"/><circle cx="${width * 0.06}" cy="${height * 0.12}" r="${shortAxis * 0.055}" fill="#e8538a"/></g></svg>`
}

function staticSvgFixture(width: number, height: number): string {
  const shortAxis = Math.min(width, height)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g><rect x="${width * 0.12}" y="${height * 0.22}" width="${width * 0.21}" height="${height * 0.56}" rx="${shortAxis * 0.08}" fill="#36a3d9"/><circle cx="${width * 0.52}" cy="${height * 0.5}" r="${shortAxis * 0.21}" fill="#101010"/><rect x="${width * 0.72}" y="${height * 0.28}" width="${width * 0.16}" height="${height * 0.44}" fill="#f8f8f8"/><path d="M ${width * 0.42} ${height * 0.82} L ${width * 0.52} ${height * 0.7} L ${width * 0.62} ${height * 0.82} Z" fill="#ffd43b"/></g></svg>`
}

async function installManagedLogo(page: Page, effect: ManagedEffect, options: ArtifactOptions = {}): Promise<ArtifactRequests> {
  await page.addInitScript(descriptor => {
    let currentConfig: unknown
    Object.defineProperty(window, 'siteConfig', {
      configurable: true,
      get: () => currentConfig,
      set: value => {
        if (value && typeof value === 'object') {
          const config = value as Record<string, unknown>
          config.logoUrl = descriptor.logoUrl
          config.logoEffect = descriptor
        }
        currentConfig = value
      }
    })
  }, effect)

  const ordinaryImage = ordinarySvgFixture(effect.width, effect.height)
  const staticImage = staticSvgFixture(effect.width, effect.height)
  const particles = effect === squareEffect ? squareParticleFixture : effect === wideEffect ? wideParticleFixture : colorProbeParticleFixture
  const requests: ArtifactRequests = { logo: [], particle: [], static: [] }
  await page.route(`**${effect.logoUrl}`, route => {
    requests.logo.push(route.request())
    return route.fulfill({
      status: options.logoStatus ?? 200,
      contentType: 'image/svg+xml',
      body: options.logoBody ?? ordinaryImage
    })
  })
  await page.route(`**${effect.staticUrl}`, route => {
    requests.static.push(route.request())
    return route.fulfill({
      status: options.staticStatus ?? 200,
      contentType: 'image/svg+xml',
      body: options.staticBody ?? staticImage
    })
  })
  await page.route(`**${effect.particleUrl}`, route => {
    requests.particle.push(route.request())
    return route.fulfill({
      status: options.particleStatus ?? 200,
      contentType: 'application/octet-stream',
      body: options.particleBody ?? particles
    })
  })
  return requests
}

async function installLogoFrameCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__logoParticleFrameCapture = { request: null }
  })
}

async function installLogoPerformanceProbe(page: Page, requestedBackend: ParticleBackendRequest = 'auto'): Promise<void> {
  await page.addInitScript(({ requestedBackend: initialRequestedBackend }: { requestedBackend: ParticleBackendRequest }) => {
    const benchmark: LogoPerformanceHook = {
      callbackCount: 0,
      callbackCpuMilliseconds: [],
      frameIntervalsMilliseconds: [],
      firstFrameMilliseconds: null,
      lastFrameAt: null,
      requestedBackend: initialRequestedBackend,
      effectiveBackend: null,
      backendDiagnostics: [],
      startup: {},
      resumes: [],
      frames: [],
      counters: {
        updateCallbacks: 0,
        renderInvocations: 0,
        afterRenderCallbacks: 0,
        rafCallbacks: 0,
        draws: 0,
        uploads: 0,
        sampleOverflow: 0
      }
    }
    benchmark.onDiagnostics = diagnostic => {
      benchmark.backendDiagnostics?.push({ ...diagnostic })
      benchmark.effectiveBackend = diagnostic.effectiveBackend
    }
    const logoPerformanceWindow = (): LogoPerformanceWindow => window as LogoPerformanceWindow
    Object.defineProperty(logoPerformanceWindow(), '__logoParticlePerformance', {
      configurable: true,
      value: benchmark,
      writable: true
    })

    let visibility: DocumentVisibilityState = 'visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility
    })
    Object.defineProperty(window, '__setLogoParticleVisibility', {
      configurable: true,
      value: (nextVisibility: DocumentVisibilityState): void => {
        visibility = nextVisibility
        document.dispatchEvent(new Event('visibilitychange'))
      },
      writable: true
    })
  }, { requestedBackend })
}

async function readLogoPerformance(page: Page): Promise<LogoPerformanceHook> {
  return page.evaluate(() => {
    const logoPerformanceWindow = (): LogoPerformanceWindow => window as LogoPerformanceWindow
    const benchmark = logoPerformanceWindow().__logoParticlePerformance
    if (!benchmark) throw new Error('The logo particle performance hook is unavailable.')
    return {
      callbackCount: benchmark.callbackCount,
      callbackCpuMilliseconds: [...benchmark.callbackCpuMilliseconds],
      frameIntervalsMilliseconds: [...benchmark.frameIntervalsMilliseconds],
      firstFrameMilliseconds: benchmark.firstFrameMilliseconds,
      lastFrameAt: benchmark.lastFrameAt,
      lastMotion: benchmark.lastMotion ? { ...benchmark.lastMotion } : undefined,
      requestedBackend: benchmark.requestedBackend,
      effectiveBackend: benchmark.effectiveBackend,
      backendDiagnostics: benchmark.backendDiagnostics?.map((diagnostic: LogoBackendDiagnostic) => ({ ...diagnostic })),
      startup: benchmark.startup ? { ...benchmark.startup } : undefined,
      resumes: benchmark.resumes?.map((resume: LogoResumeSample) => ({ ...resume })),
      frames: benchmark.frames?.map((frame: LogoPerformanceFrame) => ({ ...frame })),
      counters: benchmark.counters ? { ...benchmark.counters } : undefined
    }
  })
}

async function resetLogoPerformance(page: Page): Promise<void> {
  await page.evaluate(() => {
    const logoPerformanceWindow = (): LogoPerformanceWindow => window as LogoPerformanceWindow
    const benchmark = logoPerformanceWindow().__logoParticlePerformance
    if (!benchmark) throw new Error('The logo particle performance hook is unavailable.')
    benchmark.callbackCount = 0
    benchmark.callbackCpuMilliseconds.length = 0
    benchmark.frameIntervalsMilliseconds.length = 0
    benchmark.lastFrameAt = null
    benchmark.frames?.splice(0)
    benchmark.resumes?.splice(0)
    if (benchmark.counters) {
      benchmark.counters.updateCallbacks = 0
      benchmark.counters.renderInvocations = 0
      benchmark.counters.afterRenderCallbacks = 0
      benchmark.counters.rafCallbacks = 0
      benchmark.counters.draws = 0
      benchmark.counters.uploads = 0
      benchmark.counters.sampleOverflow = 0
    }
  })
}

interface BackendCapability {
  readonly available: boolean
  readonly evidence: string
}

async function detectBackendCapability(page: Page, backend: StrictParticleBackend): Promise<BackendCapability> {
  return page.evaluate(async selectedBackend => {
    if (selectedBackend === 'webgl2') {
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('webgl2')
      return context
        ? { available: true, evidence: 'HTMLCanvasElement.getContext(webgl2) returned a context.' }
        : { available: false, evidence: 'HTMLCanvasElement.getContext(webgl2) returned null.' }
    }

    const gpu = (navigator as Navigator & {
      gpu?: { requestAdapter?: () => Promise<unknown> }
    }).gpu
    if (!gpu || typeof gpu.requestAdapter !== 'function') {
      return { available: false, evidence: 'navigator.gpu.requestAdapter is unavailable.' }
    }
    try {
      const adapter = await gpu.requestAdapter()
      return adapter
        ? { available: true, evidence: 'navigator.gpu.requestAdapter returned a native adapter.' }
        : { available: false, evidence: 'navigator.gpu.requestAdapter returned null.' }
    } catch (error: unknown) {
      return {
        available: false,
        evidence: `navigator.gpu.requestAdapter rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }, backend)
}

function skipUnsupportedStrictBackend(testInfo: TestInfo, backend: StrictParticleBackend, capability: BackendCapability): void {
  if (capability.available) return
  const description = `Strict ${backend} coverage skipped with runtime evidence: ${capability.evidence}`
  testInfo.annotations.push({ type: 'capability-skip', description })
  test.skip(true, description)
}

async function waitForBackendOutcome(page: Page): Promise<LogoPerformanceHook> {
  await page.waitForFunction(
    () => {
      const logoPerformanceWindow = (): LogoPerformanceWindow => window as LogoPerformanceWindow
      const benchmark = logoPerformanceWindow().__logoParticlePerformance
      return benchmark !== undefined &&
        (benchmark.effectiveBackend !== null || document.querySelector('.login-particle-logo canvas') === null)
    },
    undefined,
    { timeout: 15_000 }
  )
  return readLogoPerformance(page)
}

async function expectBackendReady(
  page: Page,
  backend: StrictParticleBackend,
  effect: ManagedEffect,
  requestedBackend: ParticleBackendRequest = backend
): Promise<LogoPerformanceHook> {
  await expect
    .poll(async () => (await readLogoPerformance(page)).effectiveBackend ?? null, { timeout: 15_000 })
    .toBe(backend)
  const benchmark = await readLogoPerformance(page)
  expect(benchmark.requestedBackend).toBe(requestedBackend)
  expect(benchmark.effectiveBackend).toBe(backend)
  expect(benchmark.backendDiagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        requestedBackend,
        effectiveBackend: backend,
        fallback: requestedBackend !== backend,
        phase: 'ready',
        reason: 'ready'
      })
    ])
  )
  expect(benchmark.backendDiagnostics?.every((diagnostic: LogoBackendDiagnostic) => diagnostic.requestedBackend === requestedBackend)).toBe(true)

  const field = page.locator('.login-particle-logo')
  const canvas = field.locator('canvas')
  const staticImage = field.locator('.login-particle-logo__image')
  await expect(canvas).toHaveCount(1)
  await expect(staticImage).toHaveCSS('opacity', '0')
  await expect
    .poll(async () =>
      (await readLogoPerformance(page)).frames?.some((frame: LogoPerformanceFrame) =>
        frame.totalDrawCalls === 1 &&
        frame.particleInstances === effect.count &&
        frame.triangles === effect.count * 2 &&
        frame.computeDispatches === 0 &&
        (frame.motionScheduledBytes ?? 0) > 0 &&
        frame.colorUploadBytes === 0
      ) ?? false
    )
    .toBe(true)

  const committed = await readLogoPerformance(page)
  const startup = committed.startup
  expect(startup?.firstSubmissionAt).toEqual(expect.any(Number))
  expect(startup?.visibleCommitAt).toEqual(expect.any(Number))
  expect(startup?.visibleCommitAt).toBeGreaterThanOrEqual(startup?.firstSubmissionAt ?? Number.POSITIVE_INFINITY)
  return committed
}

async function installParticleFetchProbe(page: Page, particleUrl: string): Promise<void> {
  await page.addInitScript(expectedParticleUrl => {
    const nativeFetch = window.fetch.bind(window)
    window.__loginLogoParticleFetches = []
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new globalThis.Request(input, init)
      if (request.url === new URL(expectedParticleUrl, window.location.href).href) {
        window.__loginLogoParticleFetches?.push({
          credentials: request.credentials,
          url: request.url
        })
      }
      return nativeFetch(input, init)
    }) as typeof window.fetch
  }, particleUrl)
}

async function readParticleFetchProbe(page: Page): Promise<ParticleFetchObservation[]> {
  return page.evaluate(() => {
    const observations = window.__loginLogoParticleFetches
    if (!observations) throw new Error('The particle fetch probe is unavailable.')
    return observations
  })
}

async function installLogoResourceTrace(page: Page, requestedBackend: ParticleBackendRequest = 'auto'): Promise<void> {
  await installLogoPerformanceProbe(page, requestedBackend)
  await page.addInitScript(() => {
    const trace: Omit<LogoResourceTrace, 'activeIdleCallbacks' | 'activeLogoTimers' | 'activeRafs'> = {
      canvasCreated: 0,
      idleCallbacksCancelled: 0,
      idleCallbacksScheduled: 0,
      logoTimersCleared: 0,
      logoTimersScheduled: 0,
      pointerListenersAdded: 0,
      pointerListenersRemoved: 0,
      rafCallbacks: 0,
      rafsCancelled: 0,
      rafsScheduled: 0
    }
    const activeIdleCallbacks = new Set<number>()
    const activeLogoTimers = new Set<number>()
    const activeRafs = new Set<number>()
    window.__readLoginLogoTrace = () => ({
      ...trace,
      activeIdleCallbacks: activeIdleCallbacks.size,
      activeLogoTimers: activeLogoTimers.size,
      activeRafs: activeRafs.size
    })

    const nativeCreateElement = Document.prototype.createElement
    Document.prototype.createElement = function (
      this: Document,
      qualifiedName: string,
      options?: ElementCreationOptions
    ): HTMLElement {
      const element = nativeCreateElement.call(this, qualifiedName, options) as HTMLElement
      if (element instanceof HTMLCanvasElement && document.querySelector('.login-particle-logo')) {
        trace.canvasCreated += 1
      }
      return element
    } as typeof Document.prototype.createElement

    const nativeAddEventListener = EventTarget.prototype.addEventListener
    const nativeRemoveEventListener = EventTarget.prototype.removeEventListener
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      callback: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ): void {
      const trackedPointerEvent =
        type === 'pointermove' || type === 'pointerleave' || type === 'pointerdown' || type === 'pointerup' || type === 'pointercancel'
      if (trackedPointerEvent && this instanceof Element && this.classList.contains('login-particle-logo')) {
        trace.pointerListenersAdded += 1
      }
      nativeAddEventListener.call(this, type, callback, options)
    }
    EventTarget.prototype.removeEventListener = function (
      this: EventTarget,
      type: string,
      callback: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions
    ): void {
      const trackedPointerEvent =
        type === 'pointermove' || type === 'pointerleave' || type === 'pointerdown' || type === 'pointerup' || type === 'pointercancel'
      if (trackedPointerEvent && this instanceof Element && this.classList.contains('login-particle-logo')) {
        trace.pointerListenersRemoved += 1
      }
      nativeRemoveEventListener.call(this, type, callback, options)
    }

    const nativeSetTimeout = window.setTimeout.bind(window)
    const nativeClearTimeout = window.clearTimeout.bind(window)
    window.setTimeout = ((handler: TimerHandler, timeout = 0, ...args: unknown[]): number => {
      const tracked = (timeout === 750 || timeout === 1_500) && document.querySelector('.login-particle-logo') !== null
      let timer = 0
      const wrapped =
        typeof handler === 'function'
          ? (...callbackArgs: unknown[]) => {
              if (tracked) activeLogoTimers.delete(timer)
              handler(...callbackArgs)
            }
          : handler
      timer = nativeSetTimeout(wrapped as TimerHandler, timeout, ...args)
      if (tracked) {
        trace.logoTimersScheduled += 1
        activeLogoTimers.add(timer)
      }
      return timer
    }) as typeof window.setTimeout
    window.clearTimeout = ((timer?: number) => {
      if (timer !== undefined && activeLogoTimers.delete(timer)) trace.logoTimersCleared += 1
      nativeClearTimeout(timer)
    }) as typeof window.clearTimeout

    const nativeRequestIdleCallback = window.requestIdleCallback?.bind(window)
    const nativeCancelIdleCallback = window.cancelIdleCallback?.bind(window)
    if (nativeRequestIdleCallback && nativeCancelIdleCallback) {
      window.requestIdleCallback = (callback, options) => {
        let idleHandle = 0
        const tracked = document.querySelector('.login-particle-logo') !== null
        idleHandle = nativeRequestIdleCallback(deadline => {
          if (tracked) activeIdleCallbacks.delete(idleHandle)
          callback(deadline)
        }, options)
        if (tracked) {
          trace.idleCallbacksScheduled += 1
          activeIdleCallbacks.add(idleHandle)
        }
        return idleHandle
      }
      window.cancelIdleCallback = idleHandle => {
        if (activeIdleCallbacks.delete(idleHandle)) trace.idleCallbacksCancelled += 1
        nativeCancelIdleCallback(idleHandle)
      }
    }

    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window)
    const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window)
    window.requestAnimationFrame = callback => {
      const tracked = document.querySelector('.login-particle-logo canvas') !== null
      let frame = 0
      frame = nativeRequestAnimationFrame(time => {
        if (tracked) {
          activeRafs.delete(frame)
          trace.rafCallbacks += 1
        }
        callback(time)
      })
      if (tracked) {
        trace.rafsScheduled += 1
        activeRafs.add(frame)
      }
      return frame
    }
    window.cancelAnimationFrame = frame => {
      if (activeRafs.delete(frame)) trace.rafsCancelled += 1
      nativeCancelAnimationFrame(frame)
    }
  })
}

async function readLogoResourceTrace(page: Page): Promise<LogoResourceTrace> {
  return page.evaluate(() => {
    const read = window.__readLoginLogoTrace
    if (!read) throw new Error('The logo resource trace is unavailable.')
    return read()
  })
}

async function readLogoMotion(page: Page): Promise<LogoMotionObservation | null> {
  return page.evaluate(() => {
    const logoPerformanceWindow = (): LogoPerformanceWindow => window as LogoPerformanceWindow
    const motion = logoPerformanceWindow().__logoParticlePerformance?.lastMotion
    if (!motion) return null
    return {
      diagnostics: { ...motion },
      keys: Object.keys(motion).sort()
    }
  })
}
async function installReducedMotionChangeProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const logoPerformanceWindow = (): LogoPerformanceWindow => window as LogoPerformanceWindow
    const benchmark = logoPerformanceWindow().__logoParticlePerformance
    const readTrace = window.__readLoginLogoTrace
    if (!benchmark || !readTrace) throw new Error('The reduced-motion probe prerequisites are unavailable.')
    window.__loginLogoReducedMotionReport = null
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const recordChange = (): void => {
      if (!motionQuery.matches) return
      motionQuery.removeEventListener('change', recordChange)
      const image = document.querySelector<HTMLElement>('.login-particle-logo__image')
      window.__loginLogoReducedMotionReport = {
        performanceCallbackCount: benchmark.callbackCount,
        canvasCount: document.querySelectorAll('.login-particle-logo canvas').length,
        pointerActive: document.querySelector('.login-particle-logo--pointer-active') !== null,
        staticOpacity: image ? getComputedStyle(image).opacity : null,
        staticTransition: image?.style.transition ?? null,
        trace: readTrace()
      }
    }
    motionQuery.addEventListener('change', recordChange)
  })
}
async function readReducedMotionChangeReport(page: Page): Promise<ReducedMotionChangeReport | null> {
  return page.evaluate(() => window.__loginLogoReducedMotionReport ?? null)
}

async function installLogoOpacityTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const image = document.querySelector<HTMLElement>('.login-particle-logo__image')
    if (!image) throw new Error('The particle static image is unavailable.')
    const values: string[] = []
    const observer = new MutationObserver(() => {
      values.push(image.style.opacity)
    })
    observer.observe(image, { attributes: true, attributeFilter: ['style'] })
    Object.defineProperty(window, '__readLoginLogoOpacityTrace', {
      configurable: true,
      value: (): LogoOpacityTrace => ({ values: [...values] })
    })
  })
}
async function readLogoOpacityTrace(page: Page): Promise<LogoOpacityTrace> {
  return page.evaluate(() => {
    const read = window.__readLoginLogoOpacityTrace
    if (!read) throw new Error('The logo opacity trace is unavailable.')
    return read()
  })
}

async function installRegistrationShell(page: Page): Promise<void> {
  await page.route(/\/register$/, async route => {
    const response = await route.fetch({ url: new URL('/login', route.request().url()).href })
    const loginDocument = await response.text()
    const registerDocument = loginDocument.replace(/<login\b[^>]*><\/login>/, '<register bg-url=""></register>')
    if (registerDocument === loginDocument) throw new Error('The login document did not contain the expected application mount.')
    await route.fulfill({ response, body: registerDocument })
  })
}

async function installZeroFreeSpaceLogin(page: Page): Promise<void> {
  await page.route(
    url => url.pathname === '/login',
    async route => {
      const request = route.request()
      if (
        request.method() !== 'GET' ||
        request.resourceType() !== 'document' ||
        !request.isNavigationRequest() ||
        new URL(request.url()).pathname !== '/login'
      ) {
        await route.fallback()
        return
      }
      const response = await route.fetch()
      const loginDocument = await response.text()
      const zeroSpaceDocument = loginDocument.replace(
        '</head>',
        '<style id="login-logo-zero-space-fixture">.login > main.login-sd { width: 100% !important; max-width: none !important; }</style></head>'
      )
      if (zeroSpaceDocument === loginDocument) throw new Error('The login document did not contain the expected head element.')
      await route.fulfill({ response, body: zeroSpaceDocument })
    }
  )
}

async function measureLogoFreeWidth(page: Page): Promise<number> {
  return page.locator('main.login-sd').evaluate(card => {
    const login = card.parentElement
    if (!(login instanceof HTMLElement)) throw new Error('The login card does not have the expected parent.')
    const loginRect = login.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const paddingRight = Number.parseFloat(getComputedStyle(login).paddingRight) || 0
    const fieldRight = Math.min(loginRect.right, document.documentElement.clientWidth || window.innerWidth) - paddingRight
    return fieldRight - (cardRect.right + 24)
  })
}

function requireProjectRow(testInfo: TestInfo, projectNames: readonly string[]): void {
  test.skip(!projectNames.includes(testInfo.project.name), `Scoped to project rows: ${projectNames.join(', ')}`)
}

async function expectOrdinaryLogin(page: Page): Promise<void> {
  const card = page.locator('main.login-sd')
  const title = card.locator('#login-site-title')
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.locator('.login-brand .login-logo img')).toBeVisible()
  await expect(title).toBeVisible()
  expect((await title.textContent())?.trim()).toBeTruthy()
  await expect(page.getByLabel('Email Address', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Log In', exact: true })).toBeEnabled()
}

async function expectScrollable(surface: Locator): Promise<void> {
  await expect.poll(() => surface.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0)
  await surface.evaluate(element => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(() => surface.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
}

async function expectLoginValidation(page: Page): Promise<void> {
  const email = page.getByLabel('Email Address', { exact: true })
  const password = page.getByLabel('Password', { exact: true })
  await email.fill('person@example.test')
  await password.fill('x')
  await page.getByRole('button', { name: 'Log In', exact: true }).click()
  await expect(page.locator('main.login-sd > .v-alert[role="alert"]')).toBeVisible()
  await expect(password).toBeFocused()
}

async function expectStaticFallback(page: Page, effect: ManagedEffect): Promise<void> {
  const field = page.locator('.login-particle-logo')
  const image = field.locator('.login-particle-logo__image')
  await expectOrdinaryLogin(page)
  await expect(field).toBeVisible()
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute('src', effect.staticUrl)
  await expect(image).toHaveCSS('opacity', '1')
  await expect(field.locator('canvas')).toHaveCount(0)
}
function expectNoActiveLogoWork(trace: LogoResourceTrace): void {
  expect(trace.activeIdleCallbacks).toBe(0)
  expect(trace.activeLogoTimers).toBe(0)
  expect(trace.activeRafs).toBe(0)
  expect(trace.pointerListenersAdded - trace.pointerListenersRemoved).toBe(0)
}

async function expectSettledLoadingFailure(
  page: Page,
  effect: ManagedEffect,
  sceneRequests: readonly string[],
  particleRequests: readonly Request[]
): Promise<void> {
  await expectStaticFallback(page, effect)
  await expect
    .poll(async () => {
      const trace = await readLogoResourceTrace(page)
      return {
        activeIdleCallbacks: trace.activeIdleCallbacks,
        activeLogoTimers: trace.activeLogoTimers,
        activePointerListeners: trace.pointerListenersAdded - trace.pointerListenersRemoved,
        activeRafs: trace.activeRafs
      }
    })
    .toEqual({
      activeIdleCallbacks: 0,
      activeLogoTimers: 0,
      activePointerListeners: 0,
      activeRafs: 0
    })
  const immediateTrace = await readLogoResourceTrace(page)
  expectNoActiveLogoWork(immediateTrace)
  expect(sceneRequests.length).toBeLessThanOrEqual(1)
  expect(particleRequests.length).toBeLessThanOrEqual(1)
  const sceneRequestCount = sceneRequests.length
  const particleRequestCount = particleRequests.length

  await page.waitForTimeout(1_600)
  await expectStaticFallback(page, effect)
  const settledTrace = await readLogoResourceTrace(page)
  expectNoActiveLogoWork(settledTrace)
  expect(settledTrace).toEqual(immediateTrace)
  expect(sceneRequests).toHaveLength(sceneRequestCount)
  expect(particleRequests).toHaveLength(particleRequestCount)
}

async function collectTabOrder(page: Page, count = 5): Promise<string[]> {
  await page.evaluate(() => {
    document.body.tabIndex = -1
    document.body.focus()
  })
  const order: string[] = []
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press('Tab')
    order.push(
      await page.evaluate(() => {
        const active = document.activeElement
        if (!(active instanceof HTMLElement)) return ''
        const label = active.getAttribute('aria-label') ?? active.getAttribute('name') ?? active.textContent?.trim().replace(/\s+/g, ' ') ?? ''
        return `${active.tagName.toLowerCase()}:${active.getAttribute('type') ?? ''}:${label}`
      })
    )
  }
  return order
}

async function focusSurfaceGeometry(page: Page): Promise<{ bottom: number; left: number; right: number; top: number }> {
  const email = page.getByLabel('Email Address', { exact: true })
  await email.focus()
  await expect(email).toBeFocused()
  return email.evaluate(element => {
    const focusSurface = element.closest('.v-input') ?? element
    const rect = focusSurface.getBoundingClientRect()
    return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top }
  })
}

interface LoginAccessibilityContract {
  readonly buttons: string[]
  readonly headings: string[]
  readonly landmarks: string[]
  readonly textboxes: string[]
}

async function expectLoginAccessibilityContract(page: Page, contract: LoginAccessibilityContract): Promise<void> {
  await expect(page.getByRole('main')).toHaveCount(contract.landmarks.length)
  for (const name of contract.landmarks) {
    await expect(page.getByRole('main', { name, exact: true })).toHaveCount(1)
  }

  await expect(page.getByRole('heading')).toHaveCount(contract.headings.length)
  for (const name of contract.headings) {
    await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(1)
  }

  await expect(page.getByRole('textbox')).toHaveCount(contract.textboxes.length)
  for (const name of contract.textboxes) {
    await expect(page.getByRole('textbox', { name, exact: true })).toHaveCount(1)
  }

  await expect(page.getByRole('button')).toHaveCount(contract.buttons.length)
  for (const name of contract.buttons) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1)
  }
}

async function accessibleButtonNames(page: Page): Promise<string[]> {
  return page.getByRole('button').evaluateAll(buttons => {
    const normalize = (value: string | null | undefined): string => value?.replace(/\s+/g, ' ').trim() ?? ''
    return buttons.map(button => {
      const ariaLabel = normalize(button.getAttribute('aria-label'))
      if (ariaLabel) return ariaLabel

      const labelledBy = button
        .getAttribute('aria-labelledby')
        ?.split(/\s+/)
        .map(id => normalize(document.getElementById(id)?.textContent))
        .filter(Boolean)
        .join(' ')
      if (labelledBy) return labelledBy
      if (button instanceof HTMLInputElement) return normalize(button.value)
      return normalize(button.textContent)
    })
  })
}

async function assertTransparentSourceIdentity(image: Locator, effect: ManagedEffect, treatment: 'ordinary' | 'static'): Promise<void> {
  const sample = await image.evaluate(element => {
    if (!(element instanceof HTMLImageElement) || !element.complete || element.naturalWidth === 0) return null
    const canvas = document.createElement('canvas')
    canvas.width = 240
    canvas.height = 160
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(element, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let opaque = 0
    let nearBlack = 0
    let nearWhite = 0
    let ordinaryPink = 0
    let sourceBlue = 0
    let staticGold = 0
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const red = pixels[offset] ?? 0
      const green = pixels[offset + 1] ?? 0
      const blue = pixels[offset + 2] ?? 0
      const alpha = pixels[offset + 3] ?? 0
      if (alpha > 240) opaque += 1
      if (alpha > 240 && red < 32 && green < 32 && blue < 32) nearBlack += 1
      if (alpha > 240 && red > 235 && green > 235 && blue > 235) nearWhite += 1
      if (alpha > 220 && red > 190 && green < 115 && blue > 105) ordinaryPink += 1
      if (alpha > 240 && blue > 170 && green > 120 && red < 90) sourceBlue += 1
      if (alpha > 220 && red > 220 && green > 165 && blue < 100) staticGold += 1
    }
    const pixelCount = canvas.width * canvas.height
    return {
      cornerAlpha: [
        pixels[3],
        pixels[(canvas.width - 1) * 4 + 3],
        pixels[(canvas.height - 1) * canvas.width * 4 + 3],
        pixels[(canvas.height * canvas.width - 1) * 4 + 3]
      ],
      height: element.naturalHeight,
      nearBlackRatio: opaque === 0 ? 0 : nearBlack / opaque,
      nearWhiteRatio: opaque === 0 ? 0 : nearWhite / opaque,
      opaqueRatio: opaque / pixelCount,
      ordinaryPinkRatio: opaque === 0 ? 0 : ordinaryPink / opaque,
      sourceBlueRatio: opaque === 0 ? 0 : sourceBlue / opaque,
      staticGoldRatio: opaque === 0 ? 0 : staticGold / opaque,
      width: element.naturalWidth
    }
  })
  expect(sample).not.toBeNull()
  expect(sample).toMatchObject({ height: effect.height, width: effect.width })
  expect(sample?.cornerAlpha.every(alpha => (alpha ?? 255) < 16)).toBe(true)
  expect(sample?.opaqueRatio).toBeGreaterThan(0.02)
  expect(sample?.nearBlackRatio).toBeGreaterThan(0.002)
  expect(sample?.nearWhiteRatio).toBeGreaterThan(0.01)
  expect(sample?.sourceBlueRatio).toBeGreaterThan(0.01)
  if (treatment === 'ordinary') {
    expect(sample?.ordinaryPinkRatio).toBeGreaterThan(0.0005)
    expect(sample?.staticGoldRatio).toBeLessThan(0.0001)
  } else {
    expect(sample?.ordinaryPinkRatio).toBeLessThan(0.0001)
    expect(sample?.staticGoldRatio).toBeGreaterThan(0.005)
  }
}

interface RgbaFrame {
  readonly data: Buffer
  readonly height: number
  readonly width: number
}

interface FrameAppearance {
  readonly centroidX: number
  readonly centroidY: number
  readonly inkRatio: number
}

interface FrameDifference {
  readonly annulusMean: number
  readonly coreMean: number
  readonly mean: number
  readonly outsideMean: number
}

async function decodeScreenshot(image: Buffer): Promise<RgbaFrame> {
  const decoded = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (decoded.info.channels !== 4) throw new Error('Expected an RGBA screenshot.')
  return { data: decoded.data, height: decoded.info.height, width: decoded.info.width }
}

interface CanvasSurfaceGeometry {
  readonly backingHeight: number
  readonly backingWidth: number
  readonly height: number
  readonly left: number
  readonly top: number
  readonly viewportHeight: number
  readonly viewportWidth: number
  readonly width: number
}

interface ColorProbePixel {
  readonly alpha: number
  readonly red: number
  readonly green: number
  readonly blue: number
  readonly x: number
  readonly y: number
}

interface PageCompositionCapture {
  readonly backdrop: RgbaFrame
  readonly frame: RgbaFrame
  readonly geometry: CanvasSurfaceGeometry
  readonly visible: RgbaFrame
}

const COLOR_PROBE_PIXEL_TOLERANCE = 3

const srgbToLinear = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)

function readColorProbeAlpha(sample: ColorProbeParticle): number {
  const seed = sample.seed / 65_535
  const t = Math.min(1, Math.max(0, seed / 0.94))
  const smooth = t * t * (3 - 2 * t)
  return (sample.color[3] / 255) * (0.66 + 0.28 * smooth)
}

async function withFrozenLogoFrame<T>(page: Page, capture: () => Promise<T>): Promise<T> {
  await page.evaluate(() => {
    if (window.__loginLogoFrameFreeze) throw new Error('A logo frame freeze is already active.')
    const originalRequestAnimationFrame = window.requestAnimationFrame
    const originalCancelAnimationFrame = window.cancelAnimationFrame
    const nativeRequestAnimationFrame = originalRequestAnimationFrame.bind(window)
    const nativeCancelAnimationFrame = originalCancelAnimationFrame.bind(window)
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL
    let frozen = false
    let restored = false
    let nextQueuedFrame = 1
    const queuedFrames = new Map<number, FrameRequestCallback>()
    const requestAnimationFrame = (callback: FrameRequestCallback): number => {
      if (!frozen) return nativeRequestAnimationFrame(callback)
      const frame = nextQueuedFrame
      nextQueuedFrame += 1
      queuedFrames.set(frame, callback)
      return frame
    }
    const cancelAnimationFrame = (frame: number): void => {
      if (queuedFrames.delete(frame)) return
      nativeCancelAnimationFrame(frame)
    }
    window.requestAnimationFrame = requestAnimationFrame
    window.cancelAnimationFrame = cancelAnimationFrame
    HTMLCanvasElement.prototype.toDataURL = function (
      this: HTMLCanvasElement,
      ...args: Parameters<typeof originalToDataURL>
    ): string {
      if (!restored && this.closest('.login-particle-logo') !== null) frozen = true
      return originalToDataURL.apply(this, args)
    }
    window.__loginLogoFrameFreeze = {
      restore: () => {
        if (restored) return
        restored = true
        frozen = false
        window.requestAnimationFrame = originalRequestAnimationFrame
        window.cancelAnimationFrame = originalCancelAnimationFrame
        HTMLCanvasElement.prototype.toDataURL = originalToDataURL
        const pending = [...queuedFrames.values()]
        queuedFrames.clear()
        for (const callback of pending) nativeRequestAnimationFrame(callback)
        Reflect.deleteProperty(window, '__loginLogoFrameFreeze')
      }
    }
  })
  try {
    return await capture()
  } finally {
    await page.evaluate(() => {
      window.__loginLogoFrameFreeze?.restore()
    })
  }
}

function readColorProbeLuminance(pixel: ColorProbePixel): number {
  return 0.2126 * srgbToLinear(pixel.red / 255) + 0.7152 * srgbToLinear(pixel.green / 255) + 0.0722 * srgbToLinear(pixel.blue / 255)
}

async function readCanvasSurfaceGeometry(page: Page): Promise<CanvasSurfaceGeometry> {
  return page.locator('.login-particle-logo canvas').evaluate(element => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error('The particle canvas is unavailable.')
    const rect = element.getBoundingClientRect()
    return {
      backingHeight: element.height,
      backingWidth: element.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width
    }
  })
}

interface ApplicationThemeObservation {
  readonly background: string
  readonly className: string
}

async function readApplicationTheme(page: Page): Promise<ApplicationThemeObservation> {
  return page.locator('.v-application').evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, className: element.className }
  })
}

function locateColorProbePixel(frame: RgbaFrame, sample: ColorProbeParticle): ColorProbePixel {
  const viewportAspect = frame.width / frame.height
  const fitX = viewportAspect >= colorProbeEffect.aspect ? colorProbeEffect.aspect / viewportAspect : 1
  const fitY = viewportAspect >= colorProbeEffect.aspect ? 1 : viewportAspect / colorProbeEffect.aspect
  const centerX = ((sample.x * fitX + 1) * frame.width) / 2
  const centerY = ((1 - sample.y * fitY) * frame.height) / 2
  const radius = sample.kind === 'bead' ? 16 : 10
  const fullCoverageAlpha = readColorProbeAlpha(sample) * 255 - COLOR_PROBE_PIXEL_TOLERANCE
  let best: ColorProbePixel | null = null
  for (let y = Math.max(0, Math.floor(centerY) - radius); y <= Math.min(frame.height - 1, Math.ceil(centerY) + radius); y += 1) {
    for (let x = Math.max(0, Math.floor(centerX) - radius); x <= Math.min(frame.width - 1, Math.ceil(centerX) + radius); x += 1) {
      const offset = (y * frame.width + x) * 4
      const candidate = {
        alpha: frame.data[offset + 3] ?? 0,
        blue: frame.data[offset + 2] ?? 0,
        green: frame.data[offset + 1] ?? 0,
        red: frame.data[offset] ?? 0,
        x,
        y
      }
      if (sample.kind === 'bead' && candidate.alpha < fullCoverageAlpha) continue
      const candidateWins =
        sample.kind === 'bead'
          ? best === null || readColorProbeLuminance(candidate) > readColorProbeLuminance(best)
          : best === null || candidate.alpha > best.alpha
      if (candidateWins) best = candidate
    }
  }
  if (!best || best.alpha < (sample.kind === 'bead' ? fullCoverageAlpha : 64)) {
    throw new Error(`Color probe particle ${sample.kind} is not fully covered.`)
  }
  return best
}

function mapCanvasPixelToScreenshot(
  geometry: CanvasSurfaceGeometry,
  screenshot: RgbaFrame,
  pixel: Pick<ColorProbePixel, 'x' | 'y'>
): { readonly x: number; readonly y: number } {
  const cssX = geometry.left + ((pixel.x + 0.5) * geometry.width) / geometry.backingWidth
  const cssY = geometry.top + ((pixel.y + 0.5) * geometry.height) / geometry.backingHeight
  return {
    x: Math.max(0, Math.min(screenshot.width - 1, Math.floor((cssX * screenshot.width) / geometry.viewportWidth))),
    y: Math.max(0, Math.min(screenshot.height - 1, Math.floor((cssY * screenshot.height) / geometry.viewportHeight)))
  }
}


function readRgbaPixel(frame: RgbaFrame, x: number, y: number): ColorProbePixel {
  const offset = (y * frame.width + x) * 4
  return {
    alpha: frame.data[offset + 3] ?? 0,
    blue: frame.data[offset + 2] ?? 0,
    green: frame.data[offset + 1] ?? 0,
    red: frame.data[offset] ?? 0,
    x,
    y
  }
}


function expectIntrinsicFramesEquivalent(first: RgbaFrame, second: RgbaFrame): void {
  expect(second.width).toBe(first.width)
  expect(second.height).toBe(first.height)
  let maximumDifference = 0
  for (let offset = 0; offset < first.data.length; offset += 1) {
    maximumDifference = Math.max(maximumDifference, Math.abs((first.data[offset] ?? 0) - (second.data[offset] ?? 0)))
  }
  expect(maximumDifference).toBeLessThanOrEqual(COLOR_PROBE_PIXEL_TOLERANCE)
}
interface PerceptualFrameDifference {
  readonly maximum: number
  readonly mean: number
  readonly p95: number
}

function perceptualFrameDifference(first: RgbaFrame, second: RgbaFrame): PerceptualFrameDifference {
  if (first.width !== second.width || first.height !== second.height) throw new Error('Particle screenshots changed dimensions.')
  const differences: number[] = []
  let total = 0
  let maximum = 0
  for (let offset = 0; offset < first.data.length; offset += 4) {
    const red = srgbToLinear((first.data[offset] ?? 0) / 255) - srgbToLinear((second.data[offset] ?? 0) / 255)
    const green = srgbToLinear((first.data[offset + 1] ?? 0) / 255) - srgbToLinear((second.data[offset + 1] ?? 0) / 255)
    const blue = srgbToLinear((first.data[offset + 2] ?? 0) / 255) - srgbToLinear((second.data[offset + 2] ?? 0) / 255)
    const alpha = ((first.data[offset + 3] ?? 0) - (second.data[offset + 3] ?? 0)) / 255
    const difference = Math.hypot(red, green, blue, alpha)
    differences.push(difference)
    total += difference
    maximum = Math.max(maximum, difference)
  }
  differences.sort((left, right) => left - right)
  return {
    maximum,
    mean: total / differences.length,
    p95: differences[Math.min(differences.length - 1, Math.ceil(differences.length * 0.95))] ?? 0
  }
}

function expectPerceptuallyEquivalent(label: string, first: RgbaFrame, second: RgbaFrame): void {
  const difference = perceptualFrameDifference(first, second)
  expect(difference.mean, `${label} mean perceptual difference`).toBeLessThanOrEqual(0.025)
  expect(difference.p95, `${label} p95 perceptual difference`).toBeLessThanOrEqual(0.12)
  expect(difference.maximum, `${label} maximum perceptual difference`).toBeLessThanOrEqual(0.75)
}

function expectColorProbePixels(frame: RgbaFrame): void {
  for (const sample of colorProbeParticles) {
    const pixel = locateColorProbePixel(frame, sample)
    expect(Math.abs(pixel.alpha - readColorProbeAlpha(sample) * 255)).toBeLessThanOrEqual(COLOR_PROBE_PIXEL_TOLERANCE)
    if (sample.kind === 'dust') {
      const actualChannels = [pixel.red, pixel.green, pixel.blue]
      for (const [channel, value] of sample.color.slice(0, 3).entries()) {
        expect(Math.abs(actualChannels[channel]! - value)).toBeLessThanOrEqual(COLOR_PROBE_PIXEL_TOLERANCE)
      }
      continue
    }
    const sourceLinear = sample.color.slice(0, 3).map(channel => srgbToLinear(channel / 255))
    const actualLinear = [pixel.red, pixel.green, pixel.blue].map(channel => srgbToLinear(channel / 255))
    const denominator = sourceLinear.reduce((sum, channel) => sum + channel * channel, 0)
    const scalar = sourceLinear.reduce((sum, channel, index) => sum + channel * actualLinear[index]!, 0) / denominator
    expect(Number.isFinite(scalar)).toBe(true)
    for (const [index, channel] of actualLinear.entries()) {
      expect(Math.abs(channel - sourceLinear[index]! * scalar) * 255).toBeLessThanOrEqual(COLOR_PROBE_PIXEL_TOLERANCE)
    }
  }
}

async function capturePageComposition(page: Page): Promise<PageCompositionCapture> {
  return withFrozenLogoFrame(page, async () => {
    const geometry = await readCanvasSurfaceGeometry(page)
    const frame = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, 0, 0)).png)
    const canvas = page.locator('.login-particle-logo canvas')
    const previousVisibility = await canvas.evaluate(element => (element instanceof HTMLCanvasElement ? element.style.visibility : ''))
    let backdrop: RgbaFrame
    await canvas.evaluate(element => {
      if (!(element instanceof HTMLCanvasElement)) throw new Error('The particle canvas is unavailable.')
      element.style.visibility = 'hidden'
    })
    try {
      backdrop = await decodeScreenshot(await page.screenshot({ animations: 'disabled', fullPage: false }))
    } finally {
      await canvas.evaluate((element, visibility) => {
        if (element instanceof HTMLCanvasElement) element.style.visibility = visibility
      }, previousVisibility)
    }
    const visible = await decodeScreenshot(await page.screenshot({ animations: 'disabled', fullPage: false }))
    return { backdrop, frame, geometry, visible }
  })
}

function expectStraightSourceOver(composition: PageCompositionCapture): void {
  expect(composition.visible.width).toBe(composition.backdrop.width)
  expect(composition.visible.height).toBe(composition.backdrop.height)
  const frame = composition.frame
  for (const sample of colorProbeParticles) {
    if (sample.kind !== 'dust') continue
    const canvasPixel = locateColorProbePixel(frame, sample)
    const screenshotPixel = mapCanvasPixelToScreenshot(composition.geometry, composition.visible, canvasPixel)
    const pagePixel = readRgbaPixel(composition.visible, screenshotPixel.x, screenshotPixel.y)
    const backdropPixel = readRgbaPixel(composition.backdrop, screenshotPixel.x, screenshotPixel.y)
    const source = [sample.color[0], sample.color[1], sample.color[2]]
    const backdrop = [backdropPixel.red, backdropPixel.green, backdropPixel.blue]
    const actual = [pagePixel.red, pagePixel.green, pagePixel.blue]
    const sourceDistances = source.map((channel, index) => backdrop[index]! - channel)
    const denominator = sourceDistances.reduce((sum, distance) => sum + distance * distance, 0)
    const numerator = sourceDistances.reduce((sum, distance, index) => sum + distance * (backdrop[index]! - actual[index]!), 0)
    const effectiveAlpha = numerator / denominator
    const diagnostic = `Straight source-over mismatch for ${sample.kind} color=[${sample.color.join(',')}] canvas=(${canvasPixel.x},${canvasPixel.y}) screenshot=(${screenshotPixel.x},${screenshotPixel.y}) canvas-rgba=[${canvasPixel.red},${canvasPixel.green},${canvasPixel.blue},${canvasPixel.alpha}] backdrop-rgb=[${backdrop.join(',')}] actual-rgb=[${actual.join(',')}] fitted-alpha=${effectiveAlpha.toFixed(6)}`
    expect(effectiveAlpha, diagnostic).toBeGreaterThan(0)
    expect(effectiveAlpha, diagnostic).toBeLessThan(1)
    const expected = source.map((channel, index) => channel * effectiveAlpha + backdrop[index]! * (1 - effectiveAlpha))
    for (const [channel, value] of expected.entries()) {
      const channelName = ['red', 'green', 'blue'][channel] ?? `channel-${channel}`
      expect(
        Math.abs(actual[channel]! - value),
        `${diagnostic} expected-rgb=[${expected.map(channelValue => channelValue.toFixed(3)).join(',')}] ${channelName} delta=${(actual[channel]! - value).toFixed(3)}`
      ).toBeLessThanOrEqual(COLOR_PROBE_PIXEL_TOLERANCE)
    }
  }
}

const CANVAS_PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
async function captureLogoRenderedFrame(
  page: Page,
  pointerSample?: LogoFramePointerSample,
  elapsedSeconds?: number,
  pointerTimeMilliseconds?: number
): Promise<CapturedCanvasPng> {
  if (pointerSample && pointerTimeMilliseconds === undefined) {
    throw new Error('Deterministic pointer captures require a pointer clock.')
  }
  const capture = await page.evaluate(
    async ({ elapsedSeconds, pointerSample, pointerTimeMilliseconds }) => {
      const field = document.querySelector('.login-particle-logo')
      const canvas = field?.querySelector('canvas')
      const hook = window.__logoParticleFrameCapture
      if (!(field instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) {
        throw new Error('The animated logo canvas is unavailable for in-page capture.')
      }
      const request = hook?.request
      if (typeof request !== 'function') {
        throw new Error('The animated logo after-render capture hook is unavailable.')
      }
      const options: LogoFrameCaptureOptions = {
        ...(elapsedSeconds === undefined ? {} : { elapsedSeconds }),
        ...(pointerTimeMilliseconds === undefined ? {} : { pointerTimeMilliseconds })
      }
      const capturePromise = request(Object.keys(options).length === 0 ? undefined : options)
      if (pointerSample) {
        field.dispatchEvent(
          new PointerEvent(pointerSample.type ?? 'pointermove', {
            bubbles: true,
            clientX: pointerSample.clientX,
            clientY: pointerSample.clientY,
            isPrimary: true,
            pointerId: pointerSample.pointerId ?? 1,
            pointerType: pointerSample.pointerType ?? 'mouse'
          })
        )
      }
      return capturePromise
    },
    { elapsedSeconds, pointerSample: pointerSample ?? null, pointerTimeMilliseconds }
  )
  if (!capture.dataUrl.startsWith(CANVAS_PNG_DATA_URL_PREFIX)) throw new Error('Expected a PNG canvas data URL.')
  if (!Number.isFinite(capture.capturedAt)) throw new Error('Expected a finite page capture timestamp.')
  return {
    capturedAt: capture.capturedAt,
    png: Buffer.from(capture.dataUrl.slice(CANVAS_PNG_DATA_URL_PREFIX.length), 'base64')
  }
}
async function dispatchLogoPointerEvent(page: Page, sample: LogoFramePointerSample): Promise<void> {
  await page.evaluate(({ clientX, clientY, pointerId, pointerType, type }) => {
    const field = document.querySelector('.login-particle-logo')
    if (!(field instanceof HTMLElement)) throw new Error('The animated logo field is unavailable.')
    field.dispatchEvent(
      new PointerEvent(type ?? 'pointermove', {
        bubbles: true,
        clientX,
        clientY,
        isPrimary: true,
        pointerId: pointerId ?? 1,
        pointerType: pointerType ?? 'mouse'
      })
    )
  }, sample)
}
function expectInactivePerformance(benchmark: LogoPerformanceHook): void {
  expect(benchmark.callbackCount).toBe(0)
  expect(benchmark.callbackCpuMilliseconds).toEqual([])
  expect(benchmark.frames ?? []).toEqual([])
  expect(benchmark.counters).toMatchObject({
    updateCallbacks: 0,
    renderInvocations: 0,
    afterRenderCallbacks: 0,
    rafCallbacks: 0,
    draws: 0
  })
  expect((benchmark.frames ?? []).reduce((total: number, frame: LogoPerformanceFrame) => total + (frame.motionScheduledBytes ?? 0), 0)).toBe(0)
}

async function prepareStrictBackendPage(
  page: Page,
  backend: StrictParticleBackend,
  effect: ManagedEffect,
  colorScheme: 'light' | 'dark' = 'light'
): Promise<LogoPerformanceHook> {
  await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' })
  await installLogoResourceTrace(page, backend)
  await installLogoFrameCapture(page)
  await installManagedLogo(
    page,
    effect,
    effect === colorProbeEffect ? { particleBody: colorProbeParticleFixture } : undefined
  )
  await page.goto(`/login?strict-backend=${backend}-${colorScheme}`, { waitUntil: 'domcontentloaded' })
  await expectOrdinaryLogin(page)
  return expectBackendReady(page, backend, effect)
}

function analyzeFrame(frame: RgbaFrame): FrameAppearance {
  const cornerPixels = [0, frame.width - 1, (frame.height - 1) * frame.width, frame.height * frame.width - 1]
  const background = [0, 1, 2].map(channel => cornerPixels.reduce((sum, pixel) => sum + (frame.data[pixel * 4 + channel] ?? 0), 0) / cornerPixels.length)
  let centroidWeight = 0
  let centroidX = 0
  let centroidY = 0
  let inkPixels = 0
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const offset = (y * frame.width + x) * 4
      const weight =
        Math.abs((frame.data[offset] ?? 0) - background[0]!) +
        Math.abs((frame.data[offset + 1] ?? 0) - background[1]!) +
        Math.abs((frame.data[offset + 2] ?? 0) - background[2]!)
      if (weight > 36) inkPixels += 1
      centroidWeight += weight
      centroidX += x * weight
      centroidY += y * weight
    }
  }
  if (centroidWeight === 0) throw new Error('The particle frame contains no visible pixels.')
  return {
    centroidX: centroidX / centroidWeight,
    centroidY: centroidY / centroidWeight,
    inkRatio: inkPixels / (frame.width * frame.height)
  }
}

function compareFrames(before: RgbaFrame, after: RgbaFrame, influence?: { readonly radius: number; readonly x: number; readonly y: number }): FrameDifference {
  if (before.width !== after.width || before.height !== after.height) throw new Error('Particle screenshots changed dimensions.')
  let coreDifference = 0
  let coreSamples = 0
  let annulusDifference = 0
  let annulusSamples = 0
  let outsideDifference = 0
  let outsideSamples = 0
  let totalDifference = 0
  for (let y = 0; y < before.height; y += 1) {
    for (let x = 0; x < before.width; x += 1) {
      const offset = (y * before.width + x) * 4
      const difference =
        Math.abs((before.data[offset] ?? 0) - (after.data[offset] ?? 0)) +
        Math.abs((before.data[offset + 1] ?? 0) - (after.data[offset + 1] ?? 0)) +
        Math.abs((before.data[offset + 2] ?? 0) - (after.data[offset + 2] ?? 0))
      totalDifference += difference
      if (!influence) continue
      const distance = Math.hypot(x - influence.x, y - influence.y)
      if (distance <= influence.radius) {
        coreDifference += difference
        coreSamples += 1
      } else if (distance > influence.radius && distance <= influence.radius * 2.1) {
        annulusDifference += difference
        annulusSamples += 1
      } else if (distance >= influence.radius * 2.5) {
        outsideDifference += difference
        outsideSamples += 1
      }
    }
  }
  return {
    annulusMean: annulusSamples === 0 ? 0 : annulusDifference / (annulusSamples * 3 * 255),
    coreMean: coreSamples === 0 ? 0 : coreDifference / (coreSamples * 3 * 255),
    mean: totalDifference / (before.width * before.height * 3 * 255),
    outsideMean: outsideSamples === 0 ? 0 : outsideDifference / (outsideSamples * 3 * 255)
  }
}

async function expectFieldGeometry(page: Page, effect: ManagedEffect): Promise<void> {
  const report = await page.locator('.login-particle-logo').evaluate((field, descriptor) => {
    const image = field.querySelector('.login-particle-logo__image')
    const card = document.querySelector('main.login-sd')
    if (!(image instanceof HTMLImageElement) || !(card instanceof HTMLElement)) return null
    const fieldRect = field.getBoundingClientRect()
    const imageRect = image.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    return {
      aspectError: Math.abs(imageRect.width / imageRect.height / descriptor.aspect - 1),
      clearBottom: fieldRect.bottom - imageRect.bottom,
      clearLeft: imageRect.left - fieldRect.left,
      clearRight: fieldRect.right - imageRect.right,
      clearTop: imageRect.top - fieldRect.top,
      fieldHeight: fieldRect.height,
      fieldWidth: fieldRect.width,
      intersectsCard: !(
        fieldRect.right <= cardRect.left ||
        fieldRect.left >= cardRect.right ||
        fieldRect.bottom <= cardRect.top ||
        fieldRect.top >= cardRect.bottom
      )
    }
  }, effect)
  expect(report).not.toBeNull()
  expect(report?.aspectError).toBeLessThan(0.005)
  expect(report?.clearLeft).toBeGreaterThanOrEqual((report?.fieldWidth ?? 0) * 0.08 - 1)
  expect(report?.clearRight).toBeGreaterThanOrEqual((report?.fieldWidth ?? 0) * 0.08 - 1)
  expect(report?.clearTop).toBeGreaterThanOrEqual((report?.fieldHeight ?? 0) * 0.08 - 1)
  expect(report?.clearBottom).toBeGreaterThanOrEqual((report?.fieldHeight ?? 0) * 0.08 - 1)
  expect(report?.intersectsCard).toBe(false)
}

test.describe('strict particle backend consumer coverage', () => {
  test.beforeEach(() => test.setTimeout(60_000))

  for (const backend of ['webgpu', 'webgl2'] as const) {
    test(`${backend} commits one visible draw with diagnostics and transparent source-over pixels`, async ({ page }, testInfo) => {
      requireProjectRow(testInfo, STRICT_BACKEND_PROJECTS)
      const capability = await detectBackendCapability(page, backend)
      skipUnsupportedStrictBackend(testInfo, backend, capability)

      await prepareStrictBackendPage(page, backend, colorProbeEffect, 'light')
      const lightFrame = await withFrozenLogoFrame(
        page,
        async () => decodeScreenshot((await captureLogoRenderedFrame(page, undefined, 0, 0)).png)
      )
      const lightComposition = await capturePageComposition(page)
      const lightTheme = await readApplicationTheme(page)
      expect(lightTheme.className).toMatch(/v-theme--light/)
      expectColorProbePixels(lightFrame)
      expectStraightSourceOver(lightComposition)

      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' })
      await expect(page.locator('.v-application')).toHaveClass(/v-theme--dark/)
      await expect.poll(async () => (await readApplicationTheme(page)).background).not.toBe(lightTheme.background)
      const darkFrame = await withFrozenLogoFrame(
        page,
        async () => decodeScreenshot((await captureLogoRenderedFrame(page, undefined, 0, 0)).png)
      )
      const darkComposition = await capturePageComposition(page)
      const darkTheme = await readApplicationTheme(page)
      expect(darkTheme.className).toMatch(/v-theme--dark/)
      expect(darkTheme.background).not.toBe(lightTheme.background)
      expectColorProbePixels(darkFrame)
      expectStraightSourceOver(darkComposition)
      expectPerceptuallyEquivalent(`${backend} light/dark intrinsic particle output`, lightFrame, darkFrame)
      await expectLoginValidation(page)
    })

    test(`${backend} stops all particle work while inactive, resumes with a commit, and honors reduced motion`, async ({ page }, testInfo) => {
      requireProjectRow(testInfo, STRICT_BACKEND_PROJECTS)
      const capability = await detectBackendCapability(page, backend)
      skipUnsupportedStrictBackend(testInfo, backend, capability)

      await prepareStrictBackendPage(page, backend, squareEffect)
      const field = page.locator('.login-particle-logo')
      const canvas = field.locator('canvas')
      const staticImage = field.locator('.login-particle-logo__image')
      await installLogoOpacityTrace(page)

      await page.evaluate(() => {
        const setVisibility = window.__setLogoParticleVisibility
        if (!setVisibility) throw new Error('The logo visibility hook is unavailable.')
        setVisibility('hidden')
      })
      await resetLogoPerformance(page)
      await page.waitForTimeout(800)
      const hidden = await readLogoPerformance(page)
      expectInactivePerformance(hidden)
      await page.evaluate(() => {
        const setVisibility = window.__setLogoParticleVisibility
        const login = document.querySelector('.login')
        if (!setVisibility || !(login instanceof HTMLElement)) throw new Error('The logo visibility fixture is unavailable.')
        setVisibility('visible')
        login.style.transform = 'translateX(-200vw)'
      })
      await page.waitForTimeout(350)
      await resetLogoPerformance(page)
      await page.waitForTimeout(800)
      const offscreen = await readLogoPerformance(page)
      expectInactivePerformance(offscreen)

      const priorResumeCount = offscreen.resumes?.length ?? 0
      await page.evaluate(() => {
        const login = document.querySelector('.login')
        if (!(login instanceof HTMLElement)) throw new Error('The login surface is unavailable.')
        login.style.transform = ''
      })
      await expect
        .poll(async () =>
          (await readLogoPerformance(page)).resumes?.slice(priorResumeCount).some((resume: LogoResumeSample) => resume.outcome === 'committed') ?? false
        )
        .toBe(true)
      await expect(canvas).toHaveCount(1)
      await expect(staticImage).toHaveCSS('opacity', '0')
      const opacityValues = (await readLogoOpacityTrace(page)).values
      const pendingIndex = opacityValues.indexOf('1')
      const committedIndex = opacityValues.findIndex((value, index) => index > pendingIndex && value === '0')
      expect(pendingIndex).toBeGreaterThanOrEqual(0)
      expect(committedIndex).toBeGreaterThan(pendingIndex)
      const resumed = await readLogoPerformance(page)
      const resume = resumed.resumes?.slice(priorResumeCount).find((sample: LogoResumeSample) => sample.outcome === 'committed')
      expect(resume?.firstSubmissionAt).toEqual(expect.any(Number))
      expect(resume?.visibleCommitAt).toEqual(expect.any(Number))
      expect(resume?.visibleCommitAt).toBeGreaterThanOrEqual(resume?.firstSubmissionAt ?? Number.POSITIVE_INFINITY)
      expect(resumed.frames?.some((frame: LogoPerformanceFrame) => frame.totalDrawCalls === 1 && frame.triangles === squareEffect.count * 2)).toBe(true)

      await page.getByLabel('Email Address', { exact: true }).focus()
      await installReducedMotionChangeProbe(page)
      const callbackCountBeforeReducedMotion = (await readLogoPerformance(page)).callbackCount
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect.poll(() => readReducedMotionChangeReport(page)).not.toBeNull()
      const changeReport = await readReducedMotionChangeReport(page)
      expect(changeReport).toMatchObject({
        canvasCount: 0,
        pointerActive: false,
        staticOpacity: '1',
        staticTransition: 'none'
      })
      await expect(staticImage).toHaveCSS('opacity', '1')
      await expect(canvas).toHaveCount(0)
      await page.waitForTimeout(300)
      const reducedMotion = await readLogoPerformance(page)
      expect(reducedMotion.callbackCount).toBe(changeReport?.performanceCallbackCount)
      expect((await readLogoResourceTrace(page)).activeRafs).toBe(0)
      expect((reducedMotion.backendDiagnostics ?? []).some((diagnostic: LogoBackendDiagnostic) => diagnostic.phase === 'retired')).toBe(true)
      await expectLoginValidation(page)
    })

    test(`${backend} enters terminal static fallback after runtime loss without disturbing authentication`, async ({ page }, testInfo) => {
      requireProjectRow(testInfo, STRICT_BACKEND_PROJECTS)
      const capability = await detectBackendCapability(page, backend)
      skipUnsupportedStrictBackend(testInfo, backend, capability)

      await prepareStrictBackendPage(page, backend, squareEffect)
      const field = page.locator('.login-particle-logo')
      const canvas = field.locator('canvas')
      const staticImage = field.locator('.login-particle-logo__image')
      const email = page.getByLabel('Email Address', { exact: true })
      await email.focus()
      await expect(email).toBeFocused()

      const dispatched = await page.evaluate(() => {
        const canvas = document.querySelector('.login-particle-logo canvas')
        if (!(canvas instanceof HTMLCanvasElement)) throw new Error('The committed particle canvas is unavailable.')
        const event = new Event('webglcontextlost', { bubbles: true, cancelable: true })
        return { defaultPrevented: canvas.dispatchEvent(event), type: event.type }
      })
      expect(dispatched.type).toBe('webglcontextlost')
      await expect(staticImage).toHaveCSS('opacity', '1')
      await expect(canvas).toHaveCount(0)
      await expect(email).toBeFocused()
      await expect
        .poll(async () => {
          const diagnostics = (await readLogoPerformance(page)).backendDiagnostics ?? []
          return diagnostics.some((diagnostic: LogoBackendDiagnostic) => diagnostic.phase === 'lost' || diagnostic.phase === 'retired')
        })
        .toBe(true)
      const terminal = await readLogoPerformance(page)
      expect(terminal.resumes?.at(-1)?.outcome).not.toBe('committed')
      await expectLoginValidation(page)
    })
  }

  test('keeps native WebGPU and forced WebGL2 production screenshots within bounded perceptual tolerance in both themes', async ({
    context,
    page
  }, testInfo) => {
    requireProjectRow(testInfo, STRICT_BACKEND_PROJECTS)
    const webgpuCapability = await detectBackendCapability(page, 'webgpu')
    if (!webgpuCapability.available) {
      const description = `Native WebGPU screenshot comparison skipped with runtime evidence: ${webgpuCapability.evidence}`
      testInfo.annotations.push({ type: 'capability-skip', description })
      test.skip(true, description)
      return
    }
    const webglCapability = await detectBackendCapability(page, 'webgl2')
    if (!webglCapability.available) {
      const description = `Forced WebGL2 screenshot comparison skipped with runtime evidence: ${webglCapability.evidence}`
      testInfo.annotations.push({ type: 'capability-skip', description })
      test.skip(true, description)
      return
    }

    const captureBackendTheme = async (
      backend: StrictParticleBackend,
      colorScheme: 'light' | 'dark'
    ): Promise<{ readonly frame: RgbaFrame; readonly screenshot: RgbaFrame }> => {
      const target = await context.newPage()
      try {
        await prepareStrictBackendPage(target, backend, colorProbeEffect, colorScheme)
        const composition = await capturePageComposition(target)
        expect((await readApplicationTheme(target)).className).toMatch(colorScheme === 'light' ? /v-theme--light/ : /v-theme--dark/)
        expectColorProbePixels(composition.frame)
        expectStraightSourceOver(composition)
        return { frame: composition.frame, screenshot: composition.visible }
      } finally {
        await target.close()
      }
    }

    const nativeLight = await captureBackendTheme('webgpu', 'light')
    const forcedLight = await captureBackendTheme('webgl2', 'light')
    const nativeDark = await captureBackendTheme('webgpu', 'dark')
    const forcedDark = await captureBackendTheme('webgl2', 'dark')
    expectPerceptuallyEquivalent('light backend intrinsic pixels', nativeLight.frame, forcedLight.frame)
    expectPerceptuallyEquivalent('dark backend intrinsic pixels', nativeDark.frame, forcedDark.frame)
    expectPerceptuallyEquivalent('light production screenshot', nativeLight.screenshot, forcedLight.screenshot)
    expectPerceptuallyEquivalent('dark production screenshot', nativeDark.screenshot, forcedDark.screenshot)
  })
})

test.describe('managed login logo auth independence', () => {
  test.beforeEach(() => test.setTimeout(45_000))

  for (const fixture of [
    { effect: squareEffect, name: 'square' },
    { effect: wideEffect, name: 'wide' }
  ] as const) {
    test(`renders the transparent ${fixture.name} static treatment with preserved aspect and clear space in light and dark themes`, async ({
      context
    }, testInfo) => {
      requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
      const themeBackgrounds: string[] = []

      for (const colorScheme of ['light', 'dark'] as const) {
        const samplePage = await context.newPage()
        try {
          await samplePage.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
          await installManagedLogo(samplePage, fixture.effect)
          await samplePage.goto(`/login?logo-sample=${fixture.name}-${colorScheme}`)
          await expectStaticFallback(samplePage, fixture.effect)
          const ordinaryLogo = samplePage.locator('.login-brand .login-logo img')
          const staticImage = samplePage.locator('.login-particle-logo__image')
          await expect(ordinaryLogo).toHaveAttribute('src', fixture.effect.logoUrl)
          await expect(ordinaryLogo).toHaveCSS('width', '34px')
          const logoFrame = samplePage.locator('.login-brand .login-logo')
          await expect(logoFrame).toHaveCSS('width', '52px')
          await expect(logoFrame).toHaveCSS('height', '52px')
          await expect(logoFrame).toHaveCSS('padding', '8px')
          for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
            await expect(logoFrame).toHaveCSS(`border-${edge}-width`, '1px')
          }
          const frameAppearance = await logoFrame.evaluate(element => {
            const style = getComputedStyle(element)
            return {
              backgroundImage: style.backgroundImage,
              borderRadius: style.borderRadius,
              boxShadow: style.boxShadow
            }
          })
          expect(frameAppearance.backgroundImage).toContain('linear-gradient')
          expect(frameAppearance.borderRadius).not.toBe('0px')
          expect(frameAppearance.boxShadow).not.toBe('none')
          await expectFieldGeometry(samplePage, fixture.effect)
          expect(
            await samplePage.locator('.login-particle-logo').evaluate(element => getComputedStyle(element).getPropertyValue('--login-logo-aura').trim())
          ).toBe(fixture.name === 'square' ? 'rgb(51 102 153 / 8%)' : 'transparent')
          await assertTransparentSourceIdentity(ordinaryLogo, fixture.effect, 'ordinary')
          await assertTransparentSourceIdentity(staticImage, fixture.effect, 'static')
          themeBackgrounds.push(await samplePage.locator('.login').evaluate(element => getComputedStyle(element).backgroundColor))
          await testInfo.attach(`${fixture.name}-${colorScheme}-${testInfo.project.name}`, {
            body: await samplePage.screenshot({ animations: 'disabled', fullPage: false }),
            contentType: 'image/png'
          })
        } finally {
          await samplePage.close()
        }
      }

      expect(themeBackgrounds[0]).not.toBe(themeBackgrounds[1])
    })
  }
  test('shows the TS Epistle book during the redirect window only after terminal ordinary authentication', async ({ page }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    let ordinaryAttempts = 0
    await page.route(/\/_api\/auth\/login$/, async route => {
      ordinaryAttempts += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: true, redirect: '/login?after=ordinary' })
      })
    })

    await page.goto('/login?login-art=ordinary')
    await expectOrdinaryLogin(page)
    await page.getByLabel('Email Address', { exact: true }).fill('ordinary@example.test')
    await page.getByLabel('Password', { exact: true }).fill('ordinary-password')
    await page.getByRole('button', { name: 'Log In', exact: true }).click()

    const loader = page.locator('.loader-dialog')
    await expect(loader).toBeVisible()
    const illustration = loader.locator('.login-success-animation')
    await expect(illustration).toBeVisible()
    await expect(illustration).toHaveAttribute('width', '72')
    await expect(illustration).toHaveAttribute('height', '72')
    await expect(illustration).toHaveAttribute('aria-hidden', 'true')
    await expect(illustration.locator('[data-page-turn]')).toHaveCount(3)
    await expect(loader.locator('.atom-spinner')).toHaveCount(0)
    const animatedPage = illustration.locator('.login-success-animation__page--turn-1')
    const animationStyle = await animatedPage.evaluate(element => {
      const style = getComputedStyle(element)
      return { animationName: style.animationName, animationDuration: style.animationDuration }
    })
    expect(animationStyle.animationName).not.toBe('none')
    expect(animationStyle.animationDuration).toBe('0.9s')
    expect(ordinaryAttempts).toBe(1)
  })

  test('keeps the book hidden for a TFA challenge and shows it after authenticated TFA completion', async ({ page }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.route(/\/_api\/auth\/login(?:\/tfa)?$/, async route => {
      if (route.request().url().endsWith('/tfa')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ authenticated: true, redirect: '/login?after=tfa' })
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: false, mustProvideTFA: true, continuationToken: 'login-art-tfa' })
      })
    })

    await page.goto('/login?login-art=tfa')
    await expectOrdinaryLogin(page)
    await page.getByLabel('Email Address', { exact: true }).fill('tfa@example.test')
    await page.getByLabel('Password', { exact: true }).fill('tfa-password')
    await page.getByRole('button', { name: 'Log In', exact: true }).click()
    const tfaForm = page.locator('form.login-tfa').first()
    await expect(tfaForm).toBeVisible()
    await expect(page.locator('.login-success-animation')).toHaveCount(0)

    await tfaForm.locator('input[name="security-code"]').fill('123456')
    await tfaForm.locator('button[type="submit"]').click()
    await expect(page.locator('.loader-dialog')).toBeVisible()
    await expect(page.locator('.login-success-animation')).toBeVisible()
    await expect(page.locator('.login-success-animation__page--turn-1')).toHaveCSS('animation-name', 'none')
  })

  test('keeps the book hidden when authentication fails', async ({ page }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
    await page.route(/\/_api\/auth\/login$/, async route => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Login fixture rejected the credentials.' })
      })
    })

    await page.goto('/login?login-art=error')
    await expectOrdinaryLogin(page)
    await page.getByLabel('Email Address', { exact: true }).fill('error@example.test')
    await page.getByLabel('Password', { exact: true }).fill('incorrect-password')
    await page.getByRole('button', { name: 'Log In', exact: true }).click()
    await expect(page.locator('.loader-dialog')).toBeHidden()
    await expect(page.locator('.login-success-animation')).toHaveCount(0)
    await expect(page.locator('.v-alert[role="alert"]')).toBeVisible()
  })

  test('omits the large field at 959px, 650px, and truly zero measured space while preserving a positive narrow static field', async ({ page }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const artifacts = await installManagedLogo(page, wideEffect)

    for (const viewport of [
      { width: 959, height: 900 },
      { width: 1440, height: 650 }
    ]) {
      await page.setViewportSize(viewport)
      await page.goto(`/login?logo-sample=viewport-${viewport.width}x${viewport.height}`)
      await expectOrdinaryLogin(page)
      await expect(page.locator('.login-particle-logo')).toHaveCount(0)
      const email = page.getByLabel('Email Address', { exact: true })
      await email.focus()
      await expect(email).toBeFocused()
      expect(artifacts.particle).toHaveLength(0)
      expect(artifacts.static).toHaveLength(0)
    }

    await page.setViewportSize({ width: 960, height: 900 })
    await page.goto('/login?logo-sample=viewport-960x900')
    await expectStaticFallback(page, wideEffect)
    expect(await measureLogoFreeWidth(page)).toBeGreaterThan(0)
    const narrowImageSize = await page.locator('.login-particle-logo__image').evaluate(image => {
      const rect = image.getBoundingClientRect()
      return { longAxis: Math.max(rect.width, rect.height), shortAxis: Math.min(rect.width, rect.height) }
    })
    expect(narrowImageSize.longAxis).toBeGreaterThanOrEqual(256)
    expect(narrowImageSize.shortAxis).toBeGreaterThan(0)
    expect(narrowImageSize.shortAxis).toBeLessThan(48)
    expect(artifacts.particle).toHaveLength(0)
    expect(artifacts.static.length).toBeGreaterThan(0)

    const priorParticleRequestCount = artifacts.particle.length
    const priorStaticRequestCount = artifacts.static.length
    await installZeroFreeSpaceLogin(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/login?logo-sample=zero-space')
    await expectOrdinaryLogin(page)
    expect(await measureLogoFreeWidth(page)).toBeLessThanOrEqual(0)
    await expect(page.locator('.login-particle-logo')).toHaveCount(0)
    expect(artifacts.particle).toHaveLength(priorParticleRequestCount)
    expect(artifacts.static).toHaveLength(priorStaticRequestCount)

    await expectLoginValidation(page)
    await page.setViewportSize({ width: 960, height: 320 })
    await expect(page.locator('.login-particle-logo')).toHaveCount(0)
    await expectScrollable(page.locator('main.login-sd'))
  })

  test('preserves unmanaged landmark, heading, textbox, and button names, tab order, title, focus geometry, and auth controls', async ({ page }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/login?logo-sample=accessibility-baseline')
    await expectOrdinaryLogin(page)
    const baselineTitle = await page.title()
    const siteTitle = (await page.locator('#login-site-title').textContent())?.trim()
    expect(siteTitle).toBeTruthy()
    const baselineButtonNames = await accessibleButtonNames(page)
    expect(baselineButtonNames).toEqual(expect.arrayContaining(['View Password', 'Log In']))
    const expectedAccessibility: LoginAccessibilityContract = {
      buttons: baselineButtonNames,
      headings: [siteTitle ?? '', 'Enter your credentials'],
      landmarks: [siteTitle ?? ''],
      textboxes: ['Email Address', 'Password']
    }
    await expectLoginAccessibilityContract(page, expectedAccessibility)
    const baselineTabOrder = await collectTabOrder(page)
    const baselineFocus = await focusSurfaceGeometry(page)

    await installManagedLogo(page, squareEffect)
    await page.goto('/login?logo-sample=accessibility-managed')
    await expectStaticFallback(page, squareEffect)
    const managedButtonNames = await accessibleButtonNames(page)
    expect(managedButtonNames).toEqual(baselineButtonNames)
    await expectLoginAccessibilityContract(page, expectedAccessibility)
    const managedTabOrder = await collectTabOrder(page)
    const managedFocus = await focusSurfaceGeometry(page)

    expect(await page.title()).toBe(baselineTitle)
    expect(managedTabOrder).toEqual(baselineTabOrder)
    expect(managedTabOrder).toHaveLength(5)
    expect(new Set(managedTabOrder).size).toBe(5)
    for (const edge of ['bottom', 'left', 'right', 'top'] as const) {
      expect(Math.abs(managedFocus[edge] - baselineFocus[edge])).toBeLessThan(1)
    }
    const field = page.locator('.login-particle-logo')
    await expect(field).toHaveAttribute('aria-hidden', 'true')
    await expect(field.locator('.login-particle-logo__image')).toHaveAttribute('alt', '')
    expect(await field.locator('[tabindex], a[href], button, input, select, textarea, summary, [contenteditable]').count()).toBe(0)
    expect(
      await field.evaluate((element, focus) => {
        const rect = element.getBoundingClientRect()
        return !(rect.right <= focus.left - 4 || rect.left >= focus.right + 4 || rect.bottom <= focus.top - 4 || rect.top >= focus.bottom + 4)
      }, managedFocus)
    ).toBe(false)
    await expect(page.getByLabel('Email Address', { exact: true })).toBeFocused()
  })

  test('uses personalized static output before mount under reduced motion with zero enhancement resource trace', async ({ page }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await installLogoResourceTrace(page)
    const artifacts = await installManagedLogo(page, squareEffect)
    const sceneRequests: string[] = []
    page.on('request', request => {
      if (SCENE_REQUEST_PATTERN.test(request.url())) sceneRequests.push(request.url())
    })

    await page.goto('/login')
    await expectStaticFallback(page, squareEffect)
    const trace = await readLogoResourceTrace(page)
    const benchmark = await page.evaluate(() => {
      const logoPerformanceWindow = (): LogoPerformanceWindow => window as LogoPerformanceWindow
      const performance = logoPerformanceWindow().__logoParticlePerformance
      if (!performance) throw new Error('The logo particle performance hook is unavailable.')
      return performance
    })

    expect(artifacts.particle).toHaveLength(0)
    expect(sceneRequests).toEqual([])
    expect(trace).toEqual({
      activeIdleCallbacks: 0,
      activeLogoTimers: 0,
      activeRafs: 0,
      canvasCreated: 0,
      idleCallbacksCancelled: 0,
      idleCallbacksScheduled: 0,
      logoTimersCleared: 0,
      logoTimersScheduled: 0,
      pointerListenersAdded: 0,
      pointerListenersRemoved: 0,
      rafCallbacks: 0,
      rafsCancelled: 0,
      rafsScheduled: 0,
    })
    expect(benchmark.callbackCount).toBe(0)
  })

  test('switches an animated field immediately to static on reduced-motion opt-in and permanently tears down its resources', async ({ page }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const artifacts = await installManagedLogo(page, squareEffect)
    const sceneRequests: string[] = []
    page.on('request', request => {
      if (SCENE_REQUEST_PATTERN.test(request.url())) sceneRequests.push(request.url())
    })

    await page.goto('/login')
    const field = page.locator('.login-particle-logo')
    const staticImage = field.locator('.login-particle-logo__image')
    const outcome = await waitForBackendOutcome(page)
    if (outcome.effectiveBackend === null) {
      const diagnostic = 'No usable particle backend committed; static fallback is the explicit capability outcome.'
      testInfo.annotations.push({ type: 'capability-fallback', description: diagnostic })
      await expectSettledLoadingFailure(page, squareEffect, sceneRequests, artifacts.particle)
      await expectLoginValidation(page)
      return
    }

    await expect(field.locator('canvas')).toHaveCount(1)
    await expect(staticImage).toHaveCSS('opacity', '0')
    await expect.poll(async () => (await readLogoResourceTrace(page)).pointerListenersAdded).toBeGreaterThanOrEqual(5)
    await expect.poll(async () => (await readLogoPerformance(page)).callbackCount).toBeGreaterThan(0)
    const priorTrace = await readLogoResourceTrace(page)
    const priorSceneRequestCount = sceneRequests.length
    const priorParticleRequestCount = artifacts.particle.length
    expect(priorTrace.canvasCreated).toBeGreaterThan(0)
    await page.getByLabel('Email Address', { exact: true }).focus()
    await installReducedMotionChangeProbe(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => readReducedMotionChangeReport(page)).not.toBeNull()
    const changeReport = await readReducedMotionChangeReport(page)
    expect(changeReport).toMatchObject({
      pointerActive: false,
      staticOpacity: '1',
      staticTransition: 'none'
    })
    expect(changeReport?.trace.activeIdleCallbacks).toBe(0)
    expect(changeReport?.trace.activeLogoTimers).toBe(0)
    expect(changeReport?.trace.activeRafs).toBe(0)
    expect((changeReport?.trace.pointerListenersAdded ?? 0) - (changeReport?.trace.pointerListenersRemoved ?? 0)).toBe(0)
    await expect(staticImage).toHaveCSS('opacity', '1')
    await expect(field.locator('canvas')).toHaveCount(0)
    await expect(page.getByLabel('Email Address', { exact: true })).toBeFocused()
    const immediateTrace = await readLogoResourceTrace(page)
    expect(immediateTrace.activeIdleCallbacks).toBe(0)
    expect(immediateTrace.activeLogoTimers).toBe(0)
    expect(immediateTrace.activeRafs).toBe(0)
    expect(immediateTrace.pointerListenersAdded - immediateTrace.pointerListenersRemoved).toBe(0)

    await page.waitForTimeout(250)
    const settledTrace = await readLogoResourceTrace(page)
    expect(settledTrace.rafCallbacks).toBe(immediateTrace.rafCallbacks)
    expect(sceneRequests).toHaveLength(priorSceneRequestCount)
    expect(artifacts.particle).toHaveLength(priorParticleRequestCount)
    const settledPerformanceCallbackCount = await page.evaluate(
      () => {
        const logoPerformanceWindow = (): LogoPerformanceWindow => window as LogoPerformanceWindow
        const performance = logoPerformanceWindow().__logoParticlePerformance
        if (!performance) throw new Error('The logo particle performance hook is unavailable.')
        return performance.callbackCount
      }
    )
    expect(settledPerformanceCallbackCount).toBe(changeReport?.performanceCallbackCount)
    await expectLoginValidation(page)
  })

  test('renders a drifting particle cloud with cursor response, visible scatter, and recovery without telemetry', async ({ page }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await installLogoResourceTrace(page)
    await installLogoFrameCapture(page)
    const requests: string[] = []
    const sceneRequests: string[] = []
    page.on('request', request => {
      requests.push(request.url())
      if (SCENE_REQUEST_PATTERN.test(request.url())) sceneRequests.push(request.url())
    })
    const artifacts = await installManagedLogo(page, squareEffect)

    await page.goto('/login?logo-sample=motion', { waitUntil: 'domcontentloaded' })
    await expectOrdinaryLogin(page)
    const ordinaryLogo = page.locator('.login-brand .login-logo img')
    await expect(ordinaryLogo).toHaveAttribute('src', squareEffect.logoUrl)
    await assertTransparentSourceIdentity(ordinaryLogo, squareEffect, 'ordinary')
    const field = page.locator('.login-particle-logo')
    const canvas = field.locator('canvas')
    const outcome = await waitForBackendOutcome(page)
    if (outcome.effectiveBackend === null) {
      const diagnostic = 'No usable particle backend committed; motion coverage records the explicit static capability outcome.'
      testInfo.annotations.push({ type: 'capability-fallback', description: diagnostic })
      await expectSettledLoadingFailure(page, squareEffect, sceneRequests, artifacts.particle)
      return
    }

    await expect(canvas).toHaveCount(1)
    await expect(field.locator('.login-particle-logo__image')).toHaveCSS('opacity', '0')
    await expect.poll(async () => (await readLogoResourceTrace(page)).rafCallbacks).toBeGreaterThan(3)
    await expect.poll(() => readLogoMotion(page)).not.toBeNull()
    expect(artifacts.particle).toHaveLength(1)

    const baselineTime = 5.25
    const idleAtZero = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, 0)).png)
    const baseline = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, baselineTime)).png)
    expect(analyzeFrame(baseline).inkRatio).toBeGreaterThan(0.002)
    expect(compareFrames(idleAtZero, baseline).mean).toBeGreaterThan(0.0001)
    await expect(field.locator('.login-particle-logo__stage')).toHaveCSS('filter', 'none')

    await page.waitForLoadState('networkidle')
    const requestCountBeforeInput = requests.length
    const bounds = await canvas.boundingBox()
    if (!bounds) throw new Error('The particle field has no bounds')
    const x = bounds.x + bounds.width * 0.5
    const y = bounds.y + bounds.height * 0.5
    const clock = 1_000_000_000
    await captureLogoRenderedFrame(page, { clientX: x - 25, clientY: y }, baselineTime, clock)
    await captureLogoRenderedFrame(page, { clientX: x + 25, clientY: y }, baselineTime, clock + 30)
    const moved = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, baselineTime, clock + 180)).png)
    expect((await readLogoMotion(page))?.diagnostics.activeImpulseCount).toBeGreaterThan(0)
    expect(compareFrames(baseline, moved).mean).toBeGreaterThan(0.00001)
    await captureLogoRenderedFrame(page, undefined, baselineTime, clock + 1500)
    expect((await readLogoMotion(page))?.diagnostics.activeImpulseCount).toBe(0)

    const blastTime = clock + 5000
    const before = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, baselineTime, blastTime - 1)).png)
    await captureLogoRenderedFrame(page, { clientX: x, clientY: y, type: 'pointerdown' }, baselineTime, blastTime)
    await dispatchLogoPointerEvent(page, { clientX: x, clientY: y, type: 'pointerup' })
    const scattered = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, baselineTime, blastTime + 350)).png)
    expect((await readLogoMotion(page))?.diagnostics.activeExplosionCount).toBe(1)
    const scatteredDifference = compareFrames(before, scattered).mean
    expect(scatteredDifference).toBeGreaterThan(0.0001)
    // Scatter must retain visible particles, rather than making an alpha hole.
    expect(analyzeFrame(scattered).inkRatio).toBeGreaterThan(analyzeFrame(before).inkRatio * 0.7)
    const recovered = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, baselineTime, blastTime + 3000)).png)
    // The physical beads continue drifting; the recovered frame need not be pixel-identical.
    // Fixed-step physics tests separately compare recovery against an undisturbed cloud.
    expect(compareFrames(before, recovered).mean).toBeLessThan(scatteredDifference * 0.6)
    expect((await readLogoMotion(page))?.diagnostics.activeExplosionCount).toBe(0)

    for (let i = 0; i < 8; i++) {
      await captureLogoRenderedFrame(page, { clientX: x + i, clientY: y, type: 'pointerdown' }, baselineTime, blastTime + 4000 + i)
      await dispatchLogoPointerEvent(page, { clientX: x + i, clientY: y, type: 'pointerup' })
    }
    expect((await readLogoMotion(page))?.diagnostics.activeExplosionCount).toBe(6)
    await captureLogoRenderedFrame(page, undefined, baselineTime, blastTime + 7000)
    expect((await readLogoMotion(page))?.diagnostics.activeExplosionCount).toBe(0)
    expect(requests).toHaveLength(requestCountBeforeInput)
    await expectLoginValidation(page)
  })

  for (const failure of ['import', 'fetch', 'decode'] as const) {
    test(`keeps the personalized static treatment and authentication usable after ${failure} failure`, async ({ page }, testInfo) => {
      requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      let importFailed = false
      if (failure === 'import') {
        await page.route(SCENE_REQUEST_PATTERN, route => {
          importFailed = true
          return route.abort('failed')
        })
      }
      const artifacts = await installManagedLogo(
        page,
        squareEffect,
        failure === 'fetch'
          ? { particleStatus: 503, particleBody: 'unavailable' }
          : failure === 'decode'
            ? { particleBody: Buffer.from('not-a-particle-binary') }
            : {}
      )

      await page.goto('/login')
      if (failure === 'import') {
        await expect.poll(() => importFailed).toBe(true)
        expect(artifacts.particle).toHaveLength(0)
      } else {
        await expect.poll(() => artifacts.particle.length).toBe(1)
      }
      await expectStaticFallback(page, squareEffect)
      await expectLoginValidation(page)
    })
  }

  test('restores static treatment synchronously after particle backend loss without moving auth focus', async ({ page }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await installLogoResourceTrace(page)
    const artifacts = await installManagedLogo(page, squareEffect)
    const sceneRequests: string[] = []
    page.on('request', request => {
      if (SCENE_REQUEST_PATTERN.test(request.url())) sceneRequests.push(request.url())
    })
    await page.goto('/login')
    const field = page.locator('.login-particle-logo')
    const canvas = field.locator('canvas')
    const staticImage = field.locator('.login-particle-logo__image')
    const outcome = await waitForBackendOutcome(page)
    if (outcome.effectiveBackend == null) {
      testInfo.annotations.push({
        type: 'capability-fallback',
        description: 'No particle backend committed; static fallback is the explicit capability outcome.'
      })
      await expectSettledLoadingFailure(page, squareEffect, sceneRequests, artifacts.particle)
      await expectLoginValidation(page)
      return
    }

    await expectBackendReady(page, outcome.effectiveBackend, squareEffect, 'auto')
    const email = page.getByLabel('Email Address', { exact: true })
    await email.focus()
    await expect(email).toBeFocused()

    await canvas.dispatchEvent('webglcontextlost', { cancelable: true })
    await expect(staticImage).toHaveCSS('opacity', '1')
    await expect(canvas).toHaveCount(0)
    await expect(email).toBeFocused()
    await expect
      .poll(async () => {
        const diagnostics = (await readLogoPerformance(page)).backendDiagnostics ?? []
        return diagnostics.some((diagnostic: LogoBackendDiagnostic) => diagnostic.phase === 'lost' || diagnostic.phase === 'retired')
      })
      .toBe(true)
    await expectLoginValidation(page)
  })

  test('falls back to the shared ordinary logo when the personalized static artifact cannot decode', async ({ page }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
    const artifacts = await installManagedLogo(page, squareEffect, { staticBody: Buffer.from('not-an-image') })
    await page.goto('/login')
    await expectOrdinaryLogin(page)
    await expect(page.locator('.login-brand .login-logo img')).toHaveAttribute('src', squareEffect.logoUrl)
    await expect(page.locator('.login-particle-logo')).toHaveCount(0)
    expect(artifacts.particle).toHaveLength(0)
    await expectLoginValidation(page)
  })

  test('makes only same-origin requests, omits credentials from the particle fetch, and sends no pointer telemetry', async ({ page }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
    const baseURL = testInfo.project.use.baseURL
    if (typeof baseURL !== 'string') throw new Error('Playwright base URL is unavailable.')
    const origin = new URL(baseURL).origin
    await page.context().addCookies([{ name: 'logo-e2e-sentinel', value: 'credential', url: origin }])
    await installLogoResourceTrace(page)
    await installParticleFetchProbe(page, squareEffect.particleUrl)
    const externalRequests: string[] = []
    const allRequests: string[] = []
    const sceneRequests: string[] = []
    page.on('request', request => {
      const url = request.url()
      allRequests.push(url)
      if (SCENE_REQUEST_PATTERN.test(url)) sceneRequests.push(url)
      if (/^https?:/.test(url) && new URL(url).origin !== origin) externalRequests.push(url)
    })
    const artifacts = await installManagedLogo(page, squareEffect)

    await page.goto('/login')
    await expectOrdinaryLogin(page)
    await expect(page.locator('.login-brand .login-logo img')).toHaveAttribute('src', squareEffect.logoUrl)
    const field = page.locator('.login-particle-logo')
    const canvas = field.locator('canvas')
    const outcome = await waitForBackendOutcome(page)
    if (outcome.effectiveBackend === null) {
      testInfo.annotations.push({
        type: 'capability-fallback',
        description: 'No particle backend committed; request privacy is checked against the explicit static fallback.'
      })
      await expectSettledLoadingFailure(page, squareEffect, sceneRequests, artifacts.particle)
    } else {
      await expect(canvas).toHaveCount(1)
      await expect.poll(() => artifacts.particle.length).toBe(1)
    }

    expect(await page.evaluate(() => document.cookie.split('; ').includes('logo-e2e-sentinel=credential'))).toBe(true)
    const particleFetches = await readParticleFetchProbe(page)
    expect(particleFetches).toHaveLength(artifacts.particle.length)
    for (const [index, fetchObservation] of particleFetches.entries()) {
      const networkRequest = artifacts.particle[index]
      if (!networkRequest) throw new Error('A particle fetch did not produce a corresponding network request.')
      expect(fetchObservation.credentials).toBe('omit')
      expect(new URL(fetchObservation.url).origin).toBe(origin)
      expect(networkRequest.url()).toBe(fetchObservation.url)
      expect((await networkRequest.allHeaders()).cookie).toBeUndefined()
    }
    for (const url of allRequests) {
      if (/^https?:/.test(url)) expect(new URL(url).origin).toBe(origin)
    }

    await page.waitForLoadState('networkidle')
    const requestCountBeforePointer = allRequests.length
    const pointerTarget = outcome.effectiveBackend === null ? field : canvas
    const bounds = await pointerTarget.boundingBox()
    expect(bounds).not.toBeNull()
    if (!bounds) throw new Error('The visible logo surface has no pointer-test bounds.')
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.waitForTimeout(150)
    expect(allRequests).toHaveLength(requestCountBeforePointer)
    expect(externalRequests).toEqual([])
    if (particleFetches.length === 0) {
      await expectStaticFallback(page, squareEffect)
      expectNoActiveLogoWork(await readLogoResourceTrace(page))
    }
    await expectLoginValidation(page)
  })

  test('keeps an eligible desktop field decorative, ordered after the card, and outside auth controls', async ({ page }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await installManagedLogo(page, squareEffect)
    await page.goto('/login')
    await expectOrdinaryLogin(page)

    const field = page.locator('.login-particle-logo')
    const image = field.locator('.login-particle-logo__image')
    await expect(field).toBeVisible()
    await expect(field).toHaveAttribute('aria-hidden', 'true')
    await expect(image).toHaveAttribute('alt', '')
    await expect(field).toHaveCSS('pointer-events', 'none')
    await expect(image).toHaveCSS('pointer-events', 'none')
    expect(
      await field.evaluate(element => {
        const cardElement = document.querySelector('main.login-sd')
        const formElement = document.querySelector('form.login-form')
        const sceneChildren = element.querySelectorAll('.login-particle-logo__stage, .login-particle-logo__scene, canvas')
        return {
          followsCard: element.previousElementSibling === cardElement,
          sharesLoginParent: element.parentElement?.classList.contains('login') === true,
          outsideCard: cardElement !== null && !cardElement.contains(element) && !element.contains(cardElement),
          outsideForm: formElement !== null && !formElement.contains(element) && !element.contains(formElement),
          containsActionableOrFocusable: element.querySelector('[tabindex], a[href], button, input, select, textarea, summary, [contenteditable]') !== null,
          sceneChildrenIgnorePointers: Array.from(sceneChildren).every(child => getComputedStyle(child).pointerEvents === 'none')
        }
      })
    ).toEqual({
      followsCard: true,
      sharesLoginParent: true,
      outsideCard: true,
      outsideForm: true,
      containsActionableOrFocusable: false,
      sceneChildrenIgnorePointers: true
    })

    await expectLoginValidation(page)
  })

  test('keeps login and registration operable when the field is omitted on coarse-pointer release profiles', async ({ page }, testInfo) => {
    requireProjectRow(testInfo, OMITTED_DEVICE_PROJECTS)
    const artifacts = await installManagedLogo(page, wideEffect)
    await installRegistrationShell(page)

    await page.goto('/login')
    expect(
      await page.evaluate(() => ({
        coarse: window.matchMedia('(pointer: coarse)').matches,
        noHover: window.matchMedia('(hover: none)').matches
      }))
    ).toEqual({ coarse: true, noHover: true })
    await expectOrdinaryLogin(page)
    await expect(page.locator('.login-particle-logo')).toHaveCount(0)
    await expectLoginValidation(page)

    await page.goto('/register')
    const register = page.locator('main.register')
    const email = page.getByLabel('Email Address', { exact: true })
    const password = page.getByLabel('Password', { exact: true })
    const verifyPassword = page.getByLabel('Verify Password', { exact: true })
    const name = page.getByLabel('Name', { exact: true })
    const submit = page.getByRole('button', { name: 'Register', exact: true })
    await expect(register).toBeVisible()
    await expect(register.locator('.register-logo img')).toBeVisible()
    await expect(register.locator('.register-logo img')).toHaveAttribute('src', wideEffect.logoUrl)
    await assertTransparentSourceIdentity(register.locator('.register-logo img'), wideEffect, 'ordinary')
    await expect(register.locator('#register-site-title')).toBeVisible()
    await expect(email).toBeFocused()
    await expect(password).toBeVisible()
    await expect(verifyPassword).toBeVisible()
    await expect(name).toBeVisible()
    await expect(page.getByRole('link', { name: 'Login instead', exact: true })).toHaveAttribute('href', '/login')
    await expect(submit).toBeEnabled()
    await expect(page.locator('.login-particle-logo')).toHaveCount(0)
    expect(artifacts.particle).toHaveLength(0)
    expect(artifacts.static).toHaveLength(0)

    await email.fill('logo-journey@example.test')
    await password.fill('short')
    await verifyPassword.fill('short')
    await name.fill('Logo Journey')
    await submit.click()
    await expect(register.locator('.v-alert[role="alert"]')).toBeVisible()
    await expect(password).toBeFocused()

    await page.route('**/_api/auth/register', route =>
      route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Registration E2E fixture rejected the request.' })
      })
    )
    await password.fill('auth-independent-password')
    await verifyPassword.fill('auth-independent-password')
    const submitted = page.waitForRequest(request => request.url().endsWith('/_api/auth/register') && request.method() === 'POST')
    await submit.click()
    expect((await submitted).postDataJSON()).toEqual({
      email: 'logo-journey@example.test',
      password: 'auth-independent-password',
      name: 'Logo Journey'
    })
    await expect(register.locator('.v-alert[role="alert"]')).toBeVisible()

    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport) return
    await page.setViewportSize({ width: viewport.width, height: 360 })
    await expectScrollable(page.locator('html'))
    await submit.scrollIntoViewIfNeeded()
    await expect(submit).toBeVisible()
  })
})


test.describe('particle compositor without service workers', () => {
  test.use({ serviceWorkers: 'block' })

  test('keeps rendered particle colors intrinsic across theme changes and composites straight-alpha samples', async ({ context, page }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)

    const prepare = async (target: Page, colorScheme: 'light' | 'dark', query: string): Promise<void> => {
      await target.emulateMedia({ colorScheme, reducedMotion: 'no-preference' })
      await installLogoPerformanceProbe(target)
      await installLogoFrameCapture(target)
      await installManagedLogo(target, colorProbeEffect, { particleBody: colorProbeParticleFixture })
      await target.goto(`/login?${query}`, { waitUntil: 'domcontentloaded' })
      const card = target.locator('main.login-sd')
      const title = card.locator('#login-site-title')
      await expect(card).toBeVisible({ timeout: 15_000 })
      const ordinaryLogo = card.locator('.login-brand .login-logo img')
      await expect(ordinaryLogo).toHaveCount(1)
      await expect(ordinaryLogo).toHaveAttribute('src', colorProbeEffect.logoUrl)
      await expect(title).toBeVisible()
      expect((await title.textContent())?.trim()).toBeTruthy()
      await expect(target.getByLabel('Email Address', { exact: true })).toBeVisible()
      await expect(target.getByLabel('Password', { exact: true })).toBeVisible()
      await expect(target.getByRole('button', { name: 'Log In', exact: true })).toBeEnabled()
      const outcome = await waitForBackendOutcome(target)
      if (outcome.effectiveBackend == null) {
        const description = 'Color/compositor coverage skipped: no backend committed, with static fallback recorded as capability evidence.'
        testInfo.annotations.push({ type: 'capability-skip', description })
        test.skip(true, description)
        return
      }
      await expectBackendReady(target, outcome.effectiveBackend, colorProbeEffect, 'auto')
      const field = target.locator('.login-particle-logo')
      await expect(field.locator('canvas')).toHaveCount(1)
      await expect(field.locator('.login-particle-logo__image')).toHaveCSS('opacity', '0')
      await expect(target.locator('.v-application')).toHaveClass(colorScheme === 'light' ? /v-theme--light/ : /v-theme--dark/)
    }

    const captureIntrinsic = async (target: Page): Promise<RgbaFrame> =>
      withFrozenLogoFrame(target, async () => decodeScreenshot((await captureLogoRenderedFrame(target, undefined, 0, 0)).png))

    const cold = async (colorScheme: 'light' | 'dark'): Promise<{ readonly frame: RgbaFrame; readonly theme: ApplicationThemeObservation }> => {
      const target = await context.newPage()
      try {
        await prepare(target, colorScheme, `logo-color-probe-cold-${colorScheme}`)
        const frame = await captureIntrinsic(target)
        return { frame, theme: await readApplicationTheme(target) }
      } finally {
        await target.close()
      }
    }

    const coldLight = await cold('light')
    const coldDark = await cold('dark')
    expect(coldLight.theme.className).toMatch(/v-theme--light/)
    expect(coldDark.theme.className).toMatch(/v-theme--dark/)
    expect(coldLight.theme.background).not.toBe(coldDark.theme.background)
    expectColorProbePixels(coldLight.frame)
    expectColorProbePixels(coldDark.frame)
    expectIntrinsicFramesEquivalent(coldLight.frame, coldDark.frame)

    await prepare(page, 'light', 'logo-color-probe-live')
    const liveLightComposition = await capturePageComposition(page)
    const liveLight = {
      frame: liveLightComposition.frame,
      theme: await readApplicationTheme(page)
    }

    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' })
    await expect(page.locator('.v-application')).toHaveClass(/v-theme--dark/)
    await expect.poll(async () => (await readApplicationTheme(page)).background).not.toBe(liveLight.theme.background)
    const liveDarkComposition = await capturePageComposition(page)
    const liveDark = {
      frame: liveDarkComposition.frame,
      theme: await readApplicationTheme(page)
    }

    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
    await expect(page.locator('.v-application')).toHaveClass(/v-theme--light/)
    await expect.poll(async () => (await readApplicationTheme(page)).background).toBe(liveLight.theme.background)
    const liveLightAgainComposition = await capturePageComposition(page)
    const liveLightAgain = {
      frame: liveLightAgainComposition.frame,
      theme: await readApplicationTheme(page)
    }

    expect(liveLight.theme.className).toMatch(/v-theme--light/)
    expect(liveDark.theme.className).toMatch(/v-theme--dark/)
    expect(liveLightAgain.theme.className).toMatch(/v-theme--light/)
    expect(liveLight.theme.background).not.toBe(liveDark.theme.background)
    expect(liveDark.theme.background).not.toBe(liveLightAgain.theme.background)
    expectColorProbePixels(liveLight.frame)
    expectColorProbePixels(liveDark.frame)
    expectColorProbePixels(liveLightAgain.frame)
    expectIntrinsicFramesEquivalent(coldLight.frame, liveLight.frame)
    expectIntrinsicFramesEquivalent(coldDark.frame, liveDark.frame)
    expectIntrinsicFramesEquivalent(liveLight.frame, liveDark.frame)
    expectIntrinsicFramesEquivalent(liveLight.frame, liveLightAgain.frame)
    expectStraightSourceOver(liveLightComposition)
    expectStraightSourceOver(liveDarkComposition)
    expectStraightSourceOver(liveLightAgainComposition)
  })
})
