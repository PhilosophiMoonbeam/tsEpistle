import {
  LinearSRGBColorSpace,
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
const scheduledFrames = new Set<() => void>()
const advanceFrame = (): void => {
  const callbacks = [...scheduledFrames]
  scheduledFrames.clear()
  for (const callback of callbacks) callback()
}
const testScene = {} as Parameters<LogoParticleRendererType['compileAsync']>[0]
const testCamera = {} as Parameters<LogoParticleRendererType['compileAsync']>[1]

class FakeWebGPURenderer {
  readonly options: FakeRendererOptions
  readonly disposeCalls = { count: 0 }
  readonly initCalls = { count: 0 }
  readonly compileCalls = { count: 0 }
  readonly disposalStarted = deferred<void>()
  disposalGate: Promise<void> | undefined
  disposalError: Error | undefined
  compileGate: Promise<void> | undefined
  compileError: Error | undefined
  resourcesReleased = false
  backendDisposed = false
  compilationCompleted = false
  private animationLoop: (() => void) | null = null
  private pendingFrame: (() => void) | null = null
  coordinateSystem: number
  initialized = false
  onDeviceLost: (info: unknown) => void = () => {}
  onError: (info: unknown) => void = () => {}

  constructor(options: FakeRendererOptions = {}) {
    this.options = options
    this.coordinateSystem = options.forceWebGL === true ? WebGLCoordinateSystem : WebGPUCoordinateSystem
    createdRenderers.push(this)
  }


  async init(): Promise<this> {
    this.initCalls.count += 1
    const plan = initPlans.shift() ?? {
      coordinateSystem: this.options.forceWebGL === true ? WebGLCoordinateSystem : WebGPUCoordinateSystem
    }
    if (plan.gate !== undefined) await plan.gate
    if (plan.error !== undefined) throw plan.error
    this.coordinateSystem = plan.coordinateSystem
    this.initialized = true
    const frame = (): void => {
      scheduledFrames.add(frame)
      this.animationLoop?.()
    }
    this.pendingFrame = frame
    scheduledFrames.add(frame)
    return this
  }

  async compileAsync(): Promise<void> {
    this.compileCalls.count += 1
    if (!this.initialized) await this.init()
    if (this.compileGate !== undefined) await this.compileGate
    if (this.resourcesReleased) throw new Error('Renderer resources were released during prewarm')
    if (this.compileError !== undefined) throw this.compileError
    this.compilationCompleted = true
  }

  async setAnimationLoop(callback: (() => void) | null): Promise<void> {
    if (!this.initialized) await this.init()
    this.animationLoop = callback
  }

  async dispose(): Promise<void> {
    this.disposeCalls.count += 1
    if (this.initialized) {
      this.resourcesReleased = true
      if (this.pendingFrame !== null) scheduledFrames.delete(this.pendingFrame)
      this.disposalStarted.resolve()
      if (this.disposalGate !== undefined) await this.disposalGate
      if (this.disposalError !== undefined) throw this.disposalError
      this.backendDisposed = true
    }
    void this.setAnimationLoop(null)
  }
}

vi.mockModule('three/webgpu', import.meta.url, () => ({
  LinearSRGBColorSpace,
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
  expect(Object.keys(diagnostics).sort()).toEqual([
    'generation',
    'requestedBackend',
    'effectiveBackend',
    'phase',
    'attempt',
    'fallback',
    'reason'
  ].sort())
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
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: { requestAdapter: async () => ({}) }
  })
  createdRenderers.length = 0
  scheduledFrames.clear()
})

describe('LogoParticleRenderer', () => {
  it('uses working-space output to avoid re-encoding a direct-sRGB material', () => {
    const direct = new LogoParticleRenderer({ directSrgbMaterialPipeline: true })
    const buffered = new LogoParticleRenderer()

    expect(direct.outputColorSpace).toBe(LinearSRGBColorSpace)
    expect(direct.toneMapping).toBe(NoToneMapping)
    expect(buffered.outputColorSpace).toBe(SRGBColorSpace)
  })

  it('stops frames promptly and shares completion until asynchronous backend cleanup finishes', async () => {
    queuePlans(planFor('webgpu'))
    const renderer = new LogoParticleRenderer()
    const backendCleanup = deferred<void>()
    const record = rendererRecord(renderer)
    record.disposalGate = backendCleanup.promise
    let renderedFrames = 0
    await renderer.init()
    await renderer.setAnimationLoop(() => {
      renderedFrames += 1
    })
    advanceFrame()
    expect(renderedFrames).toBe(1)

    const first = renderer.dispose()
    const second = renderer.dispose()
    let finished = false
    void first.then(() => {
      finished = true
    })

    expect(second).toBe(first)
    expect(record.disposeCalls.count).toBe(1)
    expect(record.resourcesReleased).toBe(true)
    expect(scheduledFrames.size).toBe(0)
    advanceFrame()
    expect(renderedFrames).toBe(1)
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(record.backendDisposed).toBe(false)

    backendCleanup.resolve()
    await first
    expect(finished).toBe(true)
    expect(record.backendDisposed).toBe(true)
    expect(renderer.dispose()).toBe(first)
    expect(record.disposeCalls.count).toBe(1)
  })

  it('coalesces concurrent public initialization calls', async () => {
    const gate = deferred<void>()
    queuePlans({ ...planFor('webgpu'), gate: gate.promise })
    const renderer = new LogoParticleRenderer()

    const first = renderer.init()
    const second = renderer.init()
    expect(rendererRecord(renderer).initCalls.count).toBe(1)

    gate.resolve()
    await expect(first).resolves.toBe(renderer)
    await expect(second).resolves.toBe(renderer)
    expect(rendererRecord(renderer).initCalls.count).toBe(1)
    await renderer.dispose()
  })

  it('does not start initialization when disposed before first use', async () => {
    const renderer = new LogoParticleRenderer()
    const completion = renderer.dispose()

    expect(renderer.dispose()).toBe(completion)
    await completion
    await expect(renderer.init()).rejects.toThrow('lease was retired')
    await expect(renderer.compileAsync(testScene, testCamera)).rejects.toThrow('lease was retired')
    expect(rendererRecord(renderer).initCalls.count).toBe(0)
    expect(rendererRecord(renderer).disposeCalls.count).toBe(0)
    expect(scheduledFrames.size).toBe(0)
  })

  it('preserves a pending initialization failure when retirement is requested', async () => {
    const gate = deferred<void>()
    const failure = new Error('adapter initialization failed')
    queuePlans({ ...planFor('webgpu'), gate: gate.promise, error: failure })
    const renderer = new LogoParticleRenderer()
    const initialization = renderer.init().catch(error => error)
    const completion = renderer.dispose()

    gate.resolve()
    await expect(initialization).resolves.toBe(failure)
    await completion
    expect(rendererRecord(renderer).disposeCalls.count).toBe(0)
    expect(scheduledFrames.size).toBe(0)
    await expect(renderer.init()).rejects.toThrow('lease was retired')
  })

  it('keeps prewarm resources alive, fences frames, and waits for backend cleanup before retiring', async () => {
    queuePlans(planFor('webgpu'))
    const renderer = new LogoParticleRenderer()
    await renderer.init()
    const record = rendererRecord(renderer)
    const prewarm = deferred<void>()
    const backendCleanup = deferred<void>()
    record.compileGate = prewarm.promise
    record.disposalGate = backendCleanup.promise
    let renderedFrames = 0
    await renderer.setAnimationLoop(() => {
      renderedFrames += 1
    })

    const compilation = renderer.compileAsync(testScene, testCamera)
    const completion = renderer.dispose()
    expect(renderer.dispose()).toBe(completion)
    advanceFrame()
    expect(renderedFrames).toBe(0)
    expect(record.resourcesReleased).toBe(false)
    expect(record.disposeCalls.count).toBe(0)
    await expect(renderer.compileAsync(testScene, testCamera)).rejects.toThrow('lease was retired')

    prewarm.resolve()
    await compilation
    await record.disposalStarted.promise
    expect(record.compilationCompleted).toBe(true)
    expect(record.resourcesReleased).toBe(true)
    expect(record.backendDisposed).toBe(false)
    expect(scheduledFrames.size).toBe(0)
    backendCleanup.resolve()
    await completion
    expect(record.backendDisposed).toBe(true)
    expect(record.disposeCalls.count).toBe(1)
  })

  it('preserves prewarm failure and exposes a separate asynchronous cleanup failure', async () => {
    queuePlans(planFor('webgpu'))
    const renderer = new LogoParticleRenderer()
    await renderer.init()
    const record = rendererRecord(renderer)
    const gate = deferred<void>()
    const prewarmFailure = new Error('pipeline compilation failed')
    const cleanupFailure = new Error('backend cleanup failed')
    record.compileGate = gate.promise
    record.compileError = prewarmFailure
    record.disposalError = cleanupFailure
    const compilation = renderer.compileAsync(testScene, testCamera).catch(error => error)
    const completion = renderer.dispose()

    gate.resolve()
    await expect(compilation).resolves.toBe(prewarmFailure)
    await expect(completion).rejects.toBe(cleanupFailure)
    expect(renderer.dispose()).toBe(completion)
    expect(record.disposeCalls.count).toBe(1)
    expect(scheduledFrames.size).toBe(0)
  })
})


describe('particle backend leases', () => {
  it('forces WebGL2 in auto mode when the WebGPU API is unavailable', () => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined })
    const lease = createParticleBackendLease({ canvas: testCanvas, requestedBackend: 'auto' })

    expect(rendererRecord(lease.renderer).options.forceWebGL).toBe(true)
    void lease.retire()
  })
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
    expect(lease.renderer.outputColorSpace).toBe(LinearSRGBColorSpace)
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
    void lease.retire()
  })

  it('proves backend identity from the renderer coordinate system', async () => {
    for (const kind of ['webgpu', 'webgl2'] as const) {
      queuePlans(planFor(kind))
      const lease = createParticleBackendLease({ canvas: testCanvas, requestedBackend: kind })

      await expect(lease.init()).resolves.toBe(kind)
      expect(lease.effectiveBackend).toBe(kind)
      expect(lease.diagnostics.effectiveBackend).toBe(kind)
      expect(lease.status).toBe('ready')
      await lease.retire()
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
    const cleanupFailure = new Error('backend cleanup failed')
    rendererRecord(nativeAttempt).disposalError = cleanupFailure

    await expect(lease.init()).rejects.toThrow('Native WebGPU backend was not selected')

    expect(createdRenderers).toHaveLength(1)
    expect(nativeAttempt).toBe(lease.renderer)
    expect(rendererRecord(nativeAttempt).options.forceWebGL).toBe(false)
    expect(rendererRecord(nativeAttempt).disposeCalls.count).toBe(1)
    expect(lease.status).toBe('failed')
    expect(lease.diagnostics.fallback).toBe(false)
    expect(lease.diagnostics.reason).toBe('strict-native-required')
    await expect(lease.retire()).rejects.toBe(cleanupFailure)
    expect(rendererRecord(nativeAttempt).disposeCalls.count).toBe(1)
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
    expect(nativeAttempt.outputColorSpace).toBe(LinearSRGBColorSpace)
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
    await lease.retire()
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
    const backendCleanup = deferred<void>()
    rendererRecord(renderer).disposalGate = backendCleanup.promise

    triggerDeviceLost(renderer, { api: 'WebGL', message: 'context lost' })
    expect(lease.status).toBe('lost')
    expect(lease.diagnostics.reason).toBe('device-lost')
    expect(rendererRecord(renderer).disposeCalls.count).toBe(1)

    triggerDeviceLost(renderer, { api: 'WebGL', message: 'duplicate loss' })
    expect(rendererRecord(renderer).disposeCalls.count).toBe(1)
    await expect(lease.init()).rejects.toThrow('device was lost')

    const completion = lease.retire()
    expect(lease.retire()).toBe(completion)
    expect(lease.status).toBe('retired')
    expect(rendererRecord(renderer).disposeCalls.count).toBe(1)
    await expect(lease.init()).rejects.toThrow('lease was retired')
    expect(rendererRecord(renderer).backendDisposed).toBe(false)
    expect(scheduledFrames.size).toBe(0)
    backendCleanup.resolve()
    await completion
    expect(rendererRecord(renderer).backendDisposed).toBe(true)
  })

  it('invalidates a pending lease synchronously and waits for late init plus asynchronous disposal', async () => {
    const gate = deferred<void>()
    queuePlans({ coordinateSystem: WebGPUCoordinateSystem, gate: gate.promise })
    const lease = createParticleBackendLease({ canvas: testCanvas, requestedBackend: 'webgpu' })
    const pending = lease.init()
    const renderer = lease.renderer
    const record = rendererRecord(renderer)
    const backendCleanup = deferred<void>()
    record.disposalGate = backendCleanup.promise

    expect(lease.status).toBe('initializing')
    const completion = lease.retire()
    expect(lease.retire()).toBe(completion)
    expect(renderer.dispose()).toBe(completion)
    expect(lease.status).toBe('retired')
    expect(rendererRecord(renderer).disposeCalls.count).toBe(0)

    gate.resolve()
    await expect(pending).rejects.toThrow('lease was retired')
    await record.disposalStarted.promise
    expect(lease.status).toBe('retired')
    expect(lease.diagnostics.reason).toBe('retired')
    expect(rendererRecord(renderer).disposeCalls.count).toBe(1)
    expect(scheduledFrames.size).toBe(0)
    expect(record.backendDisposed).toBe(false)
    backendCleanup.resolve()
    await completion
    expect(record.backendDisposed).toBe(true)
    expect(lease.retire()).toBe(completion)
    await expect(lease.init()).rejects.toThrow('lease was retired')
  })
})
