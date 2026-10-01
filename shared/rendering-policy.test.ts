import { describe, expect, it } from '../server/test/bun-test.mts'
import { buildRenderingPlan, renderingIssues, renderingSettings, type RenderingModule } from './rendering-policy.ts'
const module = (key: string, extra: Partial<RenderingModule> = {}): RenderingModule => ({ key, title: key, description: '', icon: '', isEnabled: true, dependsOn: null, input: null, output: null, step: null, order: 0, props: {}, config: {}, ...extra })
const pipeline = () => [module('htmlCore', { input: 'html', output: 'html' }), module('markdownCore', { input: 'markdown', output: 'html' }), module('markdownEmoji', { dependsOn: 'markdownCore' }), module('htmlSecurity', { dependsOn: 'htmlCore', step: 'post', order: 99999, config: { safeHTML: true } }), module('htmlTwemoji', { dependsOn: 'htmlCore', step: 'post', order: 10 }), module('htmlLinks', { dependsOn: 'htmlCore' })]
describe('effective rendering pipeline', () => {
  it('orders format transformations and HTML post-processors as the worker executes them', () => {
    const plan = buildRenderingPlan(pipeline(), 'markdown')
    expect(plan.map(stage => stage.core.key)).toEqual(['markdownCore', 'htmlCore'])
    expect(plan[0]!.before.map(module => module.key)).toEqual(['markdownEmoji'])
    expect(plan[1]!.before.map(module => module.key)).toEqual(['htmlLinks'])
    expect(plan[1]!.after.map(module => module.key)).toEqual(['htmlTwemoji', 'htmlSecurity'])
    expect(buildRenderingPlan(pipeline(), 'html').map(stage => stage.core.key)).toEqual(['htmlCore'])
    expect(buildRenderingPlan(pipeline(), 'unknown')).toEqual([])
  })
  it('leaves enabled children dormant when their core is disabled and reports missing transformations', () => {
    const modules = pipeline(); modules.find(module => module.key === 'markdownCore')!.isEnabled = false
    expect(buildRenderingPlan(modules, 'markdown')).toEqual([])
    expect(renderingIssues(modules, ['markdown'])).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'markdownEmoji', severity: 'warning' }), expect.objectContaining({ key: 'markdown', severity: 'warning' })]))
  })
  it('rejects cyclic formats without rejecting the HTML pass through', () => {
    const modules = [module('a', { input: 'a', output: 'b' }), module('b', { input: 'b', output: 'a' })]
    expect(() => buildRenderingPlan(modules, 'a')).toThrow('cycle')
    expect(renderingIssues(modules, ['a']).some(issue => issue.severity === 'error')).toBe(true)
  })
  it('validates actual configuration types, enums, numeric limits and diagram endpoints', () => {
    const invalidModules = [
      module('numericOption', { props: { tabWidth: { type: 'number' } }, config: { tabWidth: '4' } }),
      module('markdownExpandtabs', { props: { tabWidth: { type: 'number' } }, config: { tabWidth: '4' } }),
      module('markdownExpandtabs', { props: { tabWidth: { type: 'number' } }, config: { tabWidth: 0 } }),
      module('markdownExpandtabs', { props: { tabWidth: { type: 'number' } }, config: { tabWidth: 33 } }),
      module('asciidocCore', { props: { safeMode: { type: 'string', enum: ['secure'] } }, config: { safeMode: 'invalid' } }),
      module('markdownKroki', { config: { server: 'javascript:run()', openMarker: 'open', closeMarker: 'close' } }),
      module('markdownKroki', { config: { server: 'https://diagrams.example.invalid', openMarker: 'same', closeMarker: 'same' } })
    ]
    for (const invalidModule of invalidModules) {
      expect(renderingIssues([invalidModule])).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: invalidModule.key, severity: 'error' })
      ]))
    }
  })
  it('reports sanitization and competing math engines as configuration effects', () => {
    const modules = pipeline(); modules.find(module => module.key === 'htmlSecurity')!.isEnabled = false; modules.push(module('markdownKatex'), module('markdownMathjax'))
    const issues = renderingIssues(modules, ['markdown'])
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'htmlSecurity', severity: 'warning' }),
      expect.objectContaining({ key: 'markdownMathjax', severity: 'warning' })
    ]))
  })
  it('only sends declared configuration options without mutating drafts', () => {
    const modules = [module('one', { props: { option: { type: 'boolean' } }, config: { option: false, internal: 42 } })]
    expect(renderingSettings(modules)[0]!.config).toEqual({ option: false })
    expect(modules[0]!.config.internal).toBe(42)
  })
})
