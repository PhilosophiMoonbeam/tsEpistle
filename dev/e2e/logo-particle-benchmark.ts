import type { ParticleBackendDiagnostics, ParticleBackendKind, ParticleBackendRequest } from '../../client/components/login-logo/particle-renderer.ts'

export interface LogoMotionDiagnostics {
  readonly activeExplosionCount: number
  readonly activeImpulseCount: number
  readonly collisionParticleCount: number
  readonly bounceRatio: number
  readonly depthScaleMax: number
  readonly depthScaleMin: number
  readonly elapsedSeconds: number
  readonly explosionHoldSeconds: number
  readonly explosionLifetimeSeconds: number
  readonly explosionRefillSeconds: number
  readonly idleAmplitudeCss: number
  readonly impulseLifetimeSeconds: number
  readonly maxImpulseTravelCss: number
  readonly neighborForceRatio: number
  readonly particleCount: number
}

export interface LogoStartupMilestones {
  readonly enhancementScheduledAt?: number
  readonly importStartedAt?: number
  readonly importEndedAt?: number
  readonly fetchStartedAt?: number
  readonly fetchEndedAt?: number
  readonly parseStartedAt?: number
  readonly parseEndedAt?: number
  readonly resourcesStartedAt?: number
  readonly resourcesEndedAt?: number
  readonly initStartedAt?: number
  readonly initEndedAt?: number
  readonly firstSubmissionAt?: number
  readonly visibleCommitAt?: number
}

export interface LogoResumeSample {
  readonly startedAt: number
  readonly firstSubmissionAt?: number | null
  readonly visibleCommitAt?: number | null
  readonly outcome?: 'committed' | 'failed' | 'lost' | 'retired'
  readonly reason?: string
}

export interface LogoPerformanceFrame {
  readonly frameId?: number
  readonly submittedAt?: number
  readonly updateCpuMs?: number
  /**
   * Wall-clock scheduling time between the update callback and render callback.
   * This is not renderer CPU time or GPU time.
   */
  readonly renderCallbackGapMs?: number
  /** Synchronous renderer.render() entry-to-return time from the opt-in scene wrapper. */
  readonly renderInvocationCpuMs?: number
  readonly afterRenderCpuMs?: number
  readonly totalDrawCalls?: number
  readonly particleInstances?: number
  readonly triangles?: number
  readonly computeDispatches?: number
  readonly motionScheduledBytes?: number
  readonly actualUploadBytes?: number | null
  readonly uploadCalls?: number | null
  readonly colorUploadBytes?: number
}

export interface LogoPerformanceCounters {
  updateCallbacks?: number
  renderInvocations?: number
  afterRenderCallbacks?: number
  rafCallbacks?: number
  draws?: number
  uploads?: number
  sampleOverflow?: number
}

export interface LogoGpuTimingSample {
  readonly frameId?: number
  readonly durationMs?: number
  readonly status?: 'available' | 'unavailable'
  readonly reason?: string
}

export type LogoUploadObservationStatus = 'available' | 'unavailable'

export interface LogoUploadApiObservation {
  status: LogoUploadObservationStatus
  calls: number | null
  bytes: number | null
  reason?: string
}

export interface LogoBenchmarkApiObservations {
  webgpu: LogoUploadApiObservation
  webgl2: LogoUploadApiObservation
}

export type LogoBackendDiagnostic = ParticleBackendDiagnostics

export interface LogoParticlePerformanceHook {
  callbackCount: number
  callbackCpuMilliseconds: number[]
  frameIntervalsMilliseconds: number[]
  firstFrameMilliseconds: number | null
  lastFrameAt: number | null
  /**
   * Set by the opt-in scene renderer wrapper for the current synchronous
   * renderer.render() invocation, then consumed by the onRender hook.
   * A missing/null value is unavailable and must not be inferred as zero.
   */
  renderInvocationCpuMs?: number | null
  /** Incremented by the harness when a GPU-timing sample window is reset. */
  gpuTimingEpoch?: number
  lastMotion?: LogoMotionDiagnostics
  maximumActiveExplosionCount?: number
  maximumActiveImpulseCount?: number
  requestedBackend?: ParticleBackendRequest
  effectiveBackend?: ParticleBackendKind | null
  backendDiagnostics?: LogoBackendDiagnostic[]
  onDiagnostics?: (diagnostic: LogoBackendDiagnostic) => void
  startup?: LogoStartupMilestones
  resumes?: LogoResumeSample[]
  frames?: LogoPerformanceFrame[]
  gpu?: LogoGpuTimingSample[]
  counters?: LogoPerformanceCounters
  apiObservations?: LogoBenchmarkApiObservations
}

export type LogoPerformanceHook = LogoParticlePerformanceHook

export type LogoPerformanceWindow = Window & {
  __logoParticlePerformance?: LogoParticlePerformanceHook
}

export function logoPerformanceWindow(): LogoPerformanceWindow {
  return window as LogoPerformanceWindow
}
