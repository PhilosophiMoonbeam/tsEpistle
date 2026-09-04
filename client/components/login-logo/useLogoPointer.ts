import { onBeforeUnmount, toValue, watch } from 'vue'
import type { MaybeRefOrGetter } from 'vue'

const FINE_POINTER_MEDIA = '(hover: hover) and (pointer: fine)'
const RETURN_BELOW_ONE_PERCENT_MS = 800
const DECAY_LOG_RATIO = Math.log(200)
const LISTENER_OPTIONS: AddEventListenerOptions = Object.freeze({ passive: true })

export interface LogoPointerState {
  x: number
  y: number
  strength: number
  radiusCss: number
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

export const compactPointerFalloff = (distanceCss: number, radiusCss: number): number => {
  if (!Number.isFinite(distanceCss) || !Number.isFinite(radiusCss) || radiusCss <= 0 || distanceCss >= radiusCss) return 0
  const position = clamp(0, 1 - Math.max(0, distanceCss) / radiusCss, 1)
  return position * position * (3 - 2 * position)
}

const applyLogoPointerMotionMetrics = (
  state: Pick<LogoPointerState, 'radiusCss' | 'displacementCss'>,
  medianStroke: number,
  renderedLongAxis: number
): void => {
  const safeLongAxis = Number.isFinite(renderedLongAxis) ? Math.max(0, renderedLongAxis) : 0
  const safeMedianStroke = Number.isFinite(medianStroke) ? Math.max(0, medianStroke) : 0
  const displayedStroke = (safeMedianStroke * safeLongAxis) / 1024
  state.radiusCss = clamp(40, 0.16 * safeLongAxis, 80)
  state.displacementCss = clamp(2, 0.3 * displayedStroke, 6)
}

export const logoPointerMotionMetrics = (medianStroke: number, renderedLongAxis: number): Pick<LogoPointerState, 'radiusCss' | 'displacementCss'> => {
  const metrics = { radiusCss: 40, displacementCss: 2 }
  applyLogoPointerMotionMetrics(metrics, medianStroke, renderedLongAxis)
  return metrics
}

export class LogoPointerController {
  readonly state: LogoPointerState = {
    x: 0,
    y: 0,
    strength: 0,
    radiusCss: 40,
    displacementCss: 2
  }

  private active = false
  private attached = false
  private disposed = false
  private lastRenderedLongAxis = Number.NaN
  private lastMotionTime: number | null = null
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
    if (this.lastMotionTime === null || this.state.strength === 0) return
    const elapsed = Math.max(0, time - this.lastMotionTime)
    this.state.strength = Math.exp((-DECAY_LOG_RATIO * elapsed) / RETURN_BELOW_ONE_PERCENT_MS)
    if (this.state.strength < 0.0001) this.reset()
  }

  private reset(): void {
    this.state.x = 0
    this.state.y = 0
    this.state.strength = 0
    this.lastMotionTime = null
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

    const bounds = this.coordinateTarget.getBoundingClientRect()
    if (
      !Number.isFinite(event.clientX) ||
      !Number.isFinite(event.clientY) ||
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      return

    this.state.x = clamp(-1, (2 * (event.clientX - bounds.left)) / bounds.width - 1, 1)
    this.state.y = clamp(-1, 1 - (2 * (event.clientY - bounds.top)) / bounds.height, 1)
    this.state.strength = 1
    this.lastMotionTime = this.now()
  }

  private readonly onPointerLeave = (event: PointerEvent): void => {
    if (!this.active || event.isPrimary !== true || (event.pointerType !== 'mouse' && event.pointerType !== 'pen') || !this.hasFinePointer()) return
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
