import { nextTick, watch } from 'vue'
import type { ThemeDefinition, ThemeInstance } from 'vuetify'
import { THEME_COLOR_KEYS, type ThemeColors, type ThemeModeColors } from '../../shared/theme-colors.ts'

export type WikiThemeName = 'light' | 'dark' | 'system'

export const installThemeSwitchGuard = (theme: Pick<ThemeInstance, 'name'>): (() => void) => {
  if (typeof document === 'undefined') return () => {}

  const root = document.documentElement
  let disposed = false
  let sequence = 0
  let firstFrame: number | null = null
  let secondFrame: number | null = null

  const cancelPendingCleanup = (): void => {
    if (firstFrame !== null) {
      window.cancelAnimationFrame(firstFrame)
      firstFrame = null
    }
    if (secondFrame !== null) {
      window.cancelAnimationFrame(secondFrame)
      secondFrame = null
    }
  }

  const scheduleCleanup = (): void => {
    const currentSequence = ++sequence
    cancelPendingCleanup()

    void nextTick().then(() => {
      if (disposed || currentSequence !== sequence) return
      firstFrame = window.requestAnimationFrame(() => {
        firstFrame = null
        if (disposed || currentSequence !== sequence) return
        secondFrame = window.requestAnimationFrame(() => {
          secondFrame = null
          if (disposed || currentSequence !== sequence) return
          root.classList.remove('wiki-theme-switching')
        })
      })
    })
  }

  const stop = watch(
    () => theme.name.value,
    () => {
      if (disposed) return
      root.classList.add('wiki-theme-switching')
      scheduleCleanup()
    },
    { flush: 'sync' }
  )

  return () => {
    if (disposed) return
    disposed = true
    sequence++
    cancelPendingCleanup()
    root.classList.remove('wiki-theme-switching')
    stop()
  }
}

export const resolveThemeName = (appearance: string | null | undefined, _siteDarkMode: boolean): WikiThemeName => {
  if (appearance === 'dark' || appearance === 'light' || appearance === 'system') return appearance
  return 'system'
}

export const WIKI_THEME_VARIATIONS = {
  colors: ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error'],
  lighten: 1,
  darken: 1
}

const relativeLuminance = (hex: string): number => {
  const channels = [1, 3, 5]
    .map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

export const contrastRatio = (foreground: string, background: string): number => {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

export const contrastForeground = (background: string): '#000000' | '#FFFFFF' => {
  const luminance = relativeLuminance(background)
  const blackContrast = (luminance + 0.05) / 0.05
  const whiteContrast = 1.05 / (luminance + 0.05)
  return blackContrast >= whiteContrast ? '#000000' : '#FFFFFF'
}

const mixHex = (base: string, mix: string, amount: number): string => {
  const channels = [1, 3, 5].map(index => {
    const baseChannel = Number.parseInt(base.slice(index, index + 2), 16)
    const mixChannel = Number.parseInt(mix.slice(index, index + 2), 16)
    return Math.round(baseChannel + (mixChannel - baseChannel) * amount)
      .toString(16)
      .padStart(2, '0')
  })
  return `#${channels.join('')}`.toUpperCase()
}

type ColorChannels = readonly [number, number, number]

const hexChannels = (hex: string): ColorChannels => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255
]

const channelsHex = (channels: ColorChannels): string =>
  `#${channels
    .map(channel =>
      Math.round(Math.max(0, Math.min(1, channel)) * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`.toUpperCase()

// CSS Color 4's OKLab transforms. These only sample the shared material backing;
// foreground selection remains in the existing ink/purpose solvers below.
const rgbToOklab = (rgb: ColorChannels): ColorChannels => {
  const [r, g, b] = rgb.map(channel => {
    const absolute = Math.abs(channel)
    return absolute <= 0.04045 ? channel / 12.92 : Math.sign(channel) * ((absolute + 0.055) / 1.055) ** 2.4
  })
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

const oklabToRgb = ([lightness, a, b]: ColorChannels): ColorChannels => {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const encode = (channel: number): number => {
    const absolute = Math.abs(channel)
    return absolute <= 0.0031308 ? channel * 12.92 : Math.sign(channel) * (1.055 * absolute ** (1 / 2.4) - 0.055)
  }
  return [
    encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  ]
}

const interpolateChannels = (base: ColorChannels, mix: ColorChannels, amount: number): ColorChannels => [
  base[0] + (mix[0] - base[0]) * amount,
  base[1] + (mix[1] - base[1]) * amount,
  base[2] + (mix[2] - base[2]) * amount
]

const mixOklch = (base: ColorChannels, mix: ColorChannels, amount: number): ColorChannels => {
  const first = rgbToOklab(base)
  const second = rgbToOklab(mix)
  const firstChroma = Math.hypot(first[1], first[2])
  const secondChroma = Math.hypot(second[1], second[2])
  // Achromatic colors have a powerless hue, inherited from the other endpoint.
  const firstHue = firstChroma < 0.000004 ? Math.atan2(second[2], second[1]) : Math.atan2(first[2], first[1])
  const secondHue = secondChroma < 0.000004 ? firstHue : Math.atan2(second[2], second[1])
  const hueDelta = ((secondHue - firstHue + 3 * Math.PI) % (2 * Math.PI)) - Math.PI
  const hue = firstHue + hueDelta * amount
  const chroma = firstChroma + (secondChroma - firstChroma) * amount
  return [first[0] + (second[0] - first[0]) * amount, chroma * Math.cos(hue), chroma * Math.sin(hue)]
}

// CSS Color 4 local-MINDE mapping for saturated custom palettes on sRGB displays.
// Do not simply clip out-of-gamut OKLCH stops before measuring their contrast.
const gamutMapOklab = (lab: ColorChannels): ColorChannels => {
  if (lab[0] >= 1) return [1, 1, 1]
  if (lab[0] <= 0) return [0, 0, 0]
  const inGamut = (rgb: ColorChannels): boolean => rgb.every(channel => channel >= -0.000001 && channel <= 1.000001)
  const clip = (rgb: ColorChannels): ColorChannels => [Math.max(0, Math.min(1, rgb[0])), Math.max(0, Math.min(1, rgb[1])), Math.max(0, Math.min(1, rgb[2]))]
  const original = oklabToRgb(lab)
  if (inGamut(original)) return clip(original)
  let clipped = clip(original)
  const difference = (candidate: ColorChannels): number => {
    const mapped = rgbToOklab(clipped)
    return Math.hypot(candidate[0] - mapped[0], candidate[1] - mapped[1], candidate[2] - mapped[2])
  }
  if (difference(lab) < 0.02) return clipped
  const chroma = Math.hypot(lab[1], lab[2])
  let minimum = 0
  let maximum = chroma
  let minimumInGamut = true
  while (maximum - minimum > 0.0001) {
    const current = (minimum + maximum) / 2
    const candidate: ColorChannels = [lab[0], (lab[1] * current) / chroma, (lab[2] * current) / chroma]
    const rgb = oklabToRgb(candidate)
    if (minimumInGamut && inGamut(rgb)) {
      minimum = current
      continue
    }
    clipped = clip(rgb)
    const delta = difference(candidate)
    if (delta < 0.02) {
      if (0.02 - delta < 0.0001) return clipped
      minimumInGamut = false
      minimum = current
    } else {
      maximum = current
    }
  }
  return clipped
}

const sampleMineralGradient = (colors: ThemeModeColors, materialTop: string, materialBottom: string, dark: boolean): string[] => {
  // Keep both endpoints and percentages synchronized with base.scss.
  const stops = [
    mixOklch(hexChannels(materialTop), hexChannels(colors.primary), dark ? 0.05 : 0.04),
    mixOklch(hexChannels(materialBottom), hexChannels(colors.secondary), dark ? 0.04 : 0.03)
  ]
  const startRgb = oklabToRgb(stops[0])
  const endRgb = oklabToRgb(stops[1])
  const samples = new Set<string>()
  // Include interior extrema in modern OKLab and legacy sRGB interpolation.
  for (let step = 0; step <= 32; step++) {
    const amount = step / 32
    samples.add(channelsHex(gamutMapOklab(interpolateChannels(stops[0], stops[1], amount))))
    samples.add(channelsHex(gamutMapOklab(rgbToOklab(interpolateChannels(startRgb, endRgb, amount)))))
  }
  return [...samples]
}

export const WIKI_PURPOSE_KEYS = ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral'] as const
export type WikiPurposeKey = (typeof WIKI_PURPOSE_KEYS)[number]

const chooseReadableColor = (candidates: readonly string[], surfaces: readonly string[], minimumContrast: number): string => {
  const score = (candidate: string): number => Math.min(...surfaces.map(surface => contrastRatio(candidate, surface)))
  const readable = candidates.find(candidate => score(candidate) >= minimumContrast)
  if (readable) return readable
  return candidates.reduce((best, candidate) => (score(candidate) > score(best) ? candidate : best))
}

const createPurposeColorMap = (colors: ThemeModeColors, surfaces: readonly string[]): Record<string, string> => {
  const onSurface = chooseReadableColor(['#000000', '#FFFFFF'], surfaces, 7)
  const seeds: Record<WikiPurposeKey, string> = {
    primary: colors.primary,
    secondary: colors.secondary,
    success: colors.success,
    info: colors.info,
    warning: colors.warning,
    error: colors.error,
    neutral: onSurface
  }
  const purposeColors: Record<string, string> = {}

  for (const key of WIKI_PURPOSE_KEYS) {
    const seed = seeds[key]
    const fill = mixHex(colors.surface, seed, 0.08)
    const edge = mixHex(colors.surface, seed, 0.22)
    const initialInk = mixHex(seed, onSurface, 0.62)
    const backings = [...surfaces, fill]
    const foreground = chooseReadableColor(['#000000', '#FFFFFF'], backings, 7)
    const ink = chooseReadableColor(
      [
        initialInk,
        mixHex(initialInk, foreground, 0.2),
        mixHex(initialInk, foreground, 0.4),
        mixHex(initialInk, foreground, 0.6),
        mixHex(initialInk, foreground, 0.8),
        foreground
      ],
      backings,
      4.5
    )
    purposeColors[`purpose-${key}-ink`] = ink
    purposeColors[`purpose-${key}-fill`] = fill
    purposeColors[`purpose-${key}-edge`] = edge
  }

  return purposeColors
}

export const WIKI_INK_KEYS = ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error'] as const
const INK_STEPS = Array.from({ length: 21 }, (_, index) => index / 20)

// Palette colors used as text or icons (`text-<color>` utilities and the
// `--wiki-<color>-ink` tokens). Each ink keeps the palette color when it already
// reads at 4.5:1 on every page surface (including the mineral gradient) and its
// own 12% tint; otherwise it moves toward the surface text color in 5% steps.
// A light primary such as the default amber therefore keeps its hue as a deeper bronze
// in light mode and stays unchanged in dark mode.
export const createInkColorMap = (colors: ThemeModeColors, surfaces: readonly string[]): Record<string, string> => {
  const onSurface = chooseReadableColor(['#000000', '#FFFFFF'], surfaces, 7)
  // Tonal buttons and chips use the existing surface-backed 12% activated fill.
  const score = (ink: string): number => Math.min(...[...surfaces, mixHex(colors.surface, ink, 0.12)].map(surface => contrastRatio(ink, surface)))
  const inks: Record<string, string> = {}
  for (const key of WIKI_INK_KEYS) {
    const candidates = INK_STEPS.map(step => mixHex(colors[key], onSurface, step))
    // The canonical burnished amber has a prescribed text ink; custom palettes
    // still use the same surface-aware solver and never inherit it blindly.
    if (key === 'primary' && colors.primary === '#E88D1F' && onSurface === '#000000') candidates.unshift('#9A5406')
    inks[`${key}-ink`] =
      candidates.find(candidate => score(candidate) >= 4.5) ?? candidates.reduce((best, candidate) => (score(candidate) > score(best) ? candidate : best))
  }
  return inks
}

const createThemeColorMap = (colors: ThemeModeColors, dark: boolean): Record<string, string> => {
  const surfaceBright = mixHex(colors.surface, '#FFFFFF', dark ? 0.12 : 0.04)
  const surfaceLight = mixHex(colors.surface, dark ? '#FFFFFF' : '#000000', dark ? 0.06 : 0.03)
  const surfaceVariant = mixHex(colors.background, colors.surface, 0.5)
  const surfaceRaised = mixHex(colors.surface, surfaceBright, 0.06)
  // Only the canonical base pair receives the prescribed exact material roles.
  // A valid saved palette is never rewritten or mistaken for a fresh default.
  const canonical = colors.background.toUpperCase() === (dark ? '#12100E' : '#F9F6EE') && colors.surface.toUpperCase() === (dark ? '#1A1714' : '#FFFDF9')
  const materialTop = canonical ? (dark ? '#221E1A' : '#FFFDF9') : surfaceRaised
  const materialBottom = canonical ? (dark ? '#1A1714' : '#F9F6EE') : dark ? colors.surface : colors.background
  const surfaceSunken = canonical ? (dark ? '#0D0B09' : '#F1ECE1') : mixHex(colors.background, colors.surface, 0.28)
  const glassBottom = canonical ? (dark ? '#161310' : '#F9F6EE') : colors.background
  const mineralSurfaces = sampleMineralGradient(colors, materialTop, materialBottom, dark)
  const surfaces = [colors.background, colors.surface, surfaceRaised, surfaceSunken, materialTop, materialBottom, glassBottom, ...mineralSurfaces]
  const commitmentEnd = mixHex(colors.primary, '#000000', 0.08)
  const commitmentSurfaces = Array.from({ length: 33 }, (_, step) => mixHex(colors.primary, commitmentEnd, step / 32))
  const commitmentInk = chooseReadableColor(['#171512', '#000000', '#FFFFFF'], commitmentSurfaces, 4.5)
  const disabledPrimaryRaised = mineralSurfaces.map(surface => mixHex(surface, colors.primary, 0.8))
  const disabledPrimarySunken = mixHex(surfaceSunken, colors.primary, 0.8)
  const colorMap: Record<string, string> = {
    ...colors,
    'surface-bright': surfaceBright,
    'surface-light': surfaceLight,
    'surface-variant': surfaceVariant,
    'material-top': materialTop,
    'material-bottom': materialBottom,
    'surface-sunken': surfaceSunken,
    'glass-bottom': glassBottom,
    'commitment-end': commitmentEnd,
    'commitment-ink': commitmentInk,
    'on-surface-variant': contrastForeground(surfaceVariant),
    'on-primary-disabled-raised': chooseReadableColor(['#000000', '#FFFFFF'], disabledPrimaryRaised, 21),
    'on-primary-disabled-sunken': contrastForeground(disabledPrimarySunken),
    // Control/focus and readable inks see the same real flat/gradient backings.
    focus: chooseReadableColor(['#000000', '#FFFFFF'], surfaces, 21),
    ...createPurposeColorMap(colors, surfaces),
    ...createInkColorMap(colors, surfaces)
  }
  for (const key of THEME_COLOR_KEYS) colorMap[`on-${key}`] = contrastForeground(colors[key])
  colorMap['on-surface'] = chooseReadableColor(['#000000', '#FFFFFF'], surfaces, 7)
  return colorMap
}
export const createWikiThemes = (colors: ThemeColors): Record<'light' | 'dark', ThemeDefinition> => ({
  light: {
    dark: false,
    colors: createThemeColorMap(colors.light, false)
  },
  dark: {
    dark: true,
    colors: createThemeColorMap(colors.dark, true)
  }
})

export const applyWikiThemeColors = (theme: ThemeInstance, colors: ThemeColors): void => {
  Object.assign(theme.themes.value.light.colors, createThemeColorMap(colors.light, false))
  Object.assign(theme.themes.value.dark.colors, createThemeColorMap(colors.dark, true))
}
