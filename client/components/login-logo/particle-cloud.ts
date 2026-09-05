import { ParticleBrush } from './particle-brush'
import type { ParsedLogoParticles } from './particle-logo'
import type { LogoPointerState } from './useLogoPointer'

/** Dust stays on the GPU; only this bounded population needs collision physics. */
export const CLOUD_BEAD_LIMIT = 512
export const CLOUD_BEAD_FRACTION = 0.065
export const CLOUD_DUST_FRACTION = 0.7
const STEP = 1 / 120
const BUCKETS = 4096
const CELL = 24
const TAU = Math.PI * 2

export class ParticleCloud {
  readonly brush = new ParticleBrush()
  /** CSS displacement and a bead flag. Original logo attributes remain immutable. */
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
  private readonly heads = new Int32Array(BUCKETS)
  private readonly next: Int32Array
  private readonly cellX: Int32Array
  private readonly cellY: Int32Array
  private readonly blastAges = new Float64Array(6).fill(Infinity)
  private lastTime = -1
  private width = 0
  private height = 0
  private accumulator = 0

  constructor(private readonly particles: ParsedLogoParticles) {
    this.motion = new Float32Array(particles.count * 3)
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
      this.motion[i * 3 + 2] = 1
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
    this.next = new Int32Array(this.count)
    this.cellX = new Int32Array(this.count)
    this.cellY = new Int32Array(this.count)
  }

  update(time: number, width: number, height: number, pointer: LogoPointerState, interactionTime = time): void {
    this.brush.update(interactionTime, pointer)
    if (this.count === 0) return
    const aspect = this.particles.width / this.particles.height
    const fitX = Math.min(1, (aspect * height) / width)
    const fitY = Math.min(1, width / (height * aspect))
    const longAxis = Math.max(width * fitX, height * fitY)
    if (width !== this.width || height !== this.height || time < this.lastTime) {
      for (let b = 0; b < this.count; b++) {
        const i = this.indices[b]!
        this.homeX[b] = ((this.particles.xy[i * 2]! / 32767) * fitX * width) / 2
        this.homeY[b] = ((this.particles.xy[i * 2 + 1]! / 32767) * fitY * height) / 2
        this.x[b] = this.homeX[b]!
        this.y[b] = this.homeY[b]!
        this.vx[b] = this.vy[b] = 0
        const seed = this.particles.seed[i]! / 65535
        const coverage = 0.65 + (0.35 * this.particles.size[i]!) / 255
        const depthScale = 1 + (0.18 * this.particles.depth[i]!) / 127
        this.radius[b] = Math.min(22, ((13 + (7 * (seed - (1 - CLOUD_BEAD_FRACTION))) / CLOUD_BEAD_FRACTION) * coverage * depthScale * longAxis) / 1024) / 2
      }
      this.width = width
      this.height = height
      this.accumulator = 0
      this.blastAges.fill(Infinity)
    }
    const delta = this.lastTime < 0 ? STEP : Math.min(1 / 30, Math.max(0, time - this.lastTime))
    this.lastTime = time
    this.accumulator += delta
    // Apply each explosion once, independent of the render rate or ring slot reuse.
    for (let slot = 0; slot < pointer.explosions.length; slot++) {
      const blast = pointer.explosions[slot]!
      if (!blast.active) {
        this.blastAges[slot] = Infinity
        continue
      }
      const newBurst = blast.ageSeconds < this.blastAges[slot]!
      this.blastAges[slot] = blast.ageSeconds
      if (!newBurst || blast.ageSeconds > 0.15) continue
      for (let b = 0; b < this.count; b++) {
        const dx = this.x[b]! - (blast.x * width) / 2
        const dy = this.y[b]! - (blast.y * height) / 2
        const d = Math.max(1, Math.hypot(dx, dy))
        const reach = Math.min(240, Math.max(100, longAxis * 0.3)) * blast.scale
        const force = Math.max(0, 1 - d / reach) ** 2 * 950 * blast.scale
        this.vx[b] += ((dx / d) * 0.94 - (dy / d) * 0.34) * force
        this.vy[b] += ((dy / d) * 0.94 + (dx / d) * 0.34) * force
      }
    }
    while (this.accumulator >= STEP) {
      this.step(time)
      this.accumulator -= STEP
    }
    for (let b = 0; b < this.count; b++) {
      const offset = this.indices[b]! * 3
      this.motion[offset] = this.x[b]! - this.homeX[b]!
      this.motion[offset + 1] = this.y[b]! - this.homeY[b]!
    }
  }

  private step(time: number): void {
    const damping = Math.exp(-3.8 * STEP)
    this.heads.fill(-1)
    for (let b = 0; b < this.count; b++) {
      const phase = (this.particles.seed[this.indices[b]!]! / 65535) * TAU
      const tx = this.homeX[b]! + Math.sin(time * 0.48 + phase) * 9
      const ty = this.homeY[b]! + Math.cos(time * 0.39 + phase * 1.7) * 9
      let ax = (tx - this.x[b]!) * 12
      let ay = (ty - this.y[b]!) * 12
      const brush = this.brush
      if (brush.travel > 0.01) {
        const dx = this.x[b]! - (brush.x * this.width) / 2
        const dy = this.y[b]! - (brush.y * this.height) / 2
        const d = Math.max(1, Math.hypot(dx, dy))
        const force = Math.max(0, 1 - d / brush.radius) ** 2 * brush.travel * 65
        ax += (dx / d + brush.directionX * 0.65) * force
        ay += (dy / d + brush.directionY * 0.65) * force
      }
      this.vx[b] = (this.vx[b]! + ax * STEP) * damping
      this.vy[b] = (this.vy[b]! + ay * STEP) * damping
      this.x[b] += this.vx[b]! * STEP
      this.y[b] += this.vy[b]! * STEP
      const cx = Math.floor(this.x[b]! / CELL)
      const cy = Math.floor(this.y[b]! / CELL)
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
            let ox = this.x[other]! - this.x[b]!
            let oy = this.y[other]! - this.y[b]!
            const separation = this.radius[b]! + this.radius[other]!
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
