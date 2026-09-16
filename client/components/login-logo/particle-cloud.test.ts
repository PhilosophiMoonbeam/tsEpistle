import { describe, expect, it } from '../../../server/test/bun-test.mts'
import type { ParsedLogoParticles } from './particle-logo'
import { CLOUD_BEAD_LIMIT, ParticleCloud } from './particle-cloud'
import { LOGO_POINTER_MAX_TRAVEL_CSS, LogoPointerController } from './useLogoPointer'

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
  for (const i of cloud.indices) sum += Math.hypot(cloud.motion[i * 2]!, cloud.motion[i * 2 + 1]!)
  return sum / Math.max(1, cloud.count)
}

describe('particle cloud physics', () => {
  it('keeps the collision population finite and bounded for an adversarial 16,000-bead source', () => {
    const input = particles(16000, true)
    const before = new Uint8Array(input.buffer).slice()
    const cloud = new ParticleCloud(input)
    const state = pointer()
    expect(cloud.count).toBe(CLOUD_BEAD_LIMIT)
    expect(cloud.motion.length).toBe(input.count * 2)
    for (let slot = 0; slot < cloud.count; slot++) {
      expect(cloud.indices[slot]).toBe(Math.floor(((slot + 1) * input.count - 1) / CLOUD_BEAD_LIMIT))
    }
    expect(cloud.indices[0]).toBeLessThan(40)
    expect(cloud.indices.at(-1)).toBeGreaterThan(15960)
    for (let frame = 0; frame <= 180; frame++) cloud.update(frame / 60, 800, 600, state)
    cloud.update(3, 320, 900, state)
    cloud.update(2, 320, 900, state)
    expect(new Uint8Array(input.buffer)).toEqual(before)
    expect(cloud.motion.every(Number.isFinite)).toBe(true)
    for (const values of [cloud.x, cloud.y, cloud.vx, cloud.vy, cloud.motion]) {
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true)
        expect(Math.abs(value)).toBeLessThan(10_000)
      }
    }
    let selected = 0
    for (let i = 0; i < input.count; i++) {
      if (selected < cloud.count && cloud.indices[selected] === i) {
        selected++
        continue
      }
      expect(cloud.motion[i * 2]).toBe(0)
      expect(cloud.motion[i * 2 + 1]).toBe(0)
    }
    expect(selected).toBe(cloud.count)
  })

  it('exposes no selected indices and zero motion for a source without beads', () => {
    const input = particles(4)
    input.seed.fill(0)
    const before = new Uint8Array(input.buffer).slice()
    const cloud = new ParticleCloud(input)
    expect(cloud.count).toBe(0)
    expect(Array.from(cloud.indices)).toEqual([])
    expect(cloud.motion.length).toBe(input.count * 2)
    cloud.update(0, 800, 600, pointer())
    expect(cloud.motion.every(value => value === 0)).toBe(true)
    expect(new Uint8Array(input.buffer)).toEqual(before)
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

  it('keeps fixed-step motion stable and preserves residual displacement and velocity across resize rollback', () => {
    const a = new ParticleCloud(particles(100))
    const b = new ParticleCloud(particles(100))
    const stateA = pointer()
    const stateB = pointer()
    for (let i = 0; i <= 120; i++) a.update(i / 60, 800, 600, stateA)
    for (let i = 0; i <= 240; i++) b.update(i / 120, 800, 600, stateB)
    for (const index of a.indices) {
      expect(Math.abs(a.motion[index * 2]! - b.motion[index * 2]!)).toBeLessThan(0.5)
      expect(Math.abs(a.motion[index * 2 + 1]! - b.motion[index * 2 + 1]!)).toBeLessThan(0.5)
    }
    a.update(3600, 800, 600, stateA)
    expect(displacement(a)).toBeLessThan(20)

    const cloud = new ParticleCloud(particles(1, true))
    const state = pointer()
    cloud.update(0, 800, 600, state)
    cloud.x[0] += 26
    cloud.y[0] -= 14
    cloud.vx[0] = 37
    cloud.vy[0] = -19
    cloud.update(0, 800, 600, state)
    const beforeMotion = [cloud.motion[0]!, cloud.motion[1]!]
    const beforeVelocity = [cloud.vx[0]!, cloud.vy[0]!]

    cloud.update(-1, 320, 900, state)
    expect(cloud.motion[0]).toBeCloseTo(beforeMotion[0]!, 6)
    expect(cloud.motion[1]).toBeCloseTo(beforeMotion[1]!, 6)
    expect(cloud.vx[0]).toBeCloseTo(beforeVelocity[0]!, 6)
    expect(cloud.vy[0]).toBeCloseTo(beforeVelocity[1]!, 6)
    expect(cloud.motion.every(Number.isFinite)).toBe(true)
  })
})

// Brush state is bounded independently of event rate and particle count.
describe('continuous particle brush', () => {
  it('makes ordinary strokes stronger with a modestly wider, bounded reach', () => {
    const cloud = new ParticleCloud(particles(0))
    const state = pointer()
    Object.assign(state.impulses[0], { active: true, travelCss: 10, strength: 2, radiusCss: 40 })
    for (let i = 0; i <= 120; i++) cloud.update(i / 120, 800, 800, state)
    expect(cloud.brush.travel).toBeCloseTo(26.25, 4)
    expect(cloud.brush.radius).toBeCloseTo(44.8, 4)
    Object.assign(state.impulses[0], { travelCss: 20, strength: 3.2, radiusCss: 72 })
    for (let i = 121; i <= 240; i++) cloud.update(i / 120, 800, 800, state)
    expect(cloud.brush.travel).toBeCloseTo(LOGO_POINTER_MAX_TRAVEL_CSS, 4)
    expect(cloud.brush.radius).toBeLessThanOrEqual(72)
  })

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
    expect(cloud.brush.travel).toBeLessThanOrEqual(LOGO_POINTER_MAX_TRAVEL_CSS)
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
})
