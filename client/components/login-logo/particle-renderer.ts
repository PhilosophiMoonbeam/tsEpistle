import {
  LinearSRGBColorSpace,
  NoToneMapping,
  SRGBColorSpace,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  WebGPURenderer
} from 'three/webgpu'

export type ParticleBackendRequest = 'auto' | 'webgpu' | 'webgl2'
export type ParticleBackendKind = 'webgpu' | 'webgl2'

export type ParticleBackendPhase = 'created' | 'initializing' | 'ready' | 'failed' | 'lost' | 'retired'

export type ParticleBackendDiagnosticReason =
  | 'created'
  | 'initializing'
  | 'ready'
  | 'fallback'
  | 'strict-native-required'
  | 'backend-error'
  | 'init-failed'
  | 'device-lost'
  | 'retired'

/**
 * A bounded, renderer-free snapshot intended for opt-in performance/debug hooks.
 * It deliberately carries no backend, device, canvas, or error object references.
 */
export interface ParticleBackendDiagnostics {
  readonly generation: number
  readonly requestedBackend: ParticleBackendRequest
  readonly effectiveBackend: ParticleBackendKind | null
  readonly phase: ParticleBackendPhase
  readonly attempt: number
  readonly fallback: boolean
  readonly reason: ParticleBackendDiagnosticReason
}

export interface LogoParticleRendererOptions {
  /** Select the deliberate WebGL2 backend instead of WebGPU-with-fallback. */
  readonly forceWebGL?: boolean
  /** The scene's material writes already-encoded sRGB directly to the canvas. */
  readonly directSrgbMaterialPipeline?: boolean
  /** The caller-owned canvas used by the renderer backend. */
  readonly canvas?: HTMLCanvasElement
}

export interface ParticleBackendLeaseOptions {
  /** The caller-owned canvas used by every backend attempt. */
  readonly canvas: HTMLCanvasElement
  /** Defaults to auto: accept native WebGPU or WebGPURenderer's built-in WebGL2 fallback. */
  readonly requestedBackend?: ParticleBackendRequest
  /** A caller-owned generation; otherwise the factory assigns a monotonic one. */
  readonly generation?: number
  readonly directSrgbMaterialPipeline?: boolean
  /** Diagnostics are silent unless an opt-in hook is provided. */
  readonly onDiagnostics?: (diagnostics: ParticleBackendDiagnostics) => void
}

export interface ParticleBackendLease {
  readonly generation: number
  readonly requestedBackend: ParticleBackendRequest
  readonly effectiveBackend: ParticleBackendKind | null
  /** The current renderer; auto fallback may replace the first, uncommitted attempt. */
  readonly renderer: LogoParticleRenderer
  readonly status: ParticleBackendPhase
  readonly diagnostics: ParticleBackendDiagnostics
  init(): Promise<ParticleBackendKind>
  retire(): void
}

const VALID_REQUESTS: readonly ParticleBackendRequest[] = ['auto', 'webgpu', 'webgl2']
let nextGeneration = 1

const retiredError = () => new Error('Particle backend lease was retired')
const lostError = () => new Error('Particle backend device was lost')
const strictNativeError = () => new Error('Native WebGPU backend was not selected')
const unknownBackendError = () => new Error('Renderer returned an unknown coordinate system')

const asRequest = (request: ParticleBackendRequest | undefined): ParticleBackendRequest => {
  const selected = request ?? 'auto'
  if (!VALID_REQUESTS.includes(selected)) throw new TypeError('Invalid particle backend request')
  return selected
}

const effectiveBackendOf = (renderer: LogoParticleRenderer): ParticleBackendKind => {
  if (renderer.coordinateSystem === WebGPUCoordinateSystem) return 'webgpu'
  if (renderer.coordinateSystem === WebGLCoordinateSystem) return 'webgl2'
  throw unknownBackendError()
}

const freezeDiagnostics = (diagnostics: ParticleBackendDiagnostics): ParticleBackendDiagnostics =>
  Object.freeze(diagnostics)

const webGpuApiAvailable = (): boolean =>
  typeof navigator !== 'undefined' &&
  typeof navigator.gpu?.requestAdapter === 'function'

/**
 * r185's common renderer owns an internal RAF once initialized. This subclass
 * gives it a public, idempotent disposal boundary without reaching into that
 * private animation object. A pending init observes the disposal request and
 * disposes immediately after the common renderer starts its RAF.
 */
export class LogoParticleRenderer extends WebGPURenderer {
  private disposeRequested = false
  private disposed = false
  private initializationPromise: Promise<this> | null = null
  constructor(options: LogoParticleRendererOptions = {}) {
    const rendererParameters = {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      premultipliedAlpha: true,
      forceWebGL: options.forceWebGL === true,
      ...(options.canvas === undefined ? {} : { canvas: options.canvas })
    }

    super(rendererParameters)

    this.outputColorSpace = options.directSrgbMaterialPipeline === true
      ? LinearSRGBColorSpace
      : SRGBColorSpace
    this.toneMapping = NoToneMapping
  }

  override init(): Promise<this> {
    if (this.disposeRequested) return Promise.reject(retiredError())
    if (this.initializationPromise !== null) return this.initializationPromise

    this.initializationPromise = (async () => {
      try {
        const renderer = await super.init()
        if (this.disposeRequested) {
          this.dispose()
          throw retiredError()
        }
        return renderer
      } catch (error) {
        if (this.disposeRequested && this.initialized) this.dispose()
        throw error
      }
    })()
    return this.initializationPromise
  }

  override dispose(): void {
    this.disposeRequested = true
    if (this.disposed || this.initialized === false) return

    this.disposed = true
    super.dispose()
  }
}

type RendererHooks = {
  readonly previousOnDeviceLost: LogoParticleRenderer['onDeviceLost']
  readonly previousOnError: LogoParticleRenderer['onError']
  readonly installedOnDeviceLost: LogoParticleRenderer['onDeviceLost']
  readonly installedOnError: LogoParticleRenderer['onError']
}

/**
 * Build a generation-scoped renderer lease. Construction is synchronous for
 * TresCanvas; initialization and backend identity proof remain explicit.
 */
export function createParticleBackendLease(options: ParticleBackendLeaseOptions): ParticleBackendLease {
  const requestedBackend = asRequest(options.requestedBackend)
  const generation = options.generation ?? nextGeneration++
  const directSrgbMaterialPipeline = options.directSrgbMaterialPipeline === true
  const onDiagnostics = options.onDiagnostics

  const currentRenderer = new LogoParticleRenderer({
    canvas: options.canvas,
    forceWebGL: requestedBackend === 'webgl2' || (requestedBackend === 'auto' && !webGpuApiAvailable()),
    directSrgbMaterialPipeline
  })
  let effectiveBackend: ParticleBackendKind | null = null
  let phase: ParticleBackendPhase = 'created'
  let attempt = 0
  let fallback = false
  let reason: ParticleBackendDiagnosticReason = 'created'
  let retired = false
  let initPromise: Promise<ParticleBackendKind> | null = null
  let diagnostics = freezeDiagnostics({
    generation,
    requestedBackend,
    effectiveBackend,
    phase,
    attempt,
    fallback,
    reason
  })

  const hooks = new WeakMap<LogoParticleRenderer, RendererHooks>()

  const publish = (patch: Partial<Omit<ParticleBackendDiagnostics, 'generation' | 'requestedBackend'>>): void => {
    if (patch.phase !== undefined) phase = patch.phase
    if (patch.effectiveBackend !== undefined) effectiveBackend = patch.effectiveBackend
    if (patch.attempt !== undefined) attempt = patch.attempt
    if (patch.fallback !== undefined) fallback = patch.fallback
    if (patch.reason !== undefined) reason = patch.reason

    diagnostics = freezeDiagnostics({
      generation,
      requestedBackend,
      effectiveBackend,
      phase,
      attempt,
      fallback,
      reason
    })

    if (onDiagnostics !== undefined) {
      try {
        onDiagnostics(diagnostics)
      } catch {
        // Opt-in diagnostics must never change renderer lifecycle behavior.
      }
    }
  }

  const restoreHooks = (renderer: LogoParticleRenderer): void => {
    const installed = hooks.get(renderer)
    if (installed === undefined) return

    if (renderer.onDeviceLost === installed.installedOnDeviceLost) {
      renderer.onDeviceLost = installed.previousOnDeviceLost
    }
    if (renderer.onError === installed.installedOnError) {
      renderer.onError = installed.previousOnError
    }
    hooks.delete(renderer)
  }

  const disposeRenderer = (renderer: LogoParticleRenderer): void => {
    restoreHooks(renderer)
    renderer.dispose()
  }

  const handleDeviceLost = (renderer: LogoParticleRenderer): void => {
    if (retired || phase === 'retired' || phase === 'lost') return

    phase = 'lost'
    publish({ phase: 'lost', reason: 'device-lost' })
    disposeRenderer(renderer)
  }

  const installHooks = (renderer: LogoParticleRenderer): void => {
    const previousOnDeviceLost = renderer.onDeviceLost
    const previousOnError = renderer.onError

    const installedOnDeviceLost = (info: Parameters<LogoParticleRenderer['onDeviceLost']>[0]): void => {
      try {
        previousOnDeviceLost.call(renderer, info)
      } finally {
        handleDeviceLost(renderer)
      }
    }

    const installedOnError = (info: Parameters<LogoParticleRenderer['onError']>[0]): void => {
      try {
        previousOnError.call(renderer, info)
      } finally {
        if (!retired && phase !== 'retired' && phase !== 'lost') publish({ reason: 'backend-error' })
      }
    }

    renderer.onDeviceLost = installedOnDeviceLost
    renderer.onError = installedOnError
    hooks.set(renderer, {
      previousOnDeviceLost,
      previousOnError,
      installedOnDeviceLost,
      installedOnError
    })
  }

  installHooks(currentRenderer)

  const assertUsable = (): void => {
    if (retired || phase === 'retired') throw retiredError()
    if (phase === 'lost') throw lostError()
  }

  const attemptRenderer = async (
    renderer: LogoParticleRenderer,
    expected: ParticleBackendKind | null
  ): Promise<ParticleBackendKind> => {
    try {
      await renderer.init()
      assertUsable()

      const selected = effectiveBackendOf(renderer)
      effectiveBackend = selected
      if (expected !== null && selected !== expected) {
        if (expected === 'webgpu' && !retired && phase !== 'lost') publish({ reason: 'strict-native-required' })
        throw strictNativeError()
      }
      return selected
    } catch (error) {
      if (expected === 'webgpu' && !retired && phase !== 'lost') publish({ reason: 'strict-native-required' })
      disposeRenderer(renderer)
      throw error
    }
  }


  const initialize = async (): Promise<ParticleBackendKind> => {
    const nativeAttempt = currentRenderer
    attempt = 1
    publish({ phase: 'initializing', attempt, reason: 'initializing' })

    const selected = await attemptRenderer(
      nativeAttempt,
      requestedBackend === 'webgpu' ? 'webgpu' : requestedBackend === 'webgl2' ? 'webgl2' : null
    )
    assertUsable()
    if (requestedBackend === 'auto' && selected === 'webgl2') {
      fallback = true
      publish({ fallback: true, reason: 'fallback' })
    }
    return selected
  }

  const init = (): Promise<ParticleBackendKind> => {
    if (retired || phase === 'retired') return Promise.reject(retiredError())
    if (phase === 'lost') return Promise.reject(lostError())
    if (initPromise !== null) return initPromise
    if (phase === 'failed') return Promise.reject(new Error('Particle backend initialization failed'))

    initPromise = initialize()
      .then(selected => {
        assertUsable()
        effectiveBackend = selected
        publish({ phase: 'ready', effectiveBackend: selected, reason: 'ready' })
        return selected
      })
      .catch(error => {
        if (retired || phase === 'retired') {
          phase = 'retired'
          publish({ phase: 'retired', reason: 'retired' })
          throw error
        }
        if (phase === 'lost') throw error

        phase = 'failed'
        const failureReason = reason === 'strict-native-required' ? reason : 'init-failed'
        publish({ phase: 'failed', reason: failureReason })
        throw error
      })

    return initPromise
  }

  const retire = (): void => {
    if (retired) return
    retired = true
    phase = 'retired'
    publish({ phase: 'retired', reason: 'retired' })
    disposeRenderer(currentRenderer)
  }

  return {
    get generation() {
      return generation
    },
    get requestedBackend() {
      return requestedBackend
    },
    get effectiveBackend() {
      return effectiveBackend
    },
    get renderer() {
      return currentRenderer
    },
    get status() {
      return phase
    },
    get diagnostics() {
      return diagnostics
    },
    init,
    retire
  }
}
