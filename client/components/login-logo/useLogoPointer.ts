import type { MaybeRefOrGetter } from 'vue'
import { onBeforeUnmount, toValue, watch } from 'vue'

const FINE_POINTER_MEDIA = '(hover: hover) and (pointer: fine)'
const DECAY_DURATION_MS = 240
const MIN_POINTER_SPEED_PX_PER_MS = 0.05
const POINTER_SPEED_RANGE_PX_PER_MS = 0.85
const LISTENER_OPTIONS: AddEventListenerOptions = Object.freeze({ passive: true })

export interface LogoPointerState {
  x: number
  y: number
  directionX: number
  directionY: number
  speed: number
  strength: number
  alongRadiusCss: number
  acrossRadiusCss: number
  displacementCss: number
}

export interface LogoPointerControllerOptions {
  readonly medianStroke: number
  readonly now?: () => number
  readonly hasFinePointer?: () => boolean
}

export interface UseLogoPointerOptions extends LogoPointerControllerOptions {
  readonly coordinateTarget: MaybeRefOrGetter<HTMLElement | null>
  readonly target: MaybeRefOrGetter<HTMLElement | null>
  readonly active: MaybeRefOrGetter<boolean>
}

const clamp = (minimum: number, value: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value))

const applyLogoPointerMotionMetrics = (
  state: Pick<LogoPointerState, 'alongRadiusCss' | 'acrossRadiusCss' | 'displacementCss'>,
  medianStroke: number,
  renderedLongAxis: number
): void => {
  const safeLongAxis = Number.isFinite(renderedLongAxis) ? Math.max(0, renderedLongAxis) : 0
  const safeMedianStroke = Number.isFinite(medianStroke) ? Math.max(0, medianStroke) : 0
  const displayedStroke = (safeMedianStroke * safeLongAxis) / 1024
  state.acrossRadiusCss = clamp(28, 0.08 * safeLongAxis, 56)
  state.alongRadiusCss = 1.8 * state.acrossRadiusCss
  state.displacementCss = clamp(10, displayedStroke, 24)
}

export const logoPointerMotionMetrics = (
  medianStroke: number,
  renderedLongAxis: number
): Pick<LogoPointerState, 'alongRadiusCss' | 'acrossRadiusCss' | 'displacementCss'> => {
  const metrics = { alongRadiusCss: 50.4, acrossRadiusCss: 28, displacementCss: 10 }
  applyLogoPointerMotionMetrics(metrics, medianStroke, renderedLongAxis)
  return metrics
}

export class LogoPointerController {
  readonly state: LogoPointerState = {
    x: 0,
    y: 0,
    directionX: 1,
    directionY: 0,
    speed: 0,
    strength: 0,
    alongRadiusCss: 50.4,
    acrossRadiusCss: 28,
    displacementCss: 10
  }

  private active = false
  private attached = false
  private disposed = false
  private lastRenderedLongAxis = Number.NaN
  private lastMotionTime: number | null = null
  private lastSampleX = 0
  private lastSampleY = 0
  private lastSampleTime: number | null = null
  private target: HTMLElement | null = null
  private coordinateTarget: HTMLElement | null = null
  private readonly hasFinePointer: () => boolean
  private readonly medianStroke: number
  private readonly now: () => number

  constructor(options: LogoPointerControllerOptions) {
    this.medianStroke = options.medianStroke
    this.now = options.now ?? (() => performance.now())
    const finePointerQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(FINE_POINTER_MEDIA) : null
    this.hasFinePointer = options.hasFinePointer ?? (() => finePointerQuery?.matches === true)
  }

  setTarget(target: HTMLElement | null): void {
    if (this.disposed || target === this.target) return
    this.detach()
    this.target = target
    this.reset()
    this.attach()
  }

  setCoordinateTarget(target: HTMLElement | null): void {
    if (this.disposed || target === this.coordinateTarget) return
    this.coordinateTarget = target
    this.reset()
  }

  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return
    this.active = active
    if (active) {
      this.reset()
      this.attach()
    } else {
      this.detach()
      this.reset()
    }
  }

  update(renderedLongAxis: number, time = this.now()): LogoPointerState {
    if (renderedLongAxis !== this.lastRenderedLongAxis) {
      applyLogoPointerMotionMetrics(this.state, this.medianStroke, renderedLongAxis)
      this.lastRenderedLongAxis = renderedLongAxis
    }
    this.decayTo(time)
    return this.state
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.detach()
    this.coordinateTarget = null
    this.target = null
    this.active = false
    this.reset()
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

  private decayTo(time: number): void {
    if (this.lastMotionTime === null || this.state.strength === 0 || !Number.isFinite(time)) return
    const elapsed = Math.max(0, time - this.lastMotionTime)
    const remaining = clamp(0, 1 - elapsed / DECAY_DURATION_MS, 1)
    this.state.strength = remaining * remaining
    if (this.state.strength === 0) this.reset(true)
  }

  private reset(preserveSampleHistory = false): void {
    this.state.x = 0
    this.state.y = 0
    this.state.directionX = 1
    this.state.directionY = 0
    this.state.speed = 0
    this.state.strength = 0
    this.lastMotionTime = null
    if (!preserveSampleHistory) {
      this.lastSampleTime = null
      this.lastSampleX = 0
      this.lastSampleY = 0
    }
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

    const lastSampleTime = this.lastSampleTime
    const isFirstSample = lastSampleTime === null
    let sampledSpeed = 0
    let candidateDirectionX = this.state.directionX
    let candidateDirectionY = this.state.directionY
    if (!isFirstSample) {
      const deltaX = clientX - this.lastSampleX
      const deltaY = this.lastSampleY - clientY
      const distance = Math.hypot(deltaX, deltaY)
      const elapsed = motionTime - lastSampleTime

      if (distance > 0 && Number.isFinite(distance)) {
        const inverseDistance = 1 / distance
        candidateDirectionX = clamp(-1, deltaX * inverseDistance, 1)
        candidateDirectionY = clamp(-1, deltaY * inverseDistance, 1)
      }

      if (elapsed > 0 && Number.isFinite(elapsed) && Number.isFinite(distance)) {
        const speedPosition = clamp(0, (distance / elapsed - MIN_POINTER_SPEED_PX_PER_MS) / POINTER_SPEED_RANGE_PX_PER_MS, 1)
        sampledSpeed = speedPosition * speedPosition * (3 - 2 * speedPosition)
      }
    }

    if (sampledSpeed > 0) {
      this.state.directionX = candidateDirectionX
      this.state.directionY = candidateDirectionY
      this.state.speed = sampledSpeed
      this.state.strength = 1
      this.lastMotionTime = motionTime
    }

    this.lastSampleX = clientX
    this.lastSampleY = clientY
    this.lastSampleTime = motionTime
    this.state.x = clamp(-1, (2 * (clientX - bounds.left)) / bounds.width - 1, 1)
    this.state.y = clamp(-1, 1 - (2 * (clientY - bounds.top)) / bounds.height, 1)
  }

  private readonly onPointerLeave = (event: PointerEvent): void => {
    if (!this.active || event.isPrimary !== true || (event.pointerType !== 'mouse' && event.pointerType !== 'pen') || !this.hasFinePointer()) return
    this.lastSampleTime = null
    this.lastSampleX = 0
    this.lastSampleY = 0
    this.decayTo(this.now())
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
