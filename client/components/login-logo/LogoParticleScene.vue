<template>
  <TresCanvas
    v-if="resources && canvasMounted"
    class="login-logo-particle-scene"
    aria-hidden="true"
    :alpha="true"
    :antialias="false"
    :camera="resources.camera"
    :clear-alpha="0"
    clear-color="#000000"
    :depth="false"
    :dpr="[1, 1.5]"
    :premultiplied-alpha="true"
    :output-color-space="LinearSRGBColorSpace"
    :renderer="rendererFactory"
    render-mode="on-demand"
    :stencil="false"
    :tone-mapping="NoToneMapping"
    @error="handleRendererError"
    @ready="handleRendererReady"
    @render="handleRendererRender"
  >
    <ParticleSceneContents
      :active="renderEnabled"
      :loop-control="loopControl"
      :fence="fence"
      :resources="resources"
      :pointer-controller="pointerController"
      @fault="handleRendererError"
    />
  </TresCanvas>
</template>

<script lang="ts">
import { TresCanvas, useLoop, useTres } from '@tresjs/core'
import type { TresContext, TresRenderer, TresRendererSetupContext } from '@tresjs/core'
import {
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearSRGBColorSpace,
  Mesh,
  NoToneMapping,
  OrthographicCamera,
  Vector2,
  Vector4
} from 'three/webgpu'
import { uniform } from 'three/tsl'
import {
  defineComponent,
  h,
  markRaw,
  onBeforeUnmount,
  onMounted,
  type PropType,
  ref,
  shallowRef,
  unref,
  watch
} from 'vue'
import type { LogoEffectDescriptor, ParsedLogoParticles } from './particle-logo'
import { ParticleCloud } from './particle-cloud'
import { updateParticleColors } from './particle-colors'
import {
  createParticleSpriteGeometry,
  createParticleSpriteMaterial,
  type ParticleNodeUniforms
} from './particle-material'
import {
  createParticleBackendLease,
  type ParticleBackendDiagnostics,
  type ParticleBackendLease,
  type ParticleBackendRequest,
  type LogoParticleRenderer
} from './particle-renderer'
import {
  LOGO_POINTER_BOUNCE_RATIO,
  LOGO_POINTER_EXPLOSION_CAPACITY,
  LOGO_POINTER_EXPLOSION_MIN_SCALE,
  LOGO_POINTER_EXPLOSION_MAX_SCALE,
  LOGO_POINTER_EXPLOSION_HOLD_SECONDS,
  LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS,
  LOGO_POINTER_EXPLOSION_REFILL_SECONDS,
  LOGO_POINTER_IMPULSE_CAPACITY,
  LOGO_POINTER_IMPULSE_LIFETIME_SECONDS,
  LOGO_POINTER_NEIGHBOR_FORCE_RATIO,
  LOGO_POINTER_MAX_TRAVEL_CSS,
  useLogoPointer
} from './useLogoPointer'
import type { LogoPointerController, LogoPointerState } from './useLogoPointer'

const DEPTH_SCALE_MIN = 0.82
const DEPTH_SCALE_MAX = 1.18
const MIN_IDLE_AMPLITUDE_CSS = 3.5
const MAX_IDLE_AMPLITUDE_CSS = 10
const MAX_DIAGNOSTIC_ELAPSED_SECONDS = Number.MAX_SAFE_INTEGER
const MAX_DIAGNOSTIC_PARTICLES = 16_000
const MAX_BENCHMARK_FRAMES = 2048

export type ParticleUniforms = ParticleNodeUniforms

export interface ParticleMotionDiagnostics {
  activeExplosionCount: number
  activeImpulseCount: number
  bounceRatio: number
  collisionParticleCount: number
  depthScaleMax: number
  depthScaleMin: number
  elapsedSeconds: number
  explosionHoldSeconds: number
  explosionLifetimeSeconds: number
  explosionRefillSeconds: number
  idleAmplitudeCss: number
  impulseLifetimeSeconds: number
  maxImpulseTravelCss: number
  neighborForceRatio: number
  particleCount: number
}

export interface ParticleSceneResources {
  readonly camera: OrthographicCamera
  readonly cloud: ParticleCloud
  readonly cloudMotion: InstancedBufferAttribute
  readonly particleColor: InstancedBufferAttribute
  readonly particles: ParsedLogoParticles
  readonly geometry: InstancedBufferGeometry
  readonly material: ReturnType<typeof createParticleSpriteMaterial>
  readonly motionDiagnostics: ParticleMotionDiagnostics | null
  readonly motionDiagnosticsBenchmark: ParticlePerformanceBenchmark | null
  readonly mesh: Mesh<InstancedBufferGeometry, ReturnType<typeof createParticleSpriteMaterial>>
  readonly uniforms: ParticleUniforms
  disposed: boolean
}

export interface ParticleSceneFrame {
  elapsed: number
  height: number
  pixelRatio: number
  pointerTimeMilliseconds?: number
  width: number
}

interface ParticleLoopControl {
  disposeFrameCapture?: (reason: Error) => void
  onFailure?: (outcome: 'failed' | 'lost' | 'retired', reason: string) => void
  ready: boolean
  start: (() => void) | null
  stop: (() => void) | null
}

interface ParticleFrameCaptureOptions {
  readonly elapsedSeconds?: number
  readonly pointerTimeMilliseconds?: number
}

interface ParticleFrameCapture {
  readonly dataUrl: string
  readonly capturedAt: number
}

type ParticleFrameCaptureRequest = (options?: ParticleFrameCaptureOptions) => Promise<ParticleFrameCapture>

interface ParticleFrameCaptureHook {
  request: ParticleFrameCaptureRequest | null
}

interface ParticleFrameCaptureRegistration {
  afterRender: (canvas: HTMLCanvasElement) => void
  consumeElapsedSecondsOverride: () => number | undefined
  currentTimeMilliseconds: () => number | undefined
  dispose: (reason: Error) => void
}

interface PendingParticleFrameCapture {
  elapsedSeconds?: number
  pointerTimeMilliseconds?: number
  readonly reject: (reason: Error) => void
  readonly resolve: (capture: ParticleFrameCapture) => void
}

type ParticleFrameCaptureWindow = Window & {
  readonly __logoParticleFrameCapture?: unknown
}

interface ParticleFrameCaptureClock {
  currentTimeMilliseconds?: number
  readonly hook: ParticleFrameCaptureHook
  readonly now: () => number
}

const particleFrameCaptureClocks = new WeakMap<ParticleFrameCaptureHook, ParticleFrameCaptureClock>()

interface SceneEvents {
  readonly firstFrame: () => void
  readonly submission?: (submittedAt: number) => void
  readonly framePending: () => void
  readonly error: (error: Error) => void
  readonly contextLost: (event: Event) => void
}

interface ParticlePerformanceStartup {
  enhancementScheduledAt?: number
  resourcesStartedAt?: number
  resourcesEndedAt?: number
  initStartedAt?: number
  initEndedAt?: number
  firstSubmissionAt?: number
  visibleCommitAt?: number
}

interface ParticlePerformanceResume {
  readonly startedAt: number
  firstSubmissionAt?: number | null
  visibleCommitAt?: number | null
  outcome?: 'committed' | 'failed' | 'lost' | 'retired'
  reason?: string
}

interface ParticlePerformanceFrame {
  readonly frameId: number
  readonly submittedAt: number
  readonly updateCpuMs: number
  readonly renderInvocationCpuMs: number
  readonly afterRenderCpuMs: number
  readonly totalDrawCalls: number
  readonly particleInstances: number
  readonly triangles: number
  readonly computeDispatches: number
  readonly motionScheduledBytes: number
  readonly actualUploadBytes: number | null
  readonly uploadCalls: number | null
  readonly colorUploadBytes: number
}

interface ParticlePerformanceCounters {
  updateCallbacks?: number
  renderInvocations?: number
  afterRenderCallbacks?: number
  rafCallbacks?: number
  draws?: number
  uploads?: number
  sampleOverflow?: number
}

interface ParticlePerformanceBenchmark {
  callbackCount: number
  readonly callbackCpuMilliseconds: number[]
  readonly frameIntervalsMilliseconds: number[]
  firstFrameMilliseconds: number | null
  lastFrameAt: number | null
  lastMotion?: ParticleMotionDiagnostics
  maximumActiveExplosionCount?: number
  maximumActiveImpulseCount?: number
  requestedBackend?: ParticleBackendRequest
  effectiveBackend?: ParticleBackendDiagnostics['effectiveBackend']
  backendDiagnostics?: ParticleBackendDiagnostics[]
  onDiagnostics?: (diagnostics: ParticleBackendDiagnostics) => void
  startup?: ParticlePerformanceStartup
  resumes?: ParticlePerformanceResume[]
  frames?: ParticlePerformanceFrame[]
  counters?: ParticlePerformanceCounters
}

type ParticlePerformanceWindow = Window & {
  readonly __logoParticlePerformance?: ParticlePerformanceBenchmark
}

const readParticlePerformanceBenchmark = (): ParticlePerformanceBenchmark | null => {
  if (typeof window === 'undefined') return null
  const benchmark = (window as ParticlePerformanceWindow).__logoParticlePerformance
  return benchmark &&
    typeof benchmark.callbackCount === 'number' &&
    Array.isArray(benchmark.callbackCpuMilliseconds) &&
    Array.isArray(benchmark.frameIntervalsMilliseconds) &&
    (benchmark.firstFrameMilliseconds === null || typeof benchmark.firstFrameMilliseconds === 'number') &&
    (benchmark.lastFrameAt === null || typeof benchmark.lastFrameAt === 'number')
    ? benchmark
    : null
}

const readParticleFrameCaptureHook = (): ParticleFrameCaptureHook | null => {
  if (typeof window === 'undefined') return null
  const hook = (window as ParticleFrameCaptureWindow).__logoParticleFrameCapture
  if (!hook || typeof hook !== 'object' || Object.getPrototypeOf(hook) !== Object.prototype) return null
  const keys = Reflect.ownKeys(hook)
  const request = Object.getOwnPropertyDescriptor(hook, 'request')
  return keys.length === 1 &&
    keys[0] === 'request' &&
    request?.value === null &&
    request.writable &&
    request.enumerable &&
    request.configurable
    ? hook as ParticleFrameCaptureHook
    : null
}

const readParticleFrameCaptureClock = (): ParticleFrameCaptureClock | null => {
  const hook = readParticleFrameCaptureHook()
  if (!hook) return null
  const existing = particleFrameCaptureClocks.get(hook)
  if (existing) return existing
  const clock: ParticleFrameCaptureClock = {
    hook,
    now: () => clock.currentTimeMilliseconds ?? performance.now()
  }
  particleFrameCaptureClocks.set(hook, clock)
  return clock
}
const clamp = (minimum: number, value: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback

const idleAmplitudeCss = (medianStroke: number, renderedLongAxis: number): number =>
  clamp(
    MIN_IDLE_AMPLITUDE_CSS,
    0.50 * Math.max(0, finiteOr(medianStroke, 0)) * Math.max(0, finiteOr(renderedLongAxis, 0)) / 1024,
    MAX_IDLE_AMPLITUDE_CSS
  )

const createMotionDiagnostics = (particleCount: number, collisionParticleCount: number): ParticleMotionDiagnostics => ({
  activeExplosionCount: 0,
  activeImpulseCount: 0,
  bounceRatio: LOGO_POINTER_BOUNCE_RATIO,
  collisionParticleCount,
  depthScaleMax: DEPTH_SCALE_MAX,
  depthScaleMin: DEPTH_SCALE_MIN,
  elapsedSeconds: 0,
  explosionHoldSeconds: LOGO_POINTER_EXPLOSION_HOLD_SECONDS,
  explosionLifetimeSeconds: LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS,
  explosionRefillSeconds: LOGO_POINTER_EXPLOSION_REFILL_SECONDS,
  idleAmplitudeCss: MIN_IDLE_AMPLITUDE_CSS,
  impulseLifetimeSeconds: LOGO_POINTER_IMPULSE_LIFETIME_SECONDS,
  maxImpulseTravelCss: LOGO_POINTER_MAX_TRAVEL_CSS,
  neighborForceRatio: LOGO_POINTER_NEIGHBOR_FORCE_RATIO,
  particleCount: clamp(0, Math.round(finiteOr(particleCount, 0)), MAX_DIAGNOSTIC_PARTICLES)
})

const asError = (reason: unknown): Error => reason instanceof Error ? reason : new Error(String(reason))

const readParticleFrameCaptureOptions = (
  options: unknown
): ParticleFrameCaptureOptions | undefined => {
  if (options === undefined) return undefined
  if (options === null || typeof options !== 'object' || Object.getPrototypeOf(options) !== Object.prototype) {
    throw new Error('Particle frame capture options are invalid')
  }
  const keys = Reflect.ownKeys(options)
  if (
    keys.length === 0 ||
    keys.length > 2 ||
    keys.some(key => key !== 'elapsedSeconds' && key !== 'pointerTimeMilliseconds')
  ) {
    throw new Error('Particle frame capture options are invalid')
  }
  const captureOptions = options as {
    readonly elapsedSeconds?: unknown
    readonly pointerTimeMilliseconds?: unknown
  }
  const elapsedSeconds = captureOptions.elapsedSeconds
  if (
    'elapsedSeconds' in captureOptions &&
    (typeof elapsedSeconds !== 'number' || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0)
  ) {
    throw new Error('Particle frame capture elapsedSeconds override is invalid')
  }
  const pointerTimeMilliseconds = captureOptions.pointerTimeMilliseconds
  if (
    'pointerTimeMilliseconds' in captureOptions &&
    (
      typeof pointerTimeMilliseconds !== 'number' ||
      !Number.isFinite(pointerTimeMilliseconds) ||
      pointerTimeMilliseconds < 0
    )
  ) {
    throw new Error('Particle frame capture pointerTimeMilliseconds override is invalid')
  }
  return {
    ...(typeof elapsedSeconds === 'number' ? { elapsedSeconds } : {}),
    ...(typeof pointerTimeMilliseconds === 'number' ? { pointerTimeMilliseconds } : {})
  }
}

const createParticleFrameCaptureRegistration = (
  invalidate: () => void
): ParticleFrameCaptureRegistration | null => {
  const clock = readParticleFrameCaptureClock()
  if (!clock) return null
  const { hook } = clock
  let disposed = false
  let pending: PendingParticleFrameCapture | null = null
  const request: ParticleFrameCaptureRequest = options => {
    if (disposed) return Promise.reject(new Error('Particle frame capture is unavailable'))
    if (pending) return Promise.reject(new Error('A particle frame capture is already pending'))
    let captureOptions: ParticleFrameCaptureOptions | undefined
    try {
      captureOptions = readParticleFrameCaptureOptions(options)
    } catch (error) {
      return Promise.reject(asError(error))
    }
    return new Promise<ParticleFrameCapture>((resolve, reject) => {
      pending = { ...captureOptions, reject, resolve }
      clock.currentTimeMilliseconds = captureOptions?.pointerTimeMilliseconds
      try {
        invalidate()
      } catch (error) {
        pending = null
        clock.currentTimeMilliseconds = undefined
        reject(asError(error))
      }
    })
  }
  hook.request = request

  return {
    afterRender: canvas => {
      if (!pending) return
      const capture = pending
      pending = null
      clock.currentTimeMilliseconds = undefined
      try {
        const dataUrl = canvas.toDataURL('image/png')
        capture.resolve({ dataUrl, capturedAt: performance.now() })
      } catch (error) {
        capture.reject(asError(error))
        throw error
      }
    },
    currentTimeMilliseconds: () => clock.currentTimeMilliseconds,
    consumeElapsedSecondsOverride: () => {
      if (!pending) return undefined
      const elapsedSeconds = pending.elapsedSeconds
      pending.elapsedSeconds = undefined
      return elapsedSeconds
    },
    dispose: reason => {
      if (disposed) return
      disposed = true
      if (hook.request === request) hook.request = null
      const capture = pending
      pending = null
      clock.currentTimeMilliseconds = undefined
      capture?.reject(reason)
    }
  }
}


const assertParticleViews = (particles: ParsedLogoParticles, effect: LogoEffectDescriptor): void => {
  if (
    particles.width !== effect.width ||
    particles.height !== effect.height ||
    particles.count !== effect.count ||
    effect.aspect !== particles.width / particles.height ||
    !Number.isFinite(effect.medianStroke) ||
    effect.medianStroke <= 0 ||
    particles.xy.length !== effect.count * 2 ||
    particles.depth.length !== effect.count ||
    particles.rgba.length !== effect.count * 4 ||
    particles.size.length !== effect.count ||
    particles.seed.length !== effect.count
  ) {
    throw new Error('Particle data does not match its effect descriptor')
  }

  for (const view of [particles.xy, particles.depth, particles.rgba, particles.size, particles.seed]) {
    if (view.buffer !== particles.buffer) throw new Error('Particle attributes must be views over the owned input buffer')
  }
}

const createParticleUniforms = (effect: LogoEffectDescriptor): ParticleNodeUniforms => ({
  aspectRatio: uniform(effect.aspect),
  pixelRatio: uniform(1),
  brushPositionRadius: uniform(new Vector4(0, 0, 18, 0)),
  brushDirection: uniform(new Vector2(0, 0)),
  explosionPositionAge: Array.from(
    { length: LOGO_POINTER_EXPLOSION_CAPACITY },
    () => uniform(new Vector4(0, 0, 0, 0))
  ),
  medianStroke: uniform(effect.medianStroke),
  renderedLongAxis: uniform(1),
  elapsedSeconds: uniform(0),
  viewportSize: uniform(new Vector2(1, 1))
})

export const createParticleSceneResources = (
  particles: ParsedLogoParticles,
  effect: LogoEffectDescriptor
): ParticleSceneResources => {
  assertParticleViews(particles, effect)

  const cloud = new ParticleCloud(particles)
  const colors = new Float32Array(particles.count * 4)
  updateParticleColors(particles, colors)
  const particleColor = new InstancedBufferAttribute(colors, 4, false)
  const { cloudMotion, geometry } = createParticleSpriteGeometry(particles, cloud, particleColor)
  geometry.instanceCount = particles.count
  const uniforms = createParticleUniforms(effect)
  const material = createParticleSpriteMaterial(uniforms)
  const mesh = new Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  mesh.updateMatrix()
  mesh.matrixWorldNeedsUpdate = true

  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
  camera.position.z = 2
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()

  const motionDiagnosticsBenchmark = readParticlePerformanceBenchmark()
  const motionDiagnostics = motionDiagnosticsBenchmark ? createMotionDiagnostics(particles.count, cloud.count) : null
  if (motionDiagnosticsBenchmark && motionDiagnostics) motionDiagnosticsBenchmark.lastMotion = motionDiagnostics

  return {
    camera,
    cloud,
    cloudMotion,
    particleColor,
    particles,
    disposed: false,
    geometry,
    material,
    mesh,
    motionDiagnostics,
    motionDiagnosticsBenchmark,
    uniforms
  }
}

export const disposeParticleSceneResources = (resources: ParticleSceneResources): void => {
  if (resources.disposed) return
  resources.disposed = true
  if (resources.motionDiagnosticsBenchmark?.lastMotion === resources.motionDiagnostics) {
    Reflect.deleteProperty(resources.motionDiagnosticsBenchmark, 'lastMotion')
  }
  resources.mesh.removeFromParent()
  resources.camera.removeFromParent()
  resources.geometry.dispose()
  resources.material.dispose()
}

type ParticleRenderMetric = 'drawCalls' | 'triangles'

const readParticleRenderMetric = (
  renderer: LogoParticleRenderer,
  metric: ParticleRenderMetric
): number | null => {
  const render = renderer.info?.render
  const value = render?.[metric]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export class ParticleSceneEventFence {
  private canvas: HTMLCanvasElement | null = null
  private disposed = false
  private failed = false
  private committed = false
  private firstFrameEmitted = false
  private pendingFrame = false
  private previousCheckShaderErrors = true
  private previousShaderError: LogoParticleRenderer['debug']['onShaderError'] = null
  private renderer: LogoParticleRenderer | null = null
  private previousDrawCalls: number | null = null
  private previousTriangles: number | null = null
  private pendingDrawCalls: number | null = null
  private pendingTriangles: number | null = null
  private lastDrawCalls = 0
  private lastTriangles = 0
  private lastSubmissionAt: number | null = null
  private readonly shaderError = (): void => {
    this.fail(new Error('Particle shader compilation failed'))
  }

  constructor(
    private readonly particleCount: number,
    private readonly events: SceneEvents
  ) {}

  get hasFailed(): boolean {
    return this.failed
  }

  get hasCommittedFrame(): boolean {
    return this.committed
  }

  get lastRenderDrawCalls(): number {
    return this.lastDrawCalls
  }

  get lastRenderTriangles(): number {
    return this.lastTriangles
  }

  get lastRenderSubmissionAt(): number | null {
    return this.lastSubmissionAt
  }

  ready(renderer: LogoParticleRenderer): void {
    if (this.disposed || this.failed) return
    if (this.renderer === renderer) return
    this.detachRenderer()
    this.renderer = renderer
    this.canvas = renderer.domElement
    this.previousDrawCalls = readParticleRenderMetric(renderer, 'drawCalls')
    this.previousTriangles = readParticleRenderMetric(renderer, 'triangles')
    this.pendingDrawCalls = null
    this.pendingTriangles = null
    this.previousCheckShaderErrors = renderer.debug.checkShaderErrors
    this.previousShaderError = renderer.debug.onShaderError
    renderer.debug.checkShaderErrors = true
    renderer.debug.onShaderError = this.shaderError
    renderer.setClearAlpha(0)
    this.canvas.addEventListener('webglcontextlost', this.onContextLost)
  }

  beforeRender(renderer: LogoParticleRenderer): void {
    this.pendingDrawCalls = null
    this.pendingTriangles = null
    if (this.disposed || this.failed || renderer !== this.renderer) return
    this.pendingDrawCalls = readParticleRenderMetric(renderer, 'drawCalls')
    this.pendingTriangles = readParticleRenderMetric(renderer, 'triangles')
  }

  markPending(): void {
    if (this.disposed || this.failed || this.pendingFrame) return
    if (!this.committed && !this.firstFrameEmitted) return
    this.pendingFrame = true
    this.firstFrameEmitted = false
    this.events.framePending()
  }

  rendered(renderer: LogoParticleRenderer, active: boolean): void {
    this.lastDrawCalls = 0
    this.lastTriangles = 0
    this.lastSubmissionAt = null
    if (
      !active ||
      this.disposed ||
      this.failed ||
      renderer !== this.renderer ||
      renderer.domElement.width <= 0 ||
      renderer.domElement.height <= 0
    ) return

    const afterDrawCalls = readParticleRenderMetric(renderer, 'drawCalls')
    const afterTriangles = readParticleRenderMetric(renderer, 'triangles')
    if (afterDrawCalls === null || afterTriangles === null) return
    const baselineDrawCalls = this.pendingDrawCalls ?? this.previousDrawCalls
    const baselineTriangles = this.pendingTriangles ?? this.previousTriangles
    this.previousDrawCalls = afterDrawCalls
    this.previousTriangles = afterTriangles
    this.pendingDrawCalls = null
    this.pendingTriangles = null
    if (baselineDrawCalls === null || baselineTriangles === null) return

    this.lastDrawCalls = Math.max(0, afterDrawCalls - baselineDrawCalls)
    this.lastTriangles = Math.max(0, afterTriangles - baselineTriangles)
    if (
      this.firstFrameEmitted ||
      this.lastDrawCalls < 1 ||
      this.lastTriangles < this.particleCount * 2
    ) return

    const submittedAt = performance.now()
    this.lastSubmissionAt = submittedAt
    this.events.submission?.(submittedAt)
    this.firstFrameEmitted = true
    this.committed = true
    this.pendingFrame = false
    this.events.firstFrame()
  }

  fail(reason: unknown): void {
    if (this.disposed || this.failed) return
    this.failed = true
    this.events.error(asError(reason))
  }

  lost(): void {
    if (this.disposed || this.failed) return
    this.failed = true
    const event = typeof Event === 'function' ? new Event('webglcontextlost') : ({ type: 'webglcontextlost' } as Event)
    this.events.contextLost(event)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.detachRenderer()
  }

  private detachRenderer(): void {
    this.canvas?.removeEventListener('webglcontextlost', this.onContextLost)
    if (this.renderer?.debug.onShaderError === this.shaderError) {
      this.renderer.debug.onShaderError = this.previousShaderError
      this.renderer.debug.checkShaderErrors = this.previousCheckShaderErrors
    }
    this.canvas = null
    this.renderer = null
    this.previousDrawCalls = null
    this.previousTriangles = null
    this.pendingDrawCalls = null
    this.pendingTriangles = null
  }

  private readonly onContextLost = (event: Event): void => {
    if (this.disposed || this.failed) return
    this.failed = true
    this.events.contextLost(event)
  }
}

const renderedLongAxis = (width: number, height: number, aspect: number): number => {
  const viewportAspect = width / height
  if (viewportAspect >= aspect) return Math.max(height * aspect, height)
  return Math.max(width, width / aspect)
}

export const updateParticleSceneFrame = (
  resources: ParticleSceneResources,
  pointerController: Pick<LogoPointerController, 'update'>,
  frame: ParticleSceneFrame
): void => {
  if (
    resources.disposed ||
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) return

  resources.uniforms.viewportSize.value.set(frame.width, frame.height)
  resources.uniforms.pixelRatio.value = clamp(1, finiteOr(frame.pixelRatio, 1), 1.5)
  resources.uniforms.renderedLongAxis.value = renderedLongAxis(
    frame.width,
    frame.height,
    resources.uniforms.aspectRatio.value
  )
  const pointer = frame.pointerTimeMilliseconds === undefined
    ? pointerController.update(resources.uniforms.renderedLongAxis.value)
    : pointerController.update(resources.uniforms.renderedLongAxis.value, frame.pointerTimeMilliseconds)
  let activeImpulseCount = 0
  for (let index = 0; index < LOGO_POINTER_IMPULSE_CAPACITY; index += 1) {
    const impulse = pointer.impulses[index]
    const ageSeconds = clamp(
      0,
      finiteOr(impulse.ageSeconds, LOGO_POINTER_IMPULSE_LIFETIME_SECONDS),
      LOGO_POINTER_IMPULSE_LIFETIME_SECONDS
    )
    const active = impulse.active && ageSeconds < LOGO_POINTER_IMPULSE_LIFETIME_SECONDS
    if (active) activeImpulseCount += 1
  }
  let activeExplosionCount = 0
  for (let index = 0; index < LOGO_POINTER_EXPLOSION_CAPACITY; index += 1) {
    const explosion = pointer.explosions[index]
    const ageSeconds = clamp(
      0,
      finiteOr(explosion.ageSeconds, LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS),
      LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS
    )
    const active = explosion.active && ageSeconds < LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS
    resources.uniforms.explosionPositionAge[index]!.value.set(
      active ? clamp(-1, finiteOr(explosion.x, 0), 1) : 0,
      active ? clamp(-1, finiteOr(explosion.y, 0), 1) : 0,
      ageSeconds,
      active ? clamp(LOGO_POINTER_EXPLOSION_MIN_SCALE, finiteOr(explosion.scale, 1), LOGO_POINTER_EXPLOSION_MAX_SCALE) : 0
    )
    if (active) activeExplosionCount += 1
  }
  const elapsed = clamp(0, finiteOr(frame.elapsed, 0), MAX_DIAGNOSTIC_ELAPSED_SECONDS)
  resources.uniforms.elapsedSeconds.value = elapsed
  resources.cloud.update(
    elapsed,
    frame.width,
    frame.height,
    pointer,
    frame.pointerTimeMilliseconds === undefined ? elapsed : frame.pointerTimeMilliseconds / 1000
  )
  const brush = resources.cloud.brush
  resources.uniforms.brushPositionRadius.value.set(brush.x, brush.y, brush.radius, brush.travel)
  resources.uniforms.brushDirection.value.set(brush.directionX, brush.directionY)
  if (resources.cloud.count > 0) resources.cloudMotion.needsUpdate = true

  const diagnostics = resources.motionDiagnostics
  if (diagnostics) {
    diagnostics.activeImpulseCount = activeImpulseCount
    diagnostics.activeExplosionCount = activeExplosionCount
    diagnostics.elapsedSeconds = elapsed
    diagnostics.idleAmplitudeCss = idleAmplitudeCss(
      resources.uniforms.medianStroke.value,
      resources.uniforms.renderedLongAxis.value
    )
  }
}

const ParticleSceneContents = defineComponent({
  name: 'ParticleSceneContents',
  props: {
    active: { type: Boolean, required: true },
    loopControl: { type: Object as PropType<ParticleLoopControl>, required: true },
    fence: { type: Object as PropType<ParticleSceneEventFence>, required: true },
    pointerController: { type: Object as PropType<LogoPointerController>, required: true },
    resources: { type: Object as PropType<ParticleSceneResources>, required: true }
  },
  emits: {
    fault: (_error: Error): boolean => true
  },
  setup (props, { emit }) {
    const { invalidate } = useTres()
    const { onBeforeRender, onRender, start, stop } = useLoop()
    props.loopControl.start = start
    props.loopControl.stop = stop
    const benchmark = readParticlePerformanceBenchmark()
    const frameCapture = createParticleFrameCaptureRegistration(invalidate)
    if (frameCapture) props.loopControl.disposeFrameCapture = frameCapture.dispose
    let callbackFailed = false
    let nextFrameId = 1
    let pendingFrameId = 0
    let pendingUpdateCpuMs = 0
    let pendingRenderStartedAt = 0
    const frame: ParticleSceneFrame = {
      elapsed: 0,
      height: 1,
      pixelRatio: 1,
      pointerTimeMilliseconds: undefined,
      width: 1
    }

    const incrementCounter = (name: keyof ParticlePerformanceCounters, amount = 1): void => {
      if (!benchmark?.counters || typeof benchmark.counters[name] !== 'number') return
      benchmark.counters[name] += amount
    }
    const recordCallback = (startedAt: number): void => {
      if (!benchmark) return
      benchmark.callbackCount += 1
      benchmark.callbackCpuMilliseconds.push(performance.now() - startedAt)
    }
    const fail = (reason: unknown): void => {
      if (callbackFailed) return
      callbackFailed = true
      stop()
      props.loopControl.onFailure?.('failed', asError(reason).message)
      emit('fault', asError(reason))
    }

    const beforeSubscription = onBeforeRender(({ elapsed, renderer, sizes }) => {
      const callbackStartedAt = benchmark ? performance.now() : 0
      let shouldRecord = false
      try {
        if (!props.active || callbackFailed) return
        const typedRenderer = renderer as unknown as LogoParticleRenderer
        frame.elapsed = elapsed
        const elapsedSecondsOverride = frameCapture?.consumeElapsedSecondsOverride()
        if (elapsedSecondsOverride !== undefined) frame.elapsed = elapsedSecondsOverride
        frame.pointerTimeMilliseconds = frameCapture?.currentTimeMilliseconds()
        frame.height = sizes.height.value
        frame.pixelRatio = renderer.getPixelRatio()
        frame.width = sizes.width.value
        const updateStartedAt = benchmark ? performance.now() : 0
        updateParticleSceneFrame(props.resources, props.pointerController, frame)
        const updateEndedAt = benchmark ? performance.now() : 0
        pendingUpdateCpuMs = benchmark ? updateEndedAt - updateStartedAt : 0
        pendingRenderStartedAt = benchmark ? updateEndedAt : 0
        props.fence.beforeRender(typedRenderer)
        pendingFrameId = nextFrameId
        nextFrameId += 1
        shouldRecord = true
        incrementCounter('updateCallbacks')
      } catch (error) {
        fail(error)
      } finally {
        if (shouldRecord) recordCallback(callbackStartedAt)
      }
    })
    const renderSubscription = onRender(({ renderer }) => {
      const callbackStartedAt = benchmark ? performance.now() : 0
      let shouldRecord = false
      try {
        frameCapture?.afterRender(renderer.domElement)
        if (!props.active || callbackFailed) return
        const typedRenderer = renderer as unknown as LogoParticleRenderer
        props.fence.rendered(typedRenderer, true)
        const submittedAt = props.fence.lastRenderSubmissionAt ?? performance.now()
        if (benchmark) {
          if (benchmark.lastFrameAt !== null) {
            benchmark.frameIntervalsMilliseconds.push(submittedAt - benchmark.lastFrameAt)
          }
          benchmark.lastFrameAt = submittedAt
          const totalDrawCalls = props.fence.lastRenderDrawCalls
          const triangles = props.fence.lastRenderTriangles
          if (benchmark.frames) {
            if (benchmark.frames.length < MAX_BENCHMARK_FRAMES) {
              benchmark.frames.push({
                frameId: pendingFrameId,
                submittedAt,
                updateCpuMs: pendingUpdateCpuMs,
                renderInvocationCpuMs: Math.max(0, callbackStartedAt - pendingRenderStartedAt),
                afterRenderCpuMs: Math.max(0, performance.now() - callbackStartedAt),
                totalDrawCalls,
                particleInstances: props.resources.geometry.instanceCount,
                triangles,
                computeDispatches: 0,
                motionScheduledBytes: props.resources.cloud.motion.byteLength,
                actualUploadBytes: null,
                uploadCalls: null,
                colorUploadBytes: 0
              })
            } else incrementCounter('sampleOverflow')
          }
          incrementCounter('renderInvocations')
          incrementCounter('afterRenderCallbacks')
          incrementCounter('draws', totalDrawCalls)
        }
        shouldRecord = true
        // TresJS on-demand mode renders only invalidated frames. Re-queue while active.
        invalidate()
      } catch (error) {
        fail(error)
      } finally {
        if (shouldRecord) recordCallback(callbackStartedAt)
      }
    })

    watch(
      () => props.active,
      active => {
        if (callbackFailed || !props.loopControl.ready) return
        if (active) {
          start()
          invalidate()
        } else stop()
      },
      { flush: 'sync', immediate: true }
    )
    onBeforeUnmount(() => {
      frameCapture?.dispose(new Error('Particle frame capture is unavailable'))
      if (frameCapture && props.loopControl.disposeFrameCapture === frameCapture.dispose) {
        Reflect.deleteProperty(props.loopControl, 'disposeFrameCapture')
      }
      if (props.loopControl.stop === stop) props.loopControl.stop = null
      beforeSubscription.off()
      renderSubscription.off()
      stop()
    })

    return () => props.resources && !props.resources.disposed
      ? h('primitive', { dispose: null, object: props.resources.mesh })
      : null
  }
})

export default defineComponent({
  name: 'LogoParticleScene',
  components: { ParticleSceneContents, TresCanvas },
  props: {
    effect: { type: Object as PropType<LogoEffectDescriptor>, required: true },
    particles: { type: Object as PropType<ParsedLogoParticles>, required: true },
    active: { type: Boolean, required: true }
  },
  emits: {
    'first-frame': (): boolean => true,
    'frame-pending': (): boolean => true,
    error: (_error: Error): boolean => true,
    'context-lost': (_event: Event): boolean => true
  },
  setup (props, { emit, expose }) {
    const resources = shallowRef<ParticleSceneResources | null>(null)
    const renderEnabled = ref(props.active)
    const canvasMounted = ref(props.active)
    const pointerTarget = shallowRef<HTMLElement | null>(null)
    const pointerCoordinateTarget = shallowRef<HTMLElement | null>(null)
    const benchmark = readParticlePerformanceBenchmark()
    const frameCaptureClock = readParticleFrameCaptureClock()
    const startup = benchmark?.startup
    let setupError: Error | null = null
    let tornDown = false
    let backendLease: ParticleBackendLease | null = null
    let backendCanvas: HTMLCanvasElement | null = null
    let backendGeneration = 0
    let activeResume: ParticlePerformanceResume | null = null
    let tresContext: TresContext | null = null

    const recordSubmission = (submittedAt: number): void => {
      if (startup && startup.firstSubmissionAt === undefined) startup.firstSubmissionAt = submittedAt
      if (activeResume && activeResume.firstSubmissionAt === null) activeResume.firstSubmissionAt = submittedAt
    }
    const recordFailure = (outcome: 'failed' | 'lost' | 'retired', reason: string): void => {
      if (!activeResume) return
      activeResume.outcome = outcome
      activeResume.reason = reason
      activeResume = null
    }
    const beginResume = (): void => {
      if (!benchmark?.resumes || !startup || !fenceForScene.hasCommittedFrame) return
      const sample: ParticlePerformanceResume = {
        startedAt: performance.now(),
        firstSubmissionAt: null,
        visibleCommitAt: null
      }
      benchmark.resumes.push(sample)
      activeResume = sample
    }
    const loopControl = markRaw<ParticleLoopControl>({
      onFailure: recordFailure,
      ready: false,
      start: null,
      stop: null
    })
    const retireBackend = (): void => {
      const lease = backendLease
      loopControl.ready = false
      if (lease && lease.status !== 'lost') {
        lease.retire()
        recordFailure('retired', 'Particle backend was retired')
      }
      backendLease = null
      backendCanvas = null
    }
    const publishDiagnostic = (owner: ParticleBackendLease, diagnostic: ParticleBackendDiagnostics): void => {
      if (owner !== backendLease) return
      if (benchmark) {
        try {
          if (benchmark.onDiagnostics) benchmark.onDiagnostics(diagnostic)
          else benchmark.backendDiagnostics?.push({ ...diagnostic })
          benchmark.effectiveBackend = diagnostic.effectiveBackend
        } catch {
          // Benchmark diagnostics are observational and must not block lifecycle fencing.
        }
      }
      if (tornDown) return
      if (diagnostic.reason === 'backend-error' && diagnostic.phase === 'ready') {
        fenceForScene.fail(new Error('Particle backend reported an error'))
        return
      }
      if (diagnostic.reason === 'device-lost') fenceForScene.lost()
    }
    const rendererFactory = ({ canvas }: TresRendererSetupContext): TresRenderer => {
      const resolvedCanvas = unref(canvas)
      if (
        backendLease &&
        backendCanvas === resolvedCanvas &&
        backendLease.status !== 'retired' &&
        backendLease.status !== 'failed' &&
        backendLease.status !== 'lost'
      ) {
        return backendLease.renderer
      }
      retireBackend()
      backendCanvas = resolvedCanvas
      if (startup && startup.initStartedAt === undefined) startup.initStartedAt = performance.now()
      const lease = createParticleBackendLease({
        canvas: resolvedCanvas,
        directSrgbMaterialPipeline: true,
        generation: ++backendGeneration,
        onDiagnostics: diagnostic => publishDiagnostic(lease, diagnostic),
        requestedBackend: benchmark?.requestedBackend ?? 'auto'
      })
      backendLease = lease
      void lease.init().catch(error => fenceForScene.fail(error))
      return lease.renderer
    }

    const pointerController = markRaw(useLogoPointer({
      active: renderEnabled,
      coordinateTarget: pointerCoordinateTarget,
      now: frameCaptureClock?.now,
      target: pointerTarget
    }))
    const disableRendering = (): void => {
      renderEnabled.value = false
      loopControl.stop?.()
      if (tresContext?.renderer.loop.isActive.value) tresContext.renderer.loop.stop()
    }
    const fenceForScene = new ParticleSceneEventFence(props.particles.count, {
      submission: recordSubmission,
      firstFrame: () => {
        const committedAt = performance.now()
        if (startup && startup.visibleCommitAt === undefined) startup.visibleCommitAt = committedAt
        if (activeResume) {
          activeResume.visibleCommitAt = committedAt
          activeResume.outcome = 'committed'
          activeResume = null
        }
        if (benchmark && benchmark.firstFrameMilliseconds === null) benchmark.firstFrameMilliseconds = committedAt
        emit('first-frame')
      },
      framePending: () => emit('frame-pending'),
      error: error => {
        disableRendering()
        loopControl.onFailure?.('failed', error.message)
        loopControl.disposeFrameCapture?.(error)
        canvasMounted.value = false
        retireBackend()
        emit('error', error)
      },
      contextLost: event => {
        disableRendering()
        loopControl.onFailure?.('lost', 'Particle backend device was lost')
        loopControl.disposeFrameCapture?.(new Error('Particle backend device was lost'))
        canvasMounted.value = false
        retireBackend()
        emit('context-lost', event)
      }
    })
    const teardown = (): void => {
      if (tornDown) return
      tornDown = true
      disableRendering()
      loopControl.ready = false
      loopControl.disposeFrameCapture?.(new Error('Particle frame capture is unavailable'))
      pointerController.dispose()
      pointerTarget.value = null
      pointerCoordinateTarget.value = null
      canvasMounted.value = false
      retireBackend()
      fenceForScene.dispose()
      if (resources.value) disposeParticleSceneResources(resources.value)
      resources.value = null
    }
    expose({ teardown })

    try {
      if (startup && startup.resourcesStartedAt === undefined) startup.resourcesStartedAt = performance.now()
      resources.value = markRaw(createParticleSceneResources(props.particles, props.effect))
      if (startup && startup.resourcesEndedAt === undefined) startup.resourcesEndedAt = performance.now()
    } catch (error) {
      setupError = asError(error)
      canvasMounted.value = false
      renderEnabled.value = false
    }

    watch(
      () => props.active,
      active => {
        if (tornDown || resources.value === null || fenceForScene.hasFailed) {
          disableRendering()
          canvasMounted.value = false
          retireBackend()
          return
        }
        if (!active) {
          disableRendering()
          fenceForScene.markPending()
          return
        }
        beginResume()
        if (!canvasMounted.value) {
          loopControl.ready = false
          canvasMounted.value = true
        }
        if (tresContext && !tresContext.renderer.loop.isActive.value) tresContext.renderer.loop.start()
        renderEnabled.value = true
      },
      { flush: 'sync' }
    )

    const handleRendererReady = async (context: TresContext): Promise<void> => {
      tresContext = context
      if (!renderEnabled.value && context.renderer.loop.isActive.value) context.renderer.loop.stop()
      if (tornDown || fenceForScene.hasFailed) return
      const lease = backendLease
      if (!lease || context.renderer.instance !== lease.renderer || lease.status !== 'ready') {
        fenceForScene.fail(new Error('Particle backend identity was not committed'))
        return
      }
      const renderer = lease.renderer
      try {
        renderer.toneMapping = NoToneMapping
        renderer.outputColorSpace = LinearSRGBColorSpace
        fenceForScene.ready(renderer)
        if (startup && startup.initEndedAt === undefined) startup.initEndedAt = performance.now()
        await renderer.compileAsync(context.scene.value, context.camera.activeCamera.value)
        if (
          tornDown ||
          fenceForScene.hasFailed ||
          backendLease !== lease ||
          lease.status !== 'ready' ||
          !renderEnabled.value ||
          !canvasMounted.value
        ) return
        loopControl.ready = true
        if (renderEnabled.value) loopControl.start?.()
        else loopControl.stop?.()
        const wrapper = renderer.domElement.closest('.login-particle-logo')
        pointerTarget.value = wrapper instanceof HTMLElement ? wrapper : null
        pointerCoordinateTarget.value = renderer.domElement
      } catch (error) {
        fenceForScene.fail(error)
      }
    }

    const handleRendererRender = (_context: TresContext): void => {
      // Per-frame proof is recorded by ParticleSceneContents around the actual render.
    }
    const handleRendererError = (reason: unknown): void => {
      fenceForScene.fail(reason)
    }

    onMounted(() => {
      if (setupError && !tornDown) fenceForScene.fail(setupError)
    })
    onBeforeUnmount(teardown)

    return {
      canvasMounted,
      fence: fenceForScene,
      handleRendererError,
      handleRendererReady,
      handleRendererRender,
      NoToneMapping,
      pointerController,
      rendererFactory,
      renderEnabled,
      resources,
      LinearSRGBColorSpace,
      loopControl
    }
  }
})
</script>

<style scoped>
.login-logo-particle-scene {
  position: absolute !important;
  inset: 0;
  width: 100%;
  height: 100%;
  background: transparent;
  pointer-events: none !important;
}
</style>
