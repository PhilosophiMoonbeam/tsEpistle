import { addExplosionDisplacement, LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS } from './particle-explosion'
import { ParticleBrush } from './particle-brush'
import type { ParticleContentRect, ParsedLogoParticles } from './particle-logo'
import type { LogoPointerState } from './useLogoPointer'

/** Dust stays on the GPU; only this bounded population needs collision physics. */
export const CLOUD_BEAD_LIMIT = 512
export const CLOUD_BEAD_FRACTION = 0.065
export const CLOUD_DUST_FRACTION = 0.7
const STEP = 1 / 120
const DAMPING = Math.exp(-3.8 * STEP)
const BUCKETS = 4096
const CELL = 24
const TAU = Math.PI * 2

export class ParticleCloud {
  readonly brush = new ParticleBrush()
  /** CSS displacement for each source particle. Original logo attributes remain immutable. */
  readonly motion: Float32Array
  readonly indices: Uint16Array
  readonly count: number
  readonly x: Float32Array
  readonly y: Float32Array
  readonly vx: Float32Array
  readonly vy: Float32Array
  readonly radius: Float32Array
  private readonly homeX: Float32Array
  private readonly homeY: Float32Array
  private readonly explosionMotion: Float32Array
  private readonly phases: Float64Array
  private readonly heads = new Int32Array(BUCKETS)
  private readonly next: Int32Array
  private readonly cellX: Int32Array
  private readonly cellY: Int32Array
  private lastTime = -1
  private simulationTime = 0
  private hasTime = false
  private width = 0
  private height = 0
  private logicalLeft = Number.NaN
  private logicalTop = Number.NaN
  private logicalWidth = Number.NaN
  private logicalHeight = Number.NaN
  private accumulator = 0

  constructor(private readonly particles: ParsedLogoParticles) {
    this.motion = new Float32Array(particles.count * 2)
    const indices: number[] = []
    let candidates = 0
    for (const seed of particles.seed) if (seed / 65535 > 1 - CLOUD_BEAD_FRACTION) candidates++
    const quota = Math.min(CLOUD_BEAD_LIMIT, candidates)
    let selection = 0
    // Spread the capped physics budget over the entire source, including spatially sorted artifacts.
    for (let i = 0; i < particles.count; i++) {
      if (particles.seed[i]! / 65535 <= 1 - CLOUD_BEAD_FRACTION) continue
      selection += quota
      if (selection < candidates) continue
      selection -= candidates
      indices.push(i)
    }
    this.indices = new Uint16Array(indices)
    this.count = indices.length
    this.x = new Float32Array(this.count)
    this.y = new Float32Array(this.count)
    this.vx = new Float32Array(this.count)
    this.vy = new Float32Array(this.count)
    this.radius = new Float32Array(this.count)
    this.homeX = new Float32Array(this.count)
    this.homeY = new Float32Array(this.count)
    this.explosionMotion = new Float32Array(this.count * 2)
    this.phases = Float64Array.from(this.indices, i => (particles.seed[i]! / 65535) * TAU)
    this.next = new Int32Array(this.count)
    this.cellX = new Int32Array(this.count)
    this.cellY = new Int32Array(this.count)
  }

  update(time: number, width: number, height: number, pointer: LogoPointerState, interactionTime = time, contentRect?: ParticleContentRect): void {
    this.brush.update(interactionTime, pointer)
    if (this.count === 0) return
    const aspect = this.particles.width / this.particles.height
    const fitX = Math.min(1, (aspect * height) / width)
    const fitY = Math.min(1, width / (height * aspect))
    const hasContentRect =
      contentRect !== undefined &&
      Number.isFinite(contentRect.left) &&
      Number.isFinite(contentRect.top) &&
      Number.isFinite(contentRect.width) &&
      Number.isFinite(contentRect.height) &&
      contentRect.width > 0 &&
      contentRect.height > 0
    const logicalLeft = hasContentRect ? contentRect.left : (width - fitX * width) * 0.5
    const logicalTop = hasContentRect ? contentRect.top : (height - fitY * height) * 0.5
    const logicalWidth = hasContentRect ? contentRect.width : fitX * width
    const logicalHeight = hasContentRect ? contentRect.height : fitY * height
    const longAxis = Math.max(logicalWidth, logicalHeight)
    const resized =
      width !== this.width ||
      height !== this.height ||
      logicalLeft !== this.logicalLeft ||
      logicalTop !== this.logicalTop ||
      logicalWidth !== this.logicalWidth ||
      logicalHeight !== this.logicalHeight
    if (resized) {
      const hadLayout = this.width > 0 && this.height > 0
      for (let b = 0; b < this.count; b++) {
        const i = this.indices[b]!
        const residualX = hadLayout ? this.x[b]! - this.homeX[b]! : 0
        const residualY = hadLayout ? this.y[b]! - this.homeY[b]! : 0
        this.homeX[b] = logicalLeft + logicalWidth * 0.5 - width * 0.5 + (this.particles.xy[i * 2]! / 32767) * logicalWidth * 0.5
        this.homeY[b] = height * 0.5 - (logicalTop + logicalHeight * 0.5) + (this.particles.xy[i * 2 + 1]! / 32767) * logicalHeight * 0.5
        this.x[b] = this.homeX[b]! + residualX
        this.y[b] = this.homeY[b]! + residualY
        if (!hadLayout) this.vx[b] = this.vy[b] = 0
        const seed = this.particles.seed[i]! / 65535
        const coverage = 0.65 + (0.35 * this.particles.size[i]!) / 255
        const depthScale = 1 + (0.18 * this.particles.depth[i]!) / 127
        this.radius[b] = Math.min(22, ((13 + (7 * (seed - (1 - CLOUD_BEAD_FRACTION))) / CLOUD_BEAD_FRACTION) * coverage * depthScale * longAxis) / 1024) / 2
      }
      this.width = width
      this.height = height
      this.logicalLeft = logicalLeft
      this.logicalTop = logicalTop
      this.logicalWidth = logicalWidth
      this.logicalHeight = logicalHeight
      this.accumulator = 0
    }
    const safeTime = Number.isFinite(time) ? time : this.lastTime < 0 ? 0 : this.lastTime
    let delta = 0
    if (!this.hasTime) {
      this.hasTime = true
      this.simulationTime = safeTime
      this.lastTime = safeTime
      delta = STEP
    } else if (safeTime < this.lastTime) {
      this.lastTime = safeTime
      this.accumulator = 0
    } else {
      delta = Math.min(1 / 30, Math.max(0, safeTime - this.lastTime))
      this.lastTime = safeTime
      this.simulationTime += delta
    }
    this.updateExplosionMotion(pointer, longAxis)
    this.accumulator += delta
    while (this.accumulator >= STEP) {
      this.step(this.simulationTime)
      this.accumulator -= STEP
    }
    for (let b = 0; b < this.count; b++) {
      const offset = this.indices[b]! * 2
      this.motion[offset] = this.x[b]! - this.homeX[b]!
      this.motion[offset + 1] = this.y[b]! - this.homeY[b]!
    }
  }

  private updateExplosionMotion(pointer: LogoPointerState, longAxis: number): void {
    this.explosionMotion.fill(0)
    for (let slot = 0; slot < pointer.explosions.length; slot += 1) {
      const explosion = pointer.explosions[slot]!
      const age = Number.isFinite(explosion.ageSeconds) ? explosion.ageSeconds : LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS
      if (!explosion.active || age < 0 || age >= LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS) continue
      for (let b = 0; b < this.count; b += 1) {
        const particleIndex = this.indices[b]!
        addExplosionDisplacement(
          this.explosionMotion,
          b * 2,
          this.homeX[b]!,
          this.homeY[b]!,
          explosion.x,
          explosion.y,
          this.width,
          this.height,
          longAxis,
          this.particles.depth[particleIndex]! / 127,
          this.particles.seed[particleIndex]! / 65535,
          explosion.scale,
          age
        )
      }
    }
  }

  private step(time: number): void {
    this.heads.fill(-1)
    for (let b = 0; b < this.count; b++) {
      const phase = this.phases[b]!
      const tx = this.homeX[b]! + Math.sin(time * 0.48 + phase) * 9
      const ty = this.homeY[b]! + Math.cos(time * 0.39 + phase * 1.7) * 9
      let ax = (tx - this.x[b]!) * 12
      let ay = (ty - this.y[b]!) * 12
      const explosionOffset = b * 2
      const actualX = this.x[b]! + this.explosionMotion[explosionOffset]!
      const actualY = this.y[b]! + this.explosionMotion[explosionOffset + 1]!
      const brush = this.brush
      if (brush.travel > 0.01) {
        const dx = actualX - (brush.x * this.width) / 2
        const dy = actualY - (brush.y * this.height) / 2
        if (dx * dx + dy * dy < brush.radius * brush.radius) {
          const d = Math.max(1, Math.hypot(dx, dy))
          const force = Math.max(0, 1 - d / brush.radius) ** 2 * brush.travel * 65
          ax += (dx / d + brush.directionX * 0.65) * force
          ay += (dy / d + brush.directionY * 0.65) * force
        }
      }
      this.vx[b] = (this.vx[b]! + ax * STEP) * DAMPING
      this.vy[b] = (this.vy[b]! + ay * STEP) * DAMPING
      this.x[b] += this.vx[b]! * STEP
      this.y[b] += this.vy[b]! * STEP
      const cx = Math.floor((this.x[b]! + this.explosionMotion[explosionOffset]!) / CELL)
      const cy = Math.floor((this.y[b]! + this.explosionMotion[explosionOffset + 1]!) / CELL)
      this.cellX[b] = cx
      this.cellY[b] = cy
      const bucket = ((cx * 73856093) ^ (cy * 19349663)) & (BUCKETS - 1)
      this.next[b] = this.heads[bucket]!
      this.heads[bucket] = b
    }
    // Spatial hashing, bounded candidates, one visit per pair. No all-pairs dust simulation.
    for (let b = 0; b < this.count; b++) {
      let remaining = 48
      for (let dx = -1; dx <= 1 && remaining > 0; dx++) {
        for (let dy = -1; dy <= 1 && remaining > 0; dy++) {
          const cx = this.cellX[b]! + dx
          const cy = this.cellY[b]! + dy
          const bucket = ((cx * 73856093) ^ (cy * 19349663)) & (BUCKETS - 1)
          for (let other = this.heads[bucket]!; other !== -1 && remaining > 0; other = this.next[other]!) {
            remaining--
            if (other <= b || this.cellX[other] !== cx || this.cellY[other] !== cy) continue
            let ox = this.x[other]! + this.explosionMotion[other * 2]! - (this.x[b]! + this.explosionMotion[b * 2]!)
            let oy = this.y[other]! + this.explosionMotion[other * 2 + 1]! - (this.y[b]! + this.explosionMotion[b * 2 + 1]!)
            const separation = this.radius[b]! + this.radius[other]!
            if (ox * ox + oy * oy >= separation * separation) continue
            let distance = Math.hypot(ox, oy)
            if (distance >= separation) continue
            if (distance < 0.001) {
              ox = 1
              oy = 0
              distance = 0.001
            }
            const nx = ox / Math.max(distance, 1)
            const ny = oy / Math.max(distance, 1)
            const correction = (separation - distance) * 0.48
            this.x[b] -= nx * correction
            this.y[b] -= ny * correction
            this.x[other] += nx * correction
            this.y[other] += ny * correction
            const relative = (this.vx[other]! - this.vx[b]!) * nx + (this.vy[other]! - this.vy[b]!) * ny
            if (relative >= 0) continue
            const bounce = -relative * 0.68
            this.vx[b] -= nx * bounce
            this.vy[b] -= ny * bounce
            this.vx[other] += nx * bounce
            this.vy[other] += ny * bounce
          }
        }
      }
    }
  }
}
