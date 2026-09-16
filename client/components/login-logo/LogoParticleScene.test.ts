import path from 'node:path'

import { compileScript, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import type { WebGPURenderer } from 'three/webgpu'
import { beforeEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import type { Component } from 'vue'
import type { ParticleSceneEventFence as ParticleSceneEventFenceClass, ParticleSceneFrame, ParticleSceneResources } from './LogoParticleScene.vue'
import type { LogoEffectDescriptor, ParsedLogoParticles, ParticleContentRect } from './particle-logo.ts'
import type { LogoPointerState } from './useLogoPointer.ts'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/login'
})
const browserWindow = dom.window
for (const [name, value] of Object.entries({
  Element: browserWindow.Element,
  Event: browserWindow.Event,
  HTMLCanvasElement: browserWindow.HTMLCanvasElement,
  HTMLElement: browserWindow.HTMLElement,
  Node: browserWindow.Node,
  SVGElement: browserWindow.SVGElement,
  MutationObserver: browserWindow.MutationObserver,
  document: browserWindow.document,
  window: browserWindow
})) {
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true })
}

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
  invalidations: 0,
  render: null as LoopCallback | null,
  starts: 0,
  stops: 0
}
const resetLoopHarness = (): void => {
  loopHarness.beforeRender = null
  loopHarness.invalidations = 0
  loopHarness.render = null
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
      loopHarness.starts += 1
    },
    stop: () => {
      loopHarness.stops += 1
    }
  }),
  useTres: () => ({
    invalidate: () => {
      loopHarness.invalidations += 1
    }
  })
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
  createParticleSceneResources: (particles: ParsedLogoParticles, effect: LogoEffectDescriptor) => ParticleSceneResources
  default: { components?: Record<string, Component>; emits?: Record<string, unknown> }
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

beforeEach(() => {
  resetLoopHarness()
  Reflect.deleteProperty(window, '__logoParticlePerformance')
  document.body.replaceChildren()
})

describe('LogoParticleScene resource path', () => {
  it('exposes the scene component with the pending and committed lifecycle events', () => {
    expect(Object.keys(LogoParticleScene.emits ?? {}).sort()).toEqual(['context-lost', 'error', 'first-frame', 'frame-pending'])
  })

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

  it('disposes the mesh resources idempotently without mutating parser-owned bytes', () => {
    const particles = makeParticles()
    const resources = createParticleSceneResources(particles, effect)
    const before = new Uint8Array(particles.buffer).slice()
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
    disposeParticleSceneResources(resources)
    expect(geometryDisposals).toBe(1)
    expect(materialDisposals).toBe(1)
    expect(resources.mesh.parent).toBeNull()
    expect(new Uint8Array(particles.buffer)).toEqual(before)
  })
})

describe('LogoParticleScene frame fence and loop', () => {
  it('proves first frames from renderer draw and triangle deltas, then requires pending before a resumed proof', () => {
    const benchmark = makeBenchmark()
    const resources = createParticleSceneResources(makeParticles(), effect)
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
      fence.rendered(harness.renderer, true)
      expect(fence.lastRenderDrawCalls).toBe(0)
      expect(fence.lastRenderTriangles).toBe(0)
      harness.renderer.info.render.drawCalls = 1
      harness.renderer.info.render.triangles = effect.count * 2
      fence.rendered(harness.renderer, true)
      expect(fence.lastRenderDrawCalls).toBe(1)
      expect(fence.lastRenderTriangles).toBe(effect.count * 2)
      expect(events).toEqual(['submission', 'first-frame'])

      fence.markPending()
      expect(events).toEqual(['submission', 'first-frame', 'frame-pending'])
      harness.renderer.info.render.drawCalls += 1
      harness.renderer.info.render.triangles += effect.count * 2
      fence.rendered(harness.renderer, true)
      expect(events).toEqual(['submission', 'first-frame', 'frame-pending', 'submission', 'first-frame'])
    } finally {
      fence.dispose()
      disposeParticleSceneResources(resources)
    }
  })

  it('records active frames while staying callback-free after deactivation', async () => {
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
