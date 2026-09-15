import type { ParsedLogoParticles } from './particle-logo'

const toLinear = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)

const smoothstep = (low: number, high: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)))
  return t * t * (3 - 2 * t)
}

/** Cache source-linear RGB and source-alpha weighted by the existing seed opacity. */
export const updateParticleColors = (particles: Pick<ParsedLogoParticles, 'count' | 'rgba' | 'seed'>, target: Float32Array): void => {
  for (let i = 0; i < particles.count; i++) {
    const offset = i * 4
    const sourceR = particles.rgba[offset]! / 255
    const sourceG = particles.rgba[offset + 1]! / 255
    const sourceB = particles.rgba[offset + 2]! / 255
    const sourceAlpha = particles.rgba[offset + 3]! / 255
    const seedOpacity = 0.66 + (0.94 - 0.66) * smoothstep(0, 0.94, particles.seed[i]! / 65535)

    target[offset] = toLinear(sourceR)
    target[offset + 1] = toLinear(sourceG)
    target[offset + 2] = toLinear(sourceB)
    target[offset + 3] = sourceAlpha * seedOpacity
  }
}
