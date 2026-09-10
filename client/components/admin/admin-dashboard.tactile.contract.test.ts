import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'

const componentPath = join(process.cwd(), 'client/components/admin/admin-dashboard.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentPath })
const template = descriptor.template?.content ?? ''
const script = descriptor.script?.content ?? ''
const styles = descriptor.styles.map(style => style.content).join('\n')

const mockWindow: Record<string, unknown> = {
  matchMedia: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  })),
  fetch: vi.fn()
}
globalThis.window = mockWindow

// Extract the compiled component definition and helper functions
const transpiledScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  script
    .replace(/^import .+$/gm, '')
    .replace(/^export\s+default/gm, 'const defaultExport =')
    .replace(/^export\s+/gm, '')
)

const runtimeScope = {
  markRaw: <T>(x: T) => x,
  inject: () => undefined,
  buildAdminNavigation: () => [],
  filterAdminNavigation: () => [],
  adminSummaryKey: Symbol('adminSummaryKey'),
  AsyncState: {},
  AnimatedNumber: {},
  wikiStore: {
    admin: { info: { pagesTotal: 42, tagsTotal: 12, usersTotal: 8, groupsTotal: 3, product: { version: '1.0.0' } } },
    site: { title: 'tsEpistle' },
    user: {
      permissions: [
        'manage:system',
        'write:pages',
        'manage:pages',
        'delete:pages',
        'manage:groups',
        'write:groups',
        'manage:users',
        'write:users',
        'manage:api'
      ]
    }
  },
  siteConfig: { agentsEnabled: true },
  fetchRecentPages: vi.fn(),
  fetchLastLogins: vi.fn(),
  getErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  loadingStart: vi.fn(),
  loadingStop: vi.fn(),
  showNotification: vi.fn(),
  window: mockWindow
}

const evaluatedExports = new Function(...Object.keys(runtimeScope), `${transpiledScript}; return { defaultExport, computeTilt, resetTilt };`)(
  ...Object.values(runtimeScope)
) as {
  defaultExport: Record<string, unknown> & {
    data: () => Record<string, unknown>
    methods: Record<string, (...args: unknown[]) => unknown>
    beforeUnmount: (this: Record<string, unknown>) => void
  }
  computeTilt: (rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number) => Record<string, string>
  resetTilt: () => Record<string, string>
}

const component = evaluatedExports.defaultExport
const { computeTilt, resetTilt } = evaluatedExports

describe('admin-dashboard tactile 3D contract', () => {
  it('parses SFC without compiler errors', () => {
    expect(errors).toEqual([])
  })

  describe('3D perspective tilt styles and properties', () => {
    it('sets 1000px perspective on dashboard inventory and connection grid containers', () => {
      expect(styles).toMatch(/\.dashboard-inventory\s*\{[^}]*perspective:\s*1000px;/s)
      expect(styles).toMatch(/\.dashboard-connections__grid\s*\{[^}]*perspective:\s*1000px;/s)
    })

    it('sets perspective transform and preserve-3d on stat cards and connection cards', () => {
      expect(styles).toMatch(
        /\.admin-stat\s*\{[^}]*transform:\s*perspective\(1000px\)\s+rotateX\(var\(--tilt-y,\s*0deg\)\)\s+rotateY\(var\(--tilt-x,\s*0deg\)\)\s+translateZ\(var\(--card-z,\s*0px\)\);/s
      )
      expect(styles).toMatch(/\.admin-stat\s*\{[^}]*transform-style:\s*preserve-3d;/s)
      expect(styles).toMatch(/\.admin-stat\s*\{[^}]*will-change:\s*transform;/s)

      expect(styles).toMatch(
        /\.dashboard-connection\s*\{[^}]*transform:\s*perspective\(1000px\)\s+rotateX\(var\(--tilt-y,\s*0deg\)\)\s+rotateY\(var\(--tilt-x,\s*0deg\)\)\s+translateZ\(var\(--card-z,\s*0px\)\);/s
      )
      expect(styles).toMatch(/\.dashboard-connection\s*\{[^}]*transform-style:\s*preserve-3d;/s)
      expect(styles).toMatch(/\.dashboard-connection\s*\{[^}]*will-change:\s*transform;/s)
    })

    it('binds reactive tilt styles and pointer event handlers in the template', () => {
      expect(template).toContain(":style='tiltStyles[stat.key]'")
      expect(template).toContain("@pointermove='handleCardPointerMove($event, stat.key)'")
      expect(template).toContain("@pointerleave='handleCardPointerLeave(stat.key)'")

      expect(template).toContain(":style='tiltStyles[item.key]'")
      expect(template).toContain("@pointermove='handleCardPointerMove($event, item.key)'")
      expect(template).toContain("@pointerleave='handleCardPointerLeave(item.key)'")
    })

    it('implements mathematical tilt physics with normalized center offset and yaw/pitch scaling', () => {
      const rect = { left: 100, top: 200, width: 200, height: 100 }

      // Exact center
      const center = computeTilt(rect, 200, 250)
      expect(center['--tilt-x']).toBe('0.00deg')
      expect(center['--tilt-y']).toBe('0.00deg')
      expect(center['--mouse-x']).toBe('50.00%')
      expect(center['--mouse-y']).toBe('50.00%')
      expect(center['--card-z']).toBe('12px')

      // Top-left: normX = -1, normY = -1 -> yaw = -8deg, pitch = +8deg
      const topLeft = computeTilt(rect, 100, 200)
      expect(topLeft['--tilt-x']).toBe('-8.00deg')
      expect(topLeft['--tilt-y']).toBe('8.00deg')
      expect(topLeft['--mouse-x']).toBe('0.00%')
      expect(topLeft['--mouse-y']).toBe('0.00%')

      // Bottom-right: normX = 1, normY = 1 -> yaw = 8deg, pitch = -8deg
      const bottomRight = computeTilt(rect, 300, 300)
      expect(bottomRight['--tilt-x']).toBe('8.00deg')
      expect(bottomRight['--tilt-y']).toBe('-8.00deg')
      expect(bottomRight['--mouse-x']).toBe('100.00%')
      expect(bottomRight['--mouse-y']).toBe('100.00%')

      // Halfway right: normX = 0.5 -> yaw = 4deg
      const halfRight = computeTilt(rect, 250, 250)
      expect(halfRight['--tilt-x']).toBe('4.00deg')
      expect(halfRight['--tilt-y']).toBe('0.00deg')
      expect(halfRight['--mouse-x']).toBe('75.00%')
    })

    it('resets tilt variables to origin on pointer leave', () => {
      const reset = resetTilt()
      expect(reset).toEqual({
        '--tilt-x': '0deg',
        '--tilt-y': '0deg',
        '--mouse-x': '50%',
        '--mouse-y': '50%',
        '--card-z': '0px'
      })
    })
  })

  describe('specular spotlight and kinetic hover selectors', () => {
    it('implements specular spotlight overlay using radial-gradient with mouse coordinates', () => {
      expect(styles).toMatch(/radial-gradient\(\s*circle\s+at\s+var\(--mouse-x,\s*50%\)\s+var\(--mouse-y,\s*50%\)/)
      expect(styles).toMatch(/\.admin-stat\b[\s\S]*?&::before\s*\{[\s\S]*?position:\s*absolute;/)
      expect(styles).toMatch(/\.admin-stat\b[\s\S]*?&:hover\b[\s\S]*?&::before\s*\{[\s\S]*?opacity:\s*1;/)

      expect(styles).toMatch(/\.dashboard-connection\b[\s\S]*?&::before\s*\{[\s\S]*?position:\s*absolute;/)
      expect(styles).toMatch(/\.dashboard-connection\b[\s\S]*?&:hover\b[\s\S]*?&::before\s*\{[\s\S]*?opacity:\s*1;/)
    })

    it('implements specular border sheen using dual background gradients', () => {
      expect(styles).toMatch(
        /\.admin-stat\b[\s\S]*?background:\s*\n\s*linear-gradient\([^;]+padding-box,\s*\n\s*radial-gradient\(\s*circle at var\(--mouse-x,\s*50%\) var\(--mouse-y,\s*50%\)[^;]+border-box;/
      )
      expect(styles).toMatch(
        /\.dashboard-connection\b[\s\S]*?background:\s*\n\s*linear-gradient\([^;]+padding-box,\s*\n\s*radial-gradient\(\s*circle at var\(--mouse-x,\s*50%\) var\(--mouse-y,\s*50%\)[^;]+border-box;/
      )
    })

    it('provides kinetic micro-interactions: icon 3D lift, arrow diagonal shift, and active tactile press', () => {
      // 3D icon lift
      expect(styles).toMatch(/\.admin-stat__top\s*>\s*\.v-icon:first-child\s*\{[\s\S]*?transform:\s*translateZ\(14px\)\s+scale\(1\.08\);/)
      expect(styles).toMatch(/\.dashboard-connection__top\s*>\s*\.v-icon:first-child\s*\{[\s\S]*?transform:\s*translateZ\(14px\)\s+scale\(1\.08\);/)

      // Diagonal arrow shift
      expect(styles).toMatch(/\.admin-stat__arrow\s*\{[\s\S]*?transform:\s*translate\(3px,\s*-3px\);/)
      expect(styles).toMatch(/\.dashboard-connection__top\s*>\s*\.v-icon:last-child\s*\{[\s\S]*?transform:\s*translate\(3px,\s*-3px\);/)

      // Active tactile press scale(0.985)
      expect(styles).toMatch(/\.admin-stat\b[\s\S]*?&:active\s*\{[\s\S]*?scale\(0\.985\);/)
      expect(styles).toMatch(/\.dashboard-connection\b[\s\S]*?&:active\s*\{[\s\S]*?scale\(0\.985\);/)
    })
  })

  describe('animated-number integration in inventory stat cards', () => {
    it('imports and registers AnimatedNumber', () => {
      expect(script).toContain("import AnimatedNumber from '@/components/common/animated-number.vue'")
      expect(component.components).toHaveProperty('AnimatedNumber')
    })

    it('renders animated-number with format-value and 600ms duration for stat values', () => {
      const statValueTemplate = template.slice(template.indexOf('strong.admin-stat__value'), template.indexOf('span.admin-stat__hint'))
      expect(statValueTemplate).toContain("template(v-if='summaryLoading || summaryError') —")
      expect(statValueTemplate).toContain(
        "animated-number(v-else :value='Number(stat.value) || 0' :duration='600' :format-value='(v) => $helpers.formatNumber(v)')"
      )
    })

    it('manages request lifecycle with AbortController for recentPages and lastLogins', async () => {
      const state: Record<string, unknown> = {
        ...component.data(),
        canViewRecentPages: true,
        canViewLastLogins: true,
        permissions: ['manage:system']
      }

      for (const [key, fn] of Object.entries(component.methods)) {
        state[key] = (fn as (...args: unknown[]) => unknown).bind(state)
      }

      // Mock window.fetch
      mockWindow.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

      // Execute methods and verify AbortController signal handling
      const recentPromise = (state.loadRecentPages as () => Promise<void>)()
      expect(state.recentPagesAbortController).not.toBeNull()
      expect(state.recentPagesAbortController instanceof AbortController).toBe(true)
      const currentController = state.recentPagesAbortController as AbortController

      // Retrying should abort previous controller
      const retryPromise = (state.loadRecentPages as () => Promise<void>)()
      expect(currentController.signal.aborted).toBe(true)

      await Promise.all([recentPromise, retryPromise])
      expect(state.recentPagesAbortController).toBeNull()

      // Last logins AbortController test
      const loginsPromise = (state.loadLastLogins as () => Promise<void>)()
      expect(state.lastLoginsAbortController).not.toBeNull()
      expect(state.lastLoginsAbortController instanceof AbortController).toBe(true)

      // Unmounting should abort in-flight lastLogins request
      component.beforeUnmount.call(state)
      expect(state.lastLoginsAbortController).toBeNull()
    })
  })

  describe('prefers-reduced-motion fallback', () => {
    it('cleanly disables 3D transforms in media query', () => {
      const reducedMotionBlock = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'))
      expect(reducedMotionBlock).toMatch(/\.admin-stat,\s*\n\s*\.dashboard-connection\s*\{[^}]*transform:\s*none\s*!important;/s)
      expect(reducedMotionBlock).toMatch(/\.admin-stat,\s*\n\s*\.dashboard-connection\s*\{[^}]*transition:\s*none\s*!important;/s)
      expect(reducedMotionBlock).toMatch(/&::before\s*\{[^}]*display:\s*none\s*!important;/s)
      expect(reducedMotionBlock).toMatch(/transform:\s*none\s*!important;/s)
    })

    it('bypasses pointer move calculations when reduced motion is preferred', () => {
      const state: Record<string, unknown> = {
        ...component.data()
      }
      for (const [key, fn] of Object.entries(component.methods)) {
        state[key] = (fn as (...args: unknown[]) => unknown).bind(state)
      }

      // Mock prefers-reduced-motion = true
      mockWindow.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))

      const mockEvent = {
        clientX: 150,
        clientY: 220,
        currentTarget: {
          getBoundingClientRect: () => ({ left: 100, top: 200, width: 200, height: 100 })
        }
      } as unknown as PointerEvent

      ;(state.handleCardPointerMove as (e: PointerEvent, key: string) => void)(mockEvent, 'pages')
      // tiltStyles should remain unset because reduced motion is preferred
      expect((state.tiltStyles as Record<string, Record<string, string>>).pages).toBeUndefined()

      // Reset mock
      mockWindow.matchMedia = vi.fn().mockReturnValue({ matches: false })
    })
  })
})
