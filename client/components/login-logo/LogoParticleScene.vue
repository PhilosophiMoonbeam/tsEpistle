<template>
  <TresCanvas
    v-if="resources && webglAvailable"
    class="login-logo-particle-scene"
    aria-hidden="true"
    :alpha="true"
    :antialias="false"
    :camera="resources.camera"
    :clear-alpha="0"
    clear-color="#000000"
    :depth="false"
    :dpr="[1, 1.5]"
    :premultiplied-alpha="false"
    render-mode="on-demand"
    :stencil="false"
    @error="handleRendererError"
    @ready="handleRendererReady"
    @render="handleRendererRender"
  >
    <ParticleSceneContents
      :active="renderEnabled"
      :loop-control="loopControl"
      :resources="resources"
      :pointer-controller="pointerController"
      @fault="handleRendererError"
    />
  </TresCanvas>
</template>

<script lang="ts">
import { TresCanvas, useLoop, useTres } from '@tresjs/core'
import type { TresContext } from '@tresjs/core'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  NormalBlending,
  OrthographicCamera,
  Points,
  ShaderMaterial,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer
} from 'three'
import type { IUniform } from 'three'
import WebGL from 'three/addons/capabilities/WebGL.js'
import {
  defineComponent,
  h,
  markRaw,
  onBeforeUnmount,
  onMounted,
  type PropType,
  ref,
  shallowRef,
  watch
} from 'vue'
import type { LogoEffectDescriptor, ParsedLogoParticles } from './particle-logo'
import fragmentShader from './particle.frag.glsl?raw'
import vertexShader from './particle.vert.glsl?raw'
import { useLogoPointer } from './useLogoPointer'
import type { LogoPointerController } from './useLogoPointer'

const DEFAULT_BACKGROUND = 0xffffff
const DEPTH_SCALE_MIN = 0.82
const DEPTH_SCALE_MAX = 1.18
const MIN_IDLE_AMPLITUDE_CSS = 2.5
const MAX_IDLE_AMPLITUDE_CSS = 7
const MIN_SLICE_DISPLACEMENT_CSS = 10
const MAX_SLICE_DISPLACEMENT_CSS = 24
const MAX_DIAGNOSTIC_ELAPSED_SECONDS = Number.MAX_SAFE_INTEGER
const MAX_DIAGNOSTIC_PARTICLES = 16_000


interface ParticleUniforms {
  [uniform: string]: IUniform
  readonly uAspect: { value: number }
  readonly uBackground: { value: Color }
  readonly uDpr: { value: number }
  readonly uMedianStroke: { value: number }
  readonly uPointer: { value: Vector2 }
  readonly uPointerDirection: { value: Vector2 }
  readonly uPointerDisplacement: { value: number }
  readonly uPointerSpeed: { value: number }
  readonly uPointerStrength: { value: number }
  readonly uRenderedLongAxis: { value: number }
  readonly uSliceAcrossRadius: { value: number }
  readonly uSliceAlongRadius: { value: number }
  readonly uTime: { value: number }
  readonly uViewport: { value: Vector2 }
}

export interface ParticleMotionDiagnostics {
  elapsedSeconds: number
  particleCount: number
  pointerStrength: number
  pointerSpeed: number
  idleAmplitudeCss: number
  sliceDisplacementCss: number
  depthScaleMin: number
  depthScaleMax: number
}

export interface ParticleSceneResources {
  readonly camera: OrthographicCamera
  readonly geometry: BufferGeometry
  readonly material: ShaderMaterial
  readonly motionDiagnostics: ParticleMotionDiagnostics | null
  readonly points: Points<BufferGeometry, ShaderMaterial>
  readonly uniforms: ParticleUniforms
  disposed: boolean
}

export interface ParticleSceneFrame {
  readonly elapsed: number
  readonly height: number
  readonly pixelRatio: number
  readonly width: number
}

interface ParticleLoopControl {
  disposeFrameCapture?: (reason: Error) => void
  stop: (() => void) | null
}

interface ParticleFrameCapture {
  readonly dataUrl: string
  readonly capturedAt: number
}

type ParticleFrameCaptureRequest = () => Promise<ParticleFrameCapture>

interface ParticleFrameCaptureHook {
  request: ParticleFrameCaptureRequest | null
}

interface ParticleFrameCaptureRegistration {
  afterRender: (canvas: HTMLCanvasElement) => void
  dispose: (reason: Error) => void
}

interface PendingParticleFrameCapture {
  readonly reject: (reason: Error) => void
  readonly resolve: (capture: ParticleFrameCapture) => void
}

type ParticleFrameCaptureWindow = Window & {
  readonly __logoParticleFrameCapture?: unknown
}

interface SceneEvents {
  readonly firstFrame: () => void
  readonly error: (error: Error) => void
  readonly contextLost: (event: Event) => void
}

interface ParticlePerformanceBenchmark {
  callbackCount: number
  readonly callbackCpuMilliseconds: number[]
  readonly frameIntervalsMilliseconds: number[]
  firstFrameMilliseconds: number | null
  lastFrameAt: number | null
  lastMotion?: ParticleMotionDiagnostics
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
const clamp = (minimum: number, value: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback

const idleAmplitudeCss = (medianStroke: number, renderedLongAxis: number): number =>
  clamp(
    MIN_IDLE_AMPLITUDE_CSS,
    0.35 * Math.max(0, finiteOr(medianStroke, 0)) * Math.max(0, finiteOr(renderedLongAxis, 0)) / 1024,
    MAX_IDLE_AMPLITUDE_CSS
  )

const createMotionDiagnostics = (particleCount: number): ParticleMotionDiagnostics => ({
  elapsedSeconds: 0,
  particleCount: clamp(0, Math.round(finiteOr(particleCount, 0)), MAX_DIAGNOSTIC_PARTICLES),
  pointerStrength: 0,
  pointerSpeed: 0,
  idleAmplitudeCss: MIN_IDLE_AMPLITUDE_CSS,
  sliceDisplacementCss: MIN_SLICE_DISPLACEMENT_CSS,
  depthScaleMin: DEPTH_SCALE_MIN,
  depthScaleMax: DEPTH_SCALE_MAX
})

const asError = (reason: unknown): Error => reason instanceof Error ? reason : new Error(String(reason))

const createParticleFrameCaptureRegistration = (
  invalidate: () => void
): ParticleFrameCaptureRegistration | null => {
  const hook = readParticleFrameCaptureHook()
  if (!hook) return null
  let disposed = false
  let pending: PendingParticleFrameCapture | null = null
  const request: ParticleFrameCaptureRequest = () => {
    if (disposed) return Promise.reject(new Error('Particle frame capture is unavailable'))
    if (pending) return Promise.reject(new Error('A particle frame capture is already pending'))
    return new Promise<ParticleFrameCapture>((resolve, reject) => {
      pending = { reject, resolve }
      try {
        invalidate()
      } catch (error) {
        pending = null
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
      try {
        const dataUrl = canvas.toDataURL('image/png')
        capture.resolve({ dataUrl, capturedAt: performance.now() })
      } catch (error) {
        capture.reject(asError(error))
        throw error
      }
    },
    dispose: reason => {
      if (disposed) return
      disposed = true
      if (hook.request === request) hook.request = null
      const capture = pending
      pending = null
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

export const createParticleSceneResources = (
  particles: ParsedLogoParticles,
  effect: LogoEffectDescriptor
): ParticleSceneResources => {
  assertParticleViews(particles, effect)

  const geometry = new BufferGeometry()
  geometry.setAttribute('logoXY', new BufferAttribute(particles.xy, 2, true))
  geometry.setAttribute('logoDepth', new BufferAttribute(particles.depth, 1, true))
  geometry.setAttribute('logoColor', new BufferAttribute(particles.rgba, 4, true))
  geometry.setAttribute('logoSize', new BufferAttribute(particles.size, 1, true))
  geometry.setAttribute('logoSeed', new BufferAttribute(particles.seed, 1, true))
  geometry.setDrawRange(0, particles.count)

  const uniforms: ParticleUniforms = {
    uAspect: { value: effect.aspect },
    uBackground: { value: new Color(DEFAULT_BACKGROUND) },
    uDpr: { value: 1 },
    uMedianStroke: { value: effect.medianStroke },
    uPointer: { value: new Vector2(0, 0) },
    uPointerDirection: { value: new Vector2(1, 0) },
    uPointerDisplacement: { value: MIN_SLICE_DISPLACEMENT_CSS },
    uPointerSpeed: { value: 0 },
    uPointerStrength: { value: 0 },
    uRenderedLongAxis: { value: 1 },
    uSliceAcrossRadius: { value: 28 },
    uSliceAlongRadius: { value: 50.4 },
    uTime: { value: 0 },
    uViewport: { value: new Vector2(1, 1) }
  }
  const material = new ShaderMaterial({
    blending: NormalBlending,
    depthTest: false,
    depthWrite: false,
    fragmentShader,
    premultipliedAlpha: false,
    toneMapped: false,
    transparent: true,
    uniforms,
    vertexShader
  })
  const points = new Points(geometry, material)
  points.frustumCulled = false
  points.matrixAutoUpdate = false
  points.updateMatrix()

  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
  camera.position.z = 2
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()

  const benchmark = readParticlePerformanceBenchmark()
  const motionDiagnostics = benchmark ? createMotionDiagnostics(particles.count) : null
  if (benchmark && motionDiagnostics) benchmark.lastMotion = motionDiagnostics

  return { camera, disposed: false, geometry, material, motionDiagnostics, points, uniforms }
}

export const disposeParticleSceneResources = (resources: ParticleSceneResources): void => {
  if (resources.disposed) return
  resources.disposed = true
  resources.points.removeFromParent()
  resources.camera.removeFromParent()
  resources.geometry.dispose()
  resources.material.dispose()
}

export class ParticleSceneEventFence {
  private canvas: HTMLCanvasElement | null = null
  private disposed = false
  private failed = false
  private firstFrameEmitted = false
  private previousCheckShaderErrors = true
  private previousShaderError: WebGLRenderer['debug']['onShaderError'] = null
  private renderer: WebGLRenderer | null = null
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

  ready(renderer: WebGLRenderer): void {
    if (this.disposed || this.failed || this.renderer) return
    this.renderer = renderer
    this.canvas = renderer.domElement
    this.previousCheckShaderErrors = renderer.debug.checkShaderErrors
    this.previousShaderError = renderer.debug.onShaderError
    renderer.debug.checkShaderErrors = true
    renderer.debug.onShaderError = this.shaderError
    renderer.setClearAlpha(0)
    this.canvas.addEventListener('webglcontextlost', this.onContextLost)
  }

  rendered(renderer: WebGLRenderer, active: boolean): void {
    if (
      !active ||
      this.disposed ||
      this.failed ||
      this.firstFrameEmitted ||
      renderer !== this.renderer ||
      renderer.domElement.width <= 0 ||
      renderer.domElement.height <= 0 ||
      renderer.info.render.points < this.particleCount
    ) return

    this.firstFrameEmitted = true
    this.events.firstFrame()
  }

  fail(reason: unknown): void {
    if (this.disposed || this.failed) return
    this.failed = true
    this.events.error(asError(reason))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.canvas?.removeEventListener('webglcontextlost', this.onContextLost)
    if (this.renderer?.debug.onShaderError === this.shaderError) {
      this.renderer.debug.onShaderError = this.previousShaderError
      this.renderer.debug.checkShaderErrors = this.previousCheckShaderErrors
    }
    this.canvas = null
    this.renderer = null
  }

  private readonly onContextLost = (event: Event): void => {
    if (this.disposed || this.failed) return
    this.failed = true
    this.events.contextLost(event)
  }
}

const isTransparent = (color: string): boolean =>
  color === '' ||
  color === 'transparent' ||
  /rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(color) ||
  /rgb\([^)]*\/\s*0(?:\.0+)?%?\s*\)$/i.test(color)

const readSurfaceColor = (canvas: HTMLCanvasElement): Color => {
  let element: HTMLElement | null = canvas.parentElement
  while (element) {
    const color = window.getComputedStyle(element).backgroundColor
    if (!isTransparent(color)) {
      try {
        return new Color().setStyle(color, SRGBColorSpace)
      } catch {
        break
      }
    }
    element = element.parentElement
  }
  return new Color(DEFAULT_BACKGROUND)
}

export const updateParticleSceneBackground = (
  resources: ParticleSceneResources,
  canvas: HTMLCanvasElement
): void => {
  if (resources.disposed) return
  resources.uniforms.uBackground.value.copy(readSurfaceColor(canvas))
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
  if (resources.disposed || frame.width <= 0 || frame.height <= 0) return
  resources.uniforms.uViewport.value.set(frame.width, frame.height)
  resources.uniforms.uDpr.value = clamp(1, finiteOr(frame.pixelRatio, 1), 1.5)
  resources.uniforms.uRenderedLongAxis.value = renderedLongAxis(
    frame.width,
    frame.height,
    resources.uniforms.uAspect.value
  )
  const pointer = pointerController.update(resources.uniforms.uRenderedLongAxis.value)
  const directionLength = Math.hypot(pointer.directionX, pointer.directionY)
  const directionScale = Number.isFinite(directionLength) && directionLength > 0.000001
    ? 1 / directionLength
    : 0
  const pointerStrength = clamp(0, finiteOr(pointer.strength, 0), 1)
  const pointerSpeed = clamp(0, finiteOr(pointer.speed, 0), 1)
  const pointerDisplacement = clamp(
    MIN_SLICE_DISPLACEMENT_CSS,
    finiteOr(pointer.displacementCss, MIN_SLICE_DISPLACEMENT_CSS),
    MAX_SLICE_DISPLACEMENT_CSS
  )
  const elapsed = clamp(0, finiteOr(frame.elapsed, 0), Number.MAX_SAFE_INTEGER)

  resources.uniforms.uPointer.value.set(
    clamp(-1, finiteOr(pointer.x, 0), 1),
    clamp(-1, finiteOr(pointer.y, 0), 1)
  )
  resources.uniforms.uPointerDirection.value.set(
    directionScale === 0 ? 1 : pointer.directionX * directionScale,
    directionScale === 0 ? 0 : pointer.directionY * directionScale
  )
  resources.uniforms.uPointerDisplacement.value = pointerDisplacement
  resources.uniforms.uPointerSpeed.value = pointerSpeed
  resources.uniforms.uPointerStrength.value = pointerStrength
  resources.uniforms.uSliceAcrossRadius.value = Math.max(0.001, finiteOr(pointer.acrossRadiusCss, 28))
  resources.uniforms.uSliceAlongRadius.value = Math.max(0.001, finiteOr(pointer.alongRadiusCss, 50.4))
  resources.uniforms.uTime.value = elapsed

  const diagnostics = resources.motionDiagnostics
  if (diagnostics) {
    diagnostics.elapsedSeconds = Math.min(elapsed, MAX_DIAGNOSTIC_ELAPSED_SECONDS)
    diagnostics.pointerStrength = pointerStrength
    diagnostics.pointerSpeed = pointerSpeed
    diagnostics.idleAmplitudeCss = idleAmplitudeCss(
      resources.uniforms.uMedianStroke.value,
      resources.uniforms.uRenderedLongAxis.value
    )
    diagnostics.sliceDisplacementCss = pointerDisplacement
  }
}

const ParticleSceneContents = defineComponent({
  name: 'ParticleSceneContents',
  props: {
    active: { type: Boolean, required: true },
    loopControl: { type: Object as PropType<ParticleLoopControl>, required: true },
    pointerController: { type: Object as PropType<LogoPointerController>, required: true },
    resources: { type: Object as PropType<ParticleSceneResources>, required: true }
  },
  emits: {
    fault: (_error: Error): boolean => true
  },
  setup (props, { emit }) {
    const { invalidate } = useTres()
    const { onBeforeRender, onRender, start, stop } = useLoop()
    props.loopControl.stop = stop
    const benchmark = readParticlePerformanceBenchmark()
    const frameCapture = createParticleFrameCaptureRegistration(invalidate)
    if (frameCapture) props.loopControl.disposeFrameCapture = frameCapture.dispose
    let callbackFailed = false

    const fail = (reason: unknown): void => {
      if (callbackFailed) return
      callbackFailed = true
      stop()
      frameCapture?.dispose(asError(reason))
      emit('fault', asError(reason))
    }

    const beforeSubscription = onBeforeRender(({ elapsed, renderer, sizes }) => {
      const callbackStartedAt = benchmark ? performance.now() : 0
      try {
        if (!props.active || callbackFailed) return
        updateParticleSceneFrame(props.resources, props.pointerController, {
          elapsed,
          height: sizes.height.value,
          pixelRatio: renderer.getPixelRatio(),
          width: sizes.width.value
        })
      } catch (error) {
        fail(error)
      } finally {
        if (benchmark) {
          benchmark.callbackCount += 1
          benchmark.callbackCpuMilliseconds.push(performance.now() - callbackStartedAt)
        }
      }
    })
    const renderSubscription = onRender(({ renderer }) => {
      const callbackStartedAt = benchmark ? performance.now() : 0
      try {
        frameCapture?.afterRender(renderer.domElement)
        if (!props.active || callbackFailed) return
        if (benchmark) {
          if (benchmark.lastFrameAt !== null) {
            benchmark.frameIntervalsMilliseconds.push(callbackStartedAt - benchmark.lastFrameAt)
          }
          benchmark.lastFrameAt = callbackStartedAt
        }
        invalidate()
      } catch (error) {
        fail(error)
      } finally {
        if (benchmark) {
          benchmark.callbackCount += 1
          benchmark.callbackCpuMilliseconds.push(performance.now() - callbackStartedAt)
        }
      }
    })

    watch(
      () => props.active,
      active => {
        if (callbackFailed) return
        if (active) {
          start()
          invalidate()
        } else {
          stop()
        }
      },
      { flush: 'sync', immediate: true }
    )

    onMounted(() => {
      if (!props.active) stop()
    })
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

    return () => h('primitive', { dispose: null, object: props.resources.points })
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
    error: (_error: Error): boolean => true,
    'context-lost': (_event: Event): boolean => true
  },
  setup (props, { emit, expose }) {
    const resources = shallowRef<ParticleSceneResources | null>(null)
    const renderEnabled = ref(false)
    const webglAvailable = ref(false)
    const loopControl = markRaw<ParticleLoopControl>({ stop: null })
    const pointerTarget = shallowRef<HTMLElement | null>(null)
    const pointerCoordinateTarget = shallowRef<HTMLElement | null>(null)
    let setupError: Error | null = null
    let surfaceObserver: MutationObserver | null = null
    let tornDown = false
    const benchmark = readParticlePerformanceBenchmark()

    const pointerController = markRaw(useLogoPointer({
      active: renderEnabled,
      coordinateTarget: pointerCoordinateTarget,
      medianStroke: props.effect.medianStroke,
      target: pointerTarget
    }))
    const disableRendering = (): void => {
      renderEnabled.value = false
      loopControl.stop?.()
    }
    const fence = new ParticleSceneEventFence(props.particles.count, {
      firstFrame: () => {
        if (benchmark && benchmark.firstFrameMilliseconds === null) {
          benchmark.firstFrameMilliseconds = performance.now()
        }
        emit('first-frame')
      },
      error: error => {
        disableRendering()
        loopControl.disposeFrameCapture?.(error)
        emit('error', error)
      },
      contextLost: event => {
        disableRendering()
        loopControl.disposeFrameCapture?.(new Error('Particle WebGL context was lost'))
        emit('context-lost', event)
      }
    })
    const teardown = (): void => {
      if (tornDown) return
      tornDown = true
      disableRendering()
      loopControl.disposeFrameCapture?.(new Error('Particle frame capture is unavailable'))
      pointerController.dispose()
      pointerTarget.value = null
      pointerCoordinateTarget.value = null
      surfaceObserver?.disconnect()
      surfaceObserver = null
      fence.dispose()
      if (resources.value) disposeParticleSceneResources(resources.value)
      resources.value = null
      webglAvailable.value = false
    }
    expose({ teardown })

    try {
      webglAvailable.value = WebGL.isWebGL2Available()
      if (!webglAvailable.value) throw new Error('WebGL 2 is unavailable')
      resources.value = markRaw(createParticleSceneResources(props.particles, props.effect))
      renderEnabled.value = props.active
    } catch (error) {
      setupError = asError(error)
    }

    watch(
      () => props.active,
      active => {
        if (tornDown || !active || fence.hasFailed || resources.value === null) {
          disableRendering()
          return
        }
        renderEnabled.value = true
      },
      { flush: 'sync' }
    )

    const handleRendererReady = (context: TresContext): void => {
      if (tornDown || fence.hasFailed) return
      const renderer = context.renderer.instance
      if (!(renderer instanceof WebGLRenderer)) {
        fence.fail(new Error('Particle scene requires a WebGL renderer'))
        return
      }

      try {
        fence.ready(renderer)
        const wrapper = renderer.domElement.closest('.login-particle-logo')
        pointerTarget.value = wrapper instanceof HTMLElement ? wrapper : null
        pointerCoordinateTarget.value = renderer.domElement
        if (resources.value) updateParticleSceneBackground(resources.value, renderer.domElement)
        surfaceObserver = new MutationObserver(() => {
          if (!resources.value || fence.hasFailed) return
          updateParticleSceneBackground(resources.value, renderer.domElement)
          context.renderer.invalidate()
        })
        const observed = new Set<Element>([document.documentElement, document.body])
        const loginSurface = renderer.domElement.closest('.login')
        if (loginSurface) observed.add(loginSurface)
        for (const element of observed) surfaceObserver.observe(element, { attributeFilter: ['class', 'style'], attributes: true })
      } catch (error) {
        fence.fail(error)
      }
    }

    const handleRendererRender = (context: TresContext): void => {
      const renderer = context.renderer.instance
      if (renderer instanceof WebGLRenderer) fence.rendered(renderer, renderEnabled.value)
    }

    const handleRendererError = (reason: unknown): void => {
      fence.fail(reason)
    }

    onMounted(() => {
      if (setupError && !tornDown) fence.fail(setupError)
    })
    onBeforeUnmount(teardown)

    return {
      handleRendererError,
      handleRendererReady,
      handleRendererRender,
      loopControl,
      pointerController,
      renderEnabled,
      resources,
      webglAvailable
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
