import type { MaybeRefOrGetter } from 'vue'
import { onBeforeUnmount, toValue, watch } from 'vue'

const FINE_POINTER_MEDIA = '(hover: hover) and (pointer: fine)'
const LISTENER_OPTIONS: AddEventListenerOptions = Object.freeze({ passive: true })

export const LOGO_POINTER_IMPULSE_CAPACITY = 6
export const LOGO_POINTER_IMPULSE_LIFETIME_SECONDS = 1.4
export const LOGO_POINTER_MAX_SEGMENT_CSS = 20
export const LOGO_POINTER_MAX_TRAVEL_CSS = 14
export const LOGO_POINTER_NEIGHBOR_FORCE_RATIO = 0.32
export const LOGO_POINTER_BOUNCE_RATIO = 0.22
export const LOGO_POINTER_SPEED_REFERENCE_CSS_PER_SECOND = 900
export const LOGO_POINTER_EXPLOSION_CAPACITY = 6
export const LOGO_POINTER_EXPLOSION_HOLD_SECONDS = 0.35
export const LOGO_POINTER_EXPLOSION_REFILL_SECONDS = 2.4
export const LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS = 2.8
const LOGO_POINTER_MIN_SEGMENT_CSS = 2
const MIN_INFLUENCE_RADIUS_CSS = 18
const MAX_INFLUENCE_RADIUS_CSS = 32

export interface LogoPointerImpulse {
  active: boolean
  ageSeconds: number
  directionX: number
  directionY: number
  radiusCss: number
  travelCss: number
  x: number
  y: number
}

export interface LogoPointerExplosion {
  active: boolean
  ageSeconds: number
  x: number
  y: number
}

type LogoPointerImpulseRing = readonly [LogoPointerImpulse, LogoPointerImpulse, LogoPointerImpulse, LogoPointerImpulse, LogoPointerImpulse, LogoPointerImpulse]
type LogoPointerExplosionRing = readonly [
  LogoPointerExplosion,
  LogoPointerExplosion,
  LogoPointerExplosion,
  LogoPointerExplosion,
  LogoPointerExplosion,
  LogoPointerExplosion
]

export interface LogoPointerState {
  activeImpulseCount: number
  activeExplosionCount: number
  influenceRadiusCss: number
  readonly impulses: LogoPointerImpulseRing
  readonly explosions: LogoPointerExplosionRing
}

export interface LogoPointerControllerOptions {
  readonly now?: () => number
  readonly hasFinePointer?: () => boolean
}

export interface UseLogoPointerOptions extends LogoPointerControllerOptions {
  readonly coordinateTarget: MaybeRefOrGetter<HTMLElement | null>
  readonly target: MaybeRefOrGetter<HTMLElement | null>
  readonly active: MaybeRefOrGetter<boolean>
}

const clamp = (minimum: number, value: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value))

export const logoPointerInfluenceRadius = (renderedLongAxis: number): number => {
  const safeLongAxis = Number.isFinite(renderedLongAxis) ? Math.max(0, renderedLongAxis) : 0
  return clamp(MIN_INFLUENCE_RADIUS_CSS, 0.05 * safeLongAxis, MAX_INFLUENCE_RADIUS_CSS)
}

const createImpulse = (): LogoPointerImpulse => ({
  active: false,
  ageSeconds: 0,
  directionX: 1,
  directionY: 0,
  radiusCss: MIN_INFLUENCE_RADIUS_CSS,
  travelCss: 0,
  x: 0,
  y: 0
})

const createExplosion = (): LogoPointerExplosion => ({
  active: false,
  ageSeconds: 0,
  x: 0,
  y: 0
})

const pointerIdOf = (event: PointerEvent): number => (Number.isFinite(event.pointerId) ? event.pointerId : 0)

const boundedDeadline = (time: number, durationMilliseconds: number): number => {
  const deadline = time + durationMilliseconds
  return Number.isFinite(deadline) ? Math.min(deadline, Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
}

export class LogoPointerController {
  readonly state: LogoPointerState = {
    activeImpulseCount: 0,
    activeExplosionCount: 0,
    influenceRadiusCss: MIN_INFLUENCE_RADIUS_CSS,
    impulses: [createImpulse(), createImpulse(), createImpulse(), createImpulse(), createImpulse(), createImpulse()],
    explosions: [createExplosion(), createExplosion(), createExplosion(), createExplosion(), createExplosion(), createExplosion()]
  }

  private active = false
  private attached = false
  private disposed = false
  private lastRenderedLongAxis = Number.NaN
  private lastSampleX = 0
  private lastSampleY = 0
  private lastSampleTime: number | null = null
  private lastSamplePointerId: number | null = null
  private nextImpulseIndex = 0
  private nextExplosionIndex = 0
  private ownedPointerId: number | null = null
  private target: HTMLElement | null = null
  private coordinateTarget: HTMLElement | null = null
  private readonly hasFinePointer: () => boolean
  private readonly impulseStartedAtMilliseconds = new Float64Array(LOGO_POINTER_IMPULSE_CAPACITY)
  private readonly explosionStartedAtMilliseconds = new Float64Array(LOGO_POINTER_EXPLOSION_CAPACITY)
  private readonly explosionDeadlineMilliseconds = new Float64Array(LOGO_POINTER_EXPLOSION_CAPACITY)
  private readonly now: () => number

  constructor(options: LogoPointerControllerOptions = {}) {
    this.now = options.now ?? (() => performance.now())
    const finePointerQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(FINE_POINTER_MEDIA) : null
    this.hasFinePointer = options.hasFinePointer ?? (() => finePointerQuery?.matches === true)
  }

  setTarget(target: HTMLElement | null): void {
    if (this.disposed || target === this.target) return
    this.detach()
    this.target = target
    this.clear()
    this.attach()
  }

  setCoordinateTarget(target: HTMLElement | null): void {
    if (this.disposed || target === this.coordinateTarget) return
    this.coordinateTarget = target
    this.clear()
  }

  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return
    this.active = active
    if (active) {
      this.clear()
      this.attach()
    } else {
      this.detach()
      this.clear()
    }
  }

  update(renderedLongAxis: number, time = this.now()): LogoPointerState {
    if (renderedLongAxis !== this.lastRenderedLongAxis) {
      this.state.influenceRadiusCss = logoPointerInfluenceRadius(renderedLongAxis)
      this.lastRenderedLongAxis = renderedLongAxis
    }
    this.ageImpulses(time)
    this.ageExplosions(time)
    return this.state
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.detach()
    this.coordinateTarget = null
    this.target = null
    this.active = false
    this.clear()
  }

  private attach(): void {
    if (this.attached || !this.active || !this.target || this.disposed) return
    this.target.addEventListener('pointerdown', this.onPointerDown, LISTENER_OPTIONS)
    this.target.addEventListener('pointermove', this.onPointerMove, LISTENER_OPTIONS)
    this.target.addEventListener('pointerleave', this.onPointerLeave, LISTENER_OPTIONS)
    this.target.addEventListener('pointerup', this.onPointerUp, LISTENER_OPTIONS)
    this.target.addEventListener('pointercancel', this.onPointerCancel, LISTENER_OPTIONS)
    this.target.classList.add('login-particle-logo--pointer-active')
    this.attached = true
  }

  private detach(): void {
    if (!this.attached || !this.target) return
    this.target.removeEventListener('pointerdown', this.onPointerDown, LISTENER_OPTIONS)
    this.target.removeEventListener('pointermove', this.onPointerMove, LISTENER_OPTIONS)
    this.target.removeEventListener('pointerleave', this.onPointerLeave, LISTENER_OPTIONS)
    this.target.removeEventListener('pointerup', this.onPointerUp, LISTENER_OPTIONS)
    this.target.removeEventListener('pointercancel', this.onPointerCancel, LISTENER_OPTIONS)
    this.target.classList.remove('login-particle-logo--pointer-active')
    this.attached = false
  }

  private ageImpulses(time: number): void {
    if (!Number.isFinite(time)) return
    let activeImpulseCount = 0
    for (let index = 0; index < LOGO_POINTER_IMPULSE_CAPACITY; index += 1) {
      const impulse = this.state.impulses[index]
      if (!impulse.active) continue
      const ageSeconds = Math.max(0, time - this.impulseStartedAtMilliseconds[index]) / 1000
      if (ageSeconds >= LOGO_POINTER_IMPULSE_LIFETIME_SECONDS) {
        impulse.active = false
        impulse.ageSeconds = LOGO_POINTER_IMPULSE_LIFETIME_SECONDS
        continue
      }
      impulse.ageSeconds = ageSeconds
      activeImpulseCount += 1
    }
    this.state.activeImpulseCount = activeImpulseCount
    if (activeImpulseCount === 0) this.nextImpulseIndex = 0
  }

  private ageExplosions(time: number): void {
    if (!Number.isFinite(time)) return
    let activeExplosionCount = 0
    for (let index = 0; index < LOGO_POINTER_EXPLOSION_CAPACITY; index += 1) {
      const explosion = this.state.explosions[index]
      if (!explosion.active) continue
      const ageSeconds = Math.max(0, time - this.explosionStartedAtMilliseconds[index]) / 1000
      if (time >= this.explosionDeadlineMilliseconds[index] || ageSeconds >= LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS) {
        explosion.active = false
        explosion.ageSeconds = LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS
        continue
      }
      explosion.ageSeconds = Math.min(ageSeconds, LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS)
      activeExplosionCount += 1
    }
    this.state.activeExplosionCount = activeExplosionCount
    if (activeExplosionCount === 0) this.nextExplosionIndex = 0
  }

  private clear(): void {
    this.state.activeImpulseCount = 0
    this.state.activeExplosionCount = 0
    this.state.influenceRadiusCss = MIN_INFLUENCE_RADIUS_CSS
    this.lastRenderedLongAxis = Number.NaN
    this.lastSampleTime = null
    this.lastSamplePointerId = null
    this.lastSampleX = 0
    this.lastSampleY = 0
    this.nextImpulseIndex = 0
    this.nextExplosionIndex = 0
    this.ownedPointerId = null
    for (let index = 0; index < LOGO_POINTER_IMPULSE_CAPACITY; index += 1) {
      const impulse = this.state.impulses[index]
      impulse.active = false
      impulse.ageSeconds = 0
      impulse.directionX = 1
      impulse.directionY = 0
      impulse.radiusCss = MIN_INFLUENCE_RADIUS_CSS
      impulse.travelCss = 0
      impulse.x = 0
      impulse.y = 0
      this.impulseStartedAtMilliseconds[index] = 0
    }
    for (let index = 0; index < LOGO_POINTER_EXPLOSION_CAPACITY; index += 1) {
      const explosion = this.state.explosions[index]
      explosion.active = false
      explosion.ageSeconds = 0
      explosion.x = 0
      explosion.y = 0
      this.explosionStartedAtMilliseconds[index] = 0
      this.explosionDeadlineMilliseconds[index] = 0
    }
  }

  private validCoordinates(clientX: number, clientY: number, bounds: DOMRect): boolean {
    return (
      Number.isFinite(clientX) &&
      Number.isFinite(clientY) &&
      Number.isFinite(bounds.left) &&
      Number.isFinite(bounds.top) &&
      Number.isFinite(bounds.width) &&
      Number.isFinite(bounds.height) &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      clientX >= bounds.left &&
      clientX <= bounds.left + bounds.width &&
      clientY >= bounds.top &&
      clientY <= bounds.top + bounds.height
    )
  }

  private recordExplosion(clientX: number, clientY: number, bounds: DOMRect, time: number): void {
    this.ageExplosions(time)
    if (this.state.activeExplosionCount >= LOGO_POINTER_EXPLOSION_CAPACITY) return
    let index = this.nextExplosionIndex
    for (let attempt = 0; attempt < LOGO_POINTER_EXPLOSION_CAPACITY; attempt += 1) {
      if (!this.state.explosions[index].active) break
      index = (index + 1) % LOGO_POINTER_EXPLOSION_CAPACITY
    }
    if (this.state.explosions[index].active) return
    const explosion = this.state.explosions[index]
    explosion.active = true
    explosion.ageSeconds = 0
    explosion.x = clamp(-1, (2 * (clientX - bounds.left)) / bounds.width - 1, 1)
    explosion.y = clamp(-1, 1 - (2 * (clientY - bounds.top)) / bounds.height, 1)
    this.explosionStartedAtMilliseconds[index] = time
    this.explosionDeadlineMilliseconds[index] = boundedDeadline(time, LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS * 1000)
    this.nextExplosionIndex = (index + 1) % LOGO_POINTER_EXPLOSION_CAPACITY
    this.state.activeExplosionCount += 1
  }

  private recordImpulse(
    clientX: number,
    clientY: number,
    bounds: DOMRect,
    deltaX: number,
    deltaY: number,
    travelCss: number,
    deltaSeconds: number,
    time: number
  ): void {
    if (this.state.activeImpulseCount >= LOGO_POINTER_IMPULSE_CAPACITY) return
    let index = this.nextImpulseIndex
    for (let attempt = 0; attempt < LOGO_POINTER_IMPULSE_CAPACITY; attempt += 1) {
      if (!this.state.impulses[index].active) break
      index = (index + 1) % LOGO_POINTER_IMPULSE_CAPACITY
    }
    if (this.state.impulses[index].active) return
    const impulse = this.state.impulses[index]
    const inverseTravel = 1 / travelCss
    const speed = travelCss / Math.max(deltaSeconds, 0.001)
    const speedRatio = clamp(0.5, speed / LOGO_POINTER_SPEED_REFERENCE_CSS_PER_SECOND, 2)
    impulse.active = true
    impulse.ageSeconds = 0
    impulse.directionX = clamp(-1, deltaX * inverseTravel, 1)
    impulse.directionY = clamp(-1, deltaY * inverseTravel, 1)
    impulse.radiusCss = this.state.influenceRadiusCss
    impulse.travelCss = Math.min(LOGO_POINTER_MAX_SEGMENT_CSS, travelCss * speedRatio)
    impulse.x = clamp(-1, (2 * (clientX - bounds.left)) / bounds.width - 1, 1)
    impulse.y = clamp(-1, 1 - (2 * (clientY - bounds.top)) / bounds.height, 1)
    this.impulseStartedAtMilliseconds[index] = time
    this.nextImpulseIndex = (index + 1) % LOGO_POINTER_IMPULSE_CAPACITY
    this.state.activeImpulseCount = Math.min(LOGO_POINTER_IMPULSE_CAPACITY, this.state.activeImpulseCount + 1)
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (
      !this.active ||
      event.isPrimary !== true ||
      (event.pointerType !== 'mouse' && event.pointerType !== 'pen' && event.pointerType !== 'touch') ||
      ((event.pointerType === 'mouse' || event.pointerType === 'pen') && event.button !== 0) ||
      !this.coordinateTarget
    )
      return
    const bounds = this.coordinateTarget.getBoundingClientRect()
    if (!this.validCoordinates(event.clientX, event.clientY, bounds)) return
    const eventTime = this.now()
    if (!Number.isFinite(eventTime)) return
    const eventPointerId = pointerIdOf(event)
    this.ownedPointerId = eventPointerId
    this.clearSamplingBaseline()
    this.lastSampleX = event.clientX
    this.lastSampleY = event.clientY
    if (event.pointerType !== 'touch' && this.hasFinePointer()) {
      this.lastSamplePointerId = eventPointerId
      this.lastSampleTime = eventTime
    }
    this.recordExplosion(event.clientX, event.clientY, bounds, eventTime)
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const eventPointerId = pointerIdOf(event)
    if (
      !this.active ||
      event.isPrimary !== true ||
      (event.pointerType !== 'mouse' && event.pointerType !== 'pen') ||
      !this.hasFinePointer() ||
      !this.coordinateTarget ||
      (this.ownedPointerId !== null && eventPointerId !== this.ownedPointerId)
    )
      return

    const clientX = event.clientX
    const clientY = event.clientY
    const bounds = this.coordinateTarget.getBoundingClientRect()
    if (!this.validCoordinates(clientX, clientY, bounds)) {
      if (this.lastSamplePointerId === eventPointerId) this.clearSamplingBaseline()
      return
    }

    const motionTime = this.now()
    if (!Number.isFinite(motionTime)) return
    this.ageImpulses(motionTime)

    if (this.lastSampleTime !== null && this.lastSamplePointerId === eventPointerId) {
      const deltaX = clientX - this.lastSampleX
      const deltaY = this.lastSampleY - clientY
      const travelCss = Math.hypot(deltaX, deltaY)
      const deltaSeconds = (motionTime - this.lastSampleTime) / 1000
      if (Number.isFinite(travelCss) && Number.isFinite(deltaSeconds) && travelCss > LOGO_POINTER_MIN_SEGMENT_CSS && deltaSeconds >= 0) {
        this.recordImpulse(clientX, clientY, bounds, deltaX, deltaY, Math.min(travelCss, LOGO_POINTER_MAX_SEGMENT_CSS), deltaSeconds, motionTime)
      }
    }

    this.lastSampleX = clientX
    this.lastSampleY = clientY
    this.lastSampleTime = motionTime
    this.lastSamplePointerId = eventPointerId
  }

  private readonly onPointerLeave = (event: PointerEvent): void => {
    if (!this.active || event.isPrimary !== true) return
    this.clearSampling(event)
    this.ageImpulses(this.now())
    this.ageExplosions(this.now())
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.active || event.isPrimary !== true) return
    this.clearSampling(event)
  }

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (!this.active || event.isPrimary !== true) return
    this.clearSampling(event)
  }

  private clearSampling(event: PointerEvent): void {
    const eventPointerId = pointerIdOf(event)
    if (this.ownedPointerId !== null) {
      if (eventPointerId !== this.ownedPointerId) return
      this.ownedPointerId = null
    } else if (this.lastSamplePointerId !== null && eventPointerId !== this.lastSamplePointerId) {
      return
    }
    this.clearSamplingBaseline()
  }

  private clearSamplingBaseline(): void {
    this.lastSampleTime = null
    this.lastSamplePointerId = null
    this.lastSampleX = 0
    this.lastSampleY = 0
  }
}

export const useLogoPointer = (options: UseLogoPointerOptions): LogoPointerController => {
  const controller = new LogoPointerController(options)

  watch(
    [() => toValue(options.target), () => toValue(options.coordinateTarget), () => toValue(options.active)],
    ([target, coordinateTarget, active]) => {
      controller.setTarget(target)
      controller.setCoordinateTarget(coordinateTarget)
      controller.setActive(active)
    },
    { flush: 'sync', immediate: true }
  )
  onBeforeUnmount(() => controller.dispose())

  return controller
}
