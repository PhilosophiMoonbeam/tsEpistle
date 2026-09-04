import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { errors, expect, test } from '@playwright/test'
import type { Browser, BrowserContext, Page } from '@playwright/test'

const outputPath = process.env.LOGO_PARTICLE_PERFORMANCE_FILE ?? 'logo-particle-performance.json'
const viewport = { width: 1440, height: 900 }
const deviceScaleFactor = 1.5
const firstFrameRuns = 20
const firstFrameTimeoutMilliseconds = 2_000
const warmUpMilliseconds = 2_000
const animationSampleMilliseconds = 10_000
const inactivitySampleMilliseconds = 2_000
const thresholds = {
  animatedFrameP95Milliseconds: 20,
  animatedFrameP99Milliseconds: 34,
  callbackCpuP95Milliseconds: 2,
  firstFrameP95Milliseconds: 1_500,
  hardIneligibleCanvasCount: 0,
  inactiveCallbackCount: 0,
  retainedCanvasCount: 1,
  timeouts: 0
} as const

const logoUrl = `/_site-logo/${'1'.repeat(64)}/logo.png`
const particleUrl = `/_site-logo/${'2'.repeat(64)}/particle.bin`
const staticUrl = `/_site-logo/${'3'.repeat(64)}/effect.png`
const descriptor = {
  logoUrl,
  particleUrl,
  staticUrl,
  width: 1_024,
  height: 1_024,
  aspect: 1,
  count: 16_000,
  medianStroke: 24,
  auraColor: '#336699'
}
const staticFixture =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><circle cx="512" cy="512" r="448" fill="#336699"/><path d="M256 512h512M512 256v512" stroke="#fff" stroke-width="48"/></svg>'

interface BenchmarkState {
  callbackCount: number
  callbackCpuMilliseconds: number[]
  frameIntervalsMilliseconds: number[]
  firstFrameMilliseconds: number | null
  lastFrameAt: number | null
}

interface BenchmarkWindow extends Window {
  __logoParticlePerformance: BenchmarkState
  __setLogoParticleVisibility: (visibility: DocumentVisibilityState) => void
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
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await page.addInitScript(managedDescriptor => {
    const benchmark: BenchmarkState = {
      callbackCount: 0,
      callbackCpuMilliseconds: [],
      frameIntervalsMilliseconds: [],
      firstFrameMilliseconds: null,
      lastFrameAt: null
    }
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
  await page.route(`**${logoUrl}`, route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: staticFixture }))
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
  })
}

async function readMeasurements(page: Page): Promise<BenchmarkState> {
  return page.evaluate(() => {
    const benchmark = (window as BenchmarkWindow).__logoParticlePerformance
    return {
      callbackCount: benchmark.callbackCount,
      callbackCpuMilliseconds: [...benchmark.callbackCpuMilliseconds],
      frameIntervalsMilliseconds: [...benchmark.frameIntervalsMilliseconds],
      firstFrameMilliseconds: benchmark.firstFrameMilliseconds,
      lastFrameAt: benchmark.lastFrameAt
    }
  })
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

function addMaximumViolation(violations: Violation[], invariant: string, measured: number | null, threshold: number): void {
  if (measured === null || measured > threshold) violations.push({ invariant, measured, threshold })
}

function addExactViolation(violations: Violation[], invariant: string, measured: number, threshold: number): void {
  if (measured !== threshold) violations.push({ invariant, measured, threshold })
}

test.describe.configure({ retries: 0 })

test('enforces managed login particle runtime budgets', async ({ browser, browserName }, testInfo) => {
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
    }
  }

  const { context, page } = await createMeasuredPage(browser)
  let animation: BenchmarkState = {
    callbackCount: 0,
    callbackCpuMilliseconds: [],
    frameIntervalsMilliseconds: [],
    firstFrameMilliseconds: null,
    lastFrameAt: null
  }
  let animationSetupTimeouts = 0
  let hidden: InactivityMeasurement
  let offscreen: InactivityMeasurement
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
    await resetMeasurements(page)
    await page.waitForTimeout(animationSampleMilliseconds)
    animation = await readMeasurements(page)
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
  const animatedFrameP95Milliseconds = nearestRank(animation.frameIntervalsMilliseconds, 0.95)
  const animatedFrameP99Milliseconds = nearestRank(animation.frameIntervalsMilliseconds, 0.99)
  const callbackCpuP95Milliseconds = nearestRank(animation.callbackCpuMilliseconds, 0.95)
  const violations: Violation[] = []
  addExactViolation(violations, 'firstFrame.timeouts === 0', firstFrameTimeouts, thresholds.timeouts)
  addExactViolation(violations, 'firstFrame.samples.length === 20', firstFrameSamplesMilliseconds.length, firstFrameRuns)
  addMaximumViolation(violations, 'firstFrame.nearestRankP95Milliseconds <= 1500', firstFrameP95Milliseconds, thresholds.firstFrameP95Milliseconds)
  addMaximumViolation(violations, 'animation.frameNearestRankP95Milliseconds <= 20', animatedFrameP95Milliseconds, thresholds.animatedFrameP95Milliseconds)
  addMaximumViolation(violations, 'animation.frameNearestRankP99Milliseconds <= 34', animatedFrameP99Milliseconds, thresholds.animatedFrameP99Milliseconds)
  addMaximumViolation(violations, 'animation.callbackCpuNearestRankP95Milliseconds <= 2', callbackCpuP95Milliseconds, thresholds.callbackCpuP95Milliseconds)
  addExactViolation(violations, 'animation.setupTimeouts === 0', animationSetupTimeouts, thresholds.timeouts)
  addExactViolation(violations, 'hidden.callbackCount === 0', hidden.callbackCount, thresholds.inactiveCallbackCount)
  addExactViolation(violations, 'hidden.canvasCount === 1', hidden.canvasCount, thresholds.retainedCanvasCount)
  addExactViolation(violations, 'offscreen.callbackCount === 0', offscreen.callbackCount, thresholds.inactiveCallbackCount)
  addExactViolation(violations, 'offscreen.canvasCount === 1', offscreen.canvasCount, thresholds.retainedCanvasCount)
  addExactViolation(violations, 'hardIneligible.canvasCount === 0', hardIneligibleCanvasCount, thresholds.hardIneligibleCanvasCount)
  addExactViolation(violations, 'hardIneligible.callbackCount === 0', hardIneligibleCallbackCount, thresholds.inactiveCallbackCount)
  addExactViolation(violations, 'environment.viewport.width === 1440', actualViewport.width, viewport.width)
  addExactViolation(violations, 'environment.viewport.height === 900', actualViewport.height, viewport.height)
  addExactViolation(violations, 'environment.deviceScaleFactor === 1.5', actualDeviceScaleFactor, deviceScaleFactor)

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
      frameIntervalsMilliseconds: animation.frameIntervalsMilliseconds,
      frameNearestRankP95Milliseconds: animatedFrameP95Milliseconds,
      frameNearestRankP99Milliseconds: animatedFrameP99Milliseconds,
      callbackCount: animation.callbackCount,
      callbackCpuMilliseconds: animation.callbackCpuMilliseconds,
      callbackCpuNearestRankP95Milliseconds: callbackCpuP95Milliseconds
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
