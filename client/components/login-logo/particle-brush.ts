import type { LogoPointerImpulse, LogoPointerState } from './useLogoPointer'

const bounded = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min

/** One continuous brush replaces the summed, abruptly recycled GPU impulse fields. */
export class ParticleBrush {
  x = 0
  y = 0
  directionX = 0
  directionY = 0
  radius = 18
  travel = 0
  private lastTime = -1

  update(time: number, pointer: LogoPointerState): void {
    let latest: LogoPointerImpulse | undefined
    for (const impulse of pointer.impulses) {
      if (!impulse.active || !Number.isFinite(impulse.ageSeconds) || impulse.ageSeconds >= 1.4) continue
      if (!latest || impulse.ageSeconds < latest.ageSeconds) latest = impulse
    }
    const reset = this.lastTime < 0 || time < this.lastTime || time - this.lastTime > 0.5
    const delta = reset ? 0 : Math.max(0, time - this.lastTime)
    this.lastTime = time
    if (reset) this.travel = 0
    if (!latest) {
      this.travel *= Math.exp(-delta / 0.18)
      return
    }
    // Fade after motion stops; do not keep reapplying old ring samples to passing particles.
    const activity = Math.exp(-Math.max(0, latest.ageSeconds - 0.04) / 0.18)
    const targetTravel = Math.min(32, bounded(latest.travelCss, 0, 20) * bounded(latest.strength, 0.9, 3.2)) * activity
    const follow = 1 - Math.exp(-delta / 0.065)
    const release = 1 - Math.exp(-delta / (targetTravel > this.travel ? 0.065 : 0.18))
    // Re-enter at the new pointer location while invisible, avoiding a sweep from stale coordinates.
    const positionFollow = reset || this.travel < 0.01 ? 1 : follow
    this.x += (bounded(latest.x, -1, 1) - this.x) * positionFollow
    this.y += (bounded(latest.y, -1, 1) - this.y) * positionFollow
    this.radius += (bounded(latest.radiusCss, 18, 72) - this.radius) * positionFollow
    const length = Math.hypot(latest.directionX, latest.directionY)
    const dx = Number.isFinite(length) && length > 0.000001 ? latest.directionX / length : 0
    const dy = Number.isFinite(length) && length > 0.000001 ? latest.directionY / length : 0
    this.directionX += (dx - this.directionX) * follow
    this.directionY += (dy - this.directionY) * follow
    this.travel += (targetTravel - this.travel) * release
  }
}
