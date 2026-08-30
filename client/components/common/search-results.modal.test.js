import fs from 'node:fs'
import path from 'node:path'

describe('Ask modal accessibility contract', () => {
  const search = fs.readFileSync(path.join(process.cwd(), 'client/components/common/search-results.vue'), 'utf8')
  const header = fs.readFileSync(path.join(process.cwd(), 'client/components/common/nav-header.vue'), 'utf8')

  test('wires the Agent surface to one focus and background lifecycle', () => {
    expect(search).toMatch(/:role=['"]isAgentOpen \? `dialog` : `region`['"]/)
    expect(search).toMatch(/:aria-modal=['"]isAgentOpen \? `true` : undefined['"]/)
    expect(search).toMatch(/createModalFocusScope\(\{[\s\S]*root,[\s\S]*restoreTarget,[\s\S]*onEscape:\s*this\.closeSearch/)
    expect(search).toMatch(/await \(this\.\$refs\.inlineAgent[\s\S]*\?\.focusComposer\(\)/)
    expect(search).toMatch(/deactivateAgentModal\(false\)/)
    expect(header.match(/v-text-field\.nav-header-search-control/g)).toHaveLength(2)
  })
})
