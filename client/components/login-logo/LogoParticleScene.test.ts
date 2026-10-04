import path from 'node:path'
import { setImmediate } from 'node:timers/promises'

import { compileScript, parse } from '@vue/compiler-sfc'
import type { TresContext, TresRendererSetupContext } from '@tresjs/core'
import type { WebGPURenderer } from 'three/webgpu'
import { beforeEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import { browserWindow, resetBody, setLocation } from '../../test/browser-dom.mts'
import type { Component } from 'vue'
import type { ParticleSceneEventFence as ParticleSceneEventFenceClass, ParticleSceneFrame, ParticleSceneResources } from './LogoParticleScene.vue'
import type { LogoEffectDescriptor, ParsedLogoParticles, ParticleContentRect } from './particle-logo.ts'
import type { LogoParticleRenderer, ParticleBackendLease } from './particle-renderer.ts'
import type { LogoPointerState } from './useLogoPointer.ts'

resetBody()
setLocation('/login')

const componentPath = path.join(process.cwd(), 'client/components/login-logo/LogoParticleScene.vue')
const componentSource = await Bun.file(componentPath).text()
const parsed = parse(componentSource, { filename: componentPath })
if (parsed.errors.length > 0) throw new Error(`Could not parse LogoParticleScene.vue: ${parsed.errors.join(', ')}`)
if (!parsed.descriptor.script || parsed.descriptor.scriptSetup) throw new Error('LogoParticleScene ordinary script was not found')
const compiledScript = compileScript(parsed.descriptor, {
  id: 'logo-particle-scene-tsl-test',
  genDefaultAs: '__sfc__'
})
const compiledComponent = `${compiledScript.content}\nexport default __sfc__\n`
const [Vue, Tres, ThreeWebgpu, ThreeTsl, Three] = await Promise.all([
  import('vue'),
  import('@tresjs/core'),
  import('three/webgpu'),
  import('three/tsl'),
  import('three')
])

interface LoopContext {
  readonly elapsed: number
  readonly renderer: WebGPURenderer
  readonly sizes: {
    readonly height: { readonly value: number }
    readonly width: { readonly value: number }
  }
  readonly contentRect: ParticleContentRect
}
type LoopCallback = (context: LoopContext) => void
const loopHarness = {
  beforeRender: null as LoopCallback | null,
  isActive: Vue.ref(false),
  invalidations: 0,
  render: null as LoopCallback | null,
  starts: 0,
  stops: 0
}
const resetLoopHarness = (): void => {
  loopHarness.beforeRender = null
  loopHarness.invalidations = 0
  loopHarness.render = null
  loopHarness.isActive.value = false
  loopHarness.starts = 0
  loopHarness.stops = 0
}
const tresTestModule = {
  ...Tres,
  useLoop: () => ({
    onBeforeRender: (callback: LoopCallback) => {
      loopHarness.beforeRender = callback
      return {
        off: () => {
          if (loopHarness.beforeRender === callback) loopHarness.beforeRender = null
        }
      }
    },
    onRender: (callback: LoopCallback) => {
      loopHarness.render = callback
      return {
        off: () => {
          if (loopHarness.render === callback) loopHarness.render = null
        }
      }
    },
    start: () => {
      if (loopHarness.isActive.value) return
      loopHarness.isActive.value = true
      loopHarness.starts += 1
    },
    stop: () => {
      loopHarness.isActive.value = false
      loopHarness.stops += 1
    }
  }),
  useTres: () => ({
    invalidate: () => {
      loopHarness.invalidations += 1
    }
  })
}
let sceneBackendLease: ParticleBackendLease | null = null
const particleRendererTestModule = {
  createParticleBackendLease: (): ParticleBackendLease => {
    if (!sceneBackendLease) throw new Error('Scene backend lease was not configured')
    return sceneBackendLease
  }
}
const bundle = await Bun.build({
  entrypoints: ['virtual:LogoParticleScene.vue'],
  external: ['@tresjs/core', 'three', 'three/webgpu', 'three/tsl', 'vue'],
  format: 'cjs',
  plugins: [
    {
      name: 'logo-particle-scene-tsl-test-sfc',
      setup(build) {
        build.onResolve({ filter: /^virtual:LogoParticleScene\.vue$/ }, () => ({ path: componentPath }))
        build.onResolve({ filter: /\/particle-renderer$/ }, () => ({
          path: 'particle-renderer-test-boundary',
          external: true
        }))
        build.onLoad({ filter: /LogoParticleScene\.vue$/, namespace: 'file' }, () => ({
          contents: compiledComponent,
          loader: 'ts',
          resolveDir: path.dirname(componentPath)
        }))
      }
    }
  ],
  target: 'bun'
})
if (!bundle.success || bundle.outputs.length !== 1) {
  throw new Error(`Could not bundle LogoParticleScene.vue: ${bundle.logs.map(log => log.message).join(', ')}`)
}
const bundleCode = await bundle.outputs[0].text()
const moduleStart = bundleCode.indexOf('(function(')
if (moduleStart < 0) throw new Error('Compiled LogoParticleScene.vue did not produce a CommonJS module')
interface CompiledModule {
  exports: Record<string, unknown>
}
const moduleFactory = new Function(`return ${bundleCode.slice(moduleStart)}`)() as (
  exports: CompiledModule['exports'],
  require: (specifier: string) => unknown,
  module: CompiledModule,
  filename: string,
  dirname: string
) => void
const compiledModule: CompiledModule = { exports: {} }
moduleFactory(
  compiledModule.exports,
  specifier => {
    if (specifier === 'vue') return Vue
    if (specifier === '@tresjs/core') return tresTestModule
    if (specifier === 'particle-renderer-test-boundary') return particleRendererTestModule
    if (specifier === 'three') return Three
    if (specifier === 'three/webgpu') return ThreeWebgpu
    if (specifier === 'three/tsl') return ThreeTsl
    throw new Error(`Unexpected import in LogoParticleScene.vue: ${specifier}`)
  },
  compiledModule,
  componentPath,
  path.dirname(componentPath)
)

const {
  ParticleSceneEventFence,
  createParticleSceneResources,
  default: LogoParticleScene,
  disposeParticleSceneResources,
  updateParticleSceneFrame
} = compiledModule.exports as {
  ParticleSceneEventFence: typeof ParticleSceneEventFenceClass
  default: { components?: Record<string, Component> }
  createParticleSceneResources: (particles: ParsedLogoParticles, effect: LogoEffectDescriptor) => ParticleSceneResources
  disposeParticleSceneResources: (resources: ParticleSceneResources) => void
  updateParticleSceneFrame: (
    resources: ParticleSceneResources,
    pointerController: { update: (renderedLongAxis: number, time?: number) => LogoPointerState },
    frame: ParticleSceneFrame
  ) => void
}
const ParticleSceneContents = LogoParticleScene.components?.ParticleSceneContents
if (!ParticleSceneContents) throw new Error('ParticleSceneContents was not exported by the compiled scene')

const effect: LogoEffectDescriptor = {
  logoUrl: '/logo.png',
  particleUrl: '/particle.bin',
  staticUrl: '/effect.png',
  pipelineVersion: 6,
  width: 640,
  height: 320,
  aspect: 2,
  count: 3,
  medianStroke: 10
}
const contentRect: ParticleContentRect = Object.freeze({
  left: 80,
  top: 16,
  width: 480,
  height: 288
})

const makeParticles = (): ParsedLogoParticles => {
  const buffer = new ArrayBuffer(36)
  const xy = new Int16Array(buffer, 0, 6)
  xy.set([-32767, 32767, 0, 0, 32767, -32767])
  const depth = new Int8Array(buffer, 12, 3)
  depth.set([-127, 0, 127])
  const rgba = new Uint8Array(buffer, 15, 12)
  rgba.set([12, 34, 56, 255, 200, 100, 50, 190, 245, 240, 235, 128])
  const size = new Uint8Array(buffer, 27, 3)
  size.set([1, 128, 255])
  const seed = new Uint16Array(buffer, 30, 3)
  seed.set([1, 32768, 65535])
  return Object.freeze({ buffer, width: 640, height: 320, count: 3, xy, depth, rgba, size, seed })
}

const makePointerState = (): LogoPointerState => ({
  activeImpulseCount: 0,
  activeExplosionCount: 0,
  influenceRadiusCss: 32,
  impulses: Array.from({ length: 6 }, () => ({
    active: false,
    ageSeconds: 0,
    directionX: 1,
    directionY: 0,
    radiusCss: 18,
    travelCss: 0,
    strength: 1,
    x: 0,
    y: 0
  })) as unknown as LogoPointerState['impulses'],
  explosions: Array.from({ length: 6 }, () => ({ active: false, ageSeconds: 0, scale: 1, x: 0, y: 0 })) as unknown as LogoPointerState['explosions']
})
const pointerState = makePointerState()

interface FakeRenderer {
  readonly canvas: HTMLCanvasElement
  readonly renderer: WebGPURenderer
}
const makeRenderer = (): FakeRenderer => {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 320
  const renderer = {
    debug: { checkShaderErrors: false, onShaderError: null },
    domElement: canvas,
    info: { render: { drawCalls: 0, triangles: 0 } },
    getPixelRatio: () => 1,
    setClearAlpha: () => {},
    coordinateSystem: Three.WebGLCoordinateSystem,
    toneMapping: Three.NoToneMapping,
    outputColorSpace: Three.SRGBColorSpace
  } as unknown as WebGPURenderer
  return { canvas, renderer }
}

const makeBenchmark = () => {
  const benchmark = {
    callbackCount: 0,
    callbackCpuMilliseconds: [] as number[],
    frameIntervalsMilliseconds: [] as number[],
    firstFrameMilliseconds: null as number | null,
    lastFrameAt: null as number | null,
    renderInvocationCpuMs: null as number | null,
    requestedBackend: 'webgl2' as const,
    effectiveBackend: null as string | null,
    backendDiagnostics: [] as Array<Record<string, unknown>>,
    startup: {} as Record<string, number>,
    resumes: [] as Array<Record<string, unknown>>,
    frames: [] as Array<Record<string, unknown>>,
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
  Object.defineProperty(window, '__logoParticlePerformance', { configurable: true, value: benchmark })
  return benchmark
}

const makeFrameContext = (renderer: WebGPURenderer, elapsed = 1): LoopContext => ({
  elapsed,
  renderer,
  sizes: { height: { value: 320 }, width: { value: 640 } },
  contentRect
})

interface PrewarmingBackend extends FakeRenderer {
  readonly compileLoopStates: boolean[]
  readonly draws: number
  readonly lease: ParticleBackendLease
  readonly rejectCompilation: (error: Error) => void
  readonly resolveCompilation: () => void
}

const makePrewarmingBackend = (generation = 1): PrewarmingBackend => {
  const { canvas, renderer } = makeRenderer()
  let status: 'ready' | 'retired' = 'ready'
  let resolveCompilation!: () => void
  let rejectCompilation!: (error: Error) => void
  const compilation = new Promise<void>((resolve, reject) => {
    resolveCompilation = resolve
    rejectCompilation = reject
  })
  const compileLoopStates: boolean[] = []
  let draws = 0
  renderer.compileAsync = () => {
    compileLoopStates.push(loopHarness.isActive.value)
    return compilation
  }
  renderer.render = () => {
    draws += 1
    renderer.info.render.drawCalls = 1
    renderer.info.render.triangles = effect.count * 2
  }
  const lease: ParticleBackendLease = {
    generation,
    requestedBackend: 'webgpu',
    effectiveBackend: 'webgpu',
    renderer: renderer as LogoParticleRenderer,
    get status() {
      return status
    },
    diagnostics: {
      generation,
      requestedBackend: 'webgpu',
      effectiveBackend: 'webgpu',
      phase: 'ready',
      attempt: 1,
      fallback: false,
      reason: 'ready'
    },
    init: async () => 'webgpu',
    retire: () => {
      status = 'retired'
      return compilation.then(() => {}, () => {})
    }
  }
  return {
    canvas,
    compileLoopStates,
    get draws() {
      return draws
    },
    lease,
    rejectCompilation,
    renderer,
    resolveCompilation
  }
}

interface ReadySceneState {
  canvasMounted: boolean
  contentRect: ParticleContentRect
  fence: ParticleSceneEventFenceClass
  handleRendererReady: (context: TresContext) => Promise<void>
  loopControl: { ready: boolean; start: (() => void) | null; stop: (() => void) | null }
  pointerController: unknown
  renderEnabled: boolean
  rendererFactory: (context: TresRendererSetupContext) => unknown
  resources: ParticleSceneResources | null
}

const mountPrewarmingScene = () => {
  const active = Vue.ref(true)
  const particles = makeParticles()
  const errors: unknown[] = []
  const events: string[] = []
  const instance = Vue.shallowRef<{ teardown: () => Promise<void> } | null>(null)
  let state!: ReadySceneState
  const sceneComponent = {
    ...LogoParticleScene,
    render(this: ReadySceneState) {
      state = this
      return this.resources && this.canvasMounted
        ? Vue.h(ParticleSceneContents, {
            active: this.renderEnabled,
            contentRect: this.contentRect,
            fence: this.fence,
            loopControl: this.loopControl,
            pointerController: this.pointerController,
            resources: this.resources
          })
        : null
    }
  }
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({
    setup: () => () => Vue.h(sceneComponent, {
      active: active.value,
      contentRect,
      effect,
      particles,
      ref: instance,
      onError: (error: Error) => errors.push(error),
      onFirstFrame: () => events.push('first-frame'),
      onFramePending: () => events.push('frame-pending')
    })
  })
  app.config.errorHandler = error => errors.push(error)
  app.mount(host)
  const resources = state.resources
  const teardown = instance.value?.teardown
  const beforeRender = loopHarness.beforeRender
  const afterRender = loopHarness.render
  if (!resources || !teardown || !beforeRender || !afterRender || !state.loopControl.start || !state.loopControl.stop) {
    throw new Error('Scene readiness harness did not mount')
  }
  const scene = new Three.Scene()
  scene.add(resources.mesh, resources.camera)

  return {
    active,
    errors,
    events,
    resources,
    state,
    teardown,
    ready: (backend: PrewarmingBackend): Promise<void> => {
      sceneBackendLease = backend.lease
      state.rendererFactory({ canvas: Vue.shallowRef(backend.canvas) } as TresRendererSetupContext)
      // Tres starts the root loop synchronously before mounting contents and emitting ready.
      loopHarness.isActive.value = true
      return state.handleRendererReady({
        camera: { activeCamera: Vue.shallowRef(resources.camera) },
        renderer: {
          instance: backend.renderer,
          invalidate: tresTestModule.useTres().invalidate,
          loop: {
            isActive: loopHarness.isActive,
            start: state.loopControl.start,
            stop: state.loopControl.stop
          }
        },
        scene: Vue.shallowRef(scene)
      } as unknown as TresContext)
    },
    callbacks: (backend: PrewarmingBackend, elapsed = 1): void => {
      const context = makeFrameContext(backend.renderer, elapsed)
      beforeRender(context)
      afterRender(context)
    },
    draw: (backend: PrewarmingBackend, elapsed = 1): void => {
      if (!loopHarness.isActive.value) return
      const context = makeFrameContext(backend.renderer, elapsed)
      backend.renderer.info.render.drawCalls = 0
      backend.renderer.info.render.triangles = 0
      beforeRender(context)
      backend.renderer.render(scene, resources.camera)
      afterRender(context)
    },
    close: async (): Promise<void> => {
      await teardown()
      app.unmount()
      host.remove()
    }
  }
}

beforeEach(() => {
  resetLoopHarness()
  sceneBackendLease = null
  Reflect.deleteProperty(window, '__logoParticlePerformance')
  document.body.replaceChildren()
})

describe('LogoParticleScene resource path', () => {
  it('builds one indexed instanced sprite draw with source-order packed attributes', () => {
    const particles = makeParticles()
    const resources = createParticleSceneResources(particles, effect)
    try {
      expect(resources.geometry.instanceCount).toBe(particles.count)
      expect(resources.geometry.index?.count).toBe(6)
      expect(resources.geometry.getAttribute('logoXY').array).toBe(particles.xy)
      expect(resources.geometry.getAttribute('logoXY').normalized).toBe(true)
      expect(resources.geometry.getAttribute('particleColor').array).toBe(resources.particleColor.array)
      expect(resources.geometry.getAttribute('cloudMotion').itemSize).toBe(2)
      expect(resources.cloudMotion.array).toBe(resources.cloud.motion)
      expect(resources.cloudMotion.array.byteLength).toBe(particles.count * 2 * Float32Array.BYTES_PER_ELEMENT)
      expect(Array.from(resources.geometry.getAttribute('logoParameters').array as Float32Array)).toEqual(
        Array.from(new Float32Array([-1, 1 / 255, 1 / 65535, 0, 0, 128 / 255, 32768 / 65535, 0, 1, 1, 1, 1]))
      )
      expect(resources.mesh.geometry).toBe(resources.geometry)
      expect(resources.mesh.material).toBe(resources.material)
      expect(resources.mesh.frustumCulled).toBe(false)
      expect(resources.material.transparent).toBe(true)
      expect(resources.material.depthTest).toBe(false)
      expect(resources.material.depthWrite).toBe(false)
    } finally {
      disposeParticleSceneResources(resources)
    }
  })

  it('updates logical scene uniforms and forwards one pointer state to motion', () => {
    const resources = createParticleSceneResources(makeParticles(), effect)
    const before = new Uint8Array(resources.particles.buffer).slice()
    const pointer = makePointerState()
    const pointerUpdates: Array<{ renderedLongAxis: number; time: number | undefined }> = []
    const pointerController = {
      update: (renderedLongAxis: number, time?: number): LogoPointerState => {
        pointerUpdates.push({ renderedLongAxis, time })
        Object.assign(pointer.explosions[0], {
          active: true,
          ageSeconds: 0.25,
          scale: 1.2,
          x: -12,
          y: 18
        })
        return pointer
      }
    }
    const sourceAttributes = ['logoXY', 'logoParameters', 'particleColor'].map(name => resources.geometry.getAttribute(name))
    const sourceVersions = sourceAttributes.map(attribute => attribute.version)
    const motionVersion = resources.cloudMotion.version

    try {
      updateParticleSceneFrame(resources, pointerController, {
        elapsed: 2.5,
        height: 320,
        pixelRatio: 2,
        pointerTimeMilliseconds: 2500,
        width: 640,
        contentRect
      })
      expect(pointerUpdates).toEqual([{ renderedLongAxis: 480, time: 2500 }])
      expect(resources.uniforms.renderedLongAxis.value).toBe(480)
      expect(resources.uniforms.contentRect.value.toArray()).toEqual([80, 16, 480, 288])
      expect(resources.uniforms.explosionPositionAge[0]!.value.toArray()).toEqual([-12, 18, 0.25, 1.2])
      expect(resources.uniforms.explosionPositionAge[1]!.value.toArray()).toEqual([0, 0, 0, 0])
      expect(resources.uniforms.elapsedSeconds.value).toBe(2.5)
      expect(resources.uniforms.viewportSize.value.toArray()).toEqual([640, 320])
      expect(resources.uniforms.pixelRatio.value).toBe(1.5)
      expect(resources.cloudMotion.version).toBeGreaterThan(motionVersion)
      expect(sourceAttributes.map(attribute => attribute.version)).toEqual(sourceVersions)
      expect(new Uint8Array(resources.particles.buffer)).toEqual(before)
    } finally {
      disposeParticleSceneResources(resources)
    }
  })

  it('notifies retired objects and disposes their owned resources once without mutating parser-owned bytes', () => {
    const particles = makeParticles()
    const resources = createParticleSceneResources(particles, effect)
    const before = new Uint8Array(particles.buffer).slice()
    const scene = new Three.Scene()
    scene.add(resources.mesh, resources.camera)
    expect(resources.mesh.parent).toBe(scene)
    expect(resources.camera.parent).toBe(scene)
    const retiredObjects: string[] = []
    resources.mesh.addEventListener('dispose', () => {
      expect(resources.mesh.parent).toBeNull()
      retiredObjects.push('mesh')
    })
    resources.camera.addEventListener('dispose', () => {
      expect(resources.camera.parent).toBeNull()
      retiredObjects.push('camera')
    })
    let geometryDisposals = 0
    let materialDisposals = 0
    const disposeGeometry = resources.geometry.dispose.bind(resources.geometry)
    const disposeMaterial = resources.material.dispose.bind(resources.material)
    resources.geometry.dispose = () => {
      geometryDisposals += 1
      disposeGeometry()
    }
    resources.material.dispose = () => {
      materialDisposals += 1
      disposeMaterial()
    }

    disposeParticleSceneResources(resources)
    expect(resources.mesh.parent).toBeNull()
    expect(resources.camera.parent).toBeNull()
    disposeParticleSceneResources(resources)
    expect(geometryDisposals).toBe(1)
    expect(materialDisposals).toBe(1)
    expect(retiredObjects).toEqual(['mesh', 'camera'])
    expect(resources.mesh.parent).toBeNull()
    expect(new Uint8Array(particles.buffer)).toEqual(before)
  })
})

describe('LogoParticleScene asynchronous teardown', () => {
  for (const { rejectCleanup, rejectPriorCleanup } of [
    { rejectCleanup: false, rejectPriorCleanup: false },
    { rejectCleanup: true, rejectPriorCleanup: false },
    { rejectCleanup: false, rejectPriorCleanup: true },
    { rejectCleanup: true, rejectPriorCleanup: true }
  ]) {
    it(`invalidates immediately and waits for backend cleanup to ${rejectCleanup ? 'reject' : 'complete'}${rejectPriorCleanup ? ' despite a prior retirement failure' : ''}`, async () => {
      const harness = makeRenderer()
      const cleanupError = new Error('Backend cleanup failed')
      const priorCleanupError = new Error('Prior backend cleanup failed')
      const unmountErrors: unknown[] = []
      let status: 'ready' | 'retired' = 'ready'
      let retireRequests = 0
      let resolveCleanup!: () => void
      let rejectBackendCleanup!: (error: Error) => void
      const cleanup = new Promise<void>((resolve, reject) => {
        resolveCleanup = resolve
        rejectBackendCleanup = reject
      })
      let rejectPriorBackendCleanup!: (error: Error) => void
      const priorCleanup = rejectPriorCleanup
        ? new Promise<void>((_, reject) => {
            rejectPriorBackendCleanup = reject
          })
        : Promise.resolve()
      sceneBackendLease = {
        generation: 1,
        requestedBackend: 'webgl2',
        effectiveBackend: 'webgl2',
        renderer: harness.renderer as LogoParticleRenderer,
        get status() {
          return status
        },
        diagnostics: {
          generation: 1,
          requestedBackend: 'webgl2',
          effectiveBackend: 'webgl2',
          phase: 'ready',
          attempt: 1,
          fallback: false,
          reason: 'ready'
        },
        init: async () => 'webgl2',
        retire: () => {
          retireRequests += 1
          status = 'retired'
          return cleanup
        }
      }
      interface SceneState {
        canvasMounted: boolean
        loopControl: { ready: boolean; stop: (() => void) | null }
        renderEnabled: boolean
        rendererFactory: (context: TresRendererSetupContext) => unknown
        resources: ParticleSceneResources | null
      }
      let sceneState!: SceneState
      const host = document.createElement('div')
      document.body.append(host)
      const app = Vue.createApp(
        {
          ...LogoParticleScene,
          render(this: SceneState) {
            sceneState = this
            return null
          }
        },
        { active: true, contentRect, effect, particles: makeParticles() }
      )
      app.config.errorHandler = error => {
        unmountErrors.push(error)
      }
      const instance = app.mount(host) as unknown as { teardown: () => Promise<void> }
      const resources = sceneState.resources
      if (!resources) throw new Error('Scene resources were not created')
      let loopStops = 0
      sceneState.loopControl.stop = () => {
        loopStops += 1
      }
      sceneState.loopControl.ready = true
      if (rejectPriorCleanup) {
        const currentLease = sceneBackendLease
        sceneBackendLease = {
          ...currentLease,
          generation: 0,
          retire: () => priorCleanup
        }
        sceneState.rendererFactory({ canvas: Vue.shallowRef(document.createElement('canvas')) } as TresRendererSetupContext)
        sceneBackendLease = currentLease
      }
      sceneState.rendererFactory({ canvas: Vue.shallowRef(harness.canvas) } as TresRendererSetupContext)
      let completed = false
      const teardown = instance.teardown()
      void teardown.then(
        () => {
          completed = true
        },
        () => {
          completed = true
        }
      )

      try {
        expect(instance.teardown()).toBe(teardown)
        expect(status).toBe('retired')
        expect(retireRequests).toBe(1)
        expect(loopStops).toBeGreaterThan(0)
        expect(sceneState.renderEnabled).toBe(false)
        expect(sceneState.canvasMounted).toBe(false)
        expect(sceneState.loopControl.ready).toBe(false)
        expect(sceneState.resources).toBeNull()
        await Promise.resolve()
        expect(completed).toBe(false)
        if (rejectPriorCleanup) {
          rejectPriorBackendCleanup(priorCleanupError)
          // Let the rejection chain drain without resolving the fresh backend cleanup.
          await setImmediate()
          expect(completed).toBe(false)
          expect(resources.disposed).toBe(false)
        }
        expect(resources.disposed).toBe(false)

        if (rejectCleanup) rejectBackendCleanup(cleanupError)
        else resolveCleanup()
        if (rejectCleanup || rejectPriorCleanup) {
          await expect(teardown).rejects.toBe(rejectPriorCleanup ? priorCleanupError : cleanupError)
        } else {
          await teardown
        }
        expect(completed).toBe(true)
        expect(resources.disposed).toBe(true)
        expect(instance.teardown()).toBe(teardown)
      } finally {
        resolveCleanup()
        if (rejectPriorCleanup) rejectPriorBackendCleanup(priorCleanupError)
        await teardown.catch(() => {})
        app.unmount()
        host.remove()
      }
      await Vue.nextTick()
      expect(unmountErrors).toEqual(rejectCleanup || rejectPriorCleanup ? [rejectPriorCleanup ? priorCleanupError : cleanupError] : [])
    })
  }
})

describe('LogoParticleScene frame fence and loop', () => {
  it('proves first frames from renderer draw and triangle deltas, then requires pending before a resumed proof', () => {
    const events: string[] = []
    const harness = makeRenderer()
    const fence = new ParticleSceneEventFence(effect.count, {
      submission: () => events.push('submission'),
      firstFrame: () => events.push('first-frame'),
      framePending: () => events.push('frame-pending'),
      error: () => events.push('error'),
      contextLost: () => events.push('context-lost')
    })
    fence.ready(harness.renderer)

    try {
      fence.beforeRender(harness.renderer)
      fence.rendered(harness.renderer, true)
      expect(fence.lastRenderDrawCalls).toBe(0)
      expect(fence.lastRenderTriangles).toBe(0)
      expect(events).toEqual([])

      harness.renderer.info.render.drawCalls = 0
      harness.renderer.info.render.triangles = 0
      fence.beforeRender(harness.renderer)
      harness.renderer.info.render.triangles = effect.count * 2
      fence.rendered(harness.renderer, true)
      expect(fence.lastRenderDrawCalls).toBe(0)
      expect(fence.lastRenderTriangles).toBe(effect.count * 2)
      expect(events).toEqual([])

      harness.renderer.info.render.drawCalls = 0
      harness.renderer.info.render.triangles = 0
      fence.beforeRender(harness.renderer)
      harness.renderer.info.render.drawCalls = 1
      harness.renderer.info.render.triangles = effect.count * 2 - 1
      fence.rendered(harness.renderer, true)
      expect(fence.lastRenderDrawCalls).toBe(1)
      expect(fence.lastRenderTriangles).toBe(effect.count * 2 - 1)
      expect(events).toEqual([])

      harness.renderer.info.render.drawCalls = 0
      harness.renderer.info.render.triangles = 0
      fence.beforeRender(harness.renderer)
      harness.renderer.info.render.drawCalls = 1
      harness.renderer.info.render.triangles = effect.count * 2
      fence.rendered(harness.renderer, true)
      expect(fence.lastRenderDrawCalls).toBe(1)
      expect(fence.lastRenderTriangles).toBe(effect.count * 2)
      expect(events).toEqual(['submission', 'first-frame'])

      fence.markPending()
      fence.markPending()
      expect(events).toEqual(['submission', 'first-frame', 'frame-pending'])
      harness.renderer.info.render.drawCalls = 0
      harness.renderer.info.render.triangles = 0
      fence.beforeRender(harness.renderer)
      harness.renderer.info.render.drawCalls = 1
      harness.renderer.info.render.triangles = effect.count * 2
      fence.rendered(harness.renderer, true)
      expect(events).toEqual(['submission', 'first-frame', 'frame-pending', 'submission', 'first-frame'])
    } finally {
      fence.dispose()
    }
  })

  it('pauses callbacks and resumes motion with the existing resources', async () => {
    const benchmark = makeBenchmark()
    const resources = createParticleSceneResources(makeParticles(), effect)
    const renderer = makeRenderer()
    const events: string[] = []
    const fence = new ParticleSceneEventFence(effect.count, {
      firstFrame: () => events.push('first-frame'),
      framePending: () => events.push('frame-pending'),
      error: () => events.push('error'),
      contextLost: () => events.push('context-lost')
    })
    fence.ready(renderer.renderer)
    const active = Vue.ref(true)
    const loopControl = { ready: false, start: null as (() => void) | null, stop: null as (() => void) | null }
    const host = document.createElement('div')
    document.body.append(host)
    const pointerUpdates: Array<{ renderedLongAxis: number; time: number | undefined }> = []
    const pointerController = {
      update: (renderedLongAxis: number, time?: number): LogoPointerState => {
        pointerUpdates.push({ renderedLongAxis, time })
        return pointerState
      }
    }
    const app = Vue.createApp({
      setup: () => () =>
        Vue.h(ParticleSceneContents, {
          active: active.value,
          contentRect,
          fence,
          loopControl,
          pointerController,
          resources
        })
    })
    app.mount(host)

    try {
      loopControl.ready = true
      if (!loopHarness.beforeRender || !loopHarness.render) throw new Error('Loop callbacks were not registered')
      const context = makeFrameContext(renderer.renderer)
      loopHarness.beforeRender(context)
      renderer.renderer.info.render.drawCalls = 1
      renderer.renderer.info.render.triangles = effect.count * 2
      benchmark.renderInvocationCpuMs = 2.5
      loopHarness.render(context)
      expect(pointerUpdates).toEqual([{ renderedLongAxis: 480, time: undefined }])
      expect(benchmark.frames).toHaveLength(1)
      const frame = benchmark.frames[0] as Record<string, unknown>
      expect(frame.totalDrawCalls).toBe(1)
      expect(frame.particleInstances).toBe(effect.count)
      expect(frame.triangles).toBe(effect.count * 2)
      expect(frame.motionScheduledBytes).toBe(resources.cloud.motion.byteLength)
      expect(frame.computeDispatches).toBe(0)
      expect(frame.colorUploadBytes).toBe(0)
      expect(frame.renderCallbackGapMs).toBeGreaterThanOrEqual(0)
      expect(frame.renderInvocationCpuMs).toBe(2.5)
      expect(frame.afterRenderCpuMs).toBeGreaterThanOrEqual(0)

      const callbackCount = benchmark.callbackCount
      const updateCallbacks = benchmark.counters.updateCallbacks
      const renderInvocations = benchmark.counters.renderInvocations
      const afterRenderCallbacks = benchmark.counters.afterRenderCallbacks
      const invalidations = loopHarness.invalidations
      const motionVersion = resources.cloudMotion.version
      const motionStorage = resources.cloudMotion.array
      const pausedElapsed = resources.uniforms.elapsedSeconds.value
      active.value = false
      await Vue.nextTick()
      loopHarness.beforeRender(context)
      loopHarness.render(context)
      expect(pointerUpdates).toHaveLength(1)
      expect(benchmark.callbackCount).toBe(callbackCount)
      expect(benchmark.counters.updateCallbacks).toBe(updateCallbacks)
      expect(benchmark.counters.renderInvocations).toBe(renderInvocations)
      expect(benchmark.counters.afterRenderCallbacks).toBe(afterRenderCallbacks)
      expect(loopHarness.invalidations).toBe(invalidations)
      expect(resources.cloudMotion.version).toBe(motionVersion)
      expect(loopHarness.stops).toBeGreaterThan(0)
      expect(resources.uniforms.elapsedSeconds.value).toBe(pausedElapsed)

      const starts = loopHarness.starts
      active.value = true
      await Vue.nextTick()
      expect(loopHarness.starts).toBe(starts + 1)
      expect(loopHarness.invalidations).toBe(invalidations + 1)
      const resumedContext = makeFrameContext(renderer.renderer, 2)
      renderer.renderer.info.render.drawCalls = 0
      renderer.renderer.info.render.triangles = 0
      loopHarness.beforeRender(resumedContext)
      renderer.renderer.info.render.drawCalls = 1
      renderer.renderer.info.render.triangles = effect.count * 2
      loopHarness.render(resumedContext)
      expect(pointerUpdates).toHaveLength(2)
      expect(benchmark.frames).toHaveLength(2)
      expect(resources.uniforms.elapsedSeconds.value).toBe(2)
      expect(resources.cloudMotion.array).toBe(motionStorage)
    } finally {
      app.unmount()
      host.remove()
      fence.dispose()
      disposeParticleSceneResources(resources)
    }
  })

  it('fences context loss and all later renderer events', () => {
    const resources = createParticleSceneResources(makeParticles(), effect)
    const harness = makeRenderer()
    const events: string[] = []
    const fence = new ParticleSceneEventFence(effect.count, {
      firstFrame: () => events.push('first-frame'),
      framePending: () => events.push('frame-pending'),
      error: () => events.push('error'),
      contextLost: (event: Event) => events.push(event.type)
    })
    fence.ready(harness.renderer)
    harness.canvas.dispatchEvent(new browserWindow.Event('webglcontextlost'))
    harness.canvas.dispatchEvent(new browserWindow.Event('webglcontextlost'))
    fence.lost()
    fence.fail(new Error('late failure'))
    expect(events).toEqual(['webglcontextlost'])
    expect(fence.hasFailed).toBe(true)
    fence.dispose()
    disposeParticleSceneResources(resources)
  })
})

describe('LogoParticleScene shader prewarm readiness', () => {
  it('stops the root before compile, blocks visibility bypass and callbacks, then draws the compiled active lease', async () => {
    const benchmark = makeBenchmark()
    const backend = makePrewarmingBackend()
    const scene = mountPrewarmingScene()
    const motionVersion = scene.resources.cloudMotion.version
    const readiness = scene.ready(backend)

    try {
      expect(backend.compileLoopStates).toEqual([false])
      expect(loopHarness.isActive.value).toBe(false)
      expect(scene.state.loopControl.ready).toBe(false)
      scene.draw(backend)
      scene.callbacks(backend)
      expect(backend.draws).toBe(0)
      expect(scene.resources.cloudMotion.version).toBe(motionVersion)
      expect(benchmark.counters.updateCallbacks).toBe(0)
      expect(benchmark.counters.renderInvocations).toBe(0)
      expect(scene.events).toEqual([])

      scene.active.value = false
      await Vue.nextTick()
      scene.active.value = true
      await Vue.nextTick()
      scene.draw(backend)
      scene.callbacks(backend)
      expect(loopHarness.isActive.value).toBe(false)
      expect(loopHarness.starts).toBe(0)
      expect(loopHarness.invalidations).toBe(0)
      expect(backend.draws).toBe(0)
      expect(scene.resources.cloudMotion.version).toBe(motionVersion)
      expect(benchmark.counters.updateCallbacks).toBe(0)
      expect(benchmark.counters.renderInvocations).toBe(0)

      backend.resolveCompilation()
      await readiness
      expect(scene.state.loopControl.ready).toBe(true)
      expect(loopHarness.isActive.value).toBe(true)
      expect(loopHarness.starts).toBe(1)
      expect(loopHarness.invalidations).toBe(1)
      expect(backend.compileLoopStates).toEqual([false])
      scene.draw(backend, 2)
      expect(backend.draws).toBe(1)
      expect(scene.resources.cloudMotion.version).toBeGreaterThan(motionVersion)
      expect(benchmark.counters.updateCallbacks).toBe(1)
      expect(benchmark.counters.renderInvocations).toBe(1)
      expect(scene.events).toEqual(['first-frame'])
      expect(scene.errors).toEqual([])

      scene.active.value = false
      await Vue.nextTick()
      scene.draw(backend, 3)
      expect(loopHarness.isActive.value).toBe(false)
      expect(backend.draws).toBe(1)
      scene.active.value = true
      await Vue.nextTick()
      expect(loopHarness.starts).toBe(2)
      scene.draw(backend, 3)
      expect(backend.draws).toBe(2)
      expect(scene.events).toEqual(['first-frame', 'frame-pending', 'first-frame'])
      expect(backend.compileLoopStates).toEqual([false])
    } finally {
      backend.resolveCompilation()
      await readiness
      await scene.close()
    }
  })

  it('commits successful prewarm while inactive without starting until visibility resumes', async () => {
    const backend = makePrewarmingBackend()
    const scene = mountPrewarmingScene()
    const readiness = scene.ready(backend)

    try {
      scene.active.value = false
      await Vue.nextTick()
      backend.resolveCompilation()
      await readiness
      expect(scene.state.loopControl.ready).toBe(true)
      expect(loopHarness.isActive.value).toBe(false)
      expect(loopHarness.starts).toBe(0)
      expect(loopHarness.invalidations).toBe(0)
      scene.draw(backend)
      expect(backend.draws).toBe(0)

      scene.active.value = true
      await Vue.nextTick()
      expect(loopHarness.isActive.value).toBe(true)
      expect(loopHarness.starts).toBe(1)
      expect(loopHarness.invalidations).toBeGreaterThan(0)
      scene.draw(backend)
      expect(backend.draws).toBe(1)
      expect(scene.events).toEqual(['first-frame'])
      expect(scene.errors).toEqual([])
      expect(backend.compileLoopStates).toEqual([false])
    } finally {
      backend.resolveCompilation()
      await readiness
      await scene.close()
    }
  })

  for (const rejectStale of [false, true]) {
    it(`ignores ${rejectStale ? 'rejection' : 'success'} from a replaced prewarm lease and starts only its compiled successor`, async () => {
      const staleBackend = makePrewarmingBackend(1)
      const currentBackend = makePrewarmingBackend(2)
      const scene = mountPrewarmingScene()
      const staleReadiness = scene.ready(staleBackend)
      const currentReadiness = scene.ready(currentBackend)

      try {
        if (rejectStale) staleBackend.rejectCompilation(new Error('Stale compilation failed'))
        else staleBackend.resolveCompilation()
        await staleReadiness
        expect(staleBackend.lease.status).toBe('retired')
        expect(scene.state.loopControl.ready).toBe(false)
        expect(loopHarness.isActive.value).toBe(false)
        expect(loopHarness.starts).toBe(0)
        expect(loopHarness.invalidations).toBe(0)
        expect(scene.errors).toEqual([])
        scene.draw(currentBackend)
        expect(currentBackend.draws).toBe(0)

        currentBackend.resolveCompilation()
        await currentReadiness
        expect(scene.state.loopControl.ready).toBe(true)
        expect(loopHarness.isActive.value).toBe(true)
        expect(loopHarness.starts).toBe(1)
        expect(loopHarness.invalidations).toBe(1)
        scene.draw(currentBackend)
        expect(staleBackend.draws).toBe(0)
        expect(currentBackend.draws).toBe(1)
        expect(scene.events).toEqual(['first-frame'])
        expect(scene.errors).toEqual([])
        expect(staleBackend.compileLoopStates).toEqual([false])
        expect(currentBackend.compileLoopStates).toEqual([false])
      } finally {
        staleBackend.resolveCompilation()
        currentBackend.resolveCompilation()
        await Promise.all([staleReadiness, currentReadiness])
        await scene.close()
      }
    })
  }

  for (const retirePending of [false, true]) {
    it(`keeps the root stopped after ${retirePending ? 'teardown during prewarm' : 'compilation rejection'}`, async () => {
      const backend = makePrewarmingBackend()
      const scene = mountPrewarmingScene()
      const readiness = scene.ready(backend)
      const compilationError = new Error('Native pipeline compilation failed')

      try {
        if (retirePending) {
          const retirement = scene.teardown()
          expect(backend.lease.status).toBe('retired')
          expect(scene.resources.disposed).toBe(false)
          expect(loopHarness.isActive.value).toBe(false)
          backend.resolveCompilation()
          await readiness
          await retirement
          expect(scene.resources.disposed).toBe(true)
        } else {
          backend.rejectCompilation(compilationError)
          await readiness
          expect(scene.errors).toEqual([compilationError])
        }
        await Vue.nextTick()
        expect(scene.state.loopControl.ready).toBe(false)
        expect(scene.state.canvasMounted).toBe(false)
        expect(scene.state.renderEnabled).toBe(false)
        expect(loopHarness.isActive.value).toBe(false)
        expect(loopHarness.starts).toBe(0)
        expect(loopHarness.invalidations).toBe(0)
        scene.active.value = false
        await Vue.nextTick()
        scene.active.value = true
        await Vue.nextTick()
        scene.draw(backend)
        scene.callbacks(backend)
        expect(loopHarness.isActive.value).toBe(false)
        expect(loopHarness.starts).toBe(0)
        expect(loopHarness.invalidations).toBe(0)
        expect(backend.draws).toBe(0)
        expect(scene.events).toEqual([])
        expect(scene.errors).toEqual(retirePending ? [] : [compilationError])
      } finally {
        backend.resolveCompilation()
        await readiness
        await scene.close()
      }
    })
  }
})
