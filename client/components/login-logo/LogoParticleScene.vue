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

interface ParticleUniforms {
  [uniform: string]: IUniform
  readonly uAspect: { value: number }
  readonly uBackground: { value: Color }
  readonly uDpr: { value: number }
  readonly uMedianStroke: { value: number }
  readonly uPointer: { value: Vector2 }
  readonly uPointerDisplacement: { value: number }
  readonly uPointerRadius: { value: number }
  readonly uPointerStrength: { value: number }
  readonly uRenderedLongAxis: { value: number }
  readonly uTime: { value: number }
  readonly uViewport: { value: Vector2 }
}

export interface ParticleSceneResources {
  readonly camera: OrthographicCamera
  readonly geometry: BufferGeometry
  readonly material: ShaderMaterial
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
  stop: (() => void) | null
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

const asError = (reason: unknown): Error => reason instanceof Error ? reason : new Error(String(reason))

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
    uPointerDisplacement: { value: 2 },
    uPointerRadius: { value: 40 },
    uPointerStrength: { value: 0 },
    uRenderedLongAxis: { value: 1 },
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

  return { camera, disposed: false, geometry, material, points, uniforms }
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
  resources.uniforms.uDpr.value = Math.min(1.5, Math.max(1, frame.pixelRatio))
  resources.uniforms.uRenderedLongAxis.value = renderedLongAxis(
    frame.width,
    frame.height,
    resources.uniforms.uAspect.value
  )
  const pointer = pointerController.update(resources.uniforms.uRenderedLongAxis.value)
  resources.uniforms.uPointer.value.set(pointer.x, pointer.y)
  resources.uniforms.uPointerDisplacement.value = pointer.displacementCss
  resources.uniforms.uPointerRadius.value = pointer.radiusCss
  resources.uniforms.uPointerStrength.value = pointer.strength
  resources.uniforms.uTime.value = frame.elapsed
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
    let callbackFailed = false

    const fail = (reason: unknown): void => {
      if (callbackFailed) return
      callbackFailed = true
      stop()
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
    const renderSubscription = onRender(() => {
      const callbackStartedAt = benchmark ? performance.now() : 0
      try {
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
        emit('error', error)
      },
      contextLost: event => {
        disableRendering()
        emit('context-lost', event)
      }
    })
    const teardown = (): void => {
      if (tornDown) return
      tornDown = true
      disableRendering()
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
