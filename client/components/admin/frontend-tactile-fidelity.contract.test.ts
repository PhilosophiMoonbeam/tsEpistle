import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from '../../../server/test/bun-test.mts'

describe('tsEpistle Frontend Modernization & Neuromarketing Tactile Fidelity Contract', () => {
  describe('Opportunity 1: Fintech Security Posture Command Center', () => {
    const gaugePath = join(process.cwd(), 'client/components/admin/security/security-posture-gauge.vue')
    const tiltCardPath = join(process.cwd(), 'client/components/admin/security/tactile-tilt-card.vue')
    const counterPath = join(process.cwd(), 'client/components/admin/security/animated-counter.vue')
    const beaconPath = join(process.cwd(), 'client/components/admin/security/radar-pulse-beacon.vue')
    const securityViewPath = join(process.cwd(), 'client/components/admin/admin-security.vue')

    const gaugeSfc = parse(readFileSync(gaugePath, 'utf8'), { filename: gaugePath })
    const tiltCardSfc = parse(readFileSync(tiltCardPath, 'utf8'), { filename: tiltCardPath })
    const counterSfc = parse(readFileSync(counterPath, 'utf8'), { filename: counterPath })
    const beaconSfc = parse(readFileSync(beaconPath, 'utf8'), { filename: beaconPath })
    const securityViewSfc = parse(readFileSync(securityViewPath, 'utf8'), { filename: securityViewPath })

    it('compiles all security tactile subcomponents without SFC compiler errors', () => {
      expect(gaugeSfc.errors).toEqual([])
      expect(tiltCardSfc.errors).toEqual([])
      expect(counterSfc.errors).toEqual([])
      expect(beaconSfc.errors).toEqual([])
      expect(securityViewSfc.errors).toEqual([])
    })

    it('security-posture-gauge implements Vue 3.5 useId, SVG multi-stop concentric arc and glow filter', () => {
      const script = gaugeSfc.descriptor.scriptSetup?.content ?? ''
      const template = gaugeSfc.descriptor.template?.content ?? ''
      expect(script).toMatch(/import\s*\{[^}]*\buseId\b[^}]*\}\s*from\s*['"]vue['"]/)
      expect(template).toContain('<filter :id="filterId"')
      expect(template).toContain('feGaussianBlur')
      expect(template).toContain('<linearGradient :id="gradientId"')
      expect(template).toContain('class="posture-gauge"')
      expect(script).toContain("status: 'Fortified'")
      expect(script).toContain("status: 'Exposure Detected'")
    })

    it('tactile-tilt-card implements 3D perspective tilt and dynamic specular reflection', () => {
      const script = tiltCardSfc.descriptor.scriptSetup?.content ?? ''
      const style = tiltCardSfc.descriptor.styles.map(s => s.content).join('\n')
      expect(script).toMatch(/import\s*\{[^}]*\buseTemplateRef\b[^}]*\}\s*from\s*['"]vue['"]/)
      expect(script).toContain('perspective(1000px)')
      expect(script).toContain('radial-gradient(circle at')
      expect(style).toContain('transform-style: preserve-3d;')
      expect(style).toContain('pointer-events: none;')
    })

    it('animated-counter implements cubic ease-out rollup interpolation', () => {
      const script = counterSfc.descriptor.scriptSetup?.content ?? ''
      expect(script).toContain('requestAnimationFrame')
      expect(script).toContain('1 - Math.pow(1 - progress, 3)')
      expect(script).toContain('cancelAnimationFrame')
    })

    it('radar-pulse-beacon renders multi-ring active defence ping', () => {
      const style = beaconSfc.descriptor.styles.map(s => s.content).join('\n')
      const template = beaconSfc.descriptor.template?.content ?? ''
      expect(template).toContain('class="radar-beacon"')
      expect(style).toContain('@keyframes radar-ping')
      expect(style).toContain('animation: radar-ping')
    })

    it('admin-security.vue integrates the posture score and tactile components into the workspace', () => {
      const script = securityViewSfc.descriptor.script?.content ?? ''
      const template = securityViewSfc.descriptor.template?.content ?? ''
      expect(script).toContain('securityPostureScore')
      expect(script).toContain('authEnforce2FA')
      expect(script).toContain('securityCSP')
      expect(template).toContain('<security-posture-gauge')
      expect(template).toContain('<tactile-tilt-card')
      expect(template).toContain('<animated-counter')
      expect(template).toContain('<radar-pulse-beacon')
    })
  })

  describe('Opportunity 2: Luminous Knowledge Constellation Topology & HUD Reticle', () => {
    const hudPath = join(process.cwd(), 'client/components/admin/visualize/constellation-hud.vue')
    const visualizePath = join(process.cwd(), 'client/components/admin/admin-pages-visualize.vue')

    const hudSfc = parse(readFileSync(hudPath, 'utf8'), { filename: hudPath })
    const visualizeSfc = parse(readFileSync(visualizePath, 'utf8'), { filename: visualizePath })

    it('compiles constellation HUD and visualize SFC without compiler errors', () => {
      expect(hudSfc.errors).toEqual([])
      expect(visualizeSfc.errors).toEqual([])
    })

    it('constellation-hud implements laser corner brackets, telemetry readouts, and accessible jump link', () => {
      const template = hudSfc.descriptor.template?.content ?? ''
      const style = hudSfc.descriptor.styles.map(s => s.content).join('\n')
      expect(template).toContain('class="constellation-hud"')
      expect(template).toContain('class="laser-corner corner--tl"')
      expect(template).toContain('hud-metric--incoming')
      expect(template).toContain('hud-metric--outgoing')
      expect(template).toContain('JUMP TO PAGE')
      expect(style).toContain('backdrop-filter: blur(')
      expect(style).toContain('rgba(6, 182, 212')
    })

    it('admin-pages-visualize.vue injects SVG multi-stage neon glow filter and degree-scaled node halos', () => {
      const template = visualizeSfc.descriptor.template?.content ?? ''
      const script = visualizeSfc.descriptor.script?.content ?? ''

      expect(script).toContain("attr('id', 'constellation-glow')")
      expect(script).toContain("attr('filter', 'url(#constellation-glow)')")
      expect(script).toContain("attr('id', 'link-gradient-incoming')")
      expect(script).toContain("attr('id', 'link-gradient-outgoing')")
      expect(script).toContain("attr('stroke', 'url(#link-gradient-incoming)')")
      expect(script).toContain("attr('stroke', 'url(#link-gradient-outgoing)')")
      expect(template).toContain('<constellation-hud')

      expect(script).toContain('Math.sqrt(inCount + outCount)')
      expect(script).toContain('constellation-halo')
    })
  })

  describe('Opportunity 3: Cybernetic Neural Execution HUD & Agent Telemetry', () => {
    const laserMeterPath = join(process.cwd(), 'client/components/agents/neural-laser-meter.vue')
    const dialPath = join(process.cwd(), 'client/components/agents/agent-velocity-dial.vue')
    const goalStatusPath = join(process.cwd(), 'client/components/agents/agent-goal-status.vue')
    const taskProgressPath = join(process.cwd(), 'client/components/agents/agent-task-progress.vue')

    const laserMeterSfc = parse(readFileSync(laserMeterPath, 'utf8'), { filename: laserMeterPath })
    const dialSfc = parse(readFileSync(dialPath, 'utf8'), { filename: dialPath })
    const goalStatusSfc = parse(readFileSync(goalStatusPath, 'utf8'), { filename: goalStatusPath })
    const taskProgressSfc = parse(readFileSync(taskProgressPath, 'utf8'), { filename: taskProgressPath })

    it('compiles neural HUD and agent execution subcomponents without compiler errors', () => {
      expect(laserMeterSfc.errors).toEqual([])
      expect(dialSfc.errors).toEqual([])
      expect(goalStatusSfc.errors).toEqual([])
      expect(taskProgressSfc.errors).toEqual([])
    })

    it('neural-laser-meter implements traveling beam head and multi-stop gradient track', () => {
      const template = laserMeterSfc.descriptor.template?.content ?? ''
      const style = laserMeterSfc.descriptor.styles.map(s => s.content).join('\n')
      expect(template).toContain('class="laser-meter"')
      expect(template).toContain('class="laser-meter__head"')
      expect(style).toContain('linear-gradient(90deg, #06b6d4 0%, #3b82f6 50%, #8b5cf6 100%)')
      expect(style).toContain('@keyframes pulse-head')
      expect(style).toContain('&--warning')
      expect(style).toContain('&--critical')
    })

    it('agent-velocity-dial uses Vue 3.5 onWatcherCleanup for reactive interval teardown', () => {
      const script = dialSfc.descriptor.scriptSetup?.content ?? ''
      expect(script).toMatch(/import\s*\{[^}]*\bonWatcherCleanup\b[^}]*\}\s*from\s*['"]vue['"]/)
      expect(script).toContain('onWatcherCleanup(() =>')
    })

    it('agent-task-progress strictly imports only from vue and implements synaptic micro-burst', () => {
      const script = taskProgressSfc.descriptor.scriptSetup?.content ?? ''
      const style = taskProgressSfc.descriptor.styles.map(s => s.content).join('\n')
      expect(script).toMatch(/import\s*\{[^}]*\bonWatcherCleanup\b[^}]*\}\s*from\s*['"]vue['"]/)
      expect(style).toContain('@keyframes synaptic-burst')
      expect(style).toContain('@keyframes laser-pulse')
    })

    it('agent-goal-status embeds glowing laser meter and retains accessible control target size', () => {
      const template = goalStatusPath.length > 0 ? readFileSync(goalStatusPath, 'utf8') : ''
      expect(template).toContain('agent-goal__meter-fill')
      expect(template).toContain('agent-goal__meter-head')
      expect(template).toContain('agent-goal__toggle')
    })
  })
})
