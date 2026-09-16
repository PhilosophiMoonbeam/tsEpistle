import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { errors, expect, test } from '@playwright/test'
import type { ParticleBackendKind, ParticleBackendRequest } from '../../client/components/login-logo/particle-renderer.ts'
import type {
  LogoBackendDiagnostic,
  LogoBenchmarkApiObservations,
  LogoGpuTimingSample,
  LogoMotionDiagnostics,
  LogoParticlePerformanceHook,
  LogoPerformanceCounters,
  LogoPerformanceFrame,
  LogoPerformanceWindow,
  LogoResumeSample,
  LogoStartupMilestones,
  LogoUploadApiObservation
} from './logo-particle-benchmark.ts'

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

type StrictBackend = Exclude<ParticleBackendRequest, 'auto'>
type EffectiveBackend = ParticleBackendKind | null
type PerformanceProfile = 'native-webgpu' | 'hardware-angle-webgl2' | 'swiftshader-webgl2-diagnostic'

const performanceProjectNames: Record<string, true> = {
  'performance-webgl2': true,
  'performance-webgl2-swiftshader': true,
  'performance-webgpu': true
}

function performanceProfileForProject(projectName: string): PerformanceProfile {
  if (projectName === 'performance-webgpu') return 'native-webgpu'
  if (projectName === 'performance-webgl2-swiftshader') return 'swiftshader-webgl2-diagnostic'
  return 'hardware-angle-webgl2'
}

function reportPathForBackend(backend: StrictBackend, projectName: string): string {
  const configuredPath = process.env.LOGO_PARTICLE_PERFORMANCE_FILE
  const suffix = projectName === 'performance-webgl2-swiftshader' ? `${backend}-swiftshader` : backend
  if (!configuredPath) return `logo-particle-performance.${suffix}.json`
  const extension = path.extname(configuredPath)
  const stem = extension ? configuredPath.slice(0, -extension.length) : configuredPath
  return `${stem}.${suffix}${extension || '.json'}`
}

const thresholds = {
  activeExplosionMaximum: 6,
  activeImpulseMaximum: 6,
  activeMotionBytes: 128_000,
  animatedFrameP95Milliseconds: 20,
  animatedFrameP99Milliseconds: 34,
  animatedFrameMinimumCoverageMilliseconds: 9_000,
  animatedFrameMinimumIntervalSamples: 250,
  callbackCpuP95Milliseconds: 2,
  depthScaleMax: 1.18,
  depthScaleMin: 0.82,
  bounceRatio: 0.4,
  explosionHoldSeconds: 0.35,
  explosionLifetimeSeconds: 2.8,
  explosionRefillSeconds: 2.4,
  firstFrameP95Milliseconds: 1_500,
  hardIneligibleCanvasCount: 0,
  idleAmplitudeMaximumCss: 10,
  idleAmplitudeMinimumCss: 3.5,
  inactiveCallbackCount: 0,
  impulseLifetimeSeconds: 1.4,
  maxImpulseTravelCss: 42,
  neighborForceRatio: 0.72,
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
  pipelineVersion: 7,
  width: 1_024,
  height: 1_024,
  aspect: 1,
  count: 16_000,
  medianStroke: 24,
  auraColor: '#336699'
}
const expectedActiveMotionBytes = thresholds.activeMotionBytes
const expectedTriangles = descriptor.count * 2
const logoFixture =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect x="64" y="64" width="896" height="896" rx="128" fill="#e8538a"/><circle cx="512" cy="512" r="300" fill="#36a3d9"/></svg>'
const staticFixture =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><circle cx="512" cy="512" r="448" fill="#336699"/><path d="M256 512h512M512 256v512" stroke="#fff" stroke-width="48"/></svg>'

const motionDiagnosticKeys = [
  'activeExplosionCount',
  'activeImpulseCount',
  'bounceRatio',
  'collisionParticleCount',
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

type BackendDiagnostic = LogoBackendDiagnostic
type StartupMilestones = LogoStartupMilestones
type ResumeSample = LogoResumeSample
type PerformanceFrameSample = LogoPerformanceFrame
type BenchmarkCounters = LogoPerformanceCounters
type UploadApiObservation = LogoUploadApiObservation
type BenchmarkApiObservations = LogoBenchmarkApiObservations

type BenchmarkState = LogoParticlePerformanceHook & {
  maximumActiveExplosionCount: number
  maximumActiveImpulseCount: number
  requestedBackend?: StrictBackend
  apiObservations: LogoBenchmarkApiObservations
}

interface BenchmarkMeasurement extends BenchmarkState {
  readonly lastMotionKeys: string[] | null
}

declare global {
  interface Window {
    __setLogoParticleVisibility?: (visibility: DocumentVisibilityState) => void
  }
}

interface SynchronizedMotionSample {
  readonly activeExplosionCount: number | null
  readonly activeImpulseCount: number | null
  readonly frameAdvanced: boolean
}

interface AnimationInputMeasurement {
  readonly cadenceMilliseconds: number
  readonly diagnosticFrameSampleFailures: number
  readonly explosionCadenceMilliseconds: number
  readonly explosionDispatchCount: number
  readonly maximumSynchronizedActiveImpulseCount: number
  readonly primeSegmentCount: number
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
  counters: BenchmarkCounters | null
  drawCallsDelta: number | null
  logicalScheduledBytes: number | null
  actualUploadBytes: number | null
  actualUploadCalls: number | null
  uploadObservations: BenchmarkApiObservations | null
  durationMilliseconds: number
  effectiveBackend: EffectiveBackend
  rafCallbacksDelta: number | null
}
interface CanvasEnvironmentObservation {
  readonly css: {
    readonly left: number
    readonly top: number
    readonly width: number
    readonly height: number
  } | null
  readonly backing: {
    readonly width: number
    readonly height: number
  } | null
  readonly devicePixelRatio: number | null
}

interface GraphicsIdentityObservation {
  readonly webgl2: {
    readonly source: 'active-canvas' | 'diagnostic-canvas' | 'unavailable'
    readonly contextAvailable: boolean
    readonly debugRendererInfoAvailable: boolean
    readonly vendor: string | null
    readonly renderer: string | null
    readonly unmaskedVendor: string | null
    readonly unmaskedRenderer: string | null
    readonly reason?: string
  }
  readonly webgpu: {
    readonly adapterAvailable: boolean
    readonly vendor: string | null
    readonly architecture: string | null
    readonly device: string | null
    readonly description: string | null
    readonly reason?: string
  }
}

interface EnvironmentMetadata {
  readonly userAgent: string
  readonly platform: string
  readonly language: string
  readonly hardwareConcurrency: number | null
  readonly timeOrigin: number | null
  readonly canvas: CanvasEnvironmentObservation
  readonly graphics: GraphicsIdentityObservation
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
    bytes[sizeOffset + index] = 255
    bytes.writeUInt16LE(((index * 40_503) % 65_535) + 1, seedOffset + index * 2)
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

function finiteValues(samples: readonly (number | null | undefined)[]): number[] {
  return samples.filter((sample): sample is number => typeof sample === 'number' && Number.isFinite(sample))
}

function nearestRankNullable(samples: readonly (number | null | undefined)[], percentile: number): number | null {
  return nearestRank(finiteValues(samples), percentile)
}

function sumNullable(samples: readonly (number | null | undefined)[]): number | null {
  const values = finiteValues(samples)
  return values.length > 0 && values.length === samples.length ? values.reduce((total, value) => total + value, 0) : null
}

function latencyMilliseconds(start: number | null | undefined, end: number | null | undefined): number | null {
  return typeof start === 'number' && Number.isFinite(start) && typeof end === 'number' && Number.isFinite(end) && end >= start ? end - start : null
}

function effectiveBackend(measurement: BenchmarkMeasurement): EffectiveBackend {
  return measurement.effectiveBackend ?? null
}

function diagnostics(measurement: BenchmarkMeasurement): readonly BackendDiagnostic[] {
  return measurement.backendDiagnostics ?? []
}

function failedDiagnostics(measurement: BenchmarkMeasurement): readonly BackendDiagnostic[] {
  return diagnostics(measurement).filter(diagnostic => diagnostic.phase === 'failed' || diagnostic.phase === 'lost')
}

function frameField(frames: readonly PerformanceFrameSample[] | undefined, field: keyof PerformanceFrameSample): Array<number | null> {
  return (frames ?? []).map(frame => {
    const value = frame[field]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  })
}

function counterValue(counters: BenchmarkCounters | null | undefined, field: keyof BenchmarkCounters): number | null {
  const value = counters?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function unavailableUploadObservation(reason: string): UploadApiObservation {
  return { status: 'unavailable', calls: null, bytes: null, reason }
}

function uploadObservationFor(measurement: BenchmarkMeasurement, backend: StrictBackend): UploadApiObservation {
  const observation = measurement.apiObservations?.[backend]
  return observation ?? unavailableUploadObservation(`${backend} upload observation was not installed`)
}

function uploadObservationsFor(measurement: BenchmarkMeasurement): BenchmarkApiObservations {
  return {
    webgpu: uploadObservationFor(measurement, 'webgpu'),
    webgl2: uploadObservationFor(measurement, 'webgl2')
  }
}

function selectedUploadObservation(measurement: BenchmarkMeasurement): UploadApiObservation {
  const backend = effectiveBackend(measurement) ?? measurement.requestedBackend
  return backend ? uploadObservationFor(measurement, backend) : unavailableUploadObservation('Effective upload observation backend is unavailable')
}
type GraphicsClassification = 'representative-hardware' | 'software-diagnostic' | 'unavailable'

function classifyGraphicsIdentity(
  profile: PerformanceProfile,
  graphics: GraphicsIdentityObservation
): {
  readonly actualIdentityAvailable: boolean
  readonly classification: GraphicsClassification
  readonly softwareHint: boolean
} {
  const identityValues = [
    graphics.webgl2.vendor,
    graphics.webgl2.renderer,
    graphics.webgl2.unmaskedVendor,
    graphics.webgl2.unmaskedRenderer,
    graphics.webgpu.vendor,
    graphics.webgpu.architecture,
    graphics.webgpu.device,
    graphics.webgpu.description
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const actualIdentityAvailable = identityValues.some(value => !/^(unknown|generic|none|null|undefined)$/i.test(value.trim()))
  const softwareHint = identityValues.some(value => /swiftshader|llvmpipe|softpipe|software rasterizer|software renderer/i.test(value))
  const classification: GraphicsClassification =
    profile === 'swiftshader-webgl2-diagnostic' || softwareHint ? 'software-diagnostic' : actualIdentityAvailable ? 'representative-hardware' : 'unavailable'
  return { actualIdentityAvailable, classification, softwareHint }
}

function writeReportAtomically(reportPath: string, report: object): void {
  const directory = path.dirname(reportPath)
  fs.mkdirSync(directory, { recursive: true })
  const temporaryPath = `${reportPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    fs.renameSync(temporaryPath, reportPath)
  } catch (error: unknown) {
    fs.rmSync(temporaryPath, { force: true })
    throw error
  }
}

async function createMeasuredPage(
  browser: Browser,
  measuredViewport = viewport,
  requestedBackend: StrictBackend
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    deviceScaleFactor,
    reducedMotion: 'no-preference',
    serviceWorkers: 'block',
    viewport: measuredViewport
  })
  const page = await context.newPage()
  await page.addInitScript(
    ({ managedDescriptor, requestedBackend: initRequestedBackend }: { managedDescriptor: typeof descriptor; requestedBackend: StrictBackend }) => {
      const startup: StartupMilestones = {}
      const backendDiagnostics: BackendDiagnostic[] = []
      const benchmark: BenchmarkState = {
        callbackCount: 0,
        callbackCpuMilliseconds: [],
        frameIntervalsMilliseconds: [],
        firstFrameMilliseconds: null,
        lastFrameAt: null,
        renderInvocationCpuMs: null,
        gpuTimingEpoch: 0,
        maximumActiveExplosionCount: 0,
        maximumActiveImpulseCount: 0,
        requestedBackend: initRequestedBackend,
        effectiveBackend: null,
        backendDiagnostics,
        startup,
        resumes: [],
        frames: [],
        gpu: [],
        counters: {
          updateCallbacks: 0,
          renderInvocations: 0,
          afterRenderCallbacks: 0,
          rafCallbacks: 0,
          draws: 0,
          sampleOverflow: 0
        },
        apiObservations: {
          webgpu: {
            status: 'unavailable',
            calls: null,
            bytes: null,
            reason: 'WebGPU upload observation was not initialized'
          },
          webgl2: {
            status: 'unavailable',
            calls: null,
            bytes: null,
            reason: 'WebGL2 upload observation was not initialized'
          }
        }
      }
      benchmark.onDiagnostics = diagnostic => {
        backendDiagnostics.push({ ...diagnostic })
        benchmark.effectiveBackend = diagnostic.effectiveBackend
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
      const logoPerformanceWindow = (): LogoPerformanceWindow => window as LogoPerformanceWindow
      logoPerformanceWindow().__logoParticlePerformance = benchmark
      type PublicMethod = (this: unknown, ...args: unknown[]) => unknown
      type ReplacedMethod = {
        readonly owner: object
        readonly name: string
        readonly descriptor: PropertyDescriptor | undefined
      }
      const observations = benchmark.apiObservations
      if (!observations) throw new Error('Particle upload observation state is unavailable')
      const readProperty = (value: unknown, name: string): unknown => {
        if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined
        return Reflect.get(value, name)
      }
      const nonNegativeInteger = (value: unknown): number | null => {
        if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null
        return value
      }
      const sourceByteLength = (value: unknown): number | null => {
        if (value === null) return 0
        if (typeof value === 'number') return nonNegativeInteger(value)
        return nonNegativeInteger(readProperty(value, 'byteLength'))
      }
      const elementByteSize = (value: unknown): number => {
        const bytesPerElement = nonNegativeInteger(readProperty(value, 'BYTES_PER_ELEMENT'))
        return bytesPerElement !== null && bytesPerElement > 0 ? bytesPerElement : 1
      }
      const rangedUploadBytes = (source: unknown, offsetArgument: unknown, lengthArgument: unknown, zeroLengthMeansRemainder: boolean): number | null => {
        const totalBytes = sourceByteLength(source)
        if (totalBytes === null) return null
        const elementSize = elementByteSize(source)
        if (totalBytes % elementSize !== 0) return null
        const totalElements = totalBytes / elementSize
        const offset = offsetArgument === undefined ? 0 : nonNegativeInteger(offsetArgument)
        if (offset === null || offset > totalElements) return null
        let length = lengthArgument === undefined ? totalElements - offset : nonNegativeInteger(lengthArgument)
        if (length === null) return null
        if (zeroLengthMeansRemainder && length === 0) length = totalElements - offset
        if (length > totalElements - offset) return null
        return length * elementSize
      }
      const webgpuUploadBytes = (source: unknown, dataOffset: unknown, size: unknown): number | null => rangedUploadBytes(source, dataOffset, size, false)
      const webglUploadBytes = (source: unknown, sourceOffset: unknown, length: unknown): number | null => {
        if (typeof source === 'number') return sourceByteLength(source)
        if (source === null) return 0
        return rangedUploadBytes(source, sourceOffset, length, true)
      }
      const recordUpload = (observation: UploadApiObservation, bytes: number | null): void => {
        if (observation.status !== 'available') return
        observation.calls = (observation.calls ?? 0) + 1
        if (observation.bytes === null || bytes === null) {
          observation.bytes = null
          if (!observation.reason) observation.reason = 'Upload byte count was unavailable for an observed call'
        } else {
          observation.bytes += bytes
        }
      }
      const markUnavailable = (backend: StrictBackend, reason: string): void => {
        observations[backend] = { status: 'unavailable', calls: null, bytes: null, reason }
      }
      const isPublicMethod = (value: unknown): value is PublicMethod => typeof value === 'function'
      const publicMethod = (owner: object, name: string): PublicMethod | null => {
        const method = readProperty(owner, name)
        return isPublicMethod(method) ? method : null
      }
      const publicPrototype = (constructorName: string): object | null => {
        const constructorValue = readProperty(globalThis, constructorName)
        const prototype = readProperty(constructorValue, 'prototype')
        return prototype !== null && typeof prototype === 'object' ? prototype : null
      }
      const replaceMethod = (owner: object, name: string, wrapper: PublicMethod): ReplacedMethod | null => {
        const descriptor = Object.getOwnPropertyDescriptor(owner, name)
        if (descriptor && ('get' in descriptor || 'set' in descriptor)) return null
        if (!publicMethod(owner, name)) return null
        try {
          Object.defineProperty(owner, name, {
            configurable: descriptor?.configurable ?? true,
            enumerable: descriptor?.enumerable ?? false,
            writable: descriptor?.writable ?? true,
            value: wrapper
          })
          return { owner, name, descriptor }
        } catch {
          return null
        }
      }
      const restoreMethod = (replaced: ReplacedMethod | null): void => {
        if (!replaced) return
        try {
          if (replaced.descriptor) Object.defineProperty(replaced.owner, replaced.name, replaced.descriptor)
          else Reflect.deleteProperty(replaced.owner, replaced.name)
        } catch {
          // Context isolation makes restoration best-effort if a browser seals a public prototype.
        }
      }

      const webgpuPrototype = publicPrototype('GPUQueue')
      const webgpuWriteBuffer = webgpuPrototype ? publicMethod(webgpuPrototype, 'writeBuffer') : null
      if (!webgpuPrototype) {
        markUnavailable('webgpu', 'GPUQueue constructor/prototype is unavailable')
      } else if (!webgpuWriteBuffer) {
        markUnavailable('webgpu', 'GPUQueue.prototype.writeBuffer is unavailable')
      } else {
        const writeBuffer = webgpuWriteBuffer
        const replaced = replaceMethod(webgpuPrototype, 'writeBuffer', function (this: unknown, ...args: unknown[]): unknown {
          const result = Reflect.apply(writeBuffer, this, args)
          recordUpload(observations.webgpu, webgpuUploadBytes(args[2], args[3], args[4]))
          return result
        })
        if (!replaced) markUnavailable('webgpu', 'GPUQueue.prototype.writeBuffer could not be wrapped')
        else observations.webgpu = { status: 'available', calls: 0, bytes: 0 }
      }

      const webglPrototype = publicPrototype('WebGL2RenderingContext')
      const webglBufferData = webglPrototype ? publicMethod(webglPrototype, 'bufferData') : null
      const webglBufferSubData = webglPrototype ? publicMethod(webglPrototype, 'bufferSubData') : null
      if (!webglPrototype) {
        markUnavailable('webgl2', 'WebGL2RenderingContext constructor/prototype is unavailable')
      } else if (!webglBufferData || !webglBufferSubData) {
        markUnavailable('webgl2', 'WebGL2 bufferData/bufferSubData prototype methods are unavailable')
      } else {
        const bufferData = webglBufferData
        const bufferSubData = webglBufferSubData
        const replacedBufferData = replaceMethod(webglPrototype, 'bufferData', function (this: unknown, ...args: unknown[]): unknown {
          const result = Reflect.apply(bufferData, this, args)
          recordUpload(observations.webgl2, webglUploadBytes(args[1], args[3], args[4]))
          return result
        })
        const replacedBufferSubData = replacedBufferData
          ? replaceMethod(webglPrototype, 'bufferSubData', function (this: unknown, ...args: unknown[]): unknown {
              const result = Reflect.apply(bufferSubData, this, args)
              recordUpload(observations.webgl2, webglUploadBytes(args[2], args[3], args[4]))
              return result
            })
          : null
        if (!replacedBufferData || !replacedBufferSubData) {
          restoreMethod(replacedBufferSubData)
          restoreMethod(replacedBufferData)
          markUnavailable('webgl2', 'WebGL2 buffer upload prototypes could not be wrapped')
        } else {
          observations.webgl2 = { status: 'available', calls: 0, bytes: 0 }
        }
      }

      type TimerQueryExtension = {
        readonly TIME_ELAPSED_EXT: number
        readonly GPU_DISJOINT_EXT: number
      }
      type TimerQuerySlot = {
        readonly query: WebGLQuery
        frameId: number
        epoch: number
        pending: boolean
      }
      type TimerQueryState = {
        readonly context: WebGL2RenderingContext
        readonly extension: TimerQueryExtension | null
        readonly slots: TimerQuerySlot[]
        nextFrameId: number
        unavailableEpoch: number
      }
      const timerQueryStates: TimerQueryState[] = []
      const pushGpuSample = (sample: LogoGpuTimingSample): void => {
        if (!benchmark.gpu || benchmark.gpu.length >= 512) return
        benchmark.gpu.push(sample)
      }
      const markGpuUnavailable = (state: TimerQueryState, reason: string, frameId?: number): void => {
        const epoch = benchmark.gpuTimingEpoch ?? 0
        if (frameId === undefined && state.unavailableEpoch === epoch) return
        if (frameId === undefined) state.unavailableEpoch = epoch
        pushGpuSample(frameId === undefined ? { status: 'unavailable', reason } : { frameId, status: 'unavailable', reason })
      }
      const timerStateFor = (context: WebGL2RenderingContext): TimerQueryState => {
        const existing = timerQueryStates.find(state => state.context === context)
        if (existing) return existing
        let extension: TimerQueryExtension | null = null
        try {
          const candidate = context.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExtension | null
          if (candidate && typeof candidate.TIME_ELAPSED_EXT === 'number' && typeof candidate.GPU_DISJOINT_EXT === 'number') {
            extension = candidate
          }
        } catch {
          extension = null
        }
        const slots: TimerQuerySlot[] = []
        if (extension) {
          for (let index = 0; index < 32; index += 1) {
            let query: WebGLQuery | null = null
            try {
              query = context.createQuery()
            } catch {
              query = null
            }
            if (!query) break
            slots.push({ query, frameId: 0, epoch: benchmark.gpuTimingEpoch ?? 0, pending: false })
          }
        }
        const state: TimerQueryState = {
          context,
          extension,
          slots,
          nextFrameId: 1,
          unavailableEpoch: -1
        }
        timerQueryStates.push(state)
        if (!extension) markGpuUnavailable(state, 'EXT_disjoint_timer_query_webgl2 is unavailable')
        else if (slots.length === 0) markGpuUnavailable(state, 'EXT_disjoint_timer_query_webgl2 query pool could not be allocated')
        return state
      }
      const pollTimerQueryState = (state: TimerQueryState): void => {
        const extension = state.extension
        if (!extension) return
        const context = state.context
        const currentEpoch = benchmark.gpuTimingEpoch ?? 0
        let disjoint = false
        try {
          disjoint = Boolean(context.getParameter(extension.GPU_DISJOINT_EXT))
        } catch {
          markGpuUnavailable(state, 'EXT_disjoint_timer_query_webgl2 disjoint state was unavailable')
          return
        }
        if (disjoint) {
          let pendingResultCount = 0
          for (const slot of state.slots) {
            if (!slot.pending) continue
            pendingResultCount += 1
            slot.pending = false
            if (slot.epoch === currentEpoch) {
              markGpuUnavailable(state, 'EXT_disjoint_timer_query_webgl2 reported a disjoint result', slot.frameId)
            }
          }
          if (pendingResultCount === 0) markGpuUnavailable(state, 'EXT_disjoint_timer_query_webgl2 reported a disjoint result')
          return
        }
        for (const slot of state.slots) {
          if (!slot.pending) continue
          let available = false
          try {
            available = Boolean(context.getQueryParameter(slot.query, context.QUERY_RESULT_AVAILABLE))
          } catch {
            slot.pending = false
            if (slot.epoch === currentEpoch) {
              markGpuUnavailable(state, 'EXT_disjoint_timer_query_webgl2 query availability was unavailable', slot.frameId)
            }
            continue
          }
          if (!available) continue
          let result: unknown
          try {
            result = context.getQueryParameter(slot.query, context.QUERY_RESULT)
          } catch {
            slot.pending = false
            if (slot.epoch === currentEpoch) {
              markGpuUnavailable(state, 'EXT_disjoint_timer_query_webgl2 query result was unavailable', slot.frameId)
            }
            continue
          }
          slot.pending = false
          const durationNanoseconds = typeof result === 'number' ? result : typeof result === 'bigint' ? Number(result) : NaN
          if (slot.epoch !== currentEpoch) continue
          if (Number.isFinite(durationNanoseconds) && durationNanoseconds >= 0) {
            pushGpuSample({ frameId: slot.frameId, durationMs: durationNanoseconds / 1_000_000, status: 'available' })
          } else {
            markGpuUnavailable(state, 'EXT_disjoint_timer_query_webgl2 returned an invalid duration', slot.frameId)
          }
        }
      }
      const pollTimerQueryStates = (): void => {
        for (const state of timerQueryStates) pollTimerQueryState(state)
      }
      const webglTimerPrototype = publicPrototype('WebGL2RenderingContext')
      const webglDrawElementsInstanced = webglTimerPrototype ? publicMethod(webglTimerPrototype, 'drawElementsInstanced') : null
      if (!webglTimerPrototype) {
        pushGpuSample({ status: 'unavailable', reason: 'WebGL2RenderingContext constructor/prototype is unavailable' })
      } else if (!webglDrawElementsInstanced) {
        pushGpuSample({ status: 'unavailable', reason: 'WebGL2RenderingContext.prototype.drawElementsInstanced is unavailable' })
      } else {
        const drawElementsInstanced = webglDrawElementsInstanced
        const replaced = replaceMethod(webglTimerPrototype, 'drawElementsInstanced', function (this: unknown, ...args: unknown[]): unknown {
          const context = this as WebGL2RenderingContext
          const state = timerStateFor(context)
          pollTimerQueryState(state)
          const instanceCount = args[4]
          if (instanceCount !== managedDescriptor.count || !state.extension) {
            return Reflect.apply(drawElementsInstanced, this, args)
          }
          const slot = state.slots.find(candidate => !candidate.pending)
          if (!slot) {
            const frameId = state.nextFrameId
            state.nextFrameId += 1
            markGpuUnavailable(state, 'EXT_disjoint_timer_query_webgl2 query pool is busy', frameId)
            return Reflect.apply(drawElementsInstanced, this, args)
          }
          const frameId = state.nextFrameId
          state.nextFrameId += 1
          slot.frameId = frameId
          let began = false
          try {
            context.beginQuery(state.extension.TIME_ELAPSED_EXT, slot.query)
            began = true
          } catch {
            markGpuUnavailable(state, 'EXT_disjoint_timer_query_webgl2 beginQuery failed', frameId)
            return Reflect.apply(drawElementsInstanced, this, args)
          }
          let failed = false
          let result: unknown
          try {
            result = Reflect.apply(drawElementsInstanced, this, args)
          } catch (error: unknown) {
            failed = true
            result = error
          }
          if (began) {
            try {
              context.endQuery(state.extension.TIME_ELAPSED_EXT)
              slot.pending = true
            } catch {
              slot.pending = false
              markGpuUnavailable(state, 'EXT_disjoint_timer_query_webgl2 endQuery failed', frameId)
            }
          }
          if (failed) throw result
          return result
        })
        if (!replaced) {
          pushGpuSample({ status: 'unavailable', reason: 'WebGL2 drawElementsInstanced could not be wrapped for timer queries' })
        }
      }
      if (initRequestedBackend === 'webgpu') {
        pushGpuSample({ status: 'unavailable', reason: 'EXT_disjoint_timer_query_webgl2 applies only to strict WebGL2' })
      }

      const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window)
      window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
        nativeRequestAnimationFrame(timestamp => {
          pollTimerQueryStates()
          const counters = benchmark.counters
          if (counters && typeof counters.rafCallbacks === 'number') counters.rafCallbacks += 1
          callback(timestamp)
        })

      let visibility: DocumentVisibilityState = 'visible'
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibility
      })
      window.__setLogoParticleVisibility = nextVisibility => {
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
    },
    { managedDescriptor: descriptor, requestedBackend }
  )
  await page.route(`**${logoUrl}`, route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: logoFixture }))
  await page.route(`**${staticUrl}`, route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: staticFixture }))
  await page.route(`**${particleUrl}`, route => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: particleFixture }))
  return { context, page }
}

async function waitForFirstFrame(page: Page): Promise<number> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => {
      const logoPerformanceWindow = (): LogoPerformanceWindow => window as LogoPerformanceWindow
      const benchmark = logoPerformanceWindow().__logoParticlePerformance
      if (!benchmark) throw new Error('Particle performance benchmark is unavailable')
      return typeof benchmark.firstFrameMilliseconds === 'number'
    },
    undefined,
    { timeout: firstFrameTimeoutMilliseconds }
  )
  return page.evaluate(() => {
    const logoPerformanceWindow = (): LogoPerformanceWindow => window as LogoPerformanceWindow
    const benchmark = logoPerformanceWindow().__logoParticlePerformance
    if (!benchmark) throw new Error('Particle performance benchmark is unavailable')
    const firstFrame = benchmark.firstFrameMilliseconds
    if (firstFrame === null) throw new Error('Particle first frame was not recorded')
    return firstFrame
  })
}

async function resetMeasurements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const logoPerformanceWindow = (): LogoPerformanceWindow => window as LogoPerformanceWindow
    const benchmark = logoPerformanceWindow().__logoParticlePerformance
    if (!benchmark) throw new Error('Particle performance benchmark is unavailable')
    benchmark.callbackCount = 0
    benchmark.callbackCpuMilliseconds.length = 0
    benchmark.frameIntervalsMilliseconds.length = 0
    benchmark.lastFrameAt = null
    benchmark.renderInvocationCpuMs = null
    benchmark.gpuTimingEpoch = (benchmark.gpuTimingEpoch ?? 0) + 1
    benchmark.maximumActiveExplosionCount = 0
    benchmark.maximumActiveImpulseCount = 0
    benchmark.frames?.splice(0)
    benchmark.gpu?.splice(0)
    if (benchmark.counters) {
      benchmark.counters.updateCallbacks = 0
      benchmark.counters.renderInvocations = 0
      benchmark.counters.afterRenderCallbacks = 0
      benchmark.counters.rafCallbacks = 0
      benchmark.counters.draws = 0
      benchmark.counters.sampleOverflow = 0
    }
    if (benchmark.apiObservations) {
      for (const observation of Object.values(benchmark.apiObservations)) {
        if (observation.status !== 'available') continue
        observation.calls = 0
        observation.bytes = 0
        delete observation.reason
      }
    }
  })
}

async function readMeasurements(page: Page): Promise<BenchmarkMeasurement> {
  return page.evaluate((): BenchmarkMeasurement => {
    const logoPerformanceWindow = (): LogoPerformanceWindow => window as LogoPerformanceWindow
    const benchmark = logoPerformanceWindow().__logoParticlePerformance
    if (!benchmark) throw new Error('Particle performance benchmark is unavailable')
    const requestedBackend = benchmark.requestedBackend
    if (requestedBackend !== 'webgpu' && requestedBackend !== 'webgl2') {
      throw new Error('Particle performance benchmark requested backend is not strict')
    }
    if (typeof benchmark.maximumActiveExplosionCount !== 'number' || typeof benchmark.maximumActiveImpulseCount !== 'number' || !benchmark.apiObservations) {
      throw new Error('Particle performance benchmark strict fields are unavailable')
    }
    return {
      callbackCount: benchmark.callbackCount,
      callbackCpuMilliseconds: [...benchmark.callbackCpuMilliseconds],
      frameIntervalsMilliseconds: [...benchmark.frameIntervalsMilliseconds],
      firstFrameMilliseconds: benchmark.firstFrameMilliseconds,
      lastFrameAt: benchmark.lastFrameAt,
      renderInvocationCpuMs: benchmark.renderInvocationCpuMs,
      lastMotion: benchmark.lastMotion ? { ...benchmark.lastMotion } : undefined,
      lastMotionKeys: benchmark.lastMotion ? Object.keys(benchmark.lastMotion).sort() : null,
      maximumActiveExplosionCount: benchmark.maximumActiveExplosionCount,
      maximumActiveImpulseCount: benchmark.maximumActiveImpulseCount,
      requestedBackend,
      effectiveBackend: benchmark.effectiveBackend,
      backendDiagnostics: benchmark.backendDiagnostics?.map((diagnostic: LogoBackendDiagnostic) => ({ ...diagnostic })),
      startup: benchmark.startup ? { ...benchmark.startup } : undefined,
      resumes: benchmark.resumes?.map((resume: LogoResumeSample) => ({ ...resume })),
      frames: benchmark.frames?.map((frame: LogoPerformanceFrame) => ({ ...frame })),
      gpu: benchmark.gpu?.map((sample: LogoGpuTimingSample) => ({ ...sample })),
      counters: benchmark.counters ? { ...benchmark.counters } : undefined,
      apiObservations: {
        webgpu: { ...benchmark.apiObservations.webgpu },
        webgl2: { ...benchmark.apiObservations.webgl2 }
      }
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
      const logoPerformanceWindow = (): LogoPerformanceWindow => window as LogoPerformanceWindow
      const benchmark = logoPerformanceWindow().__logoParticlePerformance
      if (!benchmark) throw new Error('Particle performance benchmark is unavailable')
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
            pointerId: 1,
            button: 0,
            buttons: pointerEvent.type === 'pointerdown' ? 1 : 0,
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

async function driveAnimationInput(page: Page, primeSegmentCount: number): Promise<AnimationInputMeasurement> {
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
  let explosionDispatchCount = 0
  let nextX = endX
  const segmentTotal = Math.ceil(animationSampleMilliseconds / animationInputCadenceMilliseconds)
  const inputStartedAt = Date.now()
  let nextExplosionAt = inputStartedAt
  for (let segment = 0; segment < segmentTotal; segment += 1) {
    const pointerMotion = await dispatchPerformancePointerEvent(page, 'pointermove', nextX, centerY)
    if (!pointerMotion.frameAdvanced || pointerMotion.activeImpulseCount === null) diagnosticFrameSampleFailures += 1
    maximumSynchronizedActiveImpulseCount = Math.max(maximumSynchronizedActiveImpulseCount, pointerMotion.activeImpulseCount ?? 0)
    segmentCount += 1
    if (Date.now() >= nextExplosionAt) {
      const explosionMotion = await dispatchPerformancePointerEvent(page, 'pointerdown', nextX, centerY)
      if (!explosionMotion.frameAdvanced || explosionMotion.activeExplosionCount === null || explosionMotion.activeImpulseCount === null) {
        diagnosticFrameSampleFailures += 1
      }
      await dispatchPerformancePointerEvent(page, 'pointerup', nextX, centerY)
      explosionDispatchCount += 1
      do {
        nextExplosionAt += animationExplosionCadenceMilliseconds
      } while (nextExplosionAt <= Date.now())
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
    explosionCadenceMilliseconds: animationExplosionCadenceMilliseconds,
    explosionDispatchCount,
    maximumSynchronizedActiveImpulseCount,
    primeSegmentCount,
    segmentCount,
    segmentCss: animationInputSegmentCss
  }
}

async function readInactivityMeasurement(page: Page): Promise<InactivityMeasurement> {
  const measurement = await readMeasurements(page)
  const counters = measurement.counters ?? null
  const frames = measurement.frames
  const logicalScheduledBytes = frames === undefined ? null : frames.length === 0 ? 0 : sumNullable(frameField(frames, 'motionScheduledBytes'))
  const uploadObservation = selectedUploadObservation(measurement)
  return {
    callbackCount: measurement.callbackCount,
    callbackCpuMilliseconds: measurement.callbackCpuMilliseconds,
    canvasCount: await page.locator('.login-particle-logo canvas').count(),
    counters,
    drawCallsDelta: counterValue(counters ?? undefined, 'draws'),
    logicalScheduledBytes,
    actualUploadBytes: uploadObservation.bytes,
    actualUploadCalls: uploadObservation.calls,
    uploadObservations: uploadObservationsFor(measurement),
    durationMilliseconds: inactivitySampleMilliseconds,
    effectiveBackend: effectiveBackend(measurement),
    rafCallbacksDelta: counterValue(counters ?? undefined, 'rafCallbacks')
  }
}

async function measureHidden(page: Page): Promise<InactivityMeasurement> {
  await page.evaluate(() => {
    const setVisibility = window.__setLogoParticleVisibility
    if (!setVisibility) throw new Error('Particle visibility hook is unavailable')
    setVisibility('hidden')
  })
  await resetMeasurements(page)
  await page.waitForTimeout(inactivitySampleMilliseconds)
  return readInactivityMeasurement(page)
}

async function measureOffscreen(page: Page): Promise<InactivityMeasurement> {
  await page.evaluate(() => {
    const setVisibility = window.__setLogoParticleVisibility
    if (!setVisibility) throw new Error('Particle visibility hook is unavailable')
    setVisibility('visible')
    const login = document.querySelector('.login')
    if (!(login instanceof HTMLElement)) throw new Error('Login surface is unavailable')
    login.style.transform = 'translateX(-200vw)'
  })
  await page.waitForTimeout(250)
  await resetMeasurements(page)
  await page.waitForTimeout(inactivitySampleMilliseconds)
  return readInactivityMeasurement(page)
}
async function resumeFromOffscreen(page: Page): Promise<{ sample: ResumeSample | undefined; timeout: boolean; observed: boolean }> {
  const before = await readMeasurements(page)
  const beforeFrameAt = before.lastFrameAt
  await page.evaluate(() => {
    const setVisibility = window.__setLogoParticleVisibility
    if (!setVisibility) throw new Error('Particle visibility hook is unavailable')
    const login = document.querySelector('.login')
    if (!(login instanceof HTMLElement)) throw new Error('Login surface is unavailable')
    setVisibility('visible')
    login.style.transform = ''
  })
  let timeout = false
  try {
    await page.waitForFunction(
      previousFrameAt => {
        const logoPerformanceWindow = (): LogoPerformanceWindow => window as LogoPerformanceWindow
        const benchmark = logoPerformanceWindow().__logoParticlePerformance
        if (!benchmark) throw new Error('Particle performance benchmark is unavailable')
        return benchmark.lastFrameAt !== previousFrameAt && typeof benchmark.lastFrameAt === 'number'
      },
      beforeFrameAt,
      { timeout: firstFrameTimeoutMilliseconds }
    )
  } catch (error: unknown) {
    if (!(error instanceof errors.TimeoutError)) throw error
    timeout = true
  }
  const after = await readMeasurements(page)
  const resume = after.resumes?.slice(before.resumes?.length ?? 0).at(0)
  return { sample: resume, timeout, observed: resume !== undefined }
}

function addExactViolation(violations: Violation[], invariant: string, measured: number | null, expected: number): void {
  if (measured === null || !Number.isFinite(measured) || measured !== expected) {
    violations.push({ invariant, measured, threshold: expected })
  }
}
function addObservedZeroViolation(violations: Violation[], invariant: string, measured: number | null): void {
  if (measured !== null) addExactViolation(violations, invariant, measured, 0)
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

test('enforces managed login cloud runtime budgets with bounded explosions', async ({ browser, browserName }, testInfo) => {
  test.skip(!performanceProjectNames[testInfo.project.name], 'Measured only by a strict backend performance project')
  test.setTimeout(180_000)

  const requestedBackend: StrictBackend = testInfo.project.name === 'performance-webgpu' ? 'webgpu' : 'webgl2'
  const performanceProfile = performanceProfileForProject(testInfo.project.name)
  const reportPath = reportPathForBackend(requestedBackend, testInfo.project.name)
  const firstFrameSamplesMilliseconds: number[] = []
  const coldRuns: Array<{
    readonly firstFrameMilliseconds: number | null
    readonly measurement: BenchmarkMeasurement
    readonly run: number
    readonly timedOut: boolean
  }> = []
  let firstFrameTimeouts = 0

  for (let run = 0; run < firstFrameRuns; run += 1) {
    const { context, page } = await createMeasuredPage(browser, viewport, requestedBackend)
    let firstFrameMilliseconds: number | null = null
    let timedOut = false
    try {
      firstFrameMilliseconds = await waitForFirstFrame(page)
      firstFrameSamplesMilliseconds.push(firstFrameMilliseconds)
    } catch (error: unknown) {
      if (!(error instanceof errors.TimeoutError)) throw error
      firstFrameTimeouts += 1
      timedOut = true
    } finally {
      const measurement = await readMeasurements(page)
      coldRuns.push({ firstFrameMilliseconds, measurement, run, timedOut })
      await context.close()
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, coldContextTeardownSettleMilliseconds)
      await promise
    }
  }

  const { context, page } = await createMeasuredPage(browser, viewport, requestedBackend)
  let animation: BenchmarkMeasurement | undefined
  let animationInput: AnimationInputMeasurement | undefined
  let animationSetupTimeouts = 0
  let hidden: InactivityMeasurement | undefined
  let offscreen: InactivityMeasurement | undefined
  let resumeSample: ResumeSample | undefined
  let resumeTelemetryObserved = false
  let resumeTimeouts = 0
  let recoveredActiveExplosions: number | null = null
  let recoveryDiagnosticFrameSampleFailures = 0
  let actualDeviceScaleFactor: number | undefined
  let actualViewport: { width: number; height: number } | undefined
  let environmentMetadata: EnvironmentMetadata | undefined

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
    animationInput = await driveAnimationInput(page, animationInputPrimeSegments)
    animation = await readMeasurements(page)
    await page.waitForTimeout(explosionRecoveryMilliseconds)
    const recoveryMotion = await readMotionAfterRenderedFrame(page)
    if (!recoveryMotion.frameAdvanced || recoveryMotion.activeExplosionCount === null) recoveryDiagnosticFrameSampleFailures += 1
    else recoveredActiveExplosions = recoveryMotion.activeExplosionCount
    actualDeviceScaleFactor = await page.evaluate(() => window.devicePixelRatio)
    actualViewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    environmentMetadata = await page.evaluate(async (): Promise<EnvironmentMetadata> => {
      const readString = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
      const canvasElement = document.querySelector('.login-particle-logo canvas')
      const canvas: CanvasEnvironmentObservation =
        canvasElement instanceof HTMLCanvasElement
          ? (() => {
              const bounds = canvasElement.getBoundingClientRect()
              const css = [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)
                ? { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }
                : null
              const backing =
                Number.isInteger(canvasElement.width) && Number.isInteger(canvasElement.height) && canvasElement.width >= 0 && canvasElement.height >= 0
                  ? { width: canvasElement.width, height: canvasElement.height }
                  : null
              return {
                css,
                backing,
                devicePixelRatio: Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : null
              }
            })()
          : { css: null, backing: null, devicePixelRatio: null }
      let webglContext: WebGL2RenderingContext | null = null
      let webglContextReason: string | undefined
      let webglContextSource: 'active-canvas' | 'diagnostic-canvas' | 'unavailable' = 'unavailable'
      if (canvasElement instanceof HTMLCanvasElement) {
        try {
          webglContext = canvasElement.getContext('webgl2')
          if (webglContext) webglContextSource = 'active-canvas'
        } catch {
          webglContextReason = 'The active canvas WebGL2 context could not be inspected'
        }
      }
      if (!webglContext) {
        try {
          const probeCanvas = document.createElement('canvas')
          probeCanvas.width = 1
          probeCanvas.height = 1
          webglContext = probeCanvas.getContext('webgl2')
          if (webglContext) webglContextSource = 'diagnostic-canvas'
          else webglContextReason = 'A diagnostic WebGL2 context could not be created'
        } catch {
          webglContextReason = 'Creating a diagnostic WebGL2 context threw'
        }
      }
      const readWebglString = (parameter: number): string | null => {
        if (!webglContext) return null
        try {
          return readString(webglContext.getParameter(parameter))
        } catch {
          return null
        }
      }
      let debugRendererInfoAvailable = false
      let unmaskedVendor: string | null = null
      let unmaskedRenderer: string | null = null
      if (webglContext) {
        try {
          const debugInfo = webglContext.getExtension('WEBGL_debug_renderer_info') as {
            readonly UNMASKED_VENDOR_WEBGL?: number
            readonly UNMASKED_RENDERER_WEBGL?: number
          } | null
          if (debugInfo) {
            debugRendererInfoAvailable = true
            if (typeof debugInfo.UNMASKED_VENDOR_WEBGL === 'number') {
              unmaskedVendor = readWebglString(debugInfo.UNMASKED_VENDOR_WEBGL)
            }
            if (typeof debugInfo.UNMASKED_RENDERER_WEBGL === 'number') {
              unmaskedRenderer = readWebglString(debugInfo.UNMASKED_RENDERER_WEBGL)
            }
          }
        } catch {
          debugRendererInfoAvailable = false
        }
      }

      type NavigatorWithGpu = Navigator & {
        readonly gpu?: {
          requestAdapter?: () => Promise<unknown>
        }
      }
      const gpuNavigator = navigator as NavigatorWithGpu
      let adapterAvailable = false
      let adapterReason: string | undefined
      let gpuVendor: string | null = null
      let gpuArchitecture: string | null = null
      let gpuDevice: string | null = null
      let gpuDescription: string | null = null
      const readAdapterInfoString = (info: unknown, name: string): string | null => {
        if (info === null || typeof info !== 'object' || !(name in info)) return null
        return readString(Reflect.get(info, name))
      }
      const gpu = gpuNavigator.gpu
      const requestAdapter = gpu?.requestAdapter
      if (!requestAdapter) {
        adapterReason = 'navigator.gpu.requestAdapter is unavailable'
      } else {
        try {
          const adapter = await requestAdapter.call(gpu)
          if (!adapter || typeof adapter !== 'object') {
            adapterReason = 'WebGPU requestAdapter returned no adapter'
          } else {
            adapterAvailable = true
            const info = 'info' in adapter ? adapter.info : undefined
            gpuVendor = readAdapterInfoString(info, 'vendor')
            gpuArchitecture = readAdapterInfoString(info, 'architecture')
            gpuDevice = readAdapterInfoString(info, 'device')
            gpuDescription = readAdapterInfoString(info, 'description')
          }
        } catch {
          adapterReason = 'WebGPU requestAdapter threw'
        }
      }
      return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        hardwareConcurrency: Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : null,
        timeOrigin: Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : null,
        canvas,
        graphics: {
          webgl2: {
            source: webglContextSource,
            contextAvailable: webglContext !== null,
            debugRendererInfoAvailable,
            vendor: webglContext ? readWebglString(webglContext.VENDOR) : null,
            renderer: webglContext ? readWebglString(webglContext.RENDERER) : null,
            unmaskedVendor,
            unmaskedRenderer,
            ...(webglContextReason ? { reason: webglContextReason } : {})
          },
          webgpu: {
            adapterAvailable,
            vendor: gpuVendor,
            architecture: gpuArchitecture,
            device: gpuDevice,
            description: gpuDescription,
            ...(adapterReason ? { reason: adapterReason } : {})
          }
        }
      }
    })
    hidden = await measureHidden(page)
    offscreen = await measureOffscreen(page)
    const resumed = await resumeFromOffscreen(page)
    resumeSample = resumed.sample
    resumeTelemetryObserved = resumed.observed
    if (resumed.timeout) resumeTimeouts += 1
  } finally {
    await context.close()
  }

  const ineligible = await createMeasuredPage(browser, { width: 959, height: viewport.height }, requestedBackend)
  let hardIneligibleCanvasCount: number | null = null
  let hardIneligibleCallbackCount: number | null = null
  let hardIneligibleMeasurement: BenchmarkMeasurement | undefined
  try {
    await ineligible.page.goto('/login', { waitUntil: 'domcontentloaded' })
    await ineligible.page.locator('form.login-form').waitFor({ state: 'visible' })
    await ineligible.page.waitForTimeout(500)
    hardIneligibleCanvasCount = await ineligible.page.locator('.login-particle-logo canvas').count()
    hardIneligibleMeasurement = await readMeasurements(ineligible.page)
    hardIneligibleCallbackCount = hardIneligibleMeasurement.callbackCount
  } finally {
    await ineligible.context.close()
  }

  if (
    animation === undefined ||
    animationInput === undefined ||
    hidden === undefined ||
    offscreen === undefined ||
    actualDeviceScaleFactor === undefined ||
    actualViewport === undefined ||
    environmentMetadata === undefined
  ) {
    throw new Error('Particle performance instrumentation did not produce the required animation measurements')
  }

  const firstFrameP95Milliseconds = nearestRank(firstFrameSamplesMilliseconds, 0.95)
  const animatedFrameCoverageMilliseconds = animation.frameIntervalsMilliseconds.reduce((total, interval) => total + interval, 0)
  const animatedFrameP95Milliseconds = nearestRank(animation.frameIntervalsMilliseconds, 0.95)
  const animatedFrameP99Milliseconds = nearestRank(animation.frameIntervalsMilliseconds, 0.99)
  const callbackCpuP95Milliseconds = nearestRank(animation.callbackCpuMilliseconds, 0.95)
  const frames = animation.frames
  const measuredFrames = frames ?? []
  const updateCpuMilliseconds = frameField(frames, 'updateCpuMs')
  const renderInvocationCpuMilliseconds = frameField(frames, 'renderInvocationCpuMs')
  const afterRenderCpuMilliseconds = frameField(frames, 'afterRenderCpuMs')
  const frameDrawCalls = frameField(frames, 'totalDrawCalls')
  const frameParticleInstances = frameField(frames, 'particleInstances')
  const frameTriangles = frameField(frames, 'triangles')
  const frameComputeDispatches = frameField(frames, 'computeDispatches')
  const frameMotionScheduledBytes = frameField(frames, 'motionScheduledBytes')
  const frameColorUploadBytes = frameField(frames, 'colorUploadBytes')
  const requiredFrameFields: readonly (keyof PerformanceFrameSample)[] = [
    'frameId',
    'submittedAt',
    'updateCpuMs',
    'renderCallbackGapMs',
    'renderInvocationCpuMs',
    'afterRenderCpuMs',
    'totalDrawCalls',
    'particleInstances',
    'triangles',
    'computeDispatches',
    'motionScheduledBytes',
    'colorUploadBytes'
  ]
  const renderCallbackGapMilliseconds = frameField(frames, 'renderCallbackGapMs')
  const frameInstrumentationFailures =
    frames === undefined
      ? 1
      : frames.reduce((failures, frame) => {
          const missing = requiredFrameFields.some(field => {
            const value = frame[field]
            return typeof value !== 'number' || !Number.isFinite(value)
          })
          return failures + (missing ? 1 : 0)
        }, 0)
  const phaseCpu = {
    update: {
      samplesMilliseconds: updateCpuMilliseconds,
      sampleCount: updateCpuMilliseconds.length,
      unavailableSamples: updateCpuMilliseconds.filter(sample => sample === null).length,
      nearestRankP95Milliseconds: nearestRankNullable(updateCpuMilliseconds, 0.95)
    },
    renderInvocation: {
      samplesMilliseconds: renderInvocationCpuMilliseconds,
      sampleCount: renderInvocationCpuMilliseconds.length,
      unavailableSamples: renderInvocationCpuMilliseconds.filter(sample => sample === null).length,
      nearestRankP95Milliseconds: nearestRankNullable(renderInvocationCpuMilliseconds, 0.95)
    },
    afterRender: {
      samplesMilliseconds: afterRenderCpuMilliseconds,
      sampleCount: afterRenderCpuMilliseconds.length,
      unavailableSamples: afterRenderCpuMilliseconds.filter(sample => sample === null).length,
      nearestRankP95Milliseconds: nearestRankNullable(afterRenderCpuMilliseconds, 0.95)
    }
  }
  const phaseScheduling = {
    renderCallbackGap: {
      samplesMilliseconds: renderCallbackGapMilliseconds,
      sampleCount: renderCallbackGapMilliseconds.length,
      unavailableSamples: renderCallbackGapMilliseconds.filter(sample => sample === null).length,
      nearestRankP95Milliseconds: nearestRankNullable(renderCallbackGapMilliseconds, 0.95)
    }
  }
  const startup = animation.startup
  const firstSubmissionLatencyMilliseconds = latencyMilliseconds(startup?.enhancementScheduledAt, startup?.firstSubmissionAt)
  const visibleCommitLatencyMilliseconds = latencyMilliseconds(startup?.enhancementScheduledAt, startup?.visibleCommitAt)
  const startupInstrumentationFailures =
    startup === undefined
      ? 3
      : [startup.enhancementScheduledAt, startup.firstSubmissionAt, startup.visibleCommitAt].filter(
          timestamp => typeof timestamp !== 'number' || !Number.isFinite(timestamp)
        ).length
  const resumeLatency = {
    firstSubmissionMilliseconds: latencyMilliseconds(resumeSample?.startedAt, resumeSample?.firstSubmissionAt),
    visibleCommitMilliseconds: latencyMilliseconds(resumeSample?.startedAt, resumeSample?.visibleCommitAt)
  }
  const backendMeasurements = [
    ...coldRuns.map(run => run.measurement),
    animation,
    ...(hardIneligibleMeasurement === undefined ? [] : [hardIneligibleMeasurement])
  ]
  const allBackendDiagnostics = backendMeasurements.flatMap(measurement => [...diagnostics(measurement)])
  const failedBackendDiagnostics = backendMeasurements.flatMap(measurement => [...failedDiagnostics(measurement)])
  const measuredEffectiveBackends = backendMeasurements.map(measurement => effectiveBackend(measurement))
  const effective = effectiveBackend(animation)
  const diagnosticsPresent = (animation.backendDiagnostics?.length ?? 0) > 0 && coldRuns.every(run => (run.measurement.backendDiagnostics?.length ?? 0) > 0)
  const diagnosticIdentityMatch =
    diagnosticsPresent &&
    allBackendDiagnostics.every(
      diagnostic =>
        diagnostic.requestedBackend === requestedBackend &&
        (diagnostic.effectiveBackend === null || diagnostic.effectiveBackend === 'webgpu' || diagnostic.effectiveBackend === 'webgl2')
    )
  const backendIdentityMatch =
    animation.requestedBackend === requestedBackend &&
    effective === requestedBackend &&
    coldRuns.every(run => run.measurement.requestedBackend === requestedBackend && effectiveBackend(run.measurement) === requestedBackend) &&
    diagnosticIdentityMatch
  const logicalDynamicUploadBytes = sumNullable(frameMotionScheduledBytes)
  const uploadObservations = uploadObservationsFor(animation)
  const activeUploadObservation = uploadObservationFor(animation, requestedBackend)
  const actualUploadBytes = activeUploadObservation.bytes
  const uploadCalls = activeUploadObservation.calls
  const colorUploadBytes = sumNullable(frameColorUploadBytes)
  const drawCalls = {
    delta: counterValue(animation.counters, 'draws'),
    samples: frameDrawCalls,
    sampledTotal: sumNullable(frameDrawCalls),
    unavailableSamples: frameDrawCalls.filter(sample => sample === null).length
  }
  const triangles = {
    delta: sumNullable(frameTriangles),
    samples: frameTriangles,
    sampledTotal: sumNullable(frameTriangles),
    unavailableSamples: frameTriangles.filter(sample => sample === null).length
  }
  const gpuSamples = animation.gpu ?? []
  const gpuReportSamples: readonly LogoGpuTimingSample[] =
    gpuSamples.length > 0
      ? gpuSamples
      : [
          {
            status: 'unavailable',
            reason:
              requestedBackend === 'webgl2'
                ? 'No completed EXT_disjoint_timer_query_webgl2 observation was available'
                : 'EXT_disjoint_timer_query_webgl2 timing applies only to strict WebGL2'
          }
        ]
  const gpuAvailableSamples = gpuReportSamples.filter(
    sample => sample.status === 'available' && typeof sample.durationMs === 'number' && Number.isFinite(sample.durationMs)
  )
  const gpuUnavailableSamples = gpuReportSamples.filter(sample => sample.status === 'unavailable')
  const gpuTiming = {
    samples: gpuReportSamples,
    available: gpuAvailableSamples.length > 0,
    availableSamples: gpuAvailableSamples,
    unavailableSamples: gpuUnavailableSamples,
    unavailableCount: gpuUnavailableSamples.length,
    unavailableReasons: gpuUnavailableSamples.map(sample => sample.reason).filter((reason): reason is string => typeof reason === 'string' && reason.length > 0)
  }
  const motion = animation.lastMotion
  const counterFields: readonly (keyof BenchmarkCounters)[] = [
    'updateCallbacks',
    'renderInvocations',
    'afterRenderCallbacks',
    'rafCallbacks',
    'draws',
    'sampleOverflow'
  ]
  const counterInstrumentationFailures =
    animation.counters === undefined
      ? counterFields.length
      : counterFields.reduce((failures, field) => failures + (counterValue(animation.counters, field) === null ? 1 : 0), 0)
  const violations: Violation[] = []
  addExactViolation(violations, 'backend.requestedBackend === options.requestedBackend', backendIdentityMatch ? 1 : 0, 1)
  addExactViolation(violations, 'backend.effectiveBackend === options.requestedBackend', backendIdentityMatch ? 1 : 0, 1)
  addExactViolation(violations, 'backendDiagnostics preserve diagnostic shape and requested identity', diagnosticIdentityMatch ? 1 : 0, 1)
  addExactViolation(violations, 'backendDiagnostics are present for every eligible context', diagnosticsPresent ? 1 : 0, 1)
  addExactViolation(violations, 'startup timestamps are present', startupInstrumentationFailures, 0)
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
  addExactViolation(violations, 'animation.frames are present and non-empty', frames === undefined || frames.length === 0 ? 0 : 1, 1)
  addExactViolation(violations, 'animation.frames contain mandatory instrumentation', frameInstrumentationFailures, 0)
  addExactViolation(
    violations,
    'animation.frames.every(frame => frame.totalDrawCalls === 1)',
    frames !== undefined && frameDrawCalls.length === frames.length && frameDrawCalls.every(sample => sample === 1) ? 1 : 0,
    1
  )
  addExactViolation(
    violations,
    'animation.frames.every(frame => frame.particleInstances === 16000)',
    frames !== undefined && frameParticleInstances.length === frames.length && frameParticleInstances.every(sample => sample === descriptor.count) ? 1 : 0,
    1
  )
  addExactViolation(
    violations,
    'animation.frames.every(frame => frame.triangles === 2N)',
    frames !== undefined && frameTriangles.length === frames.length && frameTriangles.every(sample => sample === expectedTriangles) ? 1 : 0,
    1
  )
  addExactViolation(
    violations,
    'animation.frames.every(frame => frame.computeDispatches === 0)',
    frames !== undefined && frameComputeDispatches.length === frames.length && frameComputeDispatches.every(sample => sample === 0) ? 1 : 0,
    1
  )
  addExactViolation(
    violations,
    'animation.frames.every(frame => frame.motionScheduledBytes === 128000)',
    frames !== undefined &&
      frameMotionScheduledBytes.length === frames.length &&
      frameMotionScheduledBytes.every(sample => sample === expectedActiveMotionBytes)
      ? 1
      : 0,
    1
  )
  addExactViolation(
    violations,
    'animation.frames.every(frame => frame.colorUploadBytes === 0)',
    frames !== undefined && frameColorUploadBytes.length === frames.length && frameColorUploadBytes.every(sample => sample === 0) ? 1 : 0,
    1
  )
  addExactViolation(
    violations,
    'animation.logicalDynamicUploadBytes === activeMotionBytes * frameCount',
    logicalDynamicUploadBytes,
    expectedActiveMotionBytes * measuredFrames.length
  )
  addExactViolation(violations, 'animation.draws.delta === animation.frames.length', drawCalls.delta, measuredFrames.length)
  addExactViolation(
    violations,
    'animation.triangles.sampledTotal === 2N * animation.frames.length',
    triangles.sampledTotal,
    expectedTriangles * measuredFrames.length
  )
  addExactViolation(
    violations,
    'animation.phaseCpu.update has one finite sample per frame',
    phaseCpu.update.sampleCount === measuredFrames.length && phaseCpu.update.unavailableSamples === 0 ? 1 : 0,
    1
  )
  addExactViolation(
    violations,
    'animation.phaseCpu.renderInvocation has one finite sample per frame',
    phaseCpu.renderInvocation.sampleCount === measuredFrames.length && phaseCpu.renderInvocation.unavailableSamples === 0 ? 1 : 0,
    1
  )
  addExactViolation(
    violations,
    'animation.phaseCpu.afterRender has one finite sample per frame',
    phaseCpu.afterRender.sampleCount === measuredFrames.length && phaseCpu.afterRender.unavailableSamples === 0 ? 1 : 0,
    1
  )
  addExactViolation(
    violations,
    'animation.phaseScheduling.renderCallbackGap has one finite sample per frame',
    phaseScheduling.renderCallbackGap.sampleCount === measuredFrames.length && phaseScheduling.renderCallbackGap.unavailableSamples === 0 ? 1 : 0,
    1
  )
  addExactViolation(violations, 'animation.counters contain mandatory instrumentation', counterInstrumentationFailures, 0)
  // RAF observation is page-global and advisory: Three's retained common renderer
  // keeps lightweight bookkeeping alive without producing particle work.
  addExactViolation(violations, 'hidden.callbackCount === 0', hidden.callbackCount, thresholds.inactiveCallbackCount)
  addExactViolation(violations, 'hidden.updateCallbacks === 0', counterValue(hidden.counters, 'updateCallbacks'), 0)
  addExactViolation(violations, 'hidden.renderInvocations === 0', counterValue(hidden.counters, 'renderInvocations'), 0)
  addExactViolation(violations, 'hidden.afterRenderCallbacks === 0', counterValue(hidden.counters, 'afterRenderCallbacks'), 0)
  addExactViolation(violations, 'hidden.canvasCount === 1', hidden.canvasCount, thresholds.retainedCanvasCount)
  addExactViolation(violations, 'hidden.drawCallsDelta === 0', hidden.drawCallsDelta, 0)
  addExactViolation(violations, 'hidden.logicalScheduledBytes === 0', hidden.logicalScheduledBytes, 0)
  addObservedZeroViolation(violations, 'hidden.actualUploadCalls === 0 when observation is available', hidden.actualUploadCalls)
  addObservedZeroViolation(violations, 'hidden.actualUploadBytes === 0 when observation is available', hidden.actualUploadBytes)
  addExactViolation(violations, 'offscreen.callbackCount === 0', offscreen.callbackCount, thresholds.inactiveCallbackCount)
  addExactViolation(violations, 'offscreen.updateCallbacks === 0', counterValue(offscreen.counters, 'updateCallbacks'), 0)
  addExactViolation(violations, 'offscreen.renderInvocations === 0', counterValue(offscreen.counters, 'renderInvocations'), 0)
  addExactViolation(violations, 'offscreen.afterRenderCallbacks === 0', counterValue(offscreen.counters, 'afterRenderCallbacks'), 0)
  addExactViolation(violations, 'offscreen.canvasCount === 1', offscreen.canvasCount, thresholds.retainedCanvasCount)
  addExactViolation(violations, 'offscreen.drawCallsDelta === 0', offscreen.drawCallsDelta, 0)
  addExactViolation(violations, 'offscreen.logicalScheduledBytes === 0', offscreen.logicalScheduledBytes, 0)
  addObservedZeroViolation(violations, 'offscreen.actualUploadCalls === 0 when observation is available', offscreen.actualUploadCalls)
  addObservedZeroViolation(violations, 'offscreen.actualUploadBytes === 0 when observation is available', offscreen.actualUploadBytes)
  addExactViolation(violations, 'resume.timeouts === 0', resumeTimeouts, thresholds.timeouts)
  addExactViolation(violations, 'resume.instrumentation is present', resumeTelemetryObserved ? 1 : 0, 1)
  addExactViolation(violations, 'resume.outcome === committed', resumeSample?.outcome === 'committed' ? 1 : 0, 1)
  addExactViolation(violations, 'resume.firstSubmissionLatencyMilliseconds is observed', resumeLatency.firstSubmissionMilliseconds === null ? 0 : 1, 1)
  addExactViolation(violations, 'resume.visibleCommitLatencyMilliseconds is observed', resumeLatency.visibleCommitMilliseconds === null ? 0 : 1, 1)
  addExactViolation(violations, 'hardIneligible.canvasCount === 0', hardIneligibleCanvasCount, thresholds.hardIneligibleCanvasCount)
  addExactViolation(violations, 'hardIneligible.callbackCount === 0', hardIneligibleCallbackCount, thresholds.inactiveCallbackCount)
  addExactViolation(violations, 'animation.lastMotion is present', motion ? 1 : 0, 1)
  addExactViolation(
    violations,
    'animation.lastMotion publishes only bounded aggregate keys',
    JSON.stringify(animation.lastMotionKeys) === JSON.stringify(motionDiagnosticKeys) ? 1 : 0,
    1
  )
  addExactViolation(
    violations,
    'animation.input.explosionCadenceMilliseconds === 700',
    animationInput.explosionCadenceMilliseconds,
    animationExplosionCadenceMilliseconds
  )
  addMinimumViolation(violations, 'animation.input.peakActiveExplosions >= 1', animation.maximumActiveExplosionCount, 1)
  addMaximumViolation(violations, 'animation.input.peakActiveExplosions <= 6', animation.maximumActiveExplosionCount, thresholds.activeExplosionMaximum)
  addExactViolation(
    violations,
    'animation.input.synchronizedPeakActiveImpulses === 6',
    animationInput.maximumSynchronizedActiveImpulseCount,
    thresholds.activeImpulseMaximum
  )
  addExactViolation(violations, 'animation.performanceSamples.sampleOverflow === 0', counterValue(animation.counters, 'sampleOverflow'), 0)
  if (motion) {
    addExactViolation(violations, 'animation.lastMotion.collisionParticleCount === 512', motion.collisionParticleCount, 512)
    addMaximumViolation(violations, 'animation.lastMotion.particleCount <= parser maximum 16000', motion.particleCount, thresholds.parserParticleMaximum)
    addRangeViolation(
      violations,
      'animation.lastMotion.idleAmplitudeCss is within 3.5..10',
      motion.idleAmplitudeCss,
      thresholds.idleAmplitudeMinimumCss,
      thresholds.idleAmplitudeMaximumCss
    )
    addExactViolation(violations, 'animation.lastMotion.impulseLifetimeSeconds === 1.4', motion.impulseLifetimeSeconds, thresholds.impulseLifetimeSeconds)
    addExactViolation(violations, 'animation.lastMotion.maxImpulseTravelCss === 42', motion.maxImpulseTravelCss, thresholds.maxImpulseTravelCss)
    addExactViolation(violations, 'animation.lastMotion.neighborForceRatio === 0.72', motion.neighborForceRatio, thresholds.neighborForceRatio)
    addExactViolation(violations, 'animation.lastMotion.bounceRatio === 0.4', motion.bounceRatio, thresholds.bounceRatio)
    addExactViolation(violations, 'animation.lastMotion.explosionHoldSeconds === 0.35', motion.explosionHoldSeconds, thresholds.explosionHoldSeconds)
    addExactViolation(violations, 'animation.lastMotion.explosionRefillSeconds === 2.4', motion.explosionRefillSeconds, thresholds.explosionRefillSeconds)
    addExactViolation(violations, 'animation.lastMotion.explosionLifetimeSeconds === 2.8', motion.explosionLifetimeSeconds, thresholds.explosionLifetimeSeconds)
    addExactViolation(violations, 'animation.lastMotion depth diagnostics are ordered', motion.depthScaleMin < motion.depthScaleMax ? 1 : 0, 1)
  }
  addExactViolation(violations, 'animation.explosions recovered to zero', recoveredActiveExplosions, 0)

  const projectMetadata = testInfo.project.metadata
  const capabilityFlags = Array.isArray(projectMetadata.webgpuCapabilityFlags)
    ? projectMetadata.webgpuCapabilityFlags.filter((flag: unknown): flag is string => typeof flag === 'string')
    : []
  const capabilityFlagsPurpose =
    typeof projectMetadata.webgpuCapabilityFlagsPurpose === 'string' ? projectMetadata.webgpuCapabilityFlagsPurpose : 'runner-capability-enablement-only'
  const launchFlags = Array.isArray(projectMetadata.launchFlags)
    ? projectMetadata.launchFlags.filter((flag: unknown): flag is string => typeof flag === 'string')
    : []
  const launchFlagsPurpose = typeof projectMetadata.launchFlagsPurpose === 'string' ? projectMetadata.launchFlagsPurpose : 'backend-selection'
  const headless =
    typeof testInfo.project.use.headless === 'boolean'
      ? testInfo.project.use.headless
      : typeof projectMetadata.headless === 'boolean'
        ? projectMetadata.headless
        : true
  const graphicsClassification = classifyGraphicsIdentity(performanceProfile, environmentMetadata.graphics)
  const report = {
    schemaVersion: 3,
    status: violations.length === 0 ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    options: { requestedBackend, project: testInfo.project.name, performanceProfile },
    backend: {
      requestedBackend,
      effectiveBackend: effective,
      backendDiagnostics: allBackendDiagnostics,
      failedBackendDiagnostics,
      effectiveBackendsObserved: measuredEffectiveBackends,
      strictIdentityMatch: backendIdentityMatch,
      identityClassification: graphicsClassification.classification,
      failureDenominator: failedBackendDiagnostics.length + firstFrameTimeouts
    },
    environment: {
      browser: browserName,
      browserVersion: browser.version(),
      os: process.platform,
      arch: process.arch,
      viewport: actualViewport,
      deviceScaleFactor: actualDeviceScaleFactor,
      userAgent: environmentMetadata.userAgent,
      platform: environmentMetadata.platform,
      language: environmentMetadata.language,
      hardwareConcurrency: environmentMetadata.hardwareConcurrency,
      timeOrigin: environmentMetadata.timeOrigin,
      canvas: environmentMetadata.canvas,
      graphics: {
        ...environmentMetadata.graphics,
        classification: graphicsClassification.classification,
        actualIdentityAvailable: graphicsClassification.actualIdentityAvailable,
        softwareHint: graphicsClassification.softwareHint
      },
      headless,
      browserMode: headless ? 'headless' : 'headful',
      launchFlags,
      launchFlagsPurpose,
      capabilityFlags,
      capabilityFlagsPurpose,
      cacheScope: 'fresh-browser-context',
      gpuCacheState: 'uncontrolled'
    },
    fixture: { descriptor, particleBinaryBytes: particleFixture.byteLength },
    thresholds,
    firstFrame: {
      cacheScope: 'fresh-browser-context',
      gpuCacheState: 'uncontrolled',
      timeoutMilliseconds: firstFrameTimeoutMilliseconds,
      runs: firstFrameRuns,
      failures: coldRuns
        .filter(run => run.timedOut)
        .map(run => ({
          run: run.run,
          timedOut: run.timedOut,
          requestedBackend: run.measurement.requestedBackend,
          effectiveBackend: effectiveBackend(run.measurement),
          backendDiagnostics: [...diagnostics(run.measurement)]
        })),
      failureDenominator: coldRuns.length,
      timeouts: firstFrameTimeouts,
      samplesMilliseconds: firstFrameSamplesMilliseconds,
      nearestRankP95Milliseconds: firstFrameP95Milliseconds,
      startupSamples: coldRuns.map(run => ({
        run: run.run,
        timedOut: run.timedOut,
        firstFrameMilliseconds: run.firstFrameMilliseconds,
        startup: run.measurement.startup,
        firstSubmissionLatencyMilliseconds: latencyMilliseconds(run.measurement.startup?.enhancementScheduledAt, run.measurement.startup?.firstSubmissionAt),
        visibleCommitLatencyMilliseconds: latencyMilliseconds(run.measurement.startup?.enhancementScheduledAt, run.measurement.startup?.visibleCommitAt),
        requestedBackend: run.measurement.requestedBackend,
        effectiveBackend: effectiveBackend(run.measurement),
        backendDiagnostics: [...diagnostics(run.measurement)]
      }))
    },
    startup: startup
      ? {
          milestones: startup,
          firstSubmissionLatencyMilliseconds,
          visibleCommitLatencyMilliseconds,
          firstSubmissionAt: startup.firstSubmissionAt,
          visibleCommitAt: startup.visibleCommitAt
        }
      : undefined,
    animation: {
      warmUpMilliseconds,
      setupTimeouts: animationSetupTimeouts,
      sampleDurationMilliseconds: animationSampleMilliseconds,
      inputCadenceMilliseconds: animationInput.cadenceMilliseconds,
      inputSegmentCss: animationInput.segmentCss,
      inputSegmentCount: animationInput.segmentCount,
      inputPrimeSegmentCount: animationInput.primeSegmentCount,
      explosionCadenceMilliseconds: animationInput.explosionCadenceMilliseconds,
      explosionDispatchCount: animationInput.explosionDispatchCount,
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
      renderCallbackGapMilliseconds,
      renderCallbackGapNearestRankP95Milliseconds: phaseScheduling.renderCallbackGap.nearestRankP95Milliseconds,
      phaseScheduling,
      phaseCpu,
      frames,
      frameSampleFailureDenominator: frames?.length,
      frameInstrumentationFailures,
      draws: drawCalls,
      triangles,
      dynamicUploads: {
        logicalScheduledBytes: logicalDynamicUploadBytes,
        logicalDynamicUploadBytes,
        scheduledBytesPerFrame: frameMotionScheduledBytes,
        actualObservedUploadBytes: actualUploadBytes,
        actualObservedUploadCalls: uploadCalls,
        activeObservationBackend: requestedBackend,
        uploadObservations,
        activeUploadMetricsAdvisory: true,
        colorUploadBytes
      },
      gpuTiming,
      counters: animation.counters,
      firstSubmissionAt: startup?.firstSubmissionAt,
      lastMotion: motion
    },
    resumes: {
      samples: [...(animation.resumes ?? []), ...(resumeSample === undefined ? [] : [resumeSample])],
      timeoutCount: resumeTimeouts,
      latest: resumeSample,
      firstSubmissionLatencyMilliseconds: resumeLatency.firstSubmissionMilliseconds,
      visibleCommitLatencyMilliseconds: resumeLatency.visibleCommitMilliseconds
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
  writeReportAtomically(reportPath, report)
  expect(violations, 'logo particle runtime budget violations').toEqual([])
})
