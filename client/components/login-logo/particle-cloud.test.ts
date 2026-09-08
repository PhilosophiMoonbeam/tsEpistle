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
  for (const i of cloud.indices) sum += Math.hypot(cloud.motion[i * 3]!, cloud.motion[i * 3 + 1]!)
  return sum / Math.max(1, cloud.count)
}


// Captured from the original fixed-step solver before distance-rejection optimization.
const referenceTrajectories: Record<string, number[][]> = {
  idle: [
    [-134.28956604003906, -0.017798496410250664, -0.6441818475723267, -1.415669560432434, -0.005161880515515804, -0.014321348629891872, -0.4095847010612488, -1.1388217210769653, 305.18511962890625, -0.0066418834030628204, 0.003487776732072234, -0.5275797247886658],
    [-135.12811279296875, -2.0352234840393066, -4.678971290588379, -12.088680267333984, -0.4963565170764923, -1.6109894514083862, -2.5412933826446533, -9.453681945800781, 305.3002014160156, -0.6922400593757629, 1.1669633388519287, -3.8208987712860107],
    [-135.408935546875, -6.830176830291748, 4.250614643096924, 1.723682165145874, 0.3094146251678467, -4.849695682525635, 4.467632293701172, 2.5050013065338135, 307.89288330078125, -0.917144238948822, 4.6233415603637695, 3.4666876792907715]
  ],
  brush: [
    [-134.30563354492188, -0.017501384019851685, -2.573453426361084, -1.3800160884857178, -0.005161880515515804, -0.014321348629891872, -0.4095847010612488, -1.1388217210769653, 305.18511962890625, -0.0066418834030628204, 0.003487776732072234, -0.5275797247886658],
    [-144.0260772705078, -0.6028903126716614, -35.63218307495117, -5.671970367431641, -0.4963565170764923, -1.6109894514083862, -2.5412933826446533, -9.453681945800781, 305.3002014160156, -0.6922400593757629, 1.1669633388519287, -3.8208987712860107],
    [-137.54493713378906, -6.386990547180176, 19.742185592651367, -1.1450473070144653, 57.03327560424805, 0.9357753396034241, -41.17171096801758, -0.7199316620826721, 307.89288330078125, -0.917144238948822, 4.6233415603637695, 3.4666876792907715]
  ],
  blast: [
    [-136.2041778564453, -0.7104151248931885, -230.3978271484375, -84.5296630859375, -0.005171570461243391, -0.05732428655028343, -0.4107474684715271, -6.2991743087768555, 305.18511962890625, -0.0066418834030628204, 0.003487776732072234, -0.5275797247886658],
    [-168.39947509765625, -14.071222305297852, -53.38069152832031, -29.706645965576172, -0.49652495980262756, -2.358276605606079, -2.5415396690368652, -10.547541618347168, 305.3002014160156, -0.6922400593757629, 1.1669633388519287, -3.8208987712860107],
    [-138.75137329101562, -8.039316177368164, 44.64629364013672, 16.336925506591797, 0.3093976676464081, -4.924767971038818, 4.467836856842041, 3.412303924560547, 307.89288330078125, -0.917144238948822, 4.6233415603637695, 3.4666876792907715]
  ],
  collisions: [
    [-13.92751407623291, -0.006419627461582422, 4.5008625984191895, -0.7235873341560364, -4.497282981872559, -0.006039857864379883, -27.11482810974121, -0.5873715877532959, 12.451387405395508, 0.00022803731553722173, 7.640025615692139, -0.25668296217918396],
    [-52.38167190551758, -1.9168097972869873, -193.82626342773438, -11.980746269226074, 0.33396100997924805, -6.24326229095459, -1.7536005973815918, -0.4044326841831207, 49.6522102355957, 3.740593671798706, 299.59613037109375, 42.685791015625],
    [-148.59152221679688, -6.822813987731934, -15.079812049865723, 1.5970162153244019, 0.3631972372531891, -4.2183685302734375, 3.571363925933838, 3.9897162914276123, 328.8106689453125, 2.3007454872131348, 139.12954711914062, -12.398768424987793]
  ],
}

const trajectory = (scenario: string): number[][] => {
  const input = particles(6, true)
  input.seed.set([61500, 62000, 63000, 64000, 65000, 65535])
  input.xy.set([-11000, 0, -3700, 0, 0, 0, 1700, 0, 4300, 0, 25000, 0])
  if (scenario === 'collisions') {
    input.seed[3] = input.seed[2]!
    input.xy[6] = input.xy[4]!
    input.xy[7] = input.xy[5]!
  }
  const cloud = new ParticleCloud(input)
  const state = pointer()
  cloud.update(0, 800, 800, state)
  if (scenario === 'collisions') {
    cloud.x.set([-10, -5, 0, 0, 5, 10])
    cloud.y.fill(0)
    cloud.vx.set([60, 40, 0, 0, -40, -60])
    cloud.vy.fill(0)
    cloud.radius.fill(6)
  }
  const result: number[][] = []
  for (let frame = 1; frame <= 120; frame++) {
    if (scenario === 'brush') Object.assign(state.impulses[0], {
      active: frame < 75, ageSeconds: 0, x: (frame - 60) / 180, y: 0,
      directionX: 1, directionY: 0.25, travelCss: 14, strength: 2, radiusCss: 55
    })
    if (scenario === 'blast') Object.assign(state.explosions[0], {
      active: true, ageSeconds: (frame - 1) / 120, x: 0, y: 0, scale: 1.1
    })
    cloud.update(frame / 120, 800, 800, state)
    if ([1, 30, 120].includes(frame)) {
      result.push([0, 2, 5].flatMap(b => [cloud.x[b]!, cloud.y[b]!, cloud.vx[b]!, cloud.vy[b]!]))
    }
  }
  return result
}

describe('particle cloud physics', () => {
  it('preserves reference idle, moving-brush, blast and crowded-collision trajectories', () => {
    for (const [scenario, expected] of Object.entries(referenceTrajectories)) {
      const actual = trajectory(scenario)
      expect(actual).toHaveLength(expected.length)
      for (let frame = 0; frame < expected.length; frame++) {
        for (let value = 0; value < expected[frame]!.length; value++) {
          expect(actual[frame]![value]!).toBeCloseTo(expected[frame]![value]!, 7)
        }
      }
    }
  })

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
