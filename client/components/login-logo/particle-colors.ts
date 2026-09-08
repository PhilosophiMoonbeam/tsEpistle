import type { ParsedLogoParticles } from './particle-logo'

interface LinearBackground {
  readonly r: number
  readonly g: number
  readonly b: number
}

const toLinear = (value: number): number => value < 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
const toSrgb = (value: number): number => value < 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
const luminance = (r: number, g: number, b: number): number => r * 0.2126 + g * 0.7152 + b * 0.0722
const smoothstep = (low: number, high: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)))
  return t * t * (3 - 2 * t)
}

/** Cache the shader's theme-dependent linear RGB and core alpha, without changing source views. */
export const updateParticleColors = (
  particles: Pick<ParsedLogoParticles, 'count' | 'rgba' | 'seed'>,
  background: LinearBackground,
  target: Float32Array
): void => {
  const backgroundLuminance = luminance(background.r, background.g, background.b)
  const bright = backgroundLuminance > 0.35
  const backgroundR = toSrgb(background.r)
  const backgroundG = toSrgb(background.g)
  const backgroundB = toSrgb(background.b)
  const targetLuminance = (backgroundLuminance + 0.05) / 3 - 0.05
  const paleTint = 1.05 / (backgroundLuminance + 0.05) > (backgroundLuminance + 0.05) / 0.05
  for (let i = 0; i < particles.count; i++) {
    const offset = i * 4
    const r = particles.rgba[offset]! / 255
    const g = particles.rgba[offset + 1]! / 255
    const b = particles.rgba[offset + 2]! / 255
    const alpha = particles.rgba[offset + 3]! / 255
    const opacity = 0.66 + (0.94 - 0.66) * smoothstep(0, 0.94, particles.seed[i]! / 65535)
    const coreAlpha = alpha * opacity
    let linearR = toLinear(r)
    let linearG = toLinear(g)
    let linearB = toLinear(b)
    if (bright) {
      // NormalBlending runs after sRGB output conversion. Keep the original
      // seven-step hue-preserving solve, but only run it when the surface changes.
      const baseR = backgroundR * (1 - coreAlpha)
      const baseG = backgroundG * (1 - coreAlpha)
      const baseB = backgroundB * (1 - coreAlpha)
      const sourceR = r * coreAlpha
      const sourceG = g * coreAlpha
      const sourceB = b * coreAlpha
      if (luminance(toLinear(baseR + sourceR), toLinear(baseG + sourceG), toLinear(baseB + sourceB)) > targetLuminance) {
        let lower = 0
        let upper = 1
        for (let iteration = 0; iteration < 7; iteration++) {
          const scale = (lower + upper) * 0.5
          const candidate = luminance(
            toLinear(baseR + sourceR * scale),
            toLinear(baseG + sourceG * scale),
            toLinear(baseB + sourceB * scale)
          )
          if (candidate > targetLuminance) upper = scale
          else lower = scale
        }
        linearR = toLinear(r * lower)
        linearG = toLinear(g * lower)
        linearB = toLinear(b * lower)
      }
    } else {
      // Dark surfaces retain the previous luminous tint and source-alpha weighting.
      const compositedLuminance = luminance(
        background.r * (1 - alpha) + linearR * alpha,
        background.g * (1 - alpha) + linearG * alpha,
        background.b * (1 - alpha) + linearB * alpha
      )
      const contrast = (Math.max(compositedLuminance, backgroundLuminance) + 0.05) /
        (Math.min(compositedLuminance, backgroundLuminance) + 0.05)
      const tint = (1 - smoothstep(1, 3, contrast)) * 0.52
      linearR += ((paleTint ? 0.68 : 0.08) - linearR) * tint
      linearG += ((paleTint ? 0.76 : 0.12) - linearG) * tint
      linearB += ((paleTint ? 0.82 : 0.16) - linearB) * tint
    }
    target[offset] = linearR
    target[offset + 1] = linearG
    target[offset + 2] = linearB
    target[offset + 3] = coreAlpha
  }
}
