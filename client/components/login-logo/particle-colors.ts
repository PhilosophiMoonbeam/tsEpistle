import type { ParsedLogoParticles } from './particle-logo'

const toLinear = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)

const smoothstep = (low: number, high: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)))
  return t * t * (3 - 2 * t)
}

/**
 * Cache source-linear RGB and the unchanged source/seed alpha. The parsed cloud
 * already excludes the source background; never turn transparent records visible.
 */
export const updateParticleColors = (
  particles: Pick<ParsedLogoParticles, 'count' | 'rgba' | 'seed'>,
  target: Float32Array,
  isDark = false
): void => {
  for (let i = 0; i < particles.count; i++) {
    const offset = i * 4
    const sourceR = particles.rgba[offset]! / 255
    const sourceG = particles.rgba[offset + 1]! / 255
    const sourceB = particles.rgba[offset + 2]! / 255
    const sourceAlpha = particles.rgba[offset + 3]! / 255
    const seedOpacity = 0.66 + (0.94 - 0.66) * smoothstep(0, 0.94, particles.seed[i]! / 65535)

    let red = toLinear(sourceR)
    let green = toLinear(sourceG)
    let blue = toLinear(sourceB)

    if (isDark && sourceAlpha > 0 && 0.2126 * red + 0.7152 * green + 0.0722 * blue < 0.28) {
      // Silver-slate starts above L=.72 in linear space. Compensate for the
      // material's .55 minimum bead shading and straight sRGB alpha compositing:
      // a fully covered core should display at least sRGB .5 over #111317.
      // Source transparency, coverage and lifecycle fades stay untouched; very
      // faint records/antialiased fringes cannot meet that floor even at white.
      const opacity = sourceAlpha * seedOpacity
      const requiredSrgb = Math.min(1, (0.5 - (1 - opacity) * (17 / 255)) / opacity)
      const requiredLinear = Math.min(1, toLinear(requiredSrgb) / 0.55)
      const lift = Math.max(0, (requiredLinear - 0.72) / (1 - 0.72))
      red = Math.max(red, 0.72 + (1 - 0.72) * lift)
      green = Math.max(green, 0.76 + (1 - 0.76) * lift)
      blue = Math.max(blue, 0.82 + (1 - 0.82) * lift)
    }

    target[offset] = red
    target[offset + 1] = green
    target[offset + 2] = blue
    target[offset + 3] = sourceAlpha * seedOpacity
  }
}
