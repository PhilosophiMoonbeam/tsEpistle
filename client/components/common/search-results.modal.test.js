import fs from 'node:fs'
import path from 'node:path'

describe('Ask modal accessibility contract', () => {
  const search = fs.readFileSync(path.join(process.cwd(), 'client/components/common/search-results.vue'), 'utf8')
  const header = fs.readFileSync(path.join(process.cwd(), 'client/components/common/nav-header.vue'), 'utf8')
  const focusScope = fs.readFileSync(path.join(process.cwd(), 'client/components/common/modal-focus-scope.ts'), 'utf8')

  test('stacks Search and Ask in one accessible modal focus lifecycle', () => {
    expect(search).toMatch(/role=['"]dialog['"]/)
    expect(search).toMatch(/aria-modal=['"]true['"]/)
    expect(search).toMatch(/:aria-labelledby=['"]isAgentOpen \? `wiki-agent-title` : `wiki-search-title`['"]/)
    expect(search).toMatch(
      /isAgentOpen\(open:\s*boolean\)\s*\{[\s\S]*if\s*\(open\)\s*\{[\s\S]*void this\.activateAgentModal\(\)[\s\S]*return[\s\S]*if \(this\.directPromptHandoffPending\) this\.directPromptHandoffId \+= 1[\s\S]*if\s*\(this\.searchIsFocused\)\s*void this\.reactivateSearchModal\(\)[\s\S]*else this\.deactivateAgentModal\(false\)/
    )
    expect(search).toMatch(
      /searchIsFocused\(open:\s*boolean\)\s*\{[\s\S]*if\s*\(open\)\s*void this\.activateAgentModal\(\)[\s\S]*else this\.deactivateModalLayers\(true\)/
    )
    expect(search).toMatch(
      /createModalFocusScope\(\{[\s\S]*root,[\s\S]*restoreTarget:\s*this\.restoreTargetFor\(opener\),[\s\S]*onEscape:\s*this\.returnToSearch/
    )
    expect(search).toMatch(
      /activateSearchModal\(restoreTarget:[\s\S]*createModalFocusScope\(\{[\s\S]*root,[\s\S]*restoreTarget:\s*this\.restoreTargetFor\(restoreTarget\),[\s\S]*additionalRoots:[\s\S]*onEscape:\s*this\.closeSearch/
    )
    expect(search).toMatch(/search\(newValue:[\s\S]*query\.trim\(\)\.length >= 2\) this\.searchIsFocused = true/)
    expect(search).toMatch(/reactivateSearchModal\(\):[\s\S]*this\.deactivateAgentModal\(true\)[\s\S]*this\.activateSearchModal\(this\.findSearchControl\(\)\)/)
    expect(search).toMatch(
      /restoreTargetFor\(target:[\s\S]*target\?\.isConnected && target\.tabIndex >= 0[\s\S]*replacement && replacement\.tabIndex >= 0[\s\S]*return this\.findSearchControl\(\)/
    )
    expect(search).toMatch(/this\.activateSearchModal\(opener \?\? this\.findSearchControl\(\)\)/)
    expect(search).toMatch(/active !== document\.body && active\.tabIndex >= 0/)
    expect(focusScope).toMatch(/new MutationObserverConstructor\(\(\) => reconcileBackgrounds\(document\)\)/)
    expect(focusScope).toMatch(
      /nextAdditionalRoots = stack\.map\(state => state\.additionalRoots\(\)\)[\s\S]*restoreBackground\(stack\[index\]!\.background\)[\s\S]*hideBackground\(state\.root, state\.observedAdditionalRoots\)/
    )
    expect(search).toMatch(/closeSearch\(\):\s*void\s*\{[\s\S]*this\.deactivateModalLayers\(true\)[\s\S]*this\.searchIsFocused\s*=\s*false/)
    expect(search).toMatch(/await \(this\.\$refs\.inlineAgent[\s\S]*\?\.focusComposer\(\)/)
    expect(header.match(/v-text-field\.nav-header-search-control/g)).toHaveLength(2)
    expect(search).toMatch(/searchListIds\(\): string/)
    expect(search).toMatch(/for \(const input of controls\)/)
    expect(search).toMatch(/input\.removeAttribute\('aria-describedby'\)/)
    expect(focusScope).toMatch(/element\.tabIndex >= 0/)
    expect(focusScope).toMatch(/!element\.matches\(':disabled'\)/)
    const modalFocusableElements = focusScope.match(/const getModalFocusableElements = ([\s\S]*?)(?=\nconst hideBackground)/)?.[1] ?? ''
    expect(modalFocusableElements).toMatch(/new Set\s*\(/)
    expect(focusScope).toMatch(/event\.stopImmediatePropagation\(\)/)
    expect(focusScope).toMatch(/target\.focus\(\{ preventScroll: true \}\)/)
  })
})
