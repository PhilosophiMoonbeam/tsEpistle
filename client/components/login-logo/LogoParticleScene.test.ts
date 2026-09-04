import fs from 'node:fs'
import path from 'node:path'

import { compileScript, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import type { WebGLRenderer } from 'three'
import type { Component } from 'vue'
import { describe, expect, it } from '../../../server/test/bun-test.mts'
import type { ParticleSceneEventFence as ParticleSceneEventFenceClass, ParticleSceneFrame, ParticleSceneResources } from './LogoParticleScene.vue'
import type { LogoEffectDescriptor, ParsedLogoParticles } from './particle-logo.ts'
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
}))
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true })

const componentPath = path.join(process.cwd(), 'client/components/login-logo/LogoParticleScene.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const parsed = parse(componentSource, { filename: componentPath })
if (parsed.errors.length > 0) throw new Error(`Could not parse LogoParticleScene.vue: ${parsed.errors.join(', ')}`)
if (!parsed.descriptor.script || parsed.descriptor.scriptSetup) {
  throw new Error('LogoParticleScene.vue ordinary script was not found')
}
const compiledScript = compileScript(parsed.descriptor, {
  id: 'logo-particle-scene-test',
  genDefaultAs: '__sfc__'
})
const compiledComponent = `${compiledScript.content}\nexport default __sfc__\n`
const [Vue, Tres, Three, WebGLModule] = await Promise.all([
  import('vue'),
  import('@tresjs/core'),
  import('three'),
  import('three/addons/capabilities/WebGL.js')
])
const shaderSources: Record<string, string> = {
  './particle.frag.glsl?raw': fs.readFileSync(path.join(path.dirname(componentPath), 'particle.frag.glsl'), 'utf8'),
  './particle.vert.glsl?raw': fs.readFileSync(path.join(path.dirname(componentPath), 'particle.vert.glsl'), 'utf8')
}

interface LoopTestContext {
  readonly elapsed: number
  readonly renderer: WebGLRenderer
  readonly sizes: {
    readonly height: { readonly value: number }
    readonly width: { readonly value: number }
  }
}

type LoopTestCallback = (context: LoopTestContext) => void

const loopHarness = {
  beforeRender: null as LoopTestCallback | null,
  invalidations: 0,
  render: null as LoopTestCallback | null,
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
    onBeforeRender: (callback: LoopTestCallback) => {
      loopHarness.beforeRender = callback
      return {
        off: () => {
          if (loopHarness.beforeRender === callback) loopHarness.beforeRender = null
        }
      }
    },
    onRender: (callback: LoopTestCallback) => {
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
  external: ['@tresjs/core', 'three', 'three/addons/capabilities/WebGL.js', 'vue'],
  format: 'cjs',
  plugins: [
    {
      name: 'logo-particle-scene-test-sfc',
      setup(build) {
        build.onResolve({ filter: /^virtual:LogoParticleScene\.vue$/ }, () => ({ path: componentPath }))
        build.onLoad({ filter: /LogoParticleScene\.vue$/, namespace: 'file' }, () => ({
          contents: compiledComponent,
          loader: 'ts',
          resolveDir: path.dirname(componentPath)
        }))
        build.onResolve({ filter: /particle\.(?:frag|vert)\.glsl\?raw$/ }, args => ({
          namespace: 'logo-particle-test-shader',
          path: args.path
        }))
        build.onLoad({ filter: /.*/, namespace: 'logo-particle-test-shader' }, args => ({
          contents: `export default ${JSON.stringify(shaderSources[args.path])}`,
          loader: 'js'
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
interface SceneModule {
  ParticleSceneEventFence: typeof ParticleSceneEventFenceClass
  createParticleSceneResources: (particles: ParsedLogoParticles, effect: LogoEffectDescriptor) => ParticleSceneResources
  default: { components?: Record<string, Component>; props?: Record<string, unknown>; emits?: Record<string, unknown> }
  disposeParticleSceneResources: (resources: ParticleSceneResources) => void
  updateParticleSceneBackground: (resources: ParticleSceneResources, canvas: HTMLCanvasElement) => void
  updateParticleSceneFrame: (
    resources: ParticleSceneResources,
    pointerController: {
      update: (renderedLongAxis: number) => LogoPointerState
    },
    frame: ParticleSceneFrame
  ) => void
}
interface CompiledModule {
  exports: Partial<SceneModule>
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
    if (specifier === 'three/addons/capabilities/WebGL.js') return WebGLModule
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
  updateParticleSceneBackground,
  updateParticleSceneFrame
} = compiledModule.exports as SceneModule
const ParticleSceneContents = LogoParticleScene.components?.ParticleSceneContents
if (!ParticleSceneContents) throw new Error('LogoParticleScene.vue inner scene component was not found')

const effect: LogoEffectDescriptor = {
  logoUrl: '/_site-logo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/logo.png',
  particleUrl: '/_site-logo/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/particle.bin',
  staticUrl: '/_site-logo/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc/effect.png',
  width: 640,
  height: 320,
  aspect: 2,
  count: 3,
  medianStroke: 10
}

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

interface RendererHarness {
  readonly canvas: HTMLCanvasElement
  readonly renderer: WebGLRenderer
  readonly clearAlpha: number[]
}

const makeRenderer = (points = effect.count): RendererHarness => {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 320
  const clearAlpha: number[] = []
  const renderer = {
    debug: { checkShaderErrors: false, onShaderError: null },
    domElement: canvas,
    info: { render: { points } },
    setClearAlpha: (alpha: number) => clearAlpha.push(alpha)
  } as unknown as WebGLRenderer
  return { canvas, clearAlpha, renderer }
}

const pointerState: LogoPointerState = {
  activeImpulseCount: 2,
  influenceRadiusCss: 32,
  impulses: [
    { active: true, ageSeconds: 0.24, directionX: 0.6, directionY: 0.8, radiusCss: 32, travelCss: 6, x: 0.25, y: -0.5 },
    { active: true, ageSeconds: 0.1, directionX: -1, directionY: 0, radiusCss: 24, travelCss: 3, x: -0.25, y: 0.5 },
    { active: false, ageSeconds: 0, directionX: 1, directionY: 0, radiusCss: 18, travelCss: 0, x: 0, y: 0 },
    { active: false, ageSeconds: 0, directionX: 1, directionY: 0, radiusCss: 18, travelCss: 0, x: 0, y: 0 }
  ]
}
const expectNormalizedDirectionTravel = (
  actual: readonly { readonly x: number; readonly y: number; readonly z: number; readonly w: number }[],
  expected: readonly [number, number, number, number][]
): void => {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((value, index) => {
    const [x, y, z, w] = expected[index]
    expect(value.x).toBeCloseTo(x, 12)
    expect(value.y).toBeCloseTo(y, 12)
    expect(value.z).toBe(z)
    expect(value.w).toBe(w)
  })
}

interface TestFrameCapture {
  readonly capturedAt: number
  readonly dataUrl: string
}

interface TestFrameCaptureOptions {
  readonly elapsedSeconds: number
}

interface TestFrameCaptureHook {
  request: ((options?: TestFrameCaptureOptions) => Promise<TestFrameCapture>) | null
}

const installFrameCaptureHook = (): TestFrameCaptureHook => {
  const hook: TestFrameCaptureHook = { request: null }
  Object.defineProperty(window, '__logoParticleFrameCapture', {
    configurable: true,
    value: hook
  })
  return hook
}

const makeLoopContext = (canvas: HTMLCanvasElement): LoopTestContext => ({
  elapsed: 1,
  renderer: {
    domElement: canvas,
    getPixelRatio: () => 1
  } as unknown as WebGLRenderer,
  sizes: {
    height: { value: 320 },
    width: { value: 640 }
  }
})

const mountParticleSceneContents = () => {
  resetLoopHarness()
  const resources = createParticleSceneResources(makeParticles(), effect)
  const loopControl = { stop: null as (() => void) | null }
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp(ParticleSceneContents, {
    active: true,
    loopControl,
    pointerController: { update: () => pointerState },
    resources
  })
  let mounted = true
  app.mount(host)

  return {
    resources,
    unmount: () => {
      if (!mounted) return
      mounted = false
      app.unmount()
      host.remove()
      disposeParticleSceneResources(resources)
    }
  }
}

describe('LogoParticleScene resources', () => {
  it('publishes only the contracted props and events', () => {
    expect(Object.keys(LogoParticleScene.props ?? {}).sort()).toEqual(['active', 'effect', 'particles'])
    expect(Object.keys(LogoParticleScene.emits ?? {}).sort()).toEqual(['context-lost', 'error', 'first-frame'])
  })

  it('creates a configured front-on orthographic camera', () => {
    const resources = createParticleSceneResources(makeParticles(), effect)

    expect(resources.camera.isOrthographicCamera).toBe(true)
    expect(resources.camera.position.toArray()).toEqual([0, 0, 2])
    expect(resources.camera.rotation.x).toBeCloseTo(0)
    expect(resources.camera.rotation.y).toBeCloseTo(0)
    expect(resources.camera.rotation.z).toBeCloseTo(0)
    disposeParticleSceneResources(resources)
  })

  it('configures stable fixed impulse uniforms alongside the gaseous motion contract', () => {
    const resources = createParticleSceneResources(makeParticles(), effect)

    expect(Object.keys(resources.uniforms).sort()).toEqual([
      'uAspect',
      'uBackground',
      'uDpr',
      'uImpulseDirectionTravel',
      'uImpulsePositionAge',
      'uMedianStroke',
      'uRenderedLongAxis',
      'uTime',
      'uViewport'
    ])
    expect(resources.uniforms.uImpulsePositionAge.value).toHaveLength(4)
    expect(resources.uniforms.uImpulseDirectionTravel.value).toHaveLength(4)
    expect(resources.uniforms.uImpulsePositionAge.value.map(value => value.toArray())).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ])
    expect(resources.uniforms.uImpulseDirectionTravel.value.map(value => value.toArray())).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ])

    disposeParticleSceneResources(resources)
  })

  it('constructs normalized zero-copy geometry attributes over the immutable SoA views', () => {
    const particles = makeParticles()
    const before = new Uint8Array(particles.buffer).slice()
    const resources = createParticleSceneResources(particles, effect)
    const expected = [
      ['logoXY', particles.xy, 2],
      ['logoDepth', particles.depth, 1],
      ['logoColor', particles.rgba, 4],
      ['logoSize', particles.size, 1],
      ['logoSeed', particles.seed, 1]
    ] as const

    for (const [name, array, itemSize] of expected) {
      const attribute = resources.geometry.getAttribute(name)
      expect(attribute.array).toBe(array)
      expect(attribute.itemSize).toBe(itemSize)
      expect(attribute.normalized).toBe(true)
      expect(attribute.count).toBe(effect.count)
    }
    expect(resources.geometry.drawRange).toEqual({ start: 0, count: effect.count })
    expect(resources.points.geometry).toBe(resources.geometry)
    expect(resources.points.material).toBe(resources.material)
    expect(resources.points.frustumCulled).toBe(false)
    expect(resources.material.transparent).toBe(true)
    expect(resources.material.depthTest).toBe(false)
    expect(resources.material.depthWrite).toBe(false)
    expect(resources.material.blending).toBe(Three.NormalBlending)
    expect(resources.material.premultipliedAlpha).toBe(false)
    expect(new Uint8Array(particles.buffer)).toEqual(before)

    disposeParticleSceneResources(resources)
  })

  it('updates every animated frame through uniforms without per-particle mutation or attribute uploads', () => {
    const particles = makeParticles()
    const before = new Uint8Array(particles.buffer).slice()
    const resources = createParticleSceneResources(particles, effect)
    const attributes = ['logoXY', 'logoDepth', 'logoColor', 'logoSize', 'logoSeed'].map(name => resources.geometry.getAttribute(name))
    const arrays = attributes.map(attribute => attribute.array)
    const versions = attributes.map(attribute => attribute.version)
    const impulseDirectionUniforms = resources.uniforms.uImpulseDirectionTravel.value
    const impulsePositionUniforms = resources.uniforms.uImpulsePositionAge.value
    const renderedLongAxes: number[] = []
    const pointerController = {
      update: (renderedLongAxis: number) => {
        renderedLongAxes.push(renderedLongAxis)
        return pointerState
      }
    }
    const uniformOnlyResources = new Proxy(resources, {
      get: (target, property, receiver) => {
        if (property === 'camera' || property === 'geometry' || property === 'material' || property === 'points') {
          throw new Error(`Frame callback read per-particle resource ${String(property)}`)
        }
        return Reflect.get(target, property, receiver)
      }
    })

    for (let frame = 0; frame < 120; frame += 1) {
      updateParticleSceneFrame(uniformOnlyResources, pointerController, {
        elapsed: frame / 60,
        height: 320,
        pixelRatio: 2,
        width: 640
      })
    }

    expect(renderedLongAxes).toHaveLength(120)
    expect(renderedLongAxes.every(value => value === 640)).toBe(true)
    expect(attributes.map(attribute => attribute.array)).toEqual(arrays)
    expect(attributes.map(attribute => attribute.version)).toEqual(versions)
    expect(new Uint8Array(particles.buffer)).toEqual(before)
    expect(resources.uniforms.uImpulseDirectionTravel.value).toBe(impulseDirectionUniforms)
    expect(resources.uniforms.uImpulsePositionAge.value.map(value => value.toArray())).toEqual([
      [0.25, -0.5, 0.24, 1],
      [-0.25, 0.5, 0.1, 1],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ])
    expectNormalizedDirectionTravel(resources.uniforms.uImpulseDirectionTravel.value, [
      [0.6, 0.8, 6, 32],
      [-1, 0, 3, 24],
      [1, 0, 0, 18],
      [1, 0, 0, 18]
    ])
    expect(resources.uniforms.uDpr.value).toBe(1.5)
    expect(resources.uniforms.uTime.value).toBeCloseTo(119 / 60)
    disposeParticleSceneResources(resources)
    updateParticleSceneFrame(uniformOnlyResources, pointerController, {
      elapsed: 99,
      height: 320,
      pixelRatio: 1,
      width: 640
    })
    expect(renderedLongAxes).toHaveLength(120)
    expect(resources.uniforms.uTime.value).toBeCloseTo(119 / 60)
  })

  it('derives each motion frame from absolute time rather than callback cadence', () => {
    const scheduled = createParticleSceneResources(makeParticles(), effect)
    const direct = createParticleSceneResources(makeParticles(), effect)
    const pointerController = { update: () => pointerState }
    const at = (resources: ParticleSceneResources, elapsed: number): void => {
      updateParticleSceneFrame(resources, pointerController, {
        elapsed,
        height: 320,
        pixelRatio: 1,
        width: 640
      })
    }

    at(scheduled, 0.125)
    at(scheduled, 0.9)
    at(scheduled, 4.25)
    at(direct, 4.25)

    expect(scheduled.uniforms.uTime.value).toBe(4.25)
    expect(direct.uniforms.uTime.value).toBe(4.25)
    expect(scheduled.uniforms.uImpulsePositionAge.value.map(value => value.toArray())).toEqual(
      direct.uniforms.uImpulsePositionAge.value.map(value => value.toArray())
    )
    expect(scheduled.uniforms.uImpulseDirectionTravel.value.map(value => value.toArray())).toEqual(
      direct.uniforms.uImpulseDirectionTravel.value.map(value => value.toArray())
    )

    disposeParticleSceneResources(scheduled)
    disposeParticleSceneResources(direct)
  })

  it('publishes one bounded aggregate motion record only through an opt-in hook', () => {
    const benchmark = {
      callbackCount: 0,
      callbackCpuMilliseconds: [] as number[],
      frameIntervalsMilliseconds: [] as number[],
      firstFrameMilliseconds: null,
      lastFrameAt: null,
      lastMotion: undefined as unknown
    }
    Object.defineProperty(window, '__logoParticlePerformance', {
      configurable: true,
      value: benchmark
    })

    try {
      const particles = makeParticles()
      const before = new Uint8Array(particles.buffer).slice()
      const resources = createParticleSceneResources(particles, effect)
      const diagnostics = benchmark.lastMotion
      const boundedPointer: LogoPointerState = {
        ...pointerState,
        activeImpulseCount: 4,
        impulses: [
          { active: true, ageSeconds: -4, directionX: 12, directionY: 16, radiusCss: 200, travelCss: 80, x: 4, y: -4 },
          { active: true, ageSeconds: 0.9, directionX: 0, directionY: 0, radiusCss: 1, travelCss: 5, x: 0, y: 0 },
          { active: true, ageSeconds: 0.4, directionX: 0, directionY: 1, radiusCss: 20, travelCss: 4, x: 0.2, y: 0.3 },
          { active: false, ageSeconds: 0.2, directionX: 1, directionY: 0, radiusCss: 18, travelCss: 4, x: 0, y: 0 }
        ]
      }

      updateParticleSceneFrame(
        resources,
        { update: () => boundedPointer },
        {
          elapsed: 123.5,
          height: 320,
          pixelRatio: 1,
          width: 640
        }
      )
      expect(resources.uniforms.uImpulsePositionAge.value.map(value => value.toArray())).toEqual([
        [1, -1, 0, 1],
        [0, 0, 0.9, 0],
        [0.2, 0.3, 0.4, 1],
        [0, 0, 0.2, 0]
      ])
      expectNormalizedDirectionTravel(resources.uniforms.uImpulseDirectionTravel.value, [
        [0.6, 0.8, 12, 32],
        [1, 0, 0, 18],
        [0, 1, 4, 20],
        [1, 0, 0, 18]
      ])

      expect(benchmark.lastMotion).toBe(diagnostics)
      expect(Object.keys(diagnostics as object).sort()).toEqual([
        'activeImpulseCount',
        'depthScaleMax',
        'depthScaleMin',
        'elapsedSeconds',
        'idleAmplitudeCss',
        'impulseLifetimeSeconds',
        'maxImpulseTravelCss',
        'neighborForceRatio',
        'particleCount'
      ])
      expect(diagnostics).toEqual({
        activeImpulseCount: 2,
        depthScaleMax: 1.18,
        depthScaleMin: 0.82,
        elapsedSeconds: 123.5,
        idleAmplitudeCss: 2.5,
        impulseLifetimeSeconds: 0.9,
        maxImpulseTravelCss: 8,
        neighborForceRatio: 0.18,
        particleCount: effect.count
      })
      expect(new Uint8Array(particles.buffer)).toEqual(before)

      disposeParticleSceneResources(resources)
      updateParticleSceneFrame(
        resources,
        { update: () => pointerState },
        {
          elapsed: 999,
          height: 320,
          pixelRatio: 1,
          width: 640
        }
      )
      expect(benchmark.lastMotion).toEqual(diagnostics)
    } finally {
      Reflect.deleteProperty(window, '__logoParticlePerformance')
    }
  })

  it('changes only the background uniform when the rendered theme surface changes', () => {
    const particles = makeParticles()
    const before = new Uint8Array(particles.buffer).slice()
    const resources = createParticleSceneResources(particles, effect)
    const attributes = ['logoXY', 'logoDepth', 'logoColor', 'logoSize', 'logoSeed'].map(name => resources.geometry.getAttribute(name))
    const versions = attributes.map(attribute => attribute.version)
    const stableUniformValues = [
      resources.uniforms.uAspect.value,
      resources.uniforms.uDpr.value,
      ...resources.uniforms.uImpulseDirectionTravel.value,
      ...resources.uniforms.uImpulsePositionAge.value,
      resources.uniforms.uMedianStroke.value,
      resources.uniforms.uRenderedLongAxis.value,
      resources.uniforms.uTime.value,
      resources.uniforms.uViewport.value
    ]
    const surface = document.createElement('div')
    const canvas = document.createElement('canvas')
    surface.append(canvas)
    document.body.append(surface)

    surface.style.backgroundColor = 'rgb(10, 20, 30)'
    updateParticleSceneBackground(resources, canvas)
    const darkBackground = resources.uniforms.uBackground.value.clone()
    surface.style.backgroundColor = 'rgb(230, 220, 210)'
    updateParticleSceneBackground(resources, canvas)

    expect(resources.uniforms.uBackground.value.equals(darkBackground)).toBe(false)
    expect([
      resources.uniforms.uAspect.value,
      resources.uniforms.uDpr.value,
      ...resources.uniforms.uImpulseDirectionTravel.value,
      ...resources.uniforms.uImpulsePositionAge.value,
      resources.uniforms.uMedianStroke.value,
      resources.uniforms.uRenderedLongAxis.value,
      resources.uniforms.uTime.value,
      resources.uniforms.uViewport.value
    ]).toEqual(stableUniformValues)
    expect(attributes.map(attribute => attribute.version)).toEqual(versions)
    expect(new Uint8Array(particles.buffer)).toEqual(before)

    surface.remove()
    disposeParticleSceneResources(resources)
  })

  it('rejects attributes detached from the parser-owned buffer', () => {
    const particles = makeParticles()
    const detached = Object.freeze({ ...particles, size: new Uint8Array([1, 2, 3]) })
    expect(() => createParticleSceneResources(detached, effect)).toThrow('owned input buffer')
  })

  it('disposes geometry and material exactly once without changing input bytes', () => {
    const particles = makeParticles()
    const before = new Uint8Array(particles.buffer).slice()
    const resources = createParticleSceneResources(particles, effect)
    const scene = new Three.Scene()
    scene.add(resources.camera, resources.points)
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
    expect(resources.points.parent).toBeNull()
    expect(resources.camera.parent).toBeNull()
    expect(new Uint8Array(particles.buffer)).toEqual(before)
  })
})

describe('LogoParticleScene test frame capture lifecycle', () => {
  it('does not expose or serialize a frame when the opt-in hook is absent', () => {
    Reflect.deleteProperty(window, '__logoParticleFrameCapture')
    const mounted = mountParticleSceneContents()

    try {
      expect('__logoParticleFrameCapture' in window).toBe(false)
      const canvas = document.createElement('canvas')
      let serializations = 0
      canvas.toDataURL = () => {
        serializations += 1
        return 'data:image/png;base64,absent'
      }
      const render = loopHarness.render
      if (!render) throw new Error('Tres after-render callback was not registered')

      render(makeLoopContext(canvas))

      expect(serializations).toBe(0)
      expect('__logoParticleFrameCapture' in window).toBe(false)
    } finally {
      mounted.unmount()
      Reflect.deleteProperty(window, '__logoParticleFrameCapture')
    }
  })

  it('resolves one owned request only from Tres after-render with the rendered PNG and page timestamp', async () => {
    const hook = installFrameCaptureHook()
    const mounted = mountParticleSceneContents()

    try {
      const request = hook.request
      if (!request) throw new Error('Particle frame capture request was not registered')
      const canvas = document.createElement('canvas')
      const requestedTypes: string[] = []
      canvas.toDataURL = type => {
        requestedTypes.push(type ?? '')
        return 'data:image/png;base64,rendered'
      }
      const beforeRender = loopHarness.beforeRender
      const render = loopHarness.render
      if (!beforeRender || !render) throw new Error('Tres frame callbacks were not registered')
      const invalidationsBeforeRequest = loopHarness.invalidations
      let settled = false
      const capturePromise = request().then(capture => {
        settled = true
        return capture
      })

      expect(loopHarness.invalidations).toBe(invalidationsBeforeRequest + 1)
      await Promise.resolve()
      expect(settled).toBe(false)
      beforeRender(makeLoopContext(canvas))
      await Promise.resolve()
      expect(settled).toBe(false)
      const earliestCapture = performance.now()
      render(makeLoopContext(canvas))
      const capture = await capturePromise

      expect(capture.dataUrl).toBe('data:image/png;base64,rendered')
      expect(capture.capturedAt).toBeGreaterThanOrEqual(earliestCapture)
      expect(capture.capturedAt).toBeLessThanOrEqual(performance.now())
      expect(requestedTypes).toEqual(['image/png'])
      expect(hook.request).toBe(request)

      const pending = request()
      await expect(request()).rejects.toThrow('already pending')
      render(makeLoopContext(canvas))
      await expect(pending).resolves.toEqual({
        capturedAt: expect.any(Number),
        dataUrl: 'data:image/png;base64,rendered'
      })

      const replacement = async (): Promise<TestFrameCapture> => ({
        capturedAt: -1,
        dataUrl: 'data:image/png;base64,replacement'
      })
      hook.request = replacement
      mounted.unmount()
      expect(hook.request).toBe(replacement)
    } finally {
      mounted.unmount()
      Reflect.deleteProperty(window, '__logoParticleFrameCapture')
    }
  })
  it('applies a finite nonnegative elapsed override once before rendering, then resumes real elapsed time', async () => {
    const hook = installFrameCaptureHook()
    const mounted = mountParticleSceneContents()

    try {
      const request = hook.request
      const beforeRender = loopHarness.beforeRender
      const render = loopHarness.render
      if (!request || !beforeRender || !render) throw new Error('Tres frame callbacks were not registered')
      const canvas = document.createElement('canvas')
      canvas.toDataURL = () => 'data:image/png;base64,override'

      const overridden = request({ elapsedSeconds: 7.25 })
      beforeRender(makeLoopContext(canvas))
      expect(mounted.resources.uniforms.uTime.value).toBe(7.25)
      expect(mounted.resources.uniforms.uImpulsePositionAge.value.map(value => value.toArray())).toEqual([
        [0.25, -0.5, 0.24, 1],
        [-0.25, 0.5, 0.1, 1],
        [0, 0, 0, 0],
        [0, 0, 0, 0]
      ])
      render(makeLoopContext(canvas))
      await expect(overridden).resolves.toEqual({
        capturedAt: expect.any(Number),
        dataUrl: 'data:image/png;base64,override'
      })

      const ordinary = request()
      beforeRender(makeLoopContext(canvas))
      expect(mounted.resources.uniforms.uTime.value).toBe(1)
      render(makeLoopContext(canvas))
      await expect(ordinary).resolves.toEqual({
        capturedAt: expect.any(Number),
        dataUrl: 'data:image/png;base64,override'
      })
    } finally {
      mounted.unmount()
      Reflect.deleteProperty(window, '__logoParticleFrameCapture')
    }
  })

  it('rejects invalid elapsed overrides without scheduling a capture', async () => {
    const hook = installFrameCaptureHook()
    const mounted = mountParticleSceneContents()

    try {
      const request = hook.request
      if (!request) throw new Error('Particle frame capture request was not registered')
      const invalidationsBeforeRequest = loopHarness.invalidations
      await expect(request({ elapsedSeconds: Number.NaN })).rejects.toThrow('elapsedSeconds override is invalid')
      expect(loopHarness.invalidations).toBe(invalidationsBeforeRequest)
      await expect(request({ elapsedSeconds: -1 })).rejects.toThrow('elapsedSeconds override is invalid')
      await expect(request({ elapsedSeconds: Number.POSITIVE_INFINITY })).rejects.toThrow('elapsedSeconds override is invalid')
    } finally {
      mounted.unmount()
      Reflect.deleteProperty(window, '__logoParticleFrameCapture')
    }
  })

  it('rejects a pending request and removes its registration during cleanup', async () => {
    const hook = installFrameCaptureHook()
    const mounted = mountParticleSceneContents()

    try {
      const request = hook.request
      if (!request) throw new Error('Particle frame capture request was not registered')
      const pending = request({ elapsedSeconds: 4 })
      mounted.unmount()

      await expect(pending).rejects.toThrow('Particle frame capture is unavailable')
      await expect(request()).rejects.toThrow('Particle frame capture is unavailable')
      expect(hook.request).toBeNull()
      expect(loopHarness.beforeRender).toBeNull()
      expect(loopHarness.render).toBeNull()
    } finally {
      mounted.unmount()
      Reflect.deleteProperty(window, '__logoParticleFrameCapture')
    }
  })

  it('rejects and removes a pending registration when after-render serialization faults', async () => {
    const hook = installFrameCaptureHook()
    const mounted = mountParticleSceneContents()

    try {
      const request = hook.request
      const render = loopHarness.render
      if (!request || !render) throw new Error('Particle frame capture lifecycle was not registered')
      const pending = request()
      const canvas = document.createElement('canvas')
      canvas.toDataURL = () => {
        throw new Error('PNG serialization failed')
      }

      render(makeLoopContext(canvas))

      await expect(pending).rejects.toThrow('PNG serialization failed')
      expect(hook.request).toBeNull()
    } finally {
      mounted.unmount()
      Reflect.deleteProperty(window, '__logoParticleFrameCapture')
    }
  })
})

describe('LogoParticleScene frame and failure fence', () => {
  it('emits first-frame once and only after an active nonzero particle render', () => {
    const events: string[] = []
    const harness = makeRenderer(0)
    const fence = new ParticleSceneEventFence(effect.count, {
      firstFrame: () => events.push('first-frame'),
      error: () => events.push('error'),
      contextLost: () => events.push('context-lost')
    })

    fence.ready(harness.renderer)
    expect(harness.clearAlpha).toEqual([0])
    expect(harness.renderer.debug.checkShaderErrors).toBe(true)
    fence.rendered(harness.renderer, false)
    fence.rendered(harness.renderer, true)
    expect(events).toEqual([])

    harness.renderer.info.render.points = effect.count
    fence.rendered(harness.renderer, true)
    fence.rendered(harness.renderer, true)
    expect(events).toEqual(['first-frame'])
    fence.dispose()
  })

  it('routes shader failure before committing a frame and removes renderer hooks on disposal', () => {
    const events: string[] = []
    const harness = makeRenderer()
    const previousShaderError = (): void => {}
    harness.renderer.debug.onShaderError = previousShaderError
    const fence = new ParticleSceneEventFence(effect.count, {
      firstFrame: () => events.push('first-frame'),
      error: error => events.push(error.message),
      contextLost: () => events.push('context-lost')
    })

    fence.ready(harness.renderer)
    harness.renderer.debug.onShaderError?.(null as never, null as never, null as never, null as never)
    fence.rendered(harness.renderer, true)
    expect(events).toEqual(['Particle shader compilation failed'])

    fence.dispose()
    expect(harness.renderer.debug.onShaderError).toBe(previousShaderError)
    expect(harness.renderer.debug.checkShaderErrors).toBe(false)
    harness.canvas.dispatchEvent(new browserWindow.Event('webglcontextlost'))
    expect(events).toEqual(['Particle shader compilation failed'])
  })

  it('emits one context-lost event and fences every later frame and error', () => {
    const events: string[] = []
    const harness = makeRenderer()
    const fence = new ParticleSceneEventFence(effect.count, {
      firstFrame: () => events.push('first-frame'),
      error: () => events.push('error'),
      contextLost: event => events.push(event.type)
    })

    fence.ready(harness.renderer)
    harness.canvas.dispatchEvent(new browserWindow.Event('webglcontextlost'))
    harness.canvas.dispatchEvent(new browserWindow.Event('webglcontextlost'))
    fence.fail(new Error('late renderer error'))
    fence.rendered(harness.renderer, true)
    expect(events).toEqual(['webglcontextlost'])
    expect(fence.hasFailed).toBe(true)
    fence.dispose()
    harness.canvas.dispatchEvent(new browserWindow.Event('webglcontextlost'))
    fence.fail(new Error('post-disposal error'))
    fence.rendered(harness.renderer, true)
    expect(events).toEqual(['webglcontextlost'])
  })
})
