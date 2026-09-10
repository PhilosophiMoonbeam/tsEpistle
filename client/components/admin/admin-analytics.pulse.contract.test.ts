import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from '../../../server/test/bun-test.mts'

const componentPath = join(process.cwd(), 'client/components/admin/admin-analytics.vue')
const scssPath = join(process.cwd(), 'client/components/admin/analytics-workspace.scss')

const componentSource = readFileSync(componentPath, 'utf8')
const scssSource = readFileSync(scssPath, 'utf8')

const { descriptor, errors } = parse(componentSource, { filename: componentPath })
const template = descriptor.template?.content ?? ''
const script = descriptor.scriptSetup?.content ?? ''

describe('Analytics Pulse Engine Contract (admin-analytics.vue & analytics-workspace.scss)', () => {
  it('compiles SFC without parsing errors', () => {
    expect(errors).toEqual([])
    expect(template.length).toBeGreaterThan(0)
    expect(script.length).toBeGreaterThan(0)
  })

  describe('1. SVG Defs with useId & Luminous Pill Geometry', () => {
    it('imports useId from vue and instantiates unique SVG filter & gradient IDs', () => {
      expect(script).toMatch(/import\s*\{[^}]*\buseId\b[^}]*\}\s*from\s*['"]vue['"]/)
      expect(script).toMatch(/const\s+barGradId\s*=\s*useId\(\)/)
      expect(script).toMatch(/const\s+barGlowId\s*=\s*useId\(\)/)
    })

    it('renders svg with analytics-chart-svg class and pointer tracking directives', () => {
      expect(template).toContain('class="analytics-chart-svg"')
      expect(template).toContain('@pointermove="handleChartPointer"')
      expect(template).toContain('@pointerleave="clearChartPointer"')
    })

    it('defines linearGradient and glow filter with primary theme luminous multi-stops', () => {
      expect(template).toContain('<defs>')
      expect(template).toContain('<linearGradient :id="barGradId"')
      expect(template).toContain('stop-color="rgb(var(--v-theme-primary))"')
      expect(template).toContain('color-mix(in srgb, rgb(var(--v-theme-primary))')
      expect(template).toContain('<filter :id="barGlowId"')
      expect(template).toContain('feDropShadow')
      expect(template).toContain('flood-color="rgb(var(--v-theme-primary))"')
    })

    it('applies gradient fill, glow filter, and rx="3" ry="3" pill geometry to bars', () => {
      expect(template).toContain(':fill="`url(#' + String.fromCharCode(36) + '{barGradId})`"')
      expect(template).toContain(':filter="`url(#' + String.fromCharCode(36) + '{barGlowId})`"')
      expect(template).toContain('rx="3"')
      expect(template).toContain('ry="3"')
    })
  })

  describe('2. Interactive Laser Crosshair HUD & Datum Elements', () => {
    it('renders laser line and anchor datum circle bound to activeBar coordinates', () => {
      expect(template).toContain('line')
      expect(template).toContain('class="chart-laser-line"')
      expect(template).toContain(':x1="activeBar.x + activeBar.width / 2"')
      expect(template).toContain('y1="8"')
      expect(template).toContain(':x2="activeBar.x + activeBar.width / 2"')
      expect(template).toContain('y2="169"')

      expect(template).toContain('circle')
      expect(template).toContain('class="chart-datum-point"')
      expect(template).toContain(':cx="activeBar.x + activeBar.width / 2"')
      expect(template).toContain(':cy="169 - activeBar.height"')
      expect(template).toContain('r="4.5"')
    })

    it('implements pointer tracking logic and activeBar state in scriptSetup', () => {
      expect(script).toContain('function handleChartPointer(event: PointerEvent)')
      expect(script).toContain('function clearChartPointer()')
      expect(script).toContain('activeBar.value = null')
      expect(script).toMatch(/const\s+activeBar\s*=\s*ref<BarDatum\s*\|\s*null>\(null\)/)
    })
  })

  describe('3. animated-number Integration', () => {
    it('imports AnimatedNumber component from common', () => {
      expect(script).toMatch(/import\s+AnimatedNumber\s+from\s+['"]@\/components\/common\/animated-number\.vue['"]/)
    })

    it('replaces static response and page metrics with animated-number in template', () => {
      expect(template).toContain('<animated-number :value="saved.insights.totalResponses" :duration="700" :format-value="number" />')
      expect(template).toContain('<animated-number :value="saved.insights.pages" :duration="700" :format-value="number" />')
      expect(template).not.toContain('<strong>{{ number(saved.insights.totalResponses) }}</strong>')
      expect(template).not.toContain('<strong>{{ number(saved.insights.pages) }}</strong>')
    })
  })

  describe('4. Glassmorphic HUD Tooltip & SCSS Micro-interactions', () => {
    it('renders floating glassmorphic tooltip with day, exact count, and % of max value', () => {
      expect(template).toContain('class="chart-hud-tooltip analytics-chart-tooltip"')
      expect(template).toContain('role="tooltip"')
      expect(template).toContain('{{ activeBar.day }}')
      expect(template).toContain('{{ number(activeBar.responses) }}')
      expect(template).toContain('{{ activeBar.pct }}% of max')
      expect(template).toContain(':style="tooltipStyle"')
    })

    it('styles glassmorphic tooltip with blur(14px) saturate(180%), primary alpha border, and glow shadow', () => {
      expect(scssSource).toContain('backdrop-filter: blur(14px) saturate(180%)')
      expect(scssSource).toContain('border: 1px solid rgba(var(--v-theme-primary), 0.35)')
      expect(scssSource).toMatch(/box-shadow:[^;]*rgba\(var\(--v-theme-primary\),\s*0\.25\)/)
    })

    it('applies cubic-bezier transitions on bar geometry and tactile hover highlights', () => {
      expect(scssSource).toContain('transition: height 0.35s cubic-bezier(0.16, 1, 0.3, 1), y 0.35s cubic-bezier(0.16, 1, 0.3, 1)')
      expect(scssSource).toMatch(/&:hover[\s\S]*?filter:\s*brightness\(1\.2\)\s*drop-shadow\(0 0 6px rgba\(var\(--v-theme-primary\), 0\.7\)\)/)
    })

    it('honors prefers-reduced-motion: reduce accessibility query in SCSS', () => {
      expect(scssSource).toContain('@media (prefers-reduced-motion: reduce)')
      expect(scssSource).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?transition:\s*none\s*!important;/)
    })
  })

  describe('5. Vue 3.5 Modernization & AbortController Lifecycle', () => {
    it('utilizes onWatcherCleanup with AbortController for race-free window switching', () => {
      expect(script).toMatch(/import\s*\{[^}]*\bonWatcherCleanup\b[^}]*\}\s*from\s*['"]vue['"]/)
      expect(script).toContain('watch(reportDays, async (days) => {')
      expect(script).toContain('const controller = new AbortController()')
      expect(script).toContain('onWatcherCleanup(() => controller.abort())')
      expect(script).toContain('controller.signal.aborted')
    })
  })
})
