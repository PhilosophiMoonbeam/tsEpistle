import { Buffer } from 'node:buffer'
import type { Locator, Page, Request, TestInfo } from '@playwright/test'
import { expect } from '@playwright/test'
import sharp from 'sharp'
import { responsiveTest as test } from './helpers.ts'

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

type ManagedEffect = typeof squareEffect | typeof wideEffect
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
    bytes.writeUInt16LE((index % 65_535) + 1, seedOffset + index * 2)
  }
  bytes.writeUInt32LE(crc32(bytes.subarray(headerBytes)), 24)
  return bytes
}

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

interface LogoMotionDiagnostics {
  readonly activeExplosionCount: number
  readonly activeImpulseCount: number
  readonly bounceRatio: number
  readonly depthScaleMax: number
  readonly depthScaleMin: number
  readonly elapsedSeconds: number
  readonly explosionHoldSeconds: number
  readonly explosionLifetimeSeconds: number
  readonly explosionRefillSeconds: number
  readonly idleAmplitudeCss: number
  readonly impulseLifetimeSeconds: number
  readonly maxImpulseTravelCss: number
  readonly neighborForceRatio: number
  readonly particleCount: number
}
const motionDiagnosticKeys = [
  'activeExplosionCount',
  'activeImpulseCount',
  'bounceRatio',
  'depthScaleMax',
  'depthScaleMin',
  'elapsedSeconds',
  'explosionHoldSeconds',
  'explosionLifetimeSeconds',
  'explosionRefillSeconds',
  'idleAmplitudeCss',
  'impulseLifetimeSeconds',
  'maxImpulseTravelCss',
  'neighborForceRatio',
  'particleCount'
] as const

interface LogoPerformanceHook {
  callbackCount: number
  callbackCpuMilliseconds: number[]
  frameIntervalsMilliseconds: number[]
  firstFrameMilliseconds: number | null
  lastFrameAt: number | null
  lastMotion?: LogoMotionDiagnostics
}

interface LogoFramePointerSample {
  readonly clientX: number
  readonly clientY: number
  readonly pointerId?: number
  readonly pointerType?: 'mouse' | 'pen' | 'touch'
  readonly type?: 'pointercancel' | 'pointerdown' | 'pointermove' | 'pointerup'
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
  webglContextRequests: number
}

interface ReducedMotionChangeReport {
  readonly performanceCallbackCount: number
  readonly canvasCount: number
  readonly pointerActive: boolean
  readonly staticOpacity: string | null
  readonly staticTransition: string | null
  readonly trace: LogoResourceTrace
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
  const particles = effect === squareEffect ? squareParticleFixture : wideParticleFixture
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
    const captureWindow = window as Window & {
      __logoParticleFrameCapture: LogoFrameCaptureHook
    }
    captureWindow.__logoParticleFrameCapture = { request: null }
  })
}

async function browserSupportsWebGL2(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas')
    return canvas.getContext('webgl2') !== null
  })
}

async function installParticleFetchProbe(page: Page, particleUrl: string): Promise<void> {
  await page.addInitScript(expectedParticleUrl => {
    const probeWindow = window as Window & {
      __loginLogoParticleFetches: ParticleFetchObservation[]
    }
    const nativeFetch = window.fetch.bind(window)
    probeWindow.__loginLogoParticleFetches = []
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new globalThis.Request(input, init)
      if (request.url === new URL(expectedParticleUrl, window.location.href).href) {
        probeWindow.__loginLogoParticleFetches.push({
          credentials: request.credentials,
          url: request.url
        })
      }
      return nativeFetch(input, init)
    }) as typeof window.fetch
  }, particleUrl)
}

async function readParticleFetchProbe(page: Page): Promise<ParticleFetchObservation[]> {
  return page.evaluate(() => (window as Window & { __loginLogoParticleFetches: ParticleFetchObservation[] }).__loginLogoParticleFetches)
}

async function installLogoResourceTrace(page: Page): Promise<void> {
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
      rafsScheduled: 0,
      webglContextRequests: 0
    }
    const activeIdleCallbacks = new Set<number>()
    const activeLogoTimers = new Set<number>()
    const activeRafs = new Set<number>()
    const logoCanvases = new WeakSet<HTMLCanvasElement>()
    const tracedWindow = window as Window & {
      __logoParticlePerformance: LogoPerformanceHook
      __readLoginLogoTrace: () => LogoResourceTrace
    }
    tracedWindow.__logoParticlePerformance = {
      callbackCount: 0,
      callbackCpuMilliseconds: [],
      frameIntervalsMilliseconds: [],
      firstFrameMilliseconds: null,
      lastFrameAt: null
    }
    tracedWindow.__readLoginLogoTrace = () => ({
      ...trace,
      activeIdleCallbacks: activeIdleCallbacks.size,
      activeLogoTimers: activeLogoTimers.size,
      activeRafs: activeRafs.size
    })

    const nativeCreateElement = Document.prototype.createElement
    Document.prototype.createElement = function (qualifiedName: string, options?: ElementCreationOptions): HTMLElement {
      const element = nativeCreateElement.call(this, qualifiedName, options) as HTMLElement
      if (element instanceof HTMLCanvasElement && document.querySelector('.login-particle-logo')) {
        trace.canvasCreated += 1
        logoCanvases.add(element)
      }
      return element
    } as typeof Document.prototype.createElement

    const nativeGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (contextId: string, options?: unknown): RenderingContext | null {
      if (/webgl/i.test(contextId) && logoCanvases.has(this)) trace.webglContextRequests += 1
      return nativeGetContext.call(this, contextId as '2d', options as CanvasRenderingContext2DSettings)
    } as typeof HTMLCanvasElement.prototype.getContext

    const nativeAddEventListener = EventTarget.prototype.addEventListener
    const nativeRemoveEventListener = EventTarget.prototype.removeEventListener
    EventTarget.prototype.addEventListener = function (
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
      type: string,
      callback: EventListenerOrEventObject | null,
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
  return page.evaluate(() => (window as Window & { __readLoginLogoTrace: () => LogoResourceTrace }).__readLoginLogoTrace())
}

async function readLogoMotion(page: Page): Promise<LogoMotionObservation | null> {
  return page.evaluate(() => {
    const motion = (window as Window & { __logoParticlePerformance?: LogoPerformanceHook }).__logoParticlePerformance?.lastMotion
    if (!motion) return null
    return {
      diagnostics: { ...motion },
      keys: Object.keys(motion).sort()
    }
  })
}

async function installReducedMotionChangeProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probeWindow = window as Window & {
      __loginLogoReducedMotionReport: ReducedMotionChangeReport | null
      __logoParticlePerformance: { callbackCount: number }
      __readLoginLogoTrace: () => LogoResourceTrace
    }
    probeWindow.__loginLogoReducedMotionReport = null
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const recordChange = (): void => {
      if (!motionQuery.matches) return
      motionQuery.removeEventListener('change', recordChange)
      const image = document.querySelector<HTMLElement>('.login-particle-logo__image')
      probeWindow.__loginLogoReducedMotionReport = {
        performanceCallbackCount: probeWindow.__logoParticlePerformance.callbackCount,
        canvasCount: document.querySelectorAll('.login-particle-logo canvas').length,
        pointerActive: document.querySelector('.login-particle-logo--pointer-active') !== null,
        staticOpacity: image ? getComputedStyle(image).opacity : null,
        staticTransition: image?.style.transition ?? null,
        trace: probeWindow.__readLoginLogoTrace()
      }
    }
    motionQuery.addEventListener('change', recordChange)
  })
}

async function readReducedMotionChangeReport(page: Page): Promise<ReducedMotionChangeReport | null> {
  return page.evaluate(() => (window as Window & { __loginLogoReducedMotionReport: ReducedMotionChangeReport | null }).__loginLogoReducedMotionReport)
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
      const hook = (
        window as Window & {
          __logoParticleFrameCapture?: LogoFrameCaptureHook
        }
      ).__logoParticleFrameCapture
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

interface CircularRegion {
  readonly radius: number
  readonly x: number
  readonly y: number
}

interface RegionAppearance {
  readonly foregroundMean: number
  readonly radialCentroid: number
}

function frameBackground(frame: RgbaFrame): readonly [number, number, number] {
  const corners = [0, frame.width - 1, (frame.height - 1) * frame.width, frame.height * frame.width - 1]
  const average = (channel: number): number => corners.reduce((sum, pixel) => sum + (frame.data[pixel * 4 + channel] ?? 0), 0) / corners.length
  return [average(0), average(1), average(2)]
}

function analyzeRegion(frame: RgbaFrame, region: CircularRegion): RegionAppearance {
  const background = frameBackground(frame)
  let foreground = 0
  let radialMoment = 0
  let samples = 0
  for (let y = Math.max(0, Math.floor(region.y - region.radius)); y <= Math.min(frame.height - 1, Math.ceil(region.y + region.radius)); y += 1) {
    for (let x = Math.max(0, Math.floor(region.x - region.radius)); x <= Math.min(frame.width - 1, Math.ceil(region.x + region.radius)); x += 1) {
      const distance = Math.hypot(x - region.x, y - region.y)
      if (distance > region.radius) continue
      const offset = (y * frame.width + x) * 4
      const weight =
        Math.abs((frame.data[offset] ?? 0) - background[0]) +
        Math.abs((frame.data[offset + 1] ?? 0) - background[1]) +
        Math.abs((frame.data[offset + 2] ?? 0) - background[2])
      foreground += weight
      radialMoment += distance * weight
      samples += 1
    }
  }
  return {
    foregroundMean: samples === 0 ? 0 : foreground / (samples * 3 * 255),
    radialCentroid: foreground === 0 ? 0 : radialMoment / foreground
  }
}

function estimateHorizontalTranslation(before: RgbaFrame, after: RgbaFrame, region: CircularRegion, maximumShift: number): number {
  if (before.width !== after.width || before.height !== after.height) throw new Error('Particle screenshots changed dimensions.')
  let bestShift = 0
  let bestError = Number.POSITIVE_INFINITY
  for (let shift = -maximumShift; shift <= maximumShift; shift += 1) {
    let error = 0
    for (let y = Math.max(0, Math.floor(region.y - region.radius)); y <= Math.min(before.height - 1, Math.ceil(region.y + region.radius)); y += 1) {
      for (let x = Math.max(0, Math.floor(region.x - region.radius)); x <= Math.min(before.width - 1, Math.ceil(region.x + region.radius)); x += 1) {
        if (Math.hypot(x - region.x, y - region.y) > region.radius || x + shift < 0 || x + shift >= after.width) continue
        const beforeOffset = (y * before.width + x) * 4
        const afterOffset = (y * after.width + x + shift) * 4
        error +=
          Math.abs((before.data[beforeOffset] ?? 0) - (after.data[afterOffset] ?? 0)) +
          Math.abs((before.data[beforeOffset + 1] ?? 0) - (after.data[afterOffset + 1] ?? 0)) +
          Math.abs((before.data[beforeOffset + 2] ?? 0) - (after.data[afterOffset + 2] ?? 0))
      }
    }
    if (error < bestError) {
      bestError = error
      bestShift = shift
    }
  }
  return bestShift
}

function estimateDarkCoreDiameter(frame: RgbaFrame): number {
  const background = frameBackground(frame)
  const fittedHalfAxis = Math.min(frame.width, frame.height) / 2
  const centerX = frame.width / 2 + 0.04 * fittedHalfAxis
  const centerY = frame.height / 2
  const radius = 0.39 * fittedHalfAxis
  const weights: number[] = []
  for (let y = Math.floor(centerY - radius); y <= Math.ceil(centerY + radius); y += 1) {
    for (let x = Math.floor(centerX - radius); x <= Math.ceil(centerX + radius); x += 1) {
      if (x < 0 || x >= frame.width || y < 0 || y >= frame.height || Math.hypot(x - centerX, y - centerY) > radius) continue
      const offset = (y * frame.width + x) * 4
      const residuals = [0, 1, 2].map(channel => Math.abs(background[channel]! - (frame.data[offset + channel] ?? 0)))
      const spread = Math.max(...residuals) - Math.min(...residuals)
      const weight = residuals[0]! + residuals[1]! + residuals[2]!
      if (weight > 36 && spread < 24) weights.push(weight)
    }
  }
  if (weights.length === 0) throw new Error('The calibrated dark fixture component was not rendered.')
  weights.sort((first, second) => first - second)
  const solidWeight = weights[Math.floor(weights.length * 0.9)]!
  const effectiveArea = weights.reduce((sum, weight) => sum + Math.min(1, weight / solidWeight), 0)
  let darkParticleCount = 0
  for (let index = 0; index < squareEffect.count; index += 1) {
    if (particleFixtureSample(index).component === 1) darkParticleCount += 1
  }
  return 2 * Math.sqrt(effectiveArea / (Math.PI * darkParticleCount))
}

function blueFixtureCentroid(frame: RgbaFrame, sample: ParticleFixtureSample): { readonly x: number; readonly y: number } {
  const fittedHalfAxis = Math.min(frame.width, frame.height) / 2
  const centerX = frame.width / 2 + sample.x * fittedHalfAxis
  const centerY = frame.height / 2 - sample.y * fittedHalfAxis
  const radius = 8
  let weight = 0
  let weightedX = 0
  let weightedY = 0
  for (let y = Math.floor(centerY - radius); y <= Math.ceil(centerY + radius); y += 1) {
    for (let x = Math.floor(centerX - radius); x <= Math.ceil(centerX + radius); x += 1) {
      if (x < 0 || x >= frame.width || y < 0 || y >= frame.height || Math.hypot(x - centerX, y - centerY) > radius) continue
      const offset = (y * frame.width + x) * 4
      const blueWeight = Math.max(0, (frame.data[offset + 2] ?? 0) - (frame.data[offset] ?? 0))
      weight += blueWeight
      weightedX += x * blueWeight
      weightedY += y * blueWeight
    }
  }
  if (weight === 0) throw new Error('The calibrated blue fixture marker was not rendered.')
  return { x: weightedX / weight, y: weightedY / weight }
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
    const benchmark = await page.evaluate(() => (window as Window & { __logoParticlePerformance: { callbackCount: number } }).__logoParticlePerformance)

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
      webglContextRequests: 0
    })
    expect(benchmark.callbackCount).toBe(0)
  })

  test('switches an animated field immediately to static on reduced-motion opt-in and permanently tears down its resources', async ({ page }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const supportsWebGL2 = await browserSupportsWebGL2(page)
    await installLogoResourceTrace(page)
    const artifacts = await installManagedLogo(page, squareEffect)
    const sceneRequests: string[] = []
    page.on('request', request => {
      if (SCENE_REQUEST_PATTERN.test(request.url())) sceneRequests.push(request.url())
    })

    await page.goto('/login')
    const field = page.locator('.login-particle-logo')
    const staticImage = field.locator('.login-particle-logo__image')
    if (!supportsWebGL2) {
      testInfo.annotations.push({
        type: 'WebGL2 unavailable',
        description: 'The animated reduced-motion transition is impossible; the personalized static fallback path is asserted instead.'
      })
      await expectSettledLoadingFailure(page, squareEffect, sceneRequests, artifacts.particle)
      await expectLoginValidation(page)
      return
    }

    await expect(field.locator('canvas')).toHaveCount(1)
    await expect(staticImage).toHaveCSS('opacity', '0')
    await expect.poll(async () => (await readLogoResourceTrace(page)).pointerListenersAdded).toBeGreaterThanOrEqual(5)
    await expect
      .poll(() => page.evaluate(() => (window as Window & { __logoParticlePerformance: { callbackCount: number } }).__logoParticlePerformance.callbackCount))
      .toBeGreaterThan(0)
    const priorTrace = await readLogoResourceTrace(page)
    const priorSceneRequestCount = sceneRequests.length
    const priorParticleRequestCount = artifacts.particle.length
    expect(priorTrace.canvasCreated).toBeGreaterThan(0)
    expect(priorTrace.webglContextRequests).toBeGreaterThan(0)
    expect(priorSceneRequestCount).toBeGreaterThan(0)
    expect(priorParticleRequestCount).toBe(1)

    await page.getByLabel('Email Address', { exact: true }).focus()
    await installReducedMotionChangeProbe(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => readReducedMotionChangeReport(page)).not.toBeNull()
    const changeReport = await readReducedMotionChangeReport(page)
    expect(changeReport).toMatchObject({
      canvasCount: 0,
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
      () => (window as Window & { __logoParticlePerformance: { callbackCount: number } }).__logoParticlePerformance.callbackCount
    )
    expect(settledPerformanceCallbackCount).toBe(changeReport?.performanceCallbackCount)
    await expectLoginValidation(page)
  })

  test('pipeline-v5 proves smaller points, stronger idle and cursor motion, delayed cascade/bounce, bounded explosions, and recovery without telemetry', async ({
    page
  }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const supportsWebGL2 = await browserSupportsWebGL2(page)
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
    if (!supportsWebGL2) {
      testInfo.annotations.push({
        type: 'WebGL2 unavailable',
        description: 'Analytic motion cannot render; faithful ordinary branding and the static treatment remain asserted.'
      })
      await expectSettledLoadingFailure(page, squareEffect, sceneRequests, artifacts.particle)
      return
    }

    await expect(canvas).toHaveCount(1)
    await expect(field.locator('.login-particle-logo__image')).toHaveCSS('opacity', '0')
    await expect.poll(async () => (await readLogoResourceTrace(page)).rafCallbacks).toBeGreaterThan(3)
    await expect.poll(() => readLogoMotion(page)).not.toBeNull()
    expect(artifacts.particle).toHaveLength(1)

    const idleMotion = await readLogoMotion(page)
    expect(idleMotion).not.toBeNull()
    expect(idleMotion?.keys).toEqual([...motionDiagnosticKeys].sort())
    expect(squareEffect.count).toBeGreaterThanOrEqual(2_000)
    expect(squareEffect.count).toBeLessThanOrEqual(8_000)
    expect(idleMotion?.diagnostics.particleCount).toBe(squareEffect.count)
    expect(idleMotion?.diagnostics.activeImpulseCount).toBe(0)
    expect(idleMotion?.diagnostics.activeExplosionCount).toBe(0)
    expect(idleMotion?.diagnostics.idleAmplitudeCss).toBeGreaterThanOrEqual(3.5)
    expect(idleMotion?.diagnostics.idleAmplitudeCss).toBeLessThanOrEqual(10)
    expect(idleMotion?.diagnostics.impulseLifetimeSeconds).toBe(1.4)
    expect(idleMotion?.diagnostics.maxImpulseTravelCss).toBe(14)
    expect(idleMotion?.diagnostics.neighborForceRatio).toBe(0.32)
    expect(idleMotion?.diagnostics.bounceRatio).toBe(0.22)
    expect(idleMotion?.diagnostics.explosionHoldSeconds).toBe(0.35)
    expect(idleMotion?.diagnostics.explosionRefillSeconds).toBe(2.4)
    expect(idleMotion?.diagnostics.explosionLifetimeSeconds).toBe(2.8)
    expect(idleMotion?.diagnostics.depthScaleMin).toBe(0.82)
    expect(idleMotion?.diagnostics.depthScaleMax).toBe(1.18)

    const fixedShaderElapsedSeconds = 5.25
    const renderedCursorMotionEpsilon = 0.000001
    const cursorImmediateDelayMs = 120
    // This fixed sample measured 2.6504 screenshot px at pixelScale ~= 0.9991.
    // The old 2.5/3.5 amplitude ratio predicts 1.893 px, leaving margin on both sides.
    const minimumRenderedIdleDisplacementCss = 2.2
    const idleAtZero = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, 0)).png)
    const idleAtLater = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds)).png)
    const idleDifference = compareFrames(idleAtZero, idleAtLater)
    expect(analyzeFrame(idleAtZero).inkRatio).toBeGreaterThan(0.002)
    expect(analyzeFrame(idleAtZero).inkRatio).toBeLessThan(0.32)
    expect(idleDifference.mean).toBeGreaterThan(0.0001)

    await page.waitForLoadState('networkidle')
    const requestCountBeforeInput = requests.length
    const bounds = await canvas.boundingBox()
    expect(bounds).not.toBeNull()
    if (!bounds) throw new Error('The animated logo has no pointer-test bounds.')
    const pointerX = bounds.x + bounds.width * 0.5
    const pointerY = bounds.y + bounds.height * 0.52
    const pixelScale = idleAtZero.width / bounds.width
    const renderedLongAxis = Math.min(bounds.width, bounds.height)
    const renderedCoreDiameter = estimateDarkCoreDiameter(idleAtZero)
    expect(renderedCoreDiameter).toBeLessThan(Math.max(1.3, renderedLongAxis * pixelScale * 0.0012))
    const idleMarker = particleFixtureSample(3)
    const idleMarkerAtZero = blueFixtureCentroid(idleAtZero, idleMarker)
    const idleMarkerAtLater = blueFixtureCentroid(idleAtLater, idleMarker)
    const renderedIdleDisplacement = Math.hypot(idleMarkerAtLater.x - idleMarkerAtZero.x, idleMarkerAtLater.y - idleMarkerAtZero.y)
    expect(renderedIdleDisplacement).toBeGreaterThan(minimumRenderedIdleDisplacementCss * pixelScale)

    const interactionClockMilliseconds = 1_000_000_000
    await page.mouse.move(pointerX - 12, pointerY)
    const cursorBefore = await decodeScreenshot(
      (await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds, interactionClockMilliseconds - 1)).png
    )
    const cursorStartedAt = interactionClockMilliseconds
    await captureLogoRenderedFrame(
      page,
      { clientX: pointerX + 30, clientY: pointerY, pointerType: 'mouse', type: 'pointermove' },
      fixedShaderElapsedSeconds,
      cursorStartedAt
    )
    const cursorImmediate = await decodeScreenshot(
      (await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds, cursorStartedAt + cursorImmediateDelayMs)).png
    )
    const influence = {
      radius: Math.min(32, Math.max(18, 0.05 * Math.max(bounds.width, bounds.height))) * (cursorImmediate.width / bounds.width),
      x: (pointerX + 30 - bounds.x) * (cursorImmediate.width / bounds.width),
      y: (pointerY - bounds.y) * (cursorImmediate.width / bounds.width)
    }
    const cursorImmediateDifference = compareFrames(cursorBefore, cursorImmediate, influence)
    expect(cursorImmediateDifference.coreMean).toBeGreaterThan(renderedCursorMotionEpsilon)
    const cascade = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds, cursorStartedAt + 420)).png)
    const cascadeDifference = compareFrames(cursorBefore, cascade, influence)
    expect(cascadeDifference.annulusMean).toBeGreaterThan(cascadeDifference.outsideMean * 1.1)
    expect(cascadeDifference.coreMean).toBeGreaterThan(renderedCursorMotionEpsilon)
    const bounceRegion = {
      radius: influence.radius * 0.42,
      x: influence.x + influence.radius * 1.2,
      y: influence.y
    }
    const maximumBounceShift = Math.max(6, Math.ceil(7 * pixelScale))
    const cascadeShift = estimateHorizontalTranslation(cursorBefore, cascade, bounceRegion, maximumBounceShift)
    const bounce = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds, cursorStartedAt + 1_100)).png)
    const bounceShift = estimateHorizontalTranslation(cursorBefore, bounce, bounceRegion, maximumBounceShift)
    expect(cascadeShift).toBeGreaterThanOrEqual(Math.max(1, Math.round(2 * pixelScale)))
    expect(bounceShift).toBeLessThanOrEqual(-Math.max(1, Math.round(pixelScale)))

    await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds, cursorStartedAt + 1_500)
    expect((await readLogoMotion(page))?.diagnostics.activeImpulseCount).toBe(0)

    const blast = async (type: 'mouse' | 'touch', startedAt: number, x = pointerX, y = pointerY): Promise<void> => {
      await captureLogoRenderedFrame(page, { clientX: x, clientY: y, pointerType: type, type: 'pointerdown' }, fixedShaderElapsedSeconds, startedAt)
      await dispatchLogoPointerEvent(page, { clientX: x, clientY: y, pointerType: type, type: 'pointerup' })
    }
    const blastStartedAt = cursorStartedAt + 5_000
    const explosionBaseline = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds, blastStartedAt - 1)).png)
    const explosionRadius = Math.min(88, Math.max(32, 0.1 * renderedLongAxis)) * pixelScale
    const explosionRegion = {
      radius: explosionRadius * 0.62,
      x: (pointerX - bounds.x) * pixelScale,
      y: (pointerY - bounds.y) * pixelScale
    }
    const explosionBaselineAppearance = analyzeRegion(explosionBaseline, explosionRegion)
    await blast('mouse', blastStartedAt)
    const oldFade = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds, blastStartedAt + 220)).png)
    expect((await readLogoMotion(page))?.diagnostics.activeExplosionCount).toBeGreaterThan(0)
    const oldFadeAppearance = analyzeRegion(oldFade, explosionRegion)
    const oldFadeDifference = compareFrames(explosionBaseline, oldFade, explosionRegion)
    expect(oldFadeAppearance.foregroundMean).toBeLessThan(explosionBaselineAppearance.foregroundMean * 0.8)
    expect(oldFadeDifference.coreMean).toBeGreaterThan(oldFadeDifference.outsideMean * 3)

    const refill = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds, blastStartedAt + 700)).png)
    const refillAppearance = analyzeRegion(refill, explosionRegion)
    const refillDifference = compareFrames(explosionBaseline, refill, explosionRegion)
    expect(refillAppearance.foregroundMean).toBeGreaterThan(oldFadeAppearance.foregroundMean * 1.2)
    expect(refillDifference.coreMean).toBeGreaterThan(refillDifference.outsideMean * 3)
    expect(refillDifference.coreMean).toBeGreaterThan(0.0001)

    const beforeExpiry = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds, blastStartedAt + 2_760)).png)
    const beforeExpiryDifference = compareFrames(explosionBaseline, beforeExpiry, explosionRegion)
    expect(beforeExpiryDifference.coreMean).toBeLessThan(refillDifference.coreMean * 0.12)
    const recovered = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds, blastStartedAt + 2_850)).png)
    const recoveryDifference = compareFrames(explosionBaseline, recovered, explosionRegion)
    expect(recoveryDifference.mean).toBeLessThan(0.00001)
    expect(recoveryDifference.coreMean).toBeLessThan(refillDifference.coreMean * 0.08)
    expect((await readLogoMotion(page))?.diagnostics.activeExplosionCount).toBe(0)

    const orderedOlderAt = blastStartedAt + 5_000
    await blast('mouse', orderedOlderAt)
    await blast('touch', orderedOlderAt + 2_560)
    const orderedLifecycle = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds, orderedOlderAt + 2_760)).png)
    expect(analyzeRegion(orderedLifecycle, explosionRegion).foregroundMean).toBeLessThan(explosionBaselineAppearance.foregroundMean * 0.9)
    await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds, orderedOlderAt + 5_500)

    const reversedOlderAt = orderedOlderAt + 7_000
    await blast('mouse', reversedOlderAt + 2_560)
    await blast('touch', reversedOlderAt)
    const reversedLifecycle = await decodeScreenshot((await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds, reversedOlderAt + 2_760)).png)
    expect(compareFrames(orderedLifecycle, reversedLifecycle, explosionRegion).mean).toBeLessThan(0.00001)
    await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds, reversedOlderAt + 5_500)

    const burstStartedAt = reversedOlderAt + 7_000
    for (let index = 0; index < 8; index += 1) {
      await blast(index % 2 === 0 ? 'mouse' : 'touch', burstStartedAt + index, pointerX + index, pointerY)
    }
    expect((await readLogoMotion(page))?.diagnostics.activeExplosionCount).toBe(6)
    await captureLogoRenderedFrame(page, undefined, fixedShaderElapsedSeconds, burstStartedAt + 2_900)
    expect((await readLogoMotion(page))?.diagnostics.activeExplosionCount).toBe(0)
    await blast('touch', burstStartedAt + 3_000)
    expect((await readLogoMotion(page))?.diagnostics.activeExplosionCount).toBeGreaterThan(0)
    await dispatchLogoPointerEvent(page, { clientX: pointerX, clientY: pointerY, pointerType: 'touch', type: 'pointercancel' })
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

  test('restores static treatment synchronously after WebGL context loss without moving auth focus', async ({ page }, testInfo) => {
    requireProjectRow(testInfo, ELIGIBLE_DESKTOP_PROJECTS)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const supportsWebGL2 = await browserSupportsWebGL2(page)
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
    if (!supportsWebGL2) {
      testInfo.annotations.push({
        type: 'WebGL2 unavailable',
        description: 'A WebGL context-loss event cannot exist; the personalized static fallback and authentication path are asserted instead.'
      })
      await expectSettledLoadingFailure(page, squareEffect, sceneRequests, artifacts.particle)
      await expectLoginValidation(page)
      return
    }

    await expect(canvas).toHaveCount(1)
    await expect(staticImage).toHaveCSS('opacity', '0')
    const email = page.getByLabel('Email Address', { exact: true })
    await email.focus()

    await canvas.dispatchEvent('webglcontextlost', { cancelable: true })
    await expect(staticImage).toHaveCSS('opacity', '1')
    await expect(canvas).toHaveCount(0)
    await expect(email).toBeFocused()
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
    const supportsWebGL2 = await browserSupportsWebGL2(page)
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
    if (supportsWebGL2) {
      await expect(canvas).toHaveCount(1)
      await expect.poll(() => artifacts.particle.length).toBe(1)
    } else {
      await expectSettledLoadingFailure(page, squareEffect, sceneRequests, artifacts.particle)
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
    expect(externalRequests).toEqual([])

    await page.waitForLoadState('networkidle')
    const requestCountBeforePointer = allRequests.length
    const pointerTarget = supportsWebGL2 ? canvas : field
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
