import fs from 'node:fs'
import path from 'node:path'

describe('Ask modal accessibility contract', () => {
  const search = fs.readFileSync(path.join(process.cwd(), 'client/components/common/search-results.vue'), 'utf8')
  const header = fs.readFileSync(path.join(process.cwd(), 'client/components/common/nav-header.vue'), 'utf8')
  const tags = fs.readFileSync(path.join(process.cwd(), 'client/components/tags.vue'), 'utf8')
  const focusScope = fs.readFileSync(path.join(process.cwd(), 'client/components/common/modal-focus-scope.ts'), 'utf8')

  test('exposes modal semantics only while Ask owns the complete focus scope', () => {
    expect(search).toMatch(/role=['"]dialog['"]/)
    expect(search).toMatch(/:aria-modal=['"]isAgentOpen \? `true` : undefined['"]/)
    expect(search).not.toMatch(/^\s+aria-modal=['"]true['"]/m)
    expect(search).toMatch(/:aria-labelledby=['"]isAgentOpen \? `wiki-agent-title` : `wiki-search-title`['"]/)
    const agentFocusScope = search.match(/const focusScope = createModalFocusScope\(\{([\s\S]*?)\n\s+\}\)/)?.[1] ?? ''
    const searchFocusScope = search.match(/this\.searchModalFocusScope = createModalFocusScope\(\{([\s\S]*?)\n\s+\}\)/)?.[1] ?? ''
    expect(agentFocusScope).toMatch(/root,[\s\S]*restoreTarget:\s*this\.restoreTargetFor\(agentOpener\),[\s\S]*onEscape:\s*this\.returnToSearch/)
    expect(agentFocusScope).not.toMatch(/additionalRoots/)
    expect(searchFocusScope).toMatch(/additionalRoots:\s*this\.searchModalAdditionalRoots/)
    expect(search).toMatch(
      /isAgentOpen\(open:\s*boolean\)\s*\{[\s\S]*if\s*\(open\)\s*\{[\s\S]*void this\.activateAgentModal\(\)[\s\S]*return[\s\S]*if \(this\.directPromptHandoffPending\) this\.directPromptHandoffId \+= 1[\s\S]*if\s*\(this\.searchIsFocused\)\s*void this\.reactivateSearchModal\(\)[\s\S]*else this\.deactivateAgentModal\(false\)/
    )
    expect(search).toMatch(
      /searchIsFocused\(open:\s*boolean\)\s*\{[\s\S]*if\s*\(open\)\s*\{[\s\S]*void this\.activateAgentModal\(\)[\s\S]*return[\s\S]*const restoreFocus = this\.searchExitRestoreFocus[\s\S]*this\.finishSearchFocus\(restoreFocus\)/
    )
    expect(search).toMatch(
      /createModalFocusScope\(\{[\s\S]*root,[\s\S]*restoreTarget:\s*this\.restoreTargetFor\(agentOpener\),[\s\S]*onEscape:\s*this\.returnToSearch/
    )
    expect(search).toMatch(
      /activateSearchModal\(restoreTarget:[\s\S]*createModalFocusScope\(\{[\s\S]*root,[\s\S]*restoreTarget:\s*this\.restoreTargetFor\(restoreTarget\),[\s\S]*additionalRoots:[\s\S]*onEscape:\s*this\.closeSearch/
    )
    expect(search).toMatch(/search\(newValue:[\s\S]*query\.trim\(\)\.length >= 2\) this\.searchIsFocused = true/)
    expect(search).toMatch(
      /reactivateSearchModal\(\):[\s\S]*this\.deactivateAgentModal\(true\)[\s\S]*this\.activateSearchModal\(this\.searchRestoreTarget \?\? this\.findSearchTrigger\(\)\)/
    )
    expect(search).toMatch(
      /restoreTargetFor\(target:[\s\S]*target\?\.isConnected && target\.tabIndex >= 0[\s\S]*replacement && replacement\.tabIndex >= 0[\s\S]*return this\.findSearchTrigger\(\)/
    )
    expect(search).toMatch(/this\.activateSearchModal\(searchOpener\)/)
    expect(search).toMatch(/active !== document\.body[\s\S]*active\.tabIndex >= 0/)
    const backgroundIsolation = focusScope.match(/const hideBackground = ([\s\S]*?)(?=\nconst restoreBackground)/)?.[1] ?? ''
    expect(backgroundIsolation).toMatch(/for \(const protectedRoot of \[root, \.\.\.additionalRoots\]\)[\s\S]*protectedElements\.add\(current\)/)
    expect(backgroundIsolation).toMatch(
      /element\.classList\.contains\('v-overlay-container'\)[\s\S]*for \(const overlay of element\.children\)[\s\S]*protectedElements\.has\(overlay as HTMLElement\)[\s\S]*hideElement\(overlay as HTMLElement\)/
    )
    expect(backgroundIsolation).toMatch(/element\.inert = true[\s\S]*element\.setAttribute\('aria-hidden', 'true'\)/)
    const backgroundReconciliation = focusScope.match(/const reconcileBackgrounds = ([\s\S]*?)(?=\nconst restoreTargetElement)/)?.[1] ?? ''
    expect(backgroundReconciliation).toMatch(/stack\.map\(state => state\.additionalRoots\(\)\)/)
    expect(backgroundReconciliation).toMatch(/state\.observedAdditionalRoots = nextAdditionalRoots\[index\]!/)
    expect(backgroundReconciliation).toMatch(
      /restoreBackground\(stack\[index\]!\.background\)[\s\S]*nestedState\.root,[\s\S]*nextAdditionalRoots\[[\s\S]*state\.background = hideBackground\(state\.root, \[\.\.\.state\.observedAdditionalRoots, \.\.\.nestedRoots\]\)/
    )
    const overlayObserver = focusScope.match(/const backgroundObserver = ([\s\S]*?)(?=\n\s*const modalAdditionalRoots)/)?.[1] ?? ''
    expect(overlayObserver).toMatch(/new MutationObserverConstructor\([\s\S]*reconcileBackgrounds\(document, true\)/)
    expect(overlayObserver).toMatch(/observe\(document\.body, \{ childList: true, subtree: true \}\)/)
    expect(focusScope).not.toMatch(/querySelectorAll[\s\S]{0,120}v-overlay--active/)
    expect(search).toMatch(
      /closeSearch\(\):\s*void\s*\{[\s\S]*this\.finishSearchFocus\(\)[\s\S]*this\.searchIsFocused\s*=\s*false[\s\S]*this\.searchMode\s*=\s*['"]search['"]/
    )
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

  test('keeps Browse Tags operable in the search focus scope without exposing every action slot on mobile', () => {
    expect(header).toMatch(/v-btn\.nav-header-browse\([^\n]*href='\/t'[^\n]*data-search-modal-action/)
    expect(header).toMatch(/v-btn\.nav-header-search-toggle\([\s\S]*?data-search-modal-action/)
    expect(header).toMatch(/mobileActions:\s*\{[\s\S]*?type: Boolean,[\s\S]*?default: false[\s\S]*?\}/)
    expect(header).toMatch(/\.nav-header-slot-actions\(v-if='\$vuetify\.display\.mdAndUp \|\| mobileActions'\)\s*\n\s*slot\(name='actions'\)/)
    expect(tags).toMatch(/nav-header\(mobile-actions\)/)
    expect(tags).toMatch(/v-btn\.tags-filter-toggle\([\s\S]*?data-search-modal-action/)
    expect(search).toMatch(/additionalRoots:\s*this\.searchModalAdditionalRoots/)
    expect(search).toMatch(/searchModalAdditionalRoots\(\): HTMLElement\[\][\s\S]*\.nav-header-search-control input, \[data-search-modal-action\]/)
  })

  test('restores the exact pre-search trigger without retaining search focus or mode', () => {
    expect(search).toMatch(/document\.addEventListener\('focusin', this\.captureSearchRestoreTarget, true\)/)
    expect(search).toMatch(/document\.removeEventListener\('focusin', this\.captureSearchRestoreTarget, true\)/)
    expect(search).toMatch(
      /captureSearchRestoreTarget\(event: FocusEvent\): void[\s\S]*event\.relatedTarget[\s\S]*!this\.isSearchControl\(previous\)[\s\S]*\? previous[\s\S]*: null/
    )
    expect(search).toMatch(
      /const searchOpener = this\.searchRestoreTarget \?\?[\s\S]*this\.isSearchControl\(activeOpener\) \? null : activeOpener[\s\S]*this\.findSearchTrigger\(\)/
    )
    expect(search).toMatch(/const agentOpener = this\.pendingAskRestoreTarget \?\? activeOpener \?\? this\.findSearchControl\(\)/)
    expect(search).toMatch(
      /finishSearchFocus\(restoreFocus = true\): void[\s\S]*this\.deactivateModalLayers\(restoreFocus\)[\s\S]*this\.isSearchControl\(active\)[\s\S]*active\.blur\(\)[\s\S]*this\.searchRestoreTarget = null/
    )
    expect(header).toMatch(
      /searchTab \(event: KeyboardEvent\)[\s\S]*event\.preventDefault\(\)[\s\S]*emitSearchExit\(false\)[\s\S]*this\.searchClose\(\)[\s\S]*nav-header-browse/
    )
    expect(header).toMatch(/searchIsFocused\(open: boolean\): void[\s\S]*!open && this\.\$vuetify\.display\.smAndDown[\s\S]*this\.searchIsShown = false/)
    expect(header).toMatch(/searchClose \(\)[\s\S]*this\.searchIsFocused = false[\s\S]*this\.searchMode = 'search'[\s\S]*this\.search = ''/)
  })
})
