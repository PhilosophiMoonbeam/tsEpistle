import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { errors, expect, test } from '@playwright/test'

const outputPath = process.env.LOGO_PARTICLE_PERFORMANCE_FILE ?? 'logo-particle-performance.json'
const viewport = { width: 1440, height: 900 }
const deviceScaleFactor = 1.5
const firstFrameRuns = 20
const coldContextTeardownSettleMilliseconds = 250
const firstFrameTimeoutMilliseconds = 2_000
const warmUpMilliseconds = 2_000
const animationSampleMilliseconds = 10_000
const inactivitySampleMilliseconds = 2_000
const animationInputCadenceMilliseconds = 200
const animationInputSegmentCss = 20
const animationInputPrimeSegmentCount = 4
const animationExplosionCadenceMilliseconds = 700
const explosionRecoveryMilliseconds = 2_900
const diagnosticFrameSynchronizationTimeoutMilliseconds = 250

const thresholds = {
  activeExplosionMaximum: 6,
  activeImpulseMaximum: 6,
  animatedFrameP95Milliseconds: 20,
  animatedFrameP99Milliseconds: 34,
  animatedFrameMinimumCoverageMilliseconds: 9_000,
  animatedFrameMinimumIntervalSamples: 250,
  callbackCpuP95Milliseconds: 2,
  depthScaleMax: 1.18,
  depthScaleMin: 0.82,
  bounceRatio: 0.22,
  explosionHoldSeconds: 0.35,
  explosionLifetimeSeconds: 2.8,
  explosionRefillSeconds: 2.4,
  firstFrameP95Milliseconds: 1_500,
  hardIneligibleCanvasCount: 0,
  idleAmplitudeMaximumCss: 10,
  idleAmplitudeMinimumCss: 3.5,
  inactiveCallbackCount: 0,
  impulseLifetimeSeconds: 1.4,
  maxImpulseTravelCss: 14,
  neighborForceRatio: 0.32,
  retainedCanvasCount: 1,
  parserParticleMaximum: 16_000,
  timeouts: 0
} as const

const logoUrl = `/_site-logo/${'1'.repeat(64)}/logo.png`
const particleUrl = `/_site-logo/${'2'.repeat(64)}/particle.bin`
const staticUrl = `/_site-logo/${'3'.repeat(64)}/effect.png`
// This fixture intentionally exercises the parser's 16,000-record ceiling;
// it is a performance stress input, not a generated-density expectation.
const descriptor = {
  logoUrl,
  particleUrl,
  staticUrl,
  pipelineVersion: 5,
  width: 1_024,
  height: 1_024,
  aspect: 1,
  count: 16_000,
  medianStroke: 24,
  auraColor: '#336699'
}
const logoFixture =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect x="64" y="64" width="896" height="896" rx="128" fill="#e8538a"/><circle cx="512" cy="512" r="300" fill="#36a3d9"/></svg>'
const staticFixture =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><circle cx="512" cy="512" r="448" fill="#336699"/><path d="M256 512h512M512 256v512" stroke="#fff" stroke-width="48"/></svg>'

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

interface BenchmarkState {
  callbackCount: number
  callbackCpuMilliseconds: number[]
  frameIntervalsMilliseconds: number[]
  firstFrameMilliseconds: number | null
  lastFrameAt: number | null
  lastMotion?: LogoMotionDiagnostics
  maximumActiveExplosionCount: number
  maximumActiveImpulseCount: number
}

interface BenchmarkMeasurement extends BenchmarkState {
  readonly lastMotionKeys: string[] | null
}

interface BenchmarkWindow extends Window {
  __logoParticlePerformance: BenchmarkState
  __setLogoParticleVisibility: (visibility: DocumentVisibilityState) => void
}

interface SynchronizedMotionSample {
  readonly activeExplosionCount: number | null
  readonly activeImpulseCount: number | null
  readonly frameAdvanced: boolean
}

interface AnimationInputMeasurement {
  readonly cadenceMilliseconds: number
  readonly diagnosticFrameSampleFailures: number
  readonly maximumSynchronizedActiveImpulseCount: number
  readonly segmentCount: number
  readonly segmentCss: number
}

interface Violation {
  invariant: string
  measured: number | null
  threshold: number
}

interface InactivityMeasurement {
  callbackCount: number
  callbackCpuMilliseconds: number[]
  canvasCount: number
  durationMilliseconds: number
}

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

function createParticleFixture(): Buffer {
  const headerBytes = 56
  const count = descriptor.count
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
  bytes.writeUInt32LE(descriptor.width, 8)
  bytes.writeUInt32LE(descriptor.height, 12)
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

  for (let index = 0; index < count; index += 1) {
    const angle = (index * 2 * Math.PI) / count
    const radius = 0.2 + 0.75 * ((index % 251) / 250)
    bytes.writeInt16LE(Math.round(Math.cos(angle) * radius * 32_767), xyOffset + index * 4)
    bytes.writeInt16LE(Math.round(Math.sin(angle) * radius * 32_767), xyOffset + index * 4 + 2)
    bytes.writeInt8((index % 255) - 127, depthOffset + index)
    bytes[rgbaOffset + index * 4] = 51 + (index % 48)
    bytes[rgbaOffset + index * 4 + 1] = 102 + (index % 48)
    bytes[rgbaOffset + index * 4 + 2] = 153 + (index % 48)
    bytes[rgbaOffset + index * 4 + 3] = 255
    bytes[sizeOffset + index] = 4 + (index % 12)
    bytes.writeUInt16LE((index % 65_535) + 1, seedOffset + index * 2)
  }
  bytes.writeUInt32LE(crc32(bytes.subarray(headerBytes)), 24)
  return bytes
}

const particleFixture = createParticleFixture()

function nearestRank(samples: readonly number[], percentile: number): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(percentile * sorted.length) - 1] ?? null
}

function writeReportAtomically(report: object): void {
  const directory = path.dirname(outputPath)
  fs.mkdirSync(directory, { recursive: true })
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    fs.renameSync(temporaryPath, outputPath)
  } catch (error: unknown) {
    fs.rmSync(temporaryPath, { force: true })
    throw error
  }
}

async function createMeasuredPage(browser: Browser, measuredViewport = viewport): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    deviceScaleFactor,
    reducedMotion: 'no-preference',
    viewport: measuredViewport
  })
  const page = await context.newPage()
  await page.addInitScript(managedDescriptor => {
    const benchmark: BenchmarkState = {
      callbackCount: 0,
      callbackCpuMilliseconds: [],
      frameIntervalsMilliseconds: [],
      firstFrameMilliseconds: null,
      lastFrameAt: null,
      maximumActiveExplosionCount: 0,
      maximumActiveImpulseCount: 0
    }
    let lastMotion: LogoMotionDiagnostics | undefined
    Object.defineProperty(benchmark, 'lastMotion', {
      configurable: true,
      get: () => lastMotion,
      set: (motion: LogoMotionDiagnostics | undefined) => {
        lastMotion = motion
        if (!motion) return
        let activeExplosionCount = motion.activeExplosionCount
        let activeImpulseCount = motion.activeImpulseCount
        Object.defineProperties(motion, {
          activeExplosionCount: {
            configurable: true,
            enumerable: true,
            get: () => activeExplosionCount,
            set: (count: number) => {
              activeExplosionCount = count
              benchmark.maximumActiveExplosionCount = Math.max(benchmark.maximumActiveExplosionCount, count)
            }
          },
          activeImpulseCount: {
            configurable: true,
            enumerable: true,
            get: () => activeImpulseCount,
            set: (count: number) => {
              activeImpulseCount = count
              benchmark.maximumActiveImpulseCount = Math.max(benchmark.maximumActiveImpulseCount, count)
            }
          }
        })
      }
    })
    const benchmarkWindow = window as BenchmarkWindow
    benchmarkWindow.__logoParticlePerformance = benchmark

    let visibility: DocumentVisibilityState = 'visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility
    })
    benchmarkWindow.__setLogoParticleVisibility = nextVisibility => {
      visibility = nextVisibility
      document.dispatchEvent(new Event('visibilitychange'))
    }

    let currentConfig: unknown
    Object.defineProperty(window, 'siteConfig', {
      configurable: true,
      get: () => currentConfig,
      set: value => {
        if (value && typeof value === 'object') {
          const config = value as Record<string, unknown>
          config.logoUrl = managedDescriptor.logoUrl
          config.logoEffect = managedDescriptor
        }
        currentConfig = value
      }
    })
  }, descriptor)
  await page.route(`**${logoUrl}`, route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: logoFixture }))
  await page.route(`**${staticUrl}`, route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: staticFixture }))
  await page.route(`**${particleUrl}`, route => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: particleFixture }))
  return { context, page }
}

async function waitForFirstFrame(page: Page): Promise<number> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => {
      const benchmark = (window as BenchmarkWindow).__logoParticlePerformance
      return typeof benchmark?.firstFrameMilliseconds === 'number'
    },
    undefined,
    { timeout: firstFrameTimeoutMilliseconds }
  )
  return page.evaluate(() => {
    const firstFrame = (window as BenchmarkWindow).__logoParticlePerformance.firstFrameMilliseconds
    if (firstFrame === null) throw new Error('Particle first frame was not recorded')
    return firstFrame
  })
}

async function resetMeasurements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const benchmark = (window as BenchmarkWindow).__logoParticlePerformance
    benchmark.callbackCount = 0
    benchmark.callbackCpuMilliseconds.length = 0
    benchmark.frameIntervalsMilliseconds.length = 0
    benchmark.lastFrameAt = null
    benchmark.maximumActiveExplosionCount = 0
    benchmark.maximumActiveImpulseCount = 0
  })
}

async function readMeasurements(page: Page): Promise<BenchmarkMeasurement> {
  return page.evaluate(() => {
    const benchmark = (window as BenchmarkWindow).__logoParticlePerformance
    return {
      callbackCount: benchmark.callbackCount,
      callbackCpuMilliseconds: [...benchmark.callbackCpuMilliseconds],
      frameIntervalsMilliseconds: [...benchmark.frameIntervalsMilliseconds],
      firstFrameMilliseconds: benchmark.firstFrameMilliseconds,
      lastFrameAt: benchmark.lastFrameAt,
      lastMotion: benchmark.lastMotion ? { ...benchmark.lastMotion } : undefined,
      lastMotionKeys: benchmark.lastMotion ? Object.keys(benchmark.lastMotion).sort() : null,
      maximumActiveExplosionCount: benchmark.maximumActiveExplosionCount,
      maximumActiveImpulseCount: benchmark.maximumActiveImpulseCount
    }
  })
}

async function primeAnimationInput(page: Page): Promise<number> {
  const bounds = await page.locator('.login-particle-logo canvas').boundingBox()
  if (!bounds) throw new Error('Particle canvas is unavailable for animation input')
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const startX = centerX - animationInputSegmentCss / 2
  const endX = centerX + animationInputSegmentCss / 2
  if (startX < bounds.x || endX > bounds.x + bounds.width || centerY < bounds.y || centerY > bounds.y + bounds.height)
    throw new Error('Animation input segment does not fit inside the particle canvas')
  await dispatchPerformancePointerEvent(page, 'pointermove', startX, centerY)
  for (let segment = 0; segment < animationInputPrimeSegmentCount; segment += 1) {
    await dispatchPerformancePointerEvent(page, 'pointermove', segment % 2 === 0 ? endX : startX, centerY)
  }
  return animationInputPrimeSegmentCount
}

interface PerformancePointerDispatch {
  readonly clientX: number
  readonly clientY: number
  readonly type: 'pointerdown' | 'pointermove' | 'pointerup'
}

async function readMotionAfterRenderedFrame(
  page: Page,
  pointerEvent: PerformancePointerDispatch | null = null,
  synchronize = true
): Promise<SynchronizedMotionSample> {
  return page.evaluate(
    async ({ pointerEvent, synchronize, timeoutMilliseconds }) => {
      const benchmark = (window as BenchmarkWindow).__logoParticlePerformance
      const previousFrameAt = benchmark.lastFrameAt
      if (pointerEvent) {
        const field = document.querySelector('.login-particle-logo')
        if (!(field instanceof HTMLElement)) throw new Error('Particle field is unavailable for input.')
        field.dispatchEvent(
          new PointerEvent(pointerEvent.type, {
            bubbles: true,
            clientX: pointerEvent.clientX,
            clientY: pointerEvent.clientY,
            isPrimary: true,
            pointerType: 'mouse'
          })
        )
      }
      if (!synchronize) {
        return {
          activeExplosionCount: benchmark.lastMotion?.activeExplosionCount ?? null,
          activeImpulseCount: benchmark.lastMotion?.activeImpulseCount ?? null,
          frameAdvanced: false
        }
      }

      return new Promise<SynchronizedMotionSample>(resolve => {
        let animationFrameId: number | null = null
        let settled = false
        const finish = (frameAdvanced: boolean): void => {
          if (settled) return
          settled = true
          window.clearTimeout(timeoutId)
          if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId)
          const motion = frameAdvanced ? benchmark.lastMotion : undefined
          resolve({
            activeExplosionCount: motion?.activeExplosionCount ?? null,
            activeImpulseCount: motion?.activeImpulseCount ?? null,
            frameAdvanced
          })
        }
        const pollFrame = (): void => {
          animationFrameId = null
          if (benchmark.lastFrameAt !== previousFrameAt) {
            finish(true)
            return
          }
          animationFrameId = window.requestAnimationFrame(pollFrame)
        }
        const timeoutId = window.setTimeout(() => finish(false), timeoutMilliseconds)
        animationFrameId = window.requestAnimationFrame(pollFrame)
      })
    },
    { pointerEvent, synchronize, timeoutMilliseconds: diagnosticFrameSynchronizationTimeoutMilliseconds }
  )
}

async function dispatchPerformancePointerEvent(
  page: Page,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number
): Promise<SynchronizedMotionSample> {
  return readMotionAfterRenderedFrame(page, { clientX, clientY, type })
}

async function driveAnimationInput(page: Page): Promise<AnimationInputMeasurement> {
  const bounds = await page.locator('.login-particle-logo canvas').boundingBox()
  if (!bounds) throw new Error('Particle canvas is unavailable for animation input')
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const startX = centerX - animationInputSegmentCss / 2
  const endX = centerX + animationInputSegmentCss / 2
  if (startX < bounds.x || endX > bounds.x + bounds.width || centerY < bounds.y || centerY > bounds.y + bounds.height)
    throw new Error('Animation input segment does not fit inside the particle canvas')

  let diagnosticFrameSampleFailures = 0
  const initialMotion = await dispatchPerformancePointerEvent(page, 'pointermove', startX, centerY)
  if (!initialMotion.frameAdvanced || initialMotion.activeImpulseCount === null) diagnosticFrameSampleFailures += 1
  let maximumSynchronizedActiveImpulseCount = initialMotion.activeImpulseCount ?? 0
  let segmentCount = 0
  let nextX = endX
  const segmentTotal = Math.ceil(animationSampleMilliseconds / animationInputCadenceMilliseconds)
  const inputStartedAt = Date.now()
  for (let segment = 0; segment < segmentTotal; segment += 1) {
    const pointerMotion = await dispatchPerformancePointerEvent(page, 'pointermove', nextX, centerY)
    if (!pointerMotion.frameAdvanced || pointerMotion.activeImpulseCount === null) diagnosticFrameSampleFailures += 1
    maximumSynchronizedActiveImpulseCount = Math.max(maximumSynchronizedActiveImpulseCount, pointerMotion.activeImpulseCount ?? 0)
    segmentCount += 1
    if (segment % Math.max(1, Math.round(animationExplosionCadenceMilliseconds / animationInputCadenceMilliseconds)) === 0) {
      const explosionMotion = await dispatchPerformancePointerEvent(page, 'pointerdown', nextX, centerY)
      if (!explosionMotion.frameAdvanced || explosionMotion.activeExplosionCount === null || explosionMotion.activeImpulseCount === null) {
        diagnosticFrameSampleFailures += 1
      }
      await dispatchPerformancePointerEvent(page, 'pointerup', nextX, centerY)
    }
    nextX = nextX === endX ? startX : endX
    if (segment + 1 < segmentTotal) {
      const delayMilliseconds = inputStartedAt + (segment + 1) * animationInputCadenceMilliseconds - Date.now()
      if (delayMilliseconds > 0) await page.waitForTimeout(delayMilliseconds)
    }
  }
  return {
    cadenceMilliseconds: animationInputCadenceMilliseconds,
    diagnosticFrameSampleFailures,
    maximumSynchronizedActiveImpulseCount,
    segmentCount,
    segmentCss: animationInputSegmentCss
  }
}
async function measureHidden(page: Page): Promise<InactivityMeasurement> {
  await page.evaluate(() => {
    const benchmarkWindow = window as BenchmarkWindow
    benchmarkWindow.__setLogoParticleVisibility('hidden')
    const benchmark = benchmarkWindow.__logoParticlePerformance
    benchmark.callbackCount = 0
    benchmark.callbackCpuMilliseconds.length = 0
    benchmark.frameIntervalsMilliseconds.length = 0
    benchmark.lastFrameAt = null
  })
  await page.waitForTimeout(inactivitySampleMilliseconds)
  const measurement = await readMeasurements(page)
  return {
    callbackCount: measurement.callbackCount,
    callbackCpuMilliseconds: measurement.callbackCpuMilliseconds,
    canvasCount: await page.locator('.login-particle-logo canvas').count(),
    durationMilliseconds: inactivitySampleMilliseconds
  }
}

async function measureOffscreen(page: Page): Promise<InactivityMeasurement> {
  await page.evaluate(() => {
    const benchmarkWindow = window as BenchmarkWindow
    benchmarkWindow.__setLogoParticleVisibility('visible')
    const login = document.querySelector('.login')
    if (!(login instanceof HTMLElement)) throw new Error('Login surface is unavailable')
    login.style.transform = 'translateX(-200vw)'
  })
  await page.waitForTimeout(250)
  await resetMeasurements(page)
  await page.waitForTimeout(inactivitySampleMilliseconds)
  const measurement = await readMeasurements(page)
  return {
    callbackCount: measurement.callbackCount,
    callbackCpuMilliseconds: measurement.callbackCpuMilliseconds,
    canvasCount: await page.locator('.login-particle-logo canvas').count(),
    durationMilliseconds: inactivitySampleMilliseconds
  }
}

function addExactViolation(violations: Violation[], invariant: string, measured: number | null, expected: number): void {
  if (measured === null || !Number.isFinite(measured) || measured !== expected) {
    violations.push({ invariant, measured, threshold: expected })
  }
}

function addMinimumViolation(violations: Violation[], invariant: string, measured: number | null, minimum: number): void {
  if (measured === null || !Number.isFinite(measured) || measured < minimum) {
    violations.push({ invariant, measured, threshold: minimum })
  }
}

function addMaximumViolation(violations: Violation[], invariant: string, measured: number | null, maximum: number): void {
  if (measured === null || !Number.isFinite(measured) || measured > maximum) {
    violations.push({ invariant, measured, threshold: maximum })
  }
}

function addRangeViolation(violations: Violation[], invariant: string, measured: number | null, minimum: number, maximum: number): void {
  if (measured === null || !Number.isFinite(measured) || measured < minimum || measured > maximum) {
    violations.push({ invariant, measured, threshold: maximum })
  }
}

test('enforces pipeline-v5 managed login particle runtime budgets with bounded explosions', async ({ browser, browserName }, testInfo) => {
  test.skip(testInfo.project.name !== 'performance-desktop', 'Measured only by the performance-desktop project')
  test.setTimeout(120_000)

  const firstFrameSamplesMilliseconds: number[] = []
  let firstFrameTimeouts = 0
  for (let run = 0; run < firstFrameRuns; run += 1) {
    const { context, page } = await createMeasuredPage(browser)
    try {
      firstFrameSamplesMilliseconds.push(await waitForFirstFrame(page))
    } catch (error: unknown) {
      if (!(error instanceof errors.TimeoutError)) throw error
      firstFrameTimeouts += 1
    } finally {
      await context.close()
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, coldContextTeardownSettleMilliseconds)
      await promise
    }
  }

  const { context, page } = await createMeasuredPage(browser)
  let animation: BenchmarkMeasurement = {
    callbackCount: 0,
    callbackCpuMilliseconds: [],
    frameIntervalsMilliseconds: [],
    firstFrameMilliseconds: null,
    lastFrameAt: null,
    lastMotionKeys: null,
    maximumActiveExplosionCount: 0,
    maximumActiveImpulseCount: 0
  }
  let animationInput = {
    cadenceMilliseconds: animationInputCadenceMilliseconds,
    diagnosticFrameSampleFailures: 0,
    maximumSynchronizedActiveImpulseCount: 0,
    segmentCount: 0,
    segmentCss: animationInputSegmentCss,
    primeSegmentCount: animationInputPrimeSegmentCount
  }
  let animationSetupTimeouts = 0
  let hidden: InactivityMeasurement
  let offscreen: InactivityMeasurement
  let recoveredActiveExplosions: number | null = null
  let recoveryDiagnosticFrameSampleFailures = 0
  let actualDeviceScaleFactor = deviceScaleFactor
  let actualViewport = { width: 0, height: 0 }
  try {
    try {
      await waitForFirstFrame(page)
    } catch (error: unknown) {
      if (!(error instanceof errors.TimeoutError)) throw error
      animationSetupTimeouts += 1
    }
    await page.waitForTimeout(warmUpMilliseconds)
    const animationInputPrimeSegments = await primeAnimationInput(page)
    await resetMeasurements(page)
    const animationInputPromise = driveAnimationInput(page)
    await page.waitForTimeout(animationSampleMilliseconds)
    animation = await readMeasurements(page)
    animationInput = {
      ...(await animationInputPromise),
      primeSegmentCount: animationInputPrimeSegments
    }
    await page.waitForTimeout(explosionRecoveryMilliseconds)
    const recoveryMotion = await readMotionAfterRenderedFrame(page)
    if (!recoveryMotion.frameAdvanced || recoveryMotion.activeExplosionCount === null) recoveryDiagnosticFrameSampleFailures += 1
    else recoveredActiveExplosions = recoveryMotion.activeExplosionCount
    actualDeviceScaleFactor = await page.evaluate(() => window.devicePixelRatio)
    hidden = await measureHidden(page)
    actualViewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    offscreen = await measureOffscreen(page)
  } finally {
    await context.close()
  }

  const ineligible = await createMeasuredPage(browser, { width: 959, height: viewport.height })
  let hardIneligibleCanvasCount: number
  let hardIneligibleCallbackCount: number
  try {
    await ineligible.page.goto('/login', { waitUntil: 'domcontentloaded' })
    await ineligible.page.locator('form.login-form').waitFor({ state: 'visible' })
    await ineligible.page.waitForTimeout(500)
    hardIneligibleCanvasCount = await ineligible.page.locator('.login-particle-logo canvas').count()
    hardIneligibleCallbackCount = (await readMeasurements(ineligible.page)).callbackCount
  } finally {
    await ineligible.context.close()
  }

  const firstFrameP95Milliseconds = nearestRank(firstFrameSamplesMilliseconds, 0.95)
  const animatedFrameCoverageMilliseconds = animation.frameIntervalsMilliseconds.reduce((total, interval) => total + interval, 0)
  const animatedFrameP95Milliseconds = nearestRank(animation.frameIntervalsMilliseconds, 0.95)
  const animatedFrameP99Milliseconds = nearestRank(animation.frameIntervalsMilliseconds, 0.99)
  const callbackCpuP95Milliseconds = nearestRank(animation.callbackCpuMilliseconds, 0.95)
  const violations: Violation[] = []
  addExactViolation(violations, 'firstFrame.timeouts === 0', firstFrameTimeouts, thresholds.timeouts)
  addExactViolation(violations, 'firstFrame.samples.length === 20', firstFrameSamplesMilliseconds.length, firstFrameRuns)
  addMaximumViolation(violations, 'firstFrame.nearestRankP95Milliseconds <= 1500', firstFrameP95Milliseconds, thresholds.firstFrameP95Milliseconds)
  addMinimumViolation(
    violations,
    'animation.frameIntervalSampleCount >= 250',
    animation.frameIntervalsMilliseconds.length,
    thresholds.animatedFrameMinimumIntervalSamples
  )
  addMinimumViolation(
    violations,
    'animation.frameCoverageMilliseconds >= 9000',
    animatedFrameCoverageMilliseconds,
    thresholds.animatedFrameMinimumCoverageMilliseconds
  )
  addMaximumViolation(violations, 'animation.frameNearestRankP95Milliseconds <= 20', animatedFrameP95Milliseconds, thresholds.animatedFrameP95Milliseconds)
  addMaximumViolation(violations, 'animation.frameNearestRankP99Milliseconds <= 34', animatedFrameP99Milliseconds, thresholds.animatedFrameP99Milliseconds)
  addMaximumViolation(violations, 'animation.callbackCpuNearestRankP95Milliseconds <= 2', callbackCpuP95Milliseconds, thresholds.callbackCpuP95Milliseconds)
  addExactViolation(violations, 'animation.setupTimeouts === 0', animationSetupTimeouts, thresholds.timeouts)
  addExactViolation(
    violations,
    'animation.diagnosticFrameSampleFailures === 0',
    animationInput.diagnosticFrameSampleFailures + recoveryDiagnosticFrameSampleFailures,
    thresholds.timeouts
  )
  addExactViolation(violations, 'hidden.callbackCount === 0', hidden.callbackCount, thresholds.inactiveCallbackCount)
  addExactViolation(violations, 'hidden.canvasCount === 1', hidden.canvasCount, thresholds.retainedCanvasCount)
  addExactViolation(violations, 'offscreen.callbackCount === 0', offscreen.callbackCount, thresholds.inactiveCallbackCount)
  addExactViolation(violations, 'offscreen.canvasCount === 1', offscreen.canvasCount, thresholds.retainedCanvasCount)
  addExactViolation(violations, 'hardIneligible.canvasCount === 0', hardIneligibleCanvasCount, thresholds.hardIneligibleCanvasCount)
  const motion = animation.lastMotion
  addExactViolation(violations, 'animation.lastMotion is present', motion ? 1 : 0, 1)
  addExactViolation(
    violations,
    'animation.lastMotion publishes only bounded aggregate keys',
    JSON.stringify(animation.lastMotionKeys) === JSON.stringify(motionDiagnosticKeys) ? 1 : 0,
    1
  )
  addMinimumViolation(violations, 'animation.input.peakActiveExplosions >= 1', animation.maximumActiveExplosionCount, 1)
  addMaximumViolation(violations, 'animation.input.peakActiveExplosions <= 6', animation.maximumActiveExplosionCount, thresholds.activeExplosionMaximum)
  addExactViolation(
    violations,
    'animation.input.synchronizedPeakActiveImpulses === 6',
    animationInput.maximumSynchronizedActiveImpulseCount,
    thresholds.activeImpulseMaximum
  )
  if (motion) {
    addMaximumViolation(violations, 'animation.lastMotion.particleCount <= parser maximum 16000', motion.particleCount, thresholds.parserParticleMaximum)
    addRangeViolation(
      violations,
      'animation.lastMotion.idleAmplitudeCss is within 3.5..10',
      motion.idleAmplitudeCss,
      thresholds.idleAmplitudeMinimumCss,
      thresholds.idleAmplitudeMaximumCss
    )
    addExactViolation(violations, 'animation.lastMotion.impulseLifetimeSeconds === 1.4', motion.impulseLifetimeSeconds, thresholds.impulseLifetimeSeconds)
    addExactViolation(violations, 'animation.lastMotion.maxImpulseTravelCss === 14', motion.maxImpulseTravelCss, thresholds.maxImpulseTravelCss)
    addExactViolation(violations, 'animation.lastMotion.neighborForceRatio === 0.32', motion.neighborForceRatio, thresholds.neighborForceRatio)
    addExactViolation(violations, 'animation.lastMotion.bounceRatio === 0.22', motion.bounceRatio, thresholds.bounceRatio)
    addExactViolation(violations, 'animation.lastMotion.explosionHoldSeconds === 0.35', motion.explosionHoldSeconds, thresholds.explosionHoldSeconds)
    addExactViolation(violations, 'animation.lastMotion.explosionRefillSeconds === 2.4', motion.explosionRefillSeconds, thresholds.explosionRefillSeconds)
    addExactViolation(violations, 'animation.lastMotion.explosionLifetimeSeconds === 2.8', motion.explosionLifetimeSeconds, thresholds.explosionLifetimeSeconds)
    addExactViolation(violations, 'animation.lastMotion depth diagnostics are ordered', motion.depthScaleMin < motion.depthScaleMax ? 1 : 0, 1)
  }
  addExactViolation(violations, 'animation.explosions recovered to zero', recoveredActiveExplosions, 0)

  const report = {
    schemaVersion: 1,
    status: violations.length === 0 ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    environment: {
      browser: browserName,
      browserVersion: browser.version(),
      viewport: actualViewport,
      deviceScaleFactor: actualDeviceScaleFactor
    },
    fixture: {
      descriptor,
      particleBinaryBytes: particleFixture.byteLength
    },
    thresholds,
    firstFrame: {
      coldCache: true,
      timeoutMilliseconds: firstFrameTimeoutMilliseconds,
      runs: firstFrameRuns,
      timeouts: firstFrameTimeouts,
      samplesMilliseconds: firstFrameSamplesMilliseconds,
      nearestRankP95Milliseconds: firstFrameP95Milliseconds
    },
    animation: {
      warmUpMilliseconds,
      setupTimeouts: animationSetupTimeouts,
      sampleDurationMilliseconds: animationSampleMilliseconds,
      inputCadenceMilliseconds: animationInput.cadenceMilliseconds,
      inputSegmentCss: animationInput.segmentCss,
      inputSegmentCount: animationInput.segmentCount,
      inputPrimeSegmentCount: animationInput.primeSegmentCount,
      peakActiveExplosions: animation.maximumActiveExplosionCount,
      peakActiveImpulses: animation.maximumActiveImpulseCount,
      synchronizedPeakActiveImpulses: animationInput.maximumSynchronizedActiveImpulseCount,
      diagnosticFrameSynchronizationTimeoutMilliseconds,
      diagnosticFrameSampleFailures: animationInput.diagnosticFrameSampleFailures + recoveryDiagnosticFrameSampleFailures,
      explosionRecoveryMilliseconds,
      recoveredActiveExplosions,
      frameIntervalsMilliseconds: animation.frameIntervalsMilliseconds,
      frameIntervalSampleCount: animation.frameIntervalsMilliseconds.length,
      frameCoverageMilliseconds: animatedFrameCoverageMilliseconds,
      frameNearestRankP95Milliseconds: animatedFrameP95Milliseconds,
      frameNearestRankP99Milliseconds: animatedFrameP99Milliseconds,
      callbackCount: animation.callbackCount,
      callbackCpuMilliseconds: animation.callbackCpuMilliseconds,
      callbackCpuNearestRankP95Milliseconds: callbackCpuP95Milliseconds,
      lastMotion: motion
    },
    inactive: {
      hidden,
      offscreen,
      hardIneligible: {
        viewport: { width: 959, height: viewport.height },
        canvasCount: hardIneligibleCanvasCount,
        callbackCount: hardIneligibleCallbackCount
      }
    },
    violations
  }
  writeReportAtomically(report)
  expect(violations, 'logo particle runtime budget violations').toEqual([])
})
