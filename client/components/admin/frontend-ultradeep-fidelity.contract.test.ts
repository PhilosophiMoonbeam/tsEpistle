import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from '../../../server/test/bun-test.mts'

describe('tsEpistle Frontend Modernization & Ultradeep Fidelity Contract', () => {
  describe('Opportunity 1: Cybernetic Hardware Telemetry & Gauge System', () => {
    const hardwareGaugePath = join(process.cwd(), 'client/components/admin/system/cybernetic-hardware-gauge.vue')
    const telemetryCardPath = join(process.cwd(), 'client/components/admin/system/hardware-telemetry-card.vue')
    const systemViewPath = join(process.cwd(), 'client/components/admin/admin-system.vue')

    const hardwareGaugeSfc = parse(readFileSync(hardwareGaugePath, 'utf8'), { filename: hardwareGaugePath })
    const telemetryCardSfc = parse(readFileSync(telemetryCardPath, 'utf8'), { filename: telemetryCardPath })
    const systemViewSfc = parse(readFileSync(systemViewPath, 'utf8'), { filename: systemViewPath })

    it('compiles cybernetic-hardware-gauge.vue, hardware-telemetry-card.vue, and admin-system.vue without errors', () => {
      expect(hardwareGaugeSfc.errors).toEqual([])
      expect(telemetryCardSfc.errors).toEqual([])
      expect(systemViewSfc.errors).toEqual([])
    })

    it('admin-system.vue uses shallowRef for snapshot to eliminate deep proxy overhead', () => {
      const script = systemViewSfc.descriptor.scriptSetup?.content ?? systemViewSfc.descriptor.script?.content ?? ''
      expect(script).toMatch(/import\s*\{[^}]*\bshallowRef\b[^}]*\}\s*from\s*['"]vue['"]/)
      expect(script).toMatch(/snapshot\s*=\s*shallowRef\b/)
    })

    it('cybernetic-hardware-gauge.vue imports and uses useId for SVG linearGradient and glow filter IDs', () => {
      const script = hardwareGaugeSfc.descriptor.scriptSetup?.content ?? ''
      const template = hardwareGaugeSfc.descriptor.template?.content ?? ''
      expect(script).toMatch(/import\s*\{[^}]*\buseId\b[^}]*\}\s*from\s*['"]vue['"]/)
      expect(script).toContain('useId()')
      expect(template).toContain(':id="gaugeFilterId"')
      expect(template).toContain(':id="heapGradId"')
      expect(template).toContain(':id="rssGradId"')
      expect(template).toContain('linearGradient')
      expect(template).toContain('feGaussianBlur')
    })

    it('cybernetic-hardware-gauge.vue renders twin concentric progress arcs for heap and RSS (stroke-dasharray, stroke-dashoffset)', () => {
      const template = hardwareGaugeSfc.descriptor.template?.content ?? ''
      expect(template).toContain(':stroke-dasharray="outerCircumference"')
      expect(template).toContain(':stroke-dashoffset="outerDashOffset"')
      expect(template).toContain(':stroke-dasharray="innerCircumference"')
      expect(template).toContain(':stroke-dashoffset="innerDashOffset"')
      expect(template).toContain('cybernetic-hardware-gauge__arc--outer')
      expect(template).toContain('cybernetic-hardware-gauge__arc--inner')
    })

    it('hardware-telemetry-card.vue implements glassmorphic border and specular hover styles', () => {
      const style = telemetryCardSfc.descriptor.styles.map(s => s.content).join('\n')
      expect(style).toContain('backdrop-filter: blur(')
      expect(style).toContain('border: 1px solid rgba(6, 182, 212, 0.25)')
      expect(style).toContain('box-shadow: 0 16px 36px -10px rgba(0, 0, 0, 0.3), 0 0 20px -4px rgba(6, 182, 212, 0.2)')
      expect(style).toContain('border-color: rgba(6, 182, 212, 0.45)')
    })
  })

  describe('Opportunity 2: Photon Reading Beam & Tactile Social Interactions', () => {
    const readingBeamPath = join(process.cwd(), 'client/themes/default/components/photon-reading-beam.vue')
    const pagePath = join(process.cwd(), 'client/themes/default/components/page.vue')
    const socialSharingPath = join(process.cwd(), 'client/components/common/social-sharing.vue')

    const readingBeamSfc = parse(readFileSync(readingBeamPath, 'utf8'), { filename: readingBeamPath })
    const pageSfc = parse(readFileSync(pagePath, 'utf8'), { filename: pagePath })
    const socialSharingSfc = parse(readFileSync(socialSharingPath, 'utf8'), { filename: socialSharingPath })

    it('compiles photon-reading-beam.vue, page.vue, and social-sharing.vue without errors', () => {
      expect(readingBeamSfc.errors).toEqual([])
      expect(pageSfc.errors).toEqual([])
      expect(socialSharingSfc.errors).toEqual([])
    })

    it('photon-reading-beam.vue implements traveling beam head (.laser-beam-head) and multi-stop gradient track', () => {
      const template = readingBeamSfc.descriptor.template?.content ?? ''
      const style = readingBeamSfc.descriptor.styles.map(s => s.content).join('\n')
      expect(template).toContain('class="laser-beam-head"')
      expect(style).toContain('.laser-beam-head')
      expect(style).toContain('linear-gradient(90deg, #06b6d4 0%, #3b82f6 50%, #8b5cf6 100%)')
    })

    it('photon-reading-beam.vue defines @keyframes reader-milestone-burst', () => {
      const style = readingBeamSfc.descriptor.styles.map(s => s.content).join('\n')
      expect(style).toContain('@keyframes reader-milestone-burst')
    })

    it('page.vue embeds photon-reading-beam component', () => {
      const template = pageSfc.descriptor.template?.content ?? ''
      const script = pageSfc.descriptor.script?.content ?? ''
      expect(template).toMatch(/photon-reading-beam/)
      expect(script).toContain("import PhotonReadingBeam from './photon-reading-beam.vue'")
    })

    it('social-sharing.vue implements tactile copy micro-interaction with @keyframes tactile-bounce', () => {
      const template = socialSharingSfc.descriptor.template?.content ?? ''
      const style = socialSharingSfc.descriptor.styles.map(s => s.content).join('\n')
      expect(template).toContain('icon-tactile-bounce')
      expect(style).toContain('@keyframes tactile-bounce')
      expect(style).toContain('animation: tactile-bounce')
    })
  })

  describe('Opportunity 3: Nav Search 3D Hotkey & Spectral Focus Halo', () => {
    const hotkeyPath = join(process.cwd(), 'client/components/common/nav-search-hotkey.vue')
    const navHeaderPath = join(process.cwd(), 'client/components/common/nav-header.vue')

    const hotkeySfc = parse(readFileSync(hotkeyPath, 'utf8'), { filename: hotkeyPath })
    const navHeaderSfc = parse(readFileSync(navHeaderPath, 'utf8'), { filename: navHeaderPath })

    it('compiles nav-search-hotkey.vue and nav-header.vue without errors', () => {
      expect(hotkeySfc.errors).toEqual([])
      expect(navHeaderSfc.errors).toEqual([])
    })

    it('nav-search-hotkey.vue implements 3D keycap physical press styles (scale(0.95) and translateY(1px))', () => {
      const style = hotkeySfc.descriptor.styles.map(s => s.content).join('\n')
      expect(style).toContain('scale(0.95)')
      expect(style).toContain('translateY(1px)')
      expect(style).toMatch(/transform:\s*translateY\(1px\)\s*scale\(0\.95\)/)
    })

    it('nav-header.vue embeds nav-search-hotkey and implements spectral focus halo (box-shadow: 0 0 20px -2px rgba(6, 182, 212, 0.45))', () => {
      const template = navHeaderSfc.descriptor.template?.content ?? ''
      const script = navHeaderSfc.descriptor.script?.content ?? ''
      const style = navHeaderSfc.descriptor.styles.map(s => s.content).join('\n')
      expect(template).toMatch(/nav-search-hotkey/)
      expect(script).toContain("import NavSearchHotkey from './nav-search-hotkey.vue'")
      expect(style).toContain('box-shadow: 0 0 20px -2px rgba(6, 182, 212, 0.45)')
    })
  })
})
