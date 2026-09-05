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
