import { describe, expect, it } from '../../../server/test/bun-test.mts'
import type { ParsedLogoParticles } from './particle-logo'
import { CLOUD_BEAD_LIMIT, ParticleCloud } from './particle-cloud'
import { LogoPointerController } from './useLogoPointer'

const particles = (count: number, allBeads = false): ParsedLogoParticles => {
  const buffer = new ArrayBuffer(count * 12)
  const xy = new Int16Array(buffer, 0, count * 2)
  const depth = new Int8Array(buffer, count * 4, count)
  const rgba = new Uint8Array(buffer, count * 5, count * 4).fill(255)
  const size = new Uint8Array(buffer, count * 9, count).fill(255)
  const seed = new Uint16Array(buffer, count * 10, count)
  for (let i = 0; i < count; i++) {
    xy[i * 2] = Math.round(Math.sin(i * 2.39996) * 12000)
    xy[i * 2 + 1] = Math.round(Math.cos(i * 2.39996) * 12000)
    seed[i] = allBeads ? 64000 : 1 + ((i * 40503) % 65535)
  }
  return { buffer, xy, depth, rgba, size, seed, count, width: 1024, height: 1024 }
}
const pointer = () => new LogoPointerController({ hasFinePointer: () => true }).state
const displacement = (cloud: ParticleCloud): number => {
  let sum = 0
  for (const i of cloud.indices) sum += Math.hypot(cloud.motion[i * 3]!, cloud.motion[i * 3 + 1]!)
  return sum / Math.max(1, cloud.count)
}

describe('particle cloud physics', () => {
  it('keeps the collision population bounded even for an adversarial 16,000-bead source', () => {
    const input = particles(16000, true)
    const before = new Uint8Array(input.buffer).slice()
    const cloud = new ParticleCloud(input)
    expect(cloud.count).toBe(CLOUD_BEAD_LIMIT)
    expect(cloud.indices[0]).toBeLessThan(40)
    expect(cloud.indices.at(-1)).toBeGreaterThan(15960)
    for (let i = 0; i < 60; i++) cloud.update(i / 60, 800, 600, pointer())
    expect(new Uint8Array(input.buffer)).toEqual(before)
    expect(cloud.motion.every(Number.isFinite)).toBe(true)
    expect(cloud.motion.filter((_, i) => i % 3 === 2 && cloud.motion[i] === 1).length).toBe(CLOUD_BEAD_LIMIT)
  })

  it('separates overlapping beads and exchanges approaching velocities', () => {
    const cloud = new ParticleCloud(particles(2, true))
    const state = pointer()
    cloud.update(0, 800, 800, state)
    cloud.x.set([-4, 4])
    cloud.y.fill(0)
    cloud.radius.fill(6)
    cloud.vx.set([50, -50])
    cloud.vy.fill(0)
    cloud.update(1 / 120, 800, 800, state)
    expect(cloud.x[1]! - cloud.x[0]!).toBeGreaterThan(11)
    expect(cloud.vx[0]).toBeLessThan(0)
    expect(cloud.vx[1]).toBeGreaterThan(0)
  })

  it('scatters existing beads on a click and gently restores the cloud', () => {
    const cloud = new ParticleCloud(particles(80, true))
    const resting = new ParticleCloud(particles(80, true))
    const idle = pointer()
    const state = pointer()
    cloud.update(0, 800, 800, state)
    resting.update(0, 800, 800, idle)
    const blast = state.explosions[0]
    blast.active = true
    blast.x = 0
    blast.y = 0
    let peak = 0
    let difference = 0
    for (let i = 1; i <= 600; i++) {
      blast.ageSeconds = (i - 1) / 120
      blast.active = blast.ageSeconds < 2.8
      cloud.update(i / 120, 800, 800, state)
      resting.update(i / 120, 800, 800, idle)
      difference = 0
      for (let b = 0; b < cloud.count; b++) difference += Math.hypot(cloud.x[b]! - resting.x[b]!, cloud.y[b]! - resting.y[b]!)
      difference /= cloud.count
      peak = Math.max(peak, difference)
    }
    expect(peak).toBeGreaterThan(20)
    expect(difference).toBeLessThan(peak * 0.15)
  })

  it('has consistent motion at 60 and 120 Hz, and bounds work after suspension or resize', () => {
    const a = new ParticleCloud(particles(100))
    const b = new ParticleCloud(particles(100))
    const state = pointer()
    for (let i = 0; i <= 120; i++) a.update(i / 60, 800, 600, state)
    for (let i = 0; i <= 240; i++) b.update(i / 120, 800, 600, state)
    for (const index of a.indices) {
      expect(Math.abs(a.motion[index * 3]! - b.motion[index * 3]!)).toBeLessThan(0.5)
      expect(Math.abs(a.motion[index * 3 + 1]! - b.motion[index * 3 + 1]!)).toBeLessThan(0.5)
    }
    a.update(3600, 800, 600, state)
    expect(displacement(a)).toBeLessThan(20)
    a.update(3601, 320, 900, state)
    expect(a.motion.every(Number.isFinite)).toBe(true)
    expect(displacement(a)).toBeLessThan(2)
  })
})

// Brush state is bounded independently of event rate and particle count.
describe('continuous particle brush', () => {
  it('preserves continuity when a saturated pointer ring is replaced or reversed', () => {
    const cloud = new ParticleCloud(particles(0))
    const state = pointer()
    const impulse = state.impulses[0]
    Object.assign(impulse, { active: true, x: -0.3, y: 0, travelCss: 20, strength: 3, radiusCss: 60 })
    for (let i = 0; i <= 30; i++) cloud.update(i / 60, 800, 800, state)
    const before = { ...cloud.brush }
    Object.assign(impulse, { x: 0.3, directionX: -1 })
    cloud.update(0.5, 800, 800, state)
    expect(cloud.brush.x).toBe(before.x)
    expect(cloud.brush.travel).toBe(before.travel)
    expect(cloud.brush.directionX).toBe(before.directionX)
    cloud.update(0.5 + 1 / 120, 800, 800, state)
    expect(cloud.brush.x).toBeGreaterThan(before.x)
    expect(cloud.brush.x).toBeLessThan(-0.2)
    expect(cloud.brush.directionX).toBeGreaterThan(0.7)
    expect(cloud.brush.travel).toBeLessThanOrEqual(32)
    impulse.active = false
    cloud.update(0.52, 800, 800, state)
    expect(cloud.brush.travel).toBeGreaterThan(20)
    for (let i = 1; i <= 120; i++) cloud.update(0.52 + i / 60, 800, 800, state)
    expect(cloud.brush.travel).toBeLessThan(0.001)
  })

  it('smooths consistently at 60 and 120 Hz and resets after suspension', () => {
    const a = new ParticleCloud(particles(0))
    const b = new ParticleCloud(particles(0))
    const state = pointer()
    Object.assign(state.impulses[0], { active: true, x: 0.4, y: -0.2, travelCss: 10, strength: 2 })
    for (let i = 0; i <= 60; i++) a.update(i / 60, 800, 800, state)
    for (let i = 0; i <= 120; i++) b.update(i / 120, 800, 800, state)
    expect(a.brush.travel).toBeCloseTo(b.brush.travel, 8)
    expect(a.brush.directionX).toBeCloseTo(b.brush.directionX, 8)
    a.update(30, 800, 800, state)
    expect(a.brush.travel).toBe(0)
  })

  it('pushes a scattered bead only when the brush reaches its current position', () => {
    const state = pointer()
    Object.assign(state.impulses[0], { active: true, x: 0, y: 0, radiusCss: 50, travelCss: 20, strength: 2 })
    const near = new ParticleCloud(particles(1, true))
    const far = new ParticleCloud(particles(1, true))
    const idle = new ParticleCloud(particles(1, true))
    const idleState = pointer()
    for (const cloud of [near, far, idle]) {
      cloud.update(0, 800, 800, idleState)
      // All three beads have the same home and blast displacement.
      cloud.x[0] = 200
      cloud.y[0] = 0
      cloud.vx[0] = cloud.vy[0] = 0
    }
    const farState = pointer()
    Object.assign(farState.impulses[0], state.impulses[0])
    state.impulses[0].x = 0.48 // 192px: next to the displaced bead.
    for (let i = 1; i <= 6; i++) {
      near.update(i / 120, 800, 800, state)
      far.update(i / 120, 800, 800, farState)
      idle.update(i / 120, 800, 800, idleState)
    }
    expect(far.x[0]).toBe(idle.x[0])
    expect(far.y[0]).toBe(idle.y[0])
    expect(near.vx[0]!).toBeGreaterThan(idle.vx[0]!)
  })

  it('gives larger blasts more reach while retaining recovery and the same bead budget', () => {
    const small = new ParticleCloud(particles(1, true))
    const large = new ParticleCloud(particles(1, true))
    const smallState = pointer()
    const largeState = pointer()
    for (const cloud of [small, large]) cloud.update(0, 800, 800, pointer())
    Object.assign(smallState.explosions[0], { active: true, x: 0, y: 0, scale: 0.9 })
    Object.assign(largeState.explosions[0], { active: true, x: 0, y: 0, scale: 1.45 })
    small.update(1 / 120, 800, 800, smallState)
    large.update(1 / 120, 800, 800, largeState)
    expect(Math.hypot(large.vx[0]!, large.vy[0]!)).toBeGreaterThan(Math.hypot(small.vx[0]!, small.vy[0]!) * 2)
    expect(large.count).toBe(small.count)
  })
})
