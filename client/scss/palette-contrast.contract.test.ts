// Contrast contract for every built-in palette in light and dark mode.
// Token formulas are read from the shipped stylesheets and evaluated the way
// the browser does: textual var() substitution, color-mix(in srgb) with CSS
// Color 5 alpha rules, and source-over compositing onto the real surface.
// PALETTE_CONTRAST_REPORT=1 prints the full matrix.
import fs from 'node:fs'
import path from 'node:path'
import { compileStyle, parse as parseSfc } from '@vue/compiler-sfc'
import postcss from 'postcss'
import { createVuetify } from 'vuetify'
import { describe, expect, test } from '../../server/test/bun-test.mts'
import { cloneThemeColors, DEFAULT_THEME_COLORS, type ThemeColors } from '../../shared/theme-colors.ts'
import { createDefaultThemePalette, type ThemePalette } from '../../shared/theme-palettes.ts'
import { createWikiThemes, WIKI_THEME_VARIATIONS } from '../helpers/theme.ts'

// ---------------------------------------------------------------------------
// Style sources. Formulas are read from the shipped stylesheets, not copied.
// ---------------------------------------------------------------------------
const root = process.cwd()
const read = (relativePath: string): string => fs.readFileSync(path.join(root, relativePath), 'utf8')
const compiled = new Map<string, postcss.Root[]>()
const compile = (source: string, filename: string): postcss.Root => {
  const result = compileStyle({
    source,
    filename: path.join(root, filename),
    id: 'palette-contrast',
    preprocessLang: 'scss',
    preprocessOptions: { loadPaths: [path.join(root, 'node_modules')], quietDeps: true, silenceDeprecations: ['import', 'global-builtin'] }
  })
  if (result.errors.length) throw result.errors[0]
  return postcss.parse(result.code, { from: filename })
}
const styleRoots = (relativePath: string): postcss.Root[] => {
  const cached = compiled.get(relativePath)
  if (cached) return cached
  const roots = relativePath.endsWith('.vue')
    ? parseSfc(read(relativePath)).descriptor.styles.map(style => compile(style.content, relativePath))
    : [compile(read(relativePath), relativePath)]
  compiled.set(relativePath, roots)
  return roots
}
type Declarations = Map<string, string>
const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()
/** Declarations (outside at-rules) of every rule with a matching selector. */
const rule = (relativePath: string, selector: string | ((candidate: string) => boolean)): Declarations => {
  const matches = typeof selector === 'string' ? (candidate: string) => candidate === selector : selector
  const found: Declarations = new Map()
  for (const styleRoot of styleRoots(relativePath)) {
    styleRoot.walkRules(node => {
      if (node.parent?.type === 'atrule' || !node.selectors.some(matches)) return
      for (const child of node.nodes) {
        if (child.type === 'decl') found.set(child.prop, normalize(child.value).replace(/\s*!important$/, ''))
      }
    })
  }
  if (!found.size) throw new Error(`${relativePath}: no rule for ${selector}`)
  return found
}
const declaration = (relativePath: string, selector: string | ((candidate: string) => boolean), prop: string): string => {
  const value = rule(relativePath, selector).get(prop)
  if (!value) throw new Error(`${relativePath}: ${selector} has no ${prop}`)
  return value
}

// ---------------------------------------------------------------------------
// Minimal CSS color evaluator: var(), rgb()/rgba(), hex, transparent,
// currentColor and color-mix(in srgb, …) with CSS Color 5 alpha rules.
// ---------------------------------------------------------------------------
interface Rgba { r: number, g: number, b: number, a: number }
const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 }
const splitTopLevel = (value: string, separator: ','): string[] => {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (character === '(') depth++
    else if (character === ')') depth--
    else if (character === separator && depth === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts
}
const closingParen = (value: string, open: number): number => {
  let depth = 0
  for (let index = open; index < value.length; index++) {
    if (value[index] === '(') depth++
    else if (value[index] === ')' && --depth === 0) return index
  }
  throw new Error(`Unbalanced parentheses in ${value}`)
}
type Scope = Record<string, string>
/** Textual var() substitution, as the CSS engine performs it. */
const substitute = (value: string, scope: Scope, seen: string[] = []): string => {
  let output = value
  for (let start = output.indexOf('var('); start !== -1; start = output.indexOf('var(')) {
    const end = closingParen(output, start + 3)
    const [name, ...fallback] = splitTopLevel(output.slice(start + 4, end), ',')
    if (seen.includes(name)) throw new Error(`Cyclic custom property ${name}`)
    const resolved = Object.hasOwn(scope, name)
      ? substitute(scope[name], scope, [...seen, name])
      : fallback.length ? substitute(fallback.join(','), scope, seen) : undefined
    if (resolved === undefined) throw new Error(`Unresolved custom property ${name}`)
    output = output.slice(0, start) + resolved + output.slice(end + 1)
  }
  return output
}
const parseHex = (hex: string): Rgba => {
  const digits = hex.slice(1)
  const full = digits.length === 3 ? [...digits].map(digit => digit + digit).join('') : digits
  return {
    r: Number.parseInt(full.slice(0, 2), 16) / 255,
    g: Number.parseInt(full.slice(2, 4), 16) / 255,
    b: Number.parseInt(full.slice(4, 6), 16) / 255,
    a: full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1
  }
}
const evaluate = (value: string, currentColor?: Rgba): Rgba => {
  const text = value.trim()
  const lower = text.toLowerCase()
  if (lower === 'transparent') return TRANSPARENT
  if (lower === 'currentcolor') {
    if (!currentColor) throw new Error('currentColor without a context color')
    return currentColor
  }
  if (text.startsWith('#')) return parseHex(text)
  const open = text.indexOf('(')
  if (open === -1 || closingParen(text, open) !== text.length - 1) throw new Error(`Unsupported color ${text}`)
  const name = text.slice(0, open).toLowerCase()
  const args = text.slice(open + 1, -1)
  if (name === 'rgb' || name === 'rgba') {
    const channels = args.replace('/', ',').split(/[\s,]+/).filter(Boolean).map(Number)
    const [r, g, b, a = 1] = channels
    return { r: r / 255, g: g / 255, b: b / 255, a }
  }
  if (name === 'color-mix') {
    const [space, first, second] = splitTopLevel(args, ',')
    if (normalize(space) !== 'in srgb') throw new Error(`Unsupported color-mix space ${space}`)
    const parse = (part: string): { color: Rgba, weight?: number } => {
      const match = part.match(/^(.*?)\s+(\d+(?:\.\d+)?)%$/s)
      return match ? { color: evaluate(match[1], currentColor), weight: Number(match[2]) / 100 } : { color: evaluate(part, currentColor) }
    }
    const one = parse(first)
    const two = parse(second)
    let p1 = one.weight ?? (two.weight === undefined ? 0.5 : 1 - two.weight)
    let p2 = two.weight ?? 1 - p1
    const sum = p1 + p2
    const alphaMultiplier = sum < 1 ? sum : 1
    p1 /= sum
    p2 /= sum
    const alpha = one.color.a * p1 + two.color.a * p2
    const channel = (key: 'r' | 'g' | 'b'): number =>
      alpha === 0 ? 0 : (one.color[key] * one.color.a * p1 + two.color[key] * two.color.a * p2) / alpha
    return { r: channel('r'), g: channel('g'), b: channel('b'), a: alpha * alphaMultiplier }
  }
  throw new Error(`Unsupported color function ${name}`)
}
/** Source-over compositing of a translucent color onto an opaque backdrop. */
const over = (top: Rgba, backdrop: Rgba): Rgba => ({
  r: top.r * top.a + backdrop.r * (1 - top.a),
  g: top.g * top.a + backdrop.g * (1 - top.a),
  b: top.b * top.a + backdrop.b * (1 - top.a),
  a: 1
})
const luminance = (color: Rgba): number => {
  const linear = (channel: number): number => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}
const contrast = (foreground: Rgba, backdrop: Rgba): number => {
  const ink = over(foreground, backdrop)
  const [dark, light] = [luminance(ink), luminance(backdrop)].sort((left, right) => left - right)
  return (light + 0.05) / (dark + 0.05)
}
const hex = (color: Rgba): string => '#' + [color.r, color.g, color.b]
  .map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('').toUpperCase()

// ---------------------------------------------------------------------------
// Runtime scope: Vuetify's generated --v-theme-* and --v-* variables plus the
// :root (and dark) custom properties from base.scss.
// ---------------------------------------------------------------------------
type Mode = 'light' | 'dark'
const MODES: Mode[] = ['light', 'dark']
interface ComputedTheme { colors: Record<string, string>, variables: Record<string, string | number> }
const themeScope = (colors: ThemeColors, mode: Mode): Scope => {
  const vuetify = createVuetify({ theme: { defaultTheme: mode, themes: createWikiThemes(colors), variations: WIKI_THEME_VARIATIONS } })
  const theme = (vuetify.theme as unknown as { computedThemes: { value: Record<Mode, ComputedTheme> } }).computedThemes.value[mode]
  const scope: Scope = {}
  for (const [key, value] of Object.entries(theme.colors)) {
    const color = parseHex(value)
    scope[`--v-theme-${key}`] = [color.r, color.g, color.b].map(channel => Math.round(channel * 255)).join(',')
  }
  for (const [key, value] of Object.entries(theme.variables)) scope[`--v-${key}`] = String(value)
  return scope
}
const BASE = 'client/scss/base/base.scss'
const tokenScope = (colors: ThemeColors, mode: Mode): Scope => ({
  ...themeScope(colors, mode),
  ...Object.fromEntries(rule(BASE, ':root')),
  ...(mode === 'dark' ? Object.fromEntries(rule(BASE, '.v-theme--dark')) : {})
})

const BACKDROPS: Record<string, string> = {
  background: 'rgb(var(--v-theme-background))',
  surface: 'rgb(var(--v-theme-surface))',
  raised: 'var(--wiki-surface-raised)',
  sunken: 'var(--wiki-surface-sunken)',
  // The header's translucent chrome over the page background.
  chrome: 'var(--wiki-chrome-surface)'
}
const PAGE = ['background', 'surface', 'raised', 'sunken']
/**
 * Named backdrop or formula, composited onto the page background when
 * translucent. `tonal` is a tonal button or chip: its own ink at Vuetify's
 * activated opacity over the surface.
 */
const backdrop = (formula: string, scope: Scope, ink?: Rgba): Rgba => {
  if (formula === 'tonal') {
    if (!ink) throw new Error('A tonal backdrop needs its ink')
    return over({ ...ink, a: Number(scope['--v-activated-opacity']) }, backdrop('surface', scope))
  }
  const color = evaluate(substitute(BACKDROPS[formula] ?? formula, scope))
  return color.a < 1 ? over(color, evaluate(substitute(BACKDROPS.background, scope))) : color
}

// ---------------------------------------------------------------------------
// The audited pairs. `text` needs 4.5:1, `ui` (boundaries, icons) needs 3:1,
// `info` is reported only (decorative or exempt by WCAG).
// ---------------------------------------------------------------------------
type Kind = 'text' | 'ui' | 'info'
interface Pair { name: string, kind: Kind, ink: string, on: string[] }
const REQUIRED: Record<Kind, number> = { text: 4.5, ui: 3, info: 0 }
const has = (...parts: string[]) => (candidate: string): boolean => parts.every(part => candidate.includes(part))
const BTN = 'client/scss/components/v-btn.scss'
const FORM = 'client/scss/components/v-form.scss'
const APP = 'client/scss/app.scss'
const PAGE_VIEW = 'client/themes/default/components/page.vue'
const HEADER = 'client/components/common/nav-header.vue'
const THREAD = 'client/components/agents/agent-thread.vue'
const LINK = '.v-application a:not(:where(.v-btn, .v-list-item, .v-tab, .v-chip))'
const PALETTE_KEYS = ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error'] as const
const PURPOSES = ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral'] as const
const OFFLINE_TONES = ['saved', 'warning', 'error', 'muted', 'action'] as const

const pairs = (): Pair[] => {
  const disabledFilled = rule(BTN, has('.v-btn--disabled', '.v-btn--variant-flat'))
  return [
    { name: 'muted text --wiki-text-muted', kind: 'text', ink: 'var(--wiki-text-muted)', on: PAGE },
    { name: 'decorative --wiki-text-subtle (exempt)', kind: 'info', ink: 'var(--wiki-text-subtle)', on: PAGE },
    { name: 'text-medium-emphasis', kind: 'text', ink: 'rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity))', on: PAGE },
    { name: 'link --wiki-accent-ink', kind: 'text', ink: declaration(APP, LINK, 'color'), on: PAGE },
    { name: 'link hover', kind: 'text', ink: declaration(APP, `${LINK}:hover`, 'color'), on: PAGE },
    ...PALETTE_KEYS.map(key => ({
      name: `text-${key} utility (text/outlined/tonal buttons, icons, controls)`,
      kind: 'text' as const,
      ink: declaration(BASE, `:where(.text-${key})`, 'color'),
      on: [...PAGE, 'tonal']
    })),
    ...(['primary', 'secondary', 'info', 'success', 'warning', 'error'] as const).map(key => ({
      name: `--wiki-${key}-ink`, kind: 'text' as const, ink: `var(--wiki-${key}-ink)`, on: PAGE
    })),
    { name: 'primary fill against surface (label identifies the button)', kind: 'info', ink: 'rgb(var(--v-theme-primary))', on: ['surface'] },
    ...(['primary', 'secondary', 'info', 'success', 'warning', 'error'] as const).map(key => ({
      name: `on-${key} on ${key} fill`, kind: 'text' as const, ink: `rgb(var(--v-theme-on-${key}))`, on: [`rgb(var(--v-theme-${key}))`]
    })),
    ...PURPOSES.map(key => ({
      name: `purpose ${key} ink on surface and fill`, kind: 'text' as const, ink: `var(--wiki-purpose-${key}-ink)`, on: ['surface', 'raised', `var(--wiki-purpose-${key}-fill)`]
    })),
    { name: 'focused field label', kind: 'text', ink: declaration(FORM, has('.v-input--focused .v-field-label'), 'color'), on: ['raised'] },
    { name: 'field error text', kind: 'text', ink: declaration(FORM, has('.v-input.v-input--error:not(.v-input--disabled) ', '.v-field-label'), 'color'), on: ['raised'] },
    { name: 'field success text', kind: 'text', ink: declaration(FORM, has('.v-input.is-success', '.v-field-label'), 'color'), on: ['raised'] },
    { name: 'disabled filled button label', kind: 'text', ink: disabledFilled.get('color') ?? '', on: [disabledFilled.get('background-color') ?? ''] },
    { name: 'field outline', kind: 'ui', ink: declaration(FORM, '.v-field--variant-outlined .v-field__outline', 'color'), on: ['raised', 'surface'] },
    { name: 'focused field outline', kind: 'ui', ink: declaration(FORM, has('.v-field--focused .v-field__outline.text-primary'), 'color'), on: ['raised'] },
    { name: 'checked switch thumb', kind: 'ui', ink: declaration(BASE, '.v-switch :is(.v-switch__track, .v-switch__thumb).bg-primary', 'background-color'), on: ['surface', 'raised'] },
    { name: 'unchecked switch outline', kind: 'ui', ink: declaration(APP, has('.v-switch .v-selection-control:not(.v-selection-control--dirty)'), '--wiki-switch-off-outline'), on: ['surface', 'raised'] },
    { name: 'focus indicator', kind: 'ui', ink: 'var(--wiki-focus-color)', on: ['background', 'surface', 'raised'] },
    { name: 'agent mark (header)', kind: 'ui', ink: declaration(HEADER, '.nav-header', '--nav-header-agent-icon-color'), on: ['chrome', 'surface'] },
    { name: 'agent mark (thread)', kind: 'ui', ink: declaration(THREAD, '.agent-message__assistant-mark', '--agent-mark-color'), on: ['surface', 'raised'] },
    ...OFFLINE_TONES.map(tone => ({
      name: `offline toggle ${tone}`, kind: 'ui' as const, ink: declaration(PAGE_VIEW, `.page-offline-control--${tone}`, 'color'), on: PAGE
    })),
    { name: 'pressed page utility', kind: 'ui', ink: declaration(PAGE_VIEW, has('__utilities .v-btn[aria-pressed=', ':not(.page-offline-control)'), 'color'), on: PAGE }
  ]
}

interface Row { mode: Mode, name: string, kind: Kind, ratio: number, worst: string, ink: string }
const measure = (colors: ThemeColors, mode: Mode, list: Pair[]): Row[] => {
  const scope = tokenScope(colors, mode)
  return list.map(pair => {
    const ink = evaluate(substitute(pair.ink, scope))
    const results = pair.on.map(on => ({ on, ratio: contrast(ink, backdrop(on, scope, ink)) }))
    const worst = results.reduce((left, right) => (right.ratio < left.ratio ? right : left))
    return {
      mode,
      name: pair.name,
      kind: pair.kind,
      ratio: worst.ratio,
      worst: Object.hasOwn(BACKDROPS, worst.on) || worst.on === 'tonal' ? worst.on : 'fill',
      ink: hex(over(ink, backdrop(worst.on, scope, ink)))
    }
  })
}
const failures = (rows: Row[]): string[] => rows
  .filter(row => row.ratio < REQUIRED[row.kind])
  .map(row => `${row.mode} ${row.name}: ${row.ratio.toFixed(2)}:1 on ${row.worst} (needs ${REQUIRED[row.kind]}:1)`)
const report = (palette: ThemePalette, rows: Row[]): void => {
  if (process.env.PALETTE_CONTRAST_REPORT !== '1') return
  console.log(`\n${palette.name}`)
  for (const row of rows) {
    const verdict = row.kind === 'info' ? 'info' : row.ratio >= REQUIRED[row.kind] ? 'pass' : 'FAIL'
    console.log(`  ${row.mode.padEnd(5)} ${verdict.padEnd(4)} ${row.ratio.toFixed(2).padStart(5)} ${row.ink} on ${row.worst.padEnd(10)} ${row.name}`)
  }
}

// Built-in palettes. Add new presets here so they are audited too.
const BUILT_IN_PALETTES: ThemePalette[] = [createDefaultThemePalette()]

// A custom palette whose raw colors fail as text in both modes: pale accents
// on a light surface and deep accents on a dark one.
const pastelAndDeep = (): ThemeColors => {
  const colors = cloneThemeColors(DEFAULT_THEME_COLORS)
  Object.assign(colors.light, { primary: '#FFD54F', secondary: '#B0BEC5', accent: '#CE93D8', info: '#4FC3F7', success: '#81C784', warning: '#FFB74D', error: '#E57373' })
  Object.assign(colors.dark, { primary: '#1A237E', secondary: '#37474F', accent: '#4A148C', info: '#0D47A1', success: '#1B5E20', warning: '#8D3B00', error: '#7F1D1D' })
  return colors
}

describe('palette contrast contract', () => {
  test('evaluates color-mix, alpha and WCAG ratios like the browser', () => {
    const scope: Scope = { '--ink': '0,0,0', '--tone': 'rgb(var(--ink))' }
    const muted = evaluate(substitute('color-mix(in srgb, var(--tone) 70%, transparent)', scope))
    expect(muted.a).toBeCloseTo(0.7, 6)
    expect(hex(over(muted, parseHex('#FFFFFF')))).toBe('#4D4D4D')
    expect(hex(evaluate('color-mix(in srgb, #FF0000 25%, #0000FF)'))).toBe('#4000BF')
    // Weights below 100% scale the result alpha (CSS Color 5).
    expect(evaluate('color-mix(in srgb, #000000 30%, #FFFFFF 20%)').a).toBeCloseTo(0.5, 6)
    expect(contrast(parseHex('#767676'), parseHex('#FFFFFF'))).toBeCloseTo(4.54, 2)
    expect(contrast(evaluate('rgba(0, 0, 0, .5)'), parseHex('#FFFFFF'))).toBeCloseTo(3.98, 2)
  })

  for (const palette of BUILT_IN_PALETTES) {
    test(`${palette.name} meets WCAG AA for every audited token in light and dark mode`, () => {
      const list = pairs()
      const rows = MODES.flatMap(mode => measure(palette.colors, mode, list))
      report(palette, rows)
      expect(failures(rows)).toEqual([])
    })
  }

  test('palette-derived inks stay readable for a custom palette whose raw colors fail', () => {
    const adaptive = pairs().filter(pair => /^(text-\w+ utility|--wiki-\w+-ink|purpose |checked switch|focus indicator|focused field)/.test(pair.name))
    const rows = MODES.flatMap(mode => measure(pastelAndDeep(), mode, adaptive))
    report({ id: 'pastel-and-deep', name: 'Custom pastel/deep palette (adaptive tokens only)', colors: pastelAndDeep() }, rows)
    expect(adaptive.length).toBeGreaterThanOrEqual(PALETTE_KEYS.length + 6 + PURPOSES.length)
    expect(failures(rows)).toEqual([])
  })

  test('keeps a palette color that already reads as its own ink', () => {
    const scope = tokenScope(DEFAULT_THEME_COLORS, 'dark')
    expect(substitute('var(--wiki-primary-ink)', scope)).toBe(substitute('rgb(var(--v-theme-primary))', scope))
    const light = tokenScope(DEFAULT_THEME_COLORS, 'light')
    expect(substitute('var(--wiki-secondary-ink)', light)).toBe(substitute('rgb(var(--v-theme-secondary))', light))
  })

  test('colors text and icons drawn from palette colors with a readable value', () => {
    // Every `color:` declaration in client styles that is a pure function of
    // palette tokens must read at 4.5:1 on the page surfaces of each built-in
    // palette. Raw rgb(var(--v-theme-primary)) and --wiki-accent-warm fail in
    // light mode; use --wiki-<color>-ink instead.
    const files = [...new Bun.Glob('client/**/*.{vue,scss}').scanSync({ cwd: root })].sort()
    const colorDeclaration = /(?<![-\w])color:\s*([^;{}]+?)\s*(?:!important\s*)?(?=;|\}|$)/gm
    const paletteReference = /--v-theme-(?:primary|secondary|accent|info|success|warning|error)\b|--wiki-accent-warm/
    const problems: string[] = []
    let audited = 0
    for (const palette of BUILT_IN_PALETTES) {
      for (const mode of MODES) {
        const scope = tokenScope(palette.colors, mode)
        for (const file of files) {
          const text = read(file)
          for (const match of text.matchAll(colorDeclaration)) {
            const value = match[1].trim()
            if (!paletteReference.test(value)) continue
            let ink: Rgba
            try {
              ink = evaluate(substitute(value, scope))
            } catch {
              continue // depends on component-local custom properties or currentColor
            }
            audited++
            const worst = Math.min(...PAGE.map(on => contrast(ink, backdrop(on, scope))))
            if (worst < 4.5) {
              const line = text.slice(0, match.index).split('\n').length
              problems.push(`${palette.name} ${mode} ${file}:${line} ${value} (${worst.toFixed(2)}:1)`)
            }
          }
        }
      }
    }
    expect(audited).toBeGreaterThan(100)
    expect(problems).toEqual([])
  })
})
