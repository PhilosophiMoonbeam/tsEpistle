import type { MaybeRefOrGetter } from 'vue'
import { onBeforeUnmount, toValue, watch } from 'vue'

const FINE_POINTER_MEDIA = '(hover: hover) and (pointer: fine)'
const LISTENER_OPTIONS: AddEventListenerOptions = Object.freeze({ passive: true })

export const LOGO_POINTER_IMPULSE_CAPACITY = 4
export const LOGO_POINTER_IMPULSE_LIFETIME_SECONDS = 0.9
export const LOGO_POINTER_MAX_SEGMENT_CSS = 12
export const LOGO_POINTER_MAX_TRAVEL_CSS = 8
export const LOGO_POINTER_NEIGHBOR_FORCE_RATIO = 0.18
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

type LogoPointerImpulseRing = readonly [LogoPointerImpulse, LogoPointerImpulse, LogoPointerImpulse, LogoPointerImpulse]

export interface LogoPointerState {
  activeImpulseCount: number
  influenceRadiusCss: number
  readonly impulses: LogoPointerImpulseRing
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

export class LogoPointerController {
  readonly state: LogoPointerState = {
    activeImpulseCount: 0,
    influenceRadiusCss: MIN_INFLUENCE_RADIUS_CSS,
    impulses: [createImpulse(), createImpulse(), createImpulse(), createImpulse()]
  }

  private active = false
  private attached = false
  private disposed = false
  private lastRenderedLongAxis = Number.NaN
  private lastSampleX = 0
  private lastSampleY = 0
  private lastSampleTime: number | null = null
  private nextImpulseIndex = 0
  private target: HTMLElement | null = null
  private coordinateTarget: HTMLElement | null = null
  private readonly hasFinePointer: () => boolean
  private readonly impulseStartedAtMilliseconds = new Float64Array(LOGO_POINTER_IMPULSE_CAPACITY)
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
    this.target.addEventListener('pointermove', this.onPointerMove, LISTENER_OPTIONS)
    this.target.addEventListener('pointerleave', this.onPointerLeave, LISTENER_OPTIONS)
    this.target.classList.add('login-particle-logo--pointer-active')
    this.attached = true
  }

  private detach(): void {
    if (!this.attached || !this.target) return
    this.target.removeEventListener('pointermove', this.onPointerMove, LISTENER_OPTIONS)
    this.target.removeEventListener('pointerleave', this.onPointerLeave, LISTENER_OPTIONS)
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

  private clear(): void {
    this.state.activeImpulseCount = 0
    this.state.influenceRadiusCss = MIN_INFLUENCE_RADIUS_CSS
    this.lastRenderedLongAxis = Number.NaN
    this.lastSampleTime = null
    this.lastSampleX = 0
    this.lastSampleY = 0
    this.nextImpulseIndex = 0
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
  }

  private recordImpulse(clientX: number, clientY: number, bounds: DOMRect, deltaX: number, deltaY: number, travelCss: number, time: number): void {
    const index = this.nextImpulseIndex
    const impulse = this.state.impulses[index]
    const inverseTravel = 1 / travelCss
    impulse.active = true
    impulse.ageSeconds = 0
    impulse.directionX = clamp(-1, deltaX * inverseTravel, 1)
    impulse.directionY = clamp(-1, deltaY * inverseTravel, 1)
    impulse.radiusCss = this.state.influenceRadiusCss
    impulse.travelCss = Math.min(travelCss, LOGO_POINTER_MAX_SEGMENT_CSS)
    impulse.x = clamp(-1, (2 * (clientX - bounds.left)) / bounds.width - 1, 1)
    impulse.y = clamp(-1, 1 - (2 * (clientY - bounds.top)) / bounds.height, 1)
    this.impulseStartedAtMilliseconds[index] = time
    this.nextImpulseIndex = (index + 1) % LOGO_POINTER_IMPULSE_CAPACITY
    this.state.activeImpulseCount = Math.min(LOGO_POINTER_IMPULSE_CAPACITY, this.state.activeImpulseCount + 1)
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (
      !this.active ||
      event.isPrimary !== true ||
      (event.pointerType !== 'mouse' && event.pointerType !== 'pen') ||
      !this.hasFinePointer() ||
      !this.coordinateTarget
    )
      return

    const clientX = event.clientX
    const clientY = event.clientY
    const bounds = this.coordinateTarget.getBoundingClientRect()
    if (
      !Number.isFinite(clientX) ||
      !Number.isFinite(clientY) ||
      !Number.isFinite(bounds.left) ||
      !Number.isFinite(bounds.top) ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      clientX < bounds.left ||
      clientX > bounds.left + bounds.width ||
      clientY < bounds.top ||
      clientY > bounds.top + bounds.height
    )
      return

    const motionTime = this.now()
    if (!Number.isFinite(motionTime)) return
    this.ageImpulses(motionTime)

    if (this.lastSampleTime !== null) {
      const deltaX = clientX - this.lastSampleX
      const deltaY = this.lastSampleY - clientY
      const travelCss = Math.hypot(deltaX, deltaY)
      if (Number.isFinite(travelCss) && travelCss > LOGO_POINTER_MIN_SEGMENT_CSS) {
        this.recordImpulse(clientX, clientY, bounds, deltaX, deltaY, travelCss, motionTime)
      }
    }

    this.lastSampleX = clientX
    this.lastSampleY = clientY
    this.lastSampleTime = motionTime
  }

  private readonly onPointerLeave = (event: PointerEvent): void => {
    if (!this.active || event.isPrimary !== true || (event.pointerType !== 'mouse' && event.pointerType !== 'pen') || !this.hasFinePointer()) return
    this.lastSampleTime = null
    this.lastSampleX = 0
    this.lastSampleY = 0
    this.ageImpulses(this.now())
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
