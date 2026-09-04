import fs from 'node:fs'
import path from 'node:path'

import { compileScript, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from '../../../server/test/bun-test.mts'
import type { WebGLRenderer } from 'three'
import type { ParticleSceneEventFence as ParticleSceneEventFenceClass, ParticleSceneFrame, ParticleSceneResources } from './LogoParticleScene.vue'
import type { LogoEffectDescriptor, ParsedLogoParticles } from './particle-logo.ts'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/login'
})
const browserWindow = dom.window
for (const [name, value] of Object.entries({
  Event: browserWindow.Event,
  HTMLCanvasElement: browserWindow.HTMLCanvasElement,
  HTMLElement: browserWindow.HTMLElement,
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
  default: { props?: Record<string, unknown>; emits?: Record<string, unknown> }
  disposeParticleSceneResources: (resources: ParticleSceneResources) => void
  updateParticleSceneBackground: (resources: ParticleSceneResources, canvas: HTMLCanvasElement) => void
  updateParticleSceneFrame: (
    resources: ParticleSceneResources,
    pointerController: {
      update: (renderedLongAxis: number) => {
        displacementCss: number
        radiusCss: number
        strength: number
        x: number
        y: number
      }
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
    if (specifier === '@tresjs/core') return Tres
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
    const renderedLongAxes: number[] = []
    const pointerController = {
      update: (renderedLongAxis: number) => {
        renderedLongAxes.push(renderedLongAxis)
        return { x: 0.25, y: -0.5, radiusCss: 64, displacementCss: 5, strength: 0.75 }
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
    expect(resources.uniforms.uPointer.value.toArray()).toEqual([0.25, -0.5])
    expect(resources.uniforms.uPointerRadius.value).toBe(64)
    expect(resources.uniforms.uPointerDisplacement.value).toBe(5)
    expect(resources.uniforms.uPointerStrength.value).toBe(0.75)
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

  it('changes only the background uniform when the rendered theme surface changes', () => {
    const particles = makeParticles()
    const before = new Uint8Array(particles.buffer).slice()
    const resources = createParticleSceneResources(particles, effect)
    const attributes = ['logoXY', 'logoDepth', 'logoColor', 'logoSize', 'logoSeed'].map(name => resources.geometry.getAttribute(name))
    const versions = attributes.map(attribute => attribute.version)
    const stableUniformValues = [
      resources.uniforms.uAspect.value,
      resources.uniforms.uDpr.value,
      resources.uniforms.uMedianStroke.value,
      resources.uniforms.uPointer.value,
      resources.uniforms.uPointerDisplacement.value,
      resources.uniforms.uPointerRadius.value,
      resources.uniforms.uPointerStrength.value,
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
      resources.uniforms.uMedianStroke.value,
      resources.uniforms.uPointer.value,
      resources.uniforms.uPointerDisplacement.value,
      resources.uniforms.uPointerRadius.value,
      resources.uniforms.uPointerStrength.value,
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
