import fs from 'node:fs'
import path from 'node:path'

describe('Ask modal accessibility contract', () => {
  const search = fs.readFileSync(path.join(process.cwd(), 'client/components/common/search-results.vue'), 'utf8')
  const header = fs.readFileSync(path.join(process.cwd(), 'client/components/common/nav-header.vue'), 'utf8')

  test('keeps Search and Agent in one accessible modal focus lifecycle', () => {
    expect(search).toMatch(/role=['"]dialog['"]/)
    expect(search).toMatch(/aria-modal=['"]true['"]/)
    expect(search).toMatch(/:aria-labelledby=['"]isAgentOpen \? `wiki-agent-title` : `wiki-search-title`['"]/)
    expect(search).toMatch(
      /searchIsFocused\(open:\s*boolean\)\s*\{[\s\S]*if\s*\(this\.isAgentOpen\)\s*return[\s\S]*if\s*\(open\)\s*void this\.activateAgentModal\(\)[\s\S]*else this\.deactivateAgentModal\(\)/
    )
    expect(search).toMatch(/createModalFocusScope\(\{[\s\S]*root,[\s\S]*restoreTarget,[\s\S]*onEscape:\s*this\.closeSearch/)
    expect(search).toMatch(/this\.activateSearchModal\(restoreTarget\)/)
    expect(search).toMatch(/await \(this\.\$refs\.inlineAgent[\s\S]*\?\.focusComposer\(\)/)
    expect(search).toMatch(/deactivateAgentModal\(false\)/)
    expect(header.match(/v-text-field\.nav-header-search-control/g)).toHaveLength(2)
  })
})
