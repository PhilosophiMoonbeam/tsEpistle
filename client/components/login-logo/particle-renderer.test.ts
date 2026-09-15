import {
  NoToneMapping,
  SRGBColorSpace,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem
} from 'three/webgpu'
import { beforeEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import type * as ParticleRendererModule from './particle-renderer.ts'
import type {
  LogoParticleRenderer as LogoParticleRendererType,
  ParticleBackendDiagnostics,
  ParticleBackendKind,
  ParticleBackendRequest
} from './particle-renderer.ts'

type FakeRendererOptions = Readonly<Record<string, unknown>>
type InitPlan = {
  readonly coordinateSystem: number
  readonly error?: Error
  readonly gate?: Promise<void>
}

const initPlans: InitPlan[] = []
const createdRenderers: FakeWebGPURenderer[] = []
const testCanvas = {} as HTMLCanvasElement

class FakeWebGPURenderer {
  readonly options: FakeRendererOptions
  readonly disposeCalls = { count: 0 }
  coordinateSystem: number
  initialized = false
  onDeviceLost: (info: unknown) => void = () => {}
  onError: (info: unknown) => void = () => {}

  constructor(options: FakeRendererOptions = {}) {
    this.options = options
    this.coordinateSystem = options.forceWebGL === true ? WebGLCoordinateSystem : WebGPUCoordinateSystem
    createdRenderers.push(this)
  }

  get needsFrameBufferTarget(): boolean {
    return true
  }

  async init(): Promise<this> {
    const plan = initPlans.shift() ?? {
      coordinateSystem: this.options.forceWebGL === true ? WebGLCoordinateSystem : WebGPUCoordinateSystem
    }
    if (plan.gate !== undefined) await plan.gate
    if (plan.error !== undefined) throw plan.error
    this.coordinateSystem = plan.coordinateSystem
    this.initialized = true
    return this
  }

  dispose(): void {
    this.disposeCalls.count += 1
  }
}

vi.mockModule('three/webgpu', import.meta.url, () => ({
  NoToneMapping,
  SRGBColorSpace,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  WebGPURenderer: FakeWebGPURenderer,
  default: FakeWebGPURenderer
}))

const { LogoParticleRenderer, createParticleBackendLease } = await vi.importFresh<typeof ParticleRendererModule>('./particle-renderer.ts', import.meta.url)

type RendererInstance = LogoParticleRendererType
const planFor = (kind: ParticleBackendKind): InitPlan => ({
  coordinateSystem: kind === 'webgpu' ? WebGPUCoordinateSystem : WebGLCoordinateSystem
})

const queuePlans = (...plans: InitPlan[]): void => {
  initPlans.push(...plans)
}

const deferred = <Value,>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value | PromiseLike<Value>) => void
} => {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  const promise = new Promise<Value>(resolveValue => {
    resolve = resolveValue
  })
  return { promise, resolve }
}

const rendererRecord = (renderer: RendererInstance): FakeWebGPURenderer => renderer as unknown as FakeWebGPURenderer

const assertBoundedDiagnostics = (diagnostics: ParticleBackendDiagnostics): void => {
  expect(Object.isFrozen(diagnostics)).toBe(true)
  expect(Object.keys(diagnostics)).toEqual([
    'generation',
    'requestedBackend',
    'effectiveBackend',
    'phase',
    'attempt',
    'fallback',
    'reason'
  ])
  expect(Object.values(diagnostics).every(value => value === null || ['number', 'string', 'boolean'].includes(typeof value))).toBe(true)
  expect(diagnostics).not.toHaveProperty('renderer')
  expect(diagnostics).not.toHaveProperty('device')
  expect(diagnostics).not.toHaveProperty('error')
}

const triggerDeviceLost = (renderer: RendererInstance, info: unknown): void => {
  ;(renderer.onDeviceLost as unknown as (value: unknown) => void)(info)
}

beforeEach(() => {
  initPlans.length = 0
  createdRenderers.length = 0
})

describe('LogoParticleRenderer', () => {
  it('uses the direct-output option to bypass the frame-buffer target', () => {
    const direct = new LogoParticleRenderer({ directSrgbMaterialPipeline: true })
    const buffered = new LogoParticleRenderer()

    expect(direct.directSrgbMaterialPipeline).toBe(true)
    expect(direct.needsFrameBufferTarget).toBe(false)
    expect(buffered.directSrgbMaterialPipeline).toBe(false)
    expect(buffered.needsFrameBufferTarget).toBe(true)
  })

  it('provides an idempotent public disposal boundary after initialization', async () => {
    queuePlans(planFor('webgpu'))
    const renderer = new LogoParticleRenderer()

    await renderer.init()
    renderer.dispose()
    renderer.dispose()

    expect(rendererRecord(renderer).disposeCalls.count).toBe(1)
  })
})

describe('particle backend leases', () => {
  it('validates backend requests before constructing a renderer and exposes stable initial getters', () => {
    expect(() => createParticleBackendLease({ canvas: testCanvas, requestedBackend: 'native' as ParticleBackendRequest })).toThrow('Invalid particle backend request')
    expect(createdRenderers).toHaveLength(0)

    const lease = createParticleBackendLease({
      canvas: testCanvas,
      requestedBackend: 'webgl2',
      generation: 7,
      directSrgbMaterialPipeline: true
    })

    expect(lease.generation).toBe(7)
    expect(lease.requestedBackend).toBe('webgl2')
    expect(lease.effectiveBackend).toBeNull()
    expect(lease.status).toBe('created')
    expect(lease.renderer.directSrgbMaterialPipeline).toBe(true)
    expect(lease.renderer.needsFrameBufferTarget).toBe(false)
    expect(lease.diagnostics).toEqual({
      generation: 7,
      requestedBackend: 'webgl2',
      effectiveBackend: null,
      phase: 'created',
      attempt: 0,
      fallback: false,
      reason: 'created'
    })
    assertBoundedDiagnostics(lease.diagnostics)
    lease.retire()
  })

  it('proves backend identity from the renderer coordinate system', async () => {
    for (const kind of ['webgpu', 'webgl2'] as const) {
      queuePlans(planFor(kind))
      const lease = createParticleBackendLease({ canvas: testCanvas, requestedBackend: kind })

      await expect(lease.init()).resolves.toBe(kind)
      expect(lease.effectiveBackend).toBe(kind)
      expect(lease.renderer.coordinateSystem).toBe(kind === 'webgpu' ? WebGPUCoordinateSystem : WebGLCoordinateSystem)
      expect(lease.diagnostics.effectiveBackend).toBe(kind)
      expect(lease.status).toBe('ready')
      lease.retire()
    }
  })

  it('rejects an unknown coordinate system instead of claiming a backend identity', async () => {
    queuePlans({ coordinateSystem: 0xdead })
    const lease = createParticleBackendLease({ canvas: testCanvas, requestedBackend: 'webgpu' })

    await expect(lease.init()).rejects.toThrow('unknown coordinate system')
    expect(lease.effectiveBackend).toBeNull()
    expect(lease.status).toBe('failed')
    expect(lease.diagnostics.reason).toBe('strict-native-required')
    expect(rendererRecord(lease.renderer).disposeCalls.count).toBe(1)
  })

  it('strictly rejects a WebGPU request when the renderer selected WebGL2', async () => {
    queuePlans(planFor('webgl2'))
    const lease = createParticleBackendLease({ canvas: testCanvas, requestedBackend: 'webgpu' })
    const nativeAttempt = lease.renderer

    await expect(lease.init()).rejects.toThrow('Native WebGPU backend was not selected')

    expect(createdRenderers).toHaveLength(1)
    expect(nativeAttempt).toBe(lease.renderer)
    expect(rendererRecord(nativeAttempt).options.forceWebGL).toBe(false)
    expect(rendererRecord(nativeAttempt).disposeCalls.count).toBe(1)
    expect(lease.status).toBe('failed')
    expect(lease.diagnostics.fallback).toBe(false)
    expect(lease.diagnostics.reason).toBe('strict-native-required')
  })

  it('strictly rejects a WebGPU initialization error without creating a fallback renderer', async () => {
    queuePlans({ coordinateSystem: WebGPUCoordinateSystem, error: new Error('native initialization failed') })
    const lease = createParticleBackendLease({ canvas: testCanvas, requestedBackend: 'webgpu' })

    await expect(lease.init()).rejects.toThrow('native initialization failed')

    expect(createdRenderers).toHaveLength(1)
    expect(rendererRecord(lease.renderer).disposeCalls.count).toBe(0)
    expect(lease.status).toBe('failed')
    expect(lease.diagnostics.reason).toBe('strict-native-required')
  })

  it('accepts a built-in WebGL fallback in auto mode without recreating the renderer', async () => {
    const observations: ParticleBackendDiagnostics[] = []
    queuePlans(planFor('webgl2'))
    const lease = createParticleBackendLease({
      canvas: testCanvas,
      requestedBackend: 'auto',
      directSrgbMaterialPipeline: true,
      onDiagnostics: diagnostics => observations.push(diagnostics)
    })
    const nativeAttempt = lease.renderer

    await expect(lease.init()).resolves.toBe('webgl2')

    expect(lease.renderer).toBe(nativeAttempt)
    expect(createdRenderers).toHaveLength(1)
    expect(rendererRecord(nativeAttempt).options.forceWebGL).toBe(false)
    expect(rendererRecord(nativeAttempt).disposeCalls.count).toBe(0)
    expect(nativeAttempt.directSrgbMaterialPipeline).toBe(true)
    expect(nativeAttempt.needsFrameBufferTarget).toBe(false)
    expect(observations).toContainEqual(expect.objectContaining({
      effectiveBackend: 'webgl2',
      phase: 'initializing',
      attempt: 1,
      fallback: true,
      reason: 'fallback'
    }))
    expect(lease.diagnostics).toMatchObject({
      effectiveBackend: 'webgl2',
      phase: 'ready',
      attempt: 1,
      fallback: true,
      reason: 'ready'
    })
    lease.retire()
  })

  it('treats an auto-mode native initialization error as terminal without retrying', async () => {
    queuePlans({ coordinateSystem: WebGPUCoordinateSystem, error: new Error('native unavailable') })
    const lease = createParticleBackendLease({ canvas: testCanvas, requestedBackend: 'auto' })
    const nativeAttempt = lease.renderer

    await expect(lease.init()).rejects.toThrow('native unavailable')

    expect(lease.renderer).toBe(nativeAttempt)
    expect(createdRenderers).toHaveLength(1)
    expect(rendererRecord(nativeAttempt).options.forceWebGL).toBe(false)
    expect(rendererRecord(nativeAttempt).disposeCalls.count).toBe(0)
    expect(lease.status).toBe('failed')
    expect(lease.diagnostics).toMatchObject({ phase: 'failed', attempt: 1, fallback: false, reason: 'init-failed' })
  })


  it('publishes immutable diagnostics that never retain renderer or device handles', async () => {
    const observations: ParticleBackendDiagnostics[] = []
    queuePlans(planFor('webgl2'))
    const lease = createParticleBackendLease({
      canvas: testCanvas,
      requestedBackend: 'webgl2',
      generation: 41,
      onDiagnostics: diagnostics => observations.push(diagnostics)
    })
    const initial = lease.diagnostics

    await lease.init()
    triggerDeviceLost(lease.renderer, {
      api: 'WebGL',
      originalEvent: { device: { secret: true } },
      renderer: lease.renderer
    })

    assertBoundedDiagnostics(initial)
    expect(initial.phase).toBe('created')
    for (const diagnostics of observations) assertBoundedDiagnostics(diagnostics)
    expect(observations.map(diagnostics => diagnostics.phase)).toContain('initializing')
    expect(observations.map(diagnostics => diagnostics.phase)).toContain('ready')
    expect(observations.map(diagnostics => diagnostics.phase)).toContain('lost')
    const latest = observations.at(-1)
    if (latest === undefined) throw new Error('Diagnostics observation was not published')
    expect(latest.phase).toBe('lost')
    expect(lease.diagnostics).toBe(latest)
    expect(() => Object.defineProperty(lease.diagnostics, 'phase', { value: 'ready' })).toThrow()
  })

  it('fences a ready lease after device loss and retires without double disposal', async () => {
    queuePlans(planFor('webgl2'))
    const lease = createParticleBackendLease({ canvas: testCanvas, requestedBackend: 'webgl2' })
    await lease.init()
    const renderer = lease.renderer

    triggerDeviceLost(renderer, { api: 'WebGL', message: 'context lost' })
    expect(lease.status).toBe('lost')
    expect(lease.diagnostics.reason).toBe('device-lost')
    expect(rendererRecord(renderer).disposeCalls.count).toBe(1)

    triggerDeviceLost(renderer, { api: 'WebGL', message: 'duplicate loss' })
    expect(rendererRecord(renderer).disposeCalls.count).toBe(1)
    await expect(lease.init()).rejects.toThrow('device was lost')

    lease.retire()
    lease.retire()
    expect(lease.status).toBe('retired')
    expect(rendererRecord(renderer).disposeCalls.count).toBe(1)
    await expect(lease.init()).rejects.toThrow('lease was retired')
  })

  it('retires a pending initialization and fences its late completion', async () => {
    const gate = deferred<void>()
    queuePlans({ coordinateSystem: WebGPUCoordinateSystem, gate: gate.promise })
    const lease = createParticleBackendLease({ canvas: testCanvas, requestedBackend: 'webgpu' })
    const pending = lease.init()
    const renderer = lease.renderer

    expect(lease.status).toBe('initializing')
    lease.retire()
    lease.retire()
    expect(lease.status).toBe('retired')
    expect(rendererRecord(renderer).disposeCalls.count).toBe(0)

    gate.resolve()
    await expect(pending).rejects.toThrow('lease was retired')
    expect(lease.status).toBe('retired')
    expect(lease.diagnostics.reason).toBe('retired')
    expect(rendererRecord(renderer).disposeCalls.count).toBe(1)
    await expect(lease.init()).rejects.toThrow('lease was retired')
  })
})
