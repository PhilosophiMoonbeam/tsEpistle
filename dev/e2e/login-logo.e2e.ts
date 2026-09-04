import { Buffer } from 'node:buffer'
import { expect } from '@playwright/test'
import type { Locator, Page, Request, TestInfo } from '@playwright/test'
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
  width: 8,
  height: 8,
  aspect: 1,
  count: 2,
  medianStroke: 2,
  auraColor: '#336699'
}

const wideEffect = {
  logoUrl: LOGO_URL,
  particleUrl: WIDE_PARTICLE_URL,
  staticUrl: WIDE_STATIC_URL,
  width: 1200,
  height: 100,
  aspect: 12,
  count: 2,
  medianStroke: 12
}

type ManagedEffect = typeof squareEffect | typeof wideEffect

const particleFixture = Buffer.from(
  '545345500107380008000000080000000200000018000000cf8f46fd3800000040000000420000004a0000004c000000500000000000000025c94912db36b7eded4ddc283cc81e6edca05578d20431d4',
  'hex'
)

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

function svgFixture(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g><rect x="${width * 0.1}" y="${height * 0.2}" width="${width * 0.25}" height="${height * 0.6}" rx="${Math.min(width, height) * 0.08}" fill="#36a3d9"/><circle cx="${width * 0.52}" cy="${height * 0.5}" r="${Math.min(width, height) * 0.24}" fill="#101010"/><rect x="${width * 0.7}" y="${height * 0.25}" width="${width * 0.2}" height="${height * 0.5}" fill="#f8f8f8"/><circle cx="${width * 0.06}" cy="${height * 0.12}" r="${Math.min(width, height) * 0.035}" fill="#e8538a"/></g></svg>`
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

  const image = svgFixture(effect.width, effect.height)
  const requests: ArtifactRequests = { logo: [], particle: [], static: [] }
  await page.route(`**${effect.logoUrl}`, route => {
    requests.logo.push(route.request())
    return route.fulfill({
      status: options.logoStatus ?? 200,
      contentType: 'image/svg+xml',
      body: options.logoBody ?? image
    })
  })
  await page.route(`**${effect.staticUrl}`, route => {
    requests.static.push(route.request())
    return route.fulfill({
      status: options.staticStatus ?? 200,
      contentType: 'image/svg+xml',
      body: options.staticBody ?? image
    })
  })
  await page.route(`**${effect.particleUrl}`, route => {
    requests.particle.push(route.request())
    return route.fulfill({
      status: options.particleStatus ?? 200,
      contentType: 'application/octet-stream',
      body: options.particleBody ?? particleFixture
    })
  })
  return requests
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
      __logoParticlePerformance: {
        callbackCount: number
        callbackCpuMilliseconds: number[]
        frameIntervalsMilliseconds: number[]
        firstFrameMilliseconds: number | null
        lastFrameAt: number | null
      }
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
      if ((type === 'pointermove' || type === 'pointerleave') && this instanceof Element && this.classList.contains('login-particle-logo')) {
        trace.pointerListenersAdded += 1
      }
      nativeAddEventListener.call(this, type, callback, options)
    }
    EventTarget.prototype.removeEventListener = function (
      type: string,
      callback: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions
    ): void {
      if ((type === 'pointermove' || type === 'pointerleave') && this instanceof Element && this.classList.contains('login-particle-logo')) {
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

async function assertTransparentSourceIdentity(image: Locator): Promise<void> {
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
    let sourceBlue = 0
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const red = pixels[offset] ?? 0
      const green = pixels[offset + 1] ?? 0
      const blue = pixels[offset + 2] ?? 0
      const alpha = pixels[offset + 3] ?? 0
      if (alpha > 240) opaque += 1
      if (alpha > 240 && red < 32 && green < 32 && blue < 32) nearBlack += 1
      if (alpha > 240 && red > 235 && green > 235 && blue > 235) nearWhite += 1
      if (alpha > 240 && blue > 170 && green > 120 && red < 90) sourceBlue += 1
    }
    const pixelCount = canvas.width * canvas.height
    return {
      cornerAlpha: [
        pixels[3],
        pixels[(canvas.width - 1) * 4 + 3],
        pixels[(canvas.height - 1) * canvas.width * 4 + 3],
        pixels[(canvas.height * canvas.width - 1) * 4 + 3]
      ],
      nearBlackRatio: opaque === 0 ? 0 : nearBlack / opaque,
      nearWhiteRatio: opaque === 0 ? 0 : nearWhite / opaque,
      opaqueRatio: opaque / pixelCount,
      sourceBlueRatio: opaque === 0 ? 0 : sourceBlue / opaque
    }
  })
  expect(sample).not.toBeNull()
  expect(sample?.cornerAlpha.every(alpha => (alpha ?? 255) < 16)).toBe(true)
  expect(sample?.opaqueRatio).toBeGreaterThan(0.02)
  expect(sample?.nearBlackRatio).toBeGreaterThan(0.002)
  expect(sample?.nearWhiteRatio).toBeGreaterThan(0.01)
  expect(sample?.sourceBlueRatio).toBeGreaterThan(0.01)
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
          await assertTransparentSourceIdentity(ordinaryLogo)
          await assertTransparentSourceIdentity(staticImage)
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
    await expect.poll(async () => (await readLogoResourceTrace(page)).pointerListenersAdded).toBeGreaterThanOrEqual(2)
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
