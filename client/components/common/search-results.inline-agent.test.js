import fs from 'node:fs'
import path from 'node:path'

describe('inline Ask mode contract', () => {
  const searchPath = path.join(process.cwd(), 'client/components/common/search-results.vue')
  const inlinePath = path.join(process.cwd(), 'client/components/agents/inline-agent-chat.vue')
  const historyPath = path.join(process.cwd(), 'client/components/agents/agent-history-panel.vue')
  const historyActionsPath = path.join(process.cwd(), 'client/components/agents/agent-history-session-actions.vue')
  const memoryPath = path.join(process.cwd(), 'client/components/agents/agent-memory-manager.vue')
  const headerPath = path.join(process.cwd(), 'client/components/common/nav-header.vue')
  const composerPath = path.join(process.cwd(), 'client/components/agents/agent-composer.vue')
  const focusScopePath = path.join(process.cwd(), 'client/components/common/modal-focus-scope.ts')
  const settingsPath = path.join(process.cwd(), 'client/components/agents/agent-session-settings.vue')
  const search = fs.readFileSync(searchPath, 'utf8')
  const inline = fs.readFileSync(inlinePath, 'utf8')
  const history = fs.readFileSync(historyPath, 'utf8')
  const historyActions = fs.readFileSync(historyActionsPath, 'utf8')
  const memory = fs.readFileSync(memoryPath, 'utf8')
  const composer = fs.readFileSync(composerPath, 'utf8')
  const settings = fs.readFileSync(settingsPath, 'utf8')
  const focusScope = fs.readFileSync(focusScopePath, 'utf8')
  const header = fs.readFileSync(headerPath, 'utf8')
  const template = search.match(/<template[^>]*>\s*([\s\S]*?)\s*<\/template>/)?.[1] ?? ''

  test('renders Ask as an immersive conversation instead of launching another application', () => {
    expect(template).toMatch(/InlineAgentChat\s*\(/)
    expect(template).toMatch(/v-if=['"]isAgentOpen['"]/)
    expect(template).toMatch(/search-results-agent-nav/)
    expect(template).toMatch(/role=['"]dialog['"]/)
    expect(template).toMatch(/aria-modal=['"]true['"]/)
    expect(template).toMatch(/:aria-labelledby=['"]isAgentOpen \? `wiki-agent-title` : `wiki-search-title`['"]/)
    expect(search).toMatch(/&--ask\s*\{[\s\S]*height:\s*100dvh[\s\S]*inset:\s*0[\s\S]*overflow:\s*hidden[\s\S]*z-index:\s*1009/)
    expect(search).toMatch(
      /&--ask\s*\{[\s\S]*color-mix\(in srgb, var\(--wiki-ambient-accent\) 5%, rgb\(var\(--v-theme-background\)\)\)[\s\S]*rgb\(var\(--v-theme-background\)\)[\s\S]*isolation:\s*isolate/
    )
    expect(search).toMatch(/&--ask\s*\{\s*animation:\s*none/)
    expect(search).toMatch(/&--ask\s*\{[\s\S]*animation:\s*agentWorkspaceReveal var\(--wiki-motion-slow\)/)
    expect(search).toMatch(/&:not\(\.search-results--ask\)\s*\{[\s\S]*top:\s*calc\(var\(--v-layout-top,\s*72px\) \+ 48px\)/)
    expect(template).not.toMatch(/action=['"]\/_?api\/agents\/launch['"]/)
    expect(template).not.toMatch(/target=['"]_blank['"]/)
    expect(search).toMatch(/if\s*\(!inlineAgent\)\s*return/)
    expect(search).toMatch(/inlineAgent\.sendPrompt\(prompt\)/)
    expect(search).toMatch(/inlineAgent\.focusConversation\(\)/)
  })

  test('reuses authenticated sessions without changing the Wiki page route', () => {
    expect(inline).toMatch(/agents\.initialize\(props\.csrfToken,\s*\{[\s\S]*routeSync:\s*false[\s\S]*reuseLatest:\s*true/)
    expect(inline).toMatch(/<AgentThread/)
    expect(inline).toMatch(/<AgentComposer/)
    expect(inline).toMatch(/currentPage:\s*currentPage\.value/)
    expect(inline).not.toMatch(/window\.(?:open|location)/)
  })
  test('uses the Agent workspace side space for persistent history and memory panels', () => {
    expect(inline).toMatch(/inline-agent__side--history/)
    expect(inline).toMatch(/<AgentHistoryPanel/)
    expect(inline).toMatch(/inline-agent__side--memory/)
    expect(inline).toMatch(/<AgentMemoryManager :model-value="memoryOpen"[\s\S]*@update:model-value="updateMemoryOpen"/)
    expect(search).toMatch(/&--ask \.inline-agent\s*\{[\s\S]*max-width:\s*112rem/)
    expect(inline).toMatch(/max-width:\s*var\(--wiki-shell-max\)/)
    expect(inline).toMatch(/@media \(max-width:\s*1711\.98px\)/)
    expect(inline).not.toMatch(/<v-menu location="bottom end">[\s\S]*?aria-label="Open agent conversation history"[\s\S]*?<\/v-menu>/)
    expect(inline).toMatch(/Open Agent panels: conversation history and memory/)
    expect(memory).not.toMatch(/<v-dialog v-model="open"/)
  })

  test('keeps direct panel controls on desktop and groups them only on mobile', () => {
    expect(inline).toMatch(/aria-label="Open agent conversation history"/)
    expect(inline).toMatch(/aria-label="Manage agent memory"/)
    expect(inline).toMatch(/\.inline-agent__mobile-panel-menu\s*\{\s*display:\s*none !important/)
    expect(inline).toMatch(
      /@media \(max-width: 639\.98px\)\s*\{[\s\S]*\.inline-agent__desktop-panel-btn\s*\{\s*display:\s*none;[\s\S]*\.inline-agent__mobile-panel-menu\s*\{\s*display:\s*inline-flex !important;/
    )
  })

  test('offers durable folders, explicit unfiling, and individual deletion in history', () => {
    expect(history).toMatch(/New folder/)
    expect(history).toMatch(/Filed conversations do not expire/)
    expect(historyActions).toMatch(/title="Recent"[\s\S]*Returns to the 90-day history window/)
    expect(historyActions).toMatch(/Delete conversation/)
    expect(history).toMatch(/fresh 90-day timer/)
    expect(history).toMatch(/agents\.moveSessionToFolder/)
    expect(history).toMatch(/agents\.removeSession/)
  })

  test('passes agent feature flags and exposes explicit skill and goal controls', () => {
    expect(search).toMatch(/:skills-enabled=['"]agentSkillsEnabled['"]/)
    expect(search).toMatch(/:goals-enabled=['"]agentGoalsEnabled['"]/)
    expect(inline).toMatch(/<AgentPersonalSkills/)
    expect(inline).toMatch(/:invocation-limit="invocationLimit"/)
    expect(inline).toMatch(/agents\.send\(prompt, invokedSkillVersionIds, mode\)/)
    expect(composer).toMatch(/Start goal/)
  })

  test('keeps Escape dismissal tied to the active trailing command token', () => {
    expect(composer).toMatch(/const dismissedCommandToken\s*=\s*ref<\{\s*start:\s*number;\s*prefix:\s*string\s*\}\s*\|\s*null>\(null\)/)

    const candidateStart = composer.indexOf('const skillCommandCandidate')
    const candidateEnd = composer.indexOf('const skillCommandMatch', candidateStart)
    expect(candidateStart).toBeGreaterThanOrEqual(0)
    expect(candidateEnd).toBeGreaterThan(candidateStart)
    const candidate = composer.slice(candidateStart, candidateEnd)
    expect(candidate).toMatch(/computed<SkillCommandMatch\s*\|\s*null>/)
    expect(candidate).toMatch(/\.exec\(\s*draft\.value\s*\)/)
    expect(candidate).not.toMatch(/dismissedCommandToken|dismissed/)
    expect(candidate).toMatch(/const boundary\s*=\s*match\[1\]/)
    expect(candidate).toMatch(/query:\s*match\[2\]/)
    expect(candidate).toMatch(/start:\s*match\.index\s*\+\s*boundary\.length/)
    expect(candidate).toMatch(/end:\s*draft\.value\.length/)

    const matcher = candidate.match(/const match\s*=\s*(\/.*\/[a-z]*)\.exec\(/)?.[1] ?? ''
    expect(matcher).not.toBe('')
    expect(matcher).toMatch(/\^/)
    expect(matcher).toMatch(/\$/)
    expect(matcher).toMatch(/\\s/)
    expect(matcher).toMatch(/\/.*\[/)

    expect(composer).toMatch(/dismissed\.start === candidate\.start && dismissed\.prefix === draft\.value\.slice\(0, candidate\.start\)/)
    expect(composer).toMatch(
      /if \(dismissed && \([\s\S]*!candidate[\s\S]*candidate\.start !== dismissed\.start[\s\S]*value\.slice\(0, dismissed\.start\) !== dismissed\.prefix/
    )
    expect(composer).toMatch(
      /const command = skillCommandCandidate\.value[\s\S]*dismissedCommandToken\.value = \{ start: command\.start, prefix: draft\.value\.slice\(0, command\.start\) \}/
    )
    expect(composer).not.toMatch(/if \(!value\.startsWith\(['"]\/['"]\)\) commandDismissed/)
  })

  test('keeps cross-conversation skill preferences in the composer and hides empty configuration', () => {
    expect(settings).not.toMatch(/Pinned skills/)
    expect(inline).toMatch(/v-if="thread && profiles\.length > 1"/)
    expect(inline).toMatch(/@update-skill-preferences="agents\.setSkillPreferences"/)
    expect(composer).toMatch(/@click\.stop="togglePreference\(skill\.versionId\)"/)
    expect(composer).toMatch(/always load in conversations/)
    expect(composer).toMatch(/visibleSkillByVersionId\s*=\s*computed\(\(\)\s*=>\s*new Map\([\s\S]*props\.skills\.map/)
    expect(composer).toMatch(/visibleSkillByVersionId\.value\.get\(versionId\)/)
    expect(composer).toMatch(/preferredSkillIds\.value\.has\(skillId\)/)
    expect(composer).not.toMatch(/pin(?:ned)? to this session/i)
  })

  test('keeps the overlay mounted through the Search-to-Agent handoff', () => {
    expect(header).not.toMatch(/@blur=['"]searchBlur['"]/)
    expect(header).not.toMatch(/searchBlur\s*\(/)
    expect(template).toMatch(/v-if=['"]isAgentOpen \|\| searchIsFocused \|\| normalizedSearch\.length > 1['"]/)
    expect(search).toMatch(/openAsk\(\): void\s*\{[\s\S]*this\.searchIsFocused\s*=\s*true[\s\S]*this\.searchMode\s*=\s*['"]ask['"]/)
    expect(search).toMatch(/closeSearch\(\): void\s*\{[\s\S]*this\.searchMode\s*=\s*['"]search['"]/)
    expect(search).toMatch(/canAsk\(allowed:\s*boolean\)\s*\{[\s\S]*if \(!allowed && this\.searchMode === ['"]ask['"]\) this\.searchMode = ['"]search['"]/)
  })

  test('focuses the full Agent composer for direct mode switching', () => {
    expect(header).toMatch(/event\.key\.toLowerCase\(\)\s*!==\s*['"]a['"]/)
    expect(header).toMatch(/this\.searchIsFocused\s*=\s*true[\s\S]*this\.searchMode\s*=\s*['"]ask['"]/)
    expect(header).toMatch(/event\.ctrlKey\s*\|\|\s*event\.metaKey/)
    expect(search).toMatch(/focusComposer\(\)/)
    expect(inline).toMatch(/defineExpose\(\{\s*sendPrompt,\s*focusComposer,\s*focusConversation\s*\}\)/)
    expect(composer).toMatch(/defineExpose\(\{\s*focusInput,\s*focusSkillsTrigger\s*\}\)/)
    expect(search).toMatch(/async submitAskPrompt\(\): Promise<void>/)
  })

  test('uses one LIFO focus stack across Search, Ask, and compact panels', () => {
    expect(focusScope).toMatch(/scopeStacks\s*=\s*new WeakMap<Document,\s*ModalFocusScopeState\[\]>/)
    expect(focusScope).toMatch(/isTopScope\(\)/)
    expect(focusScope).toMatch(/while \(stack\.length > 0 && !stack\[stack\.length - 1\]!\.active\)/)
    expect(focusScope).toMatch(/new MutationObserverConstructor\(\(\) => reconcileBackgrounds\(document\)\)/)
    expect(focusScope).toMatch(
      /for \(let index = stack\.length - 1; index >= 0; index -= 1\) restoreBackground\(stack\[index\]!\.background\)[\s\S]*state\.background = hideBackground\(state\.root, state\.observedAdditionalRoots\)/
    )
    expect(focusScope).toMatch(/target\.focus\(\{\s*preventScroll:\s*true\s*\}\)/)
    expect(focusScope).toMatch(/event\.stopImmediatePropagation\(\)/)
    expect(search).toMatch(/onEscape:\s*this\.returnToSearch/)
    expect(search).toMatch(/additionalRoots:\s*\(\) => this\.syncSearchInputA11y\(\)/)
    expect(inline).toMatch(/:role="compactPanels \? 'dialog' : undefined"/)
    expect(inline).toMatch(/triggerForPanel/)
    expect(inline).toMatch(
      /const triggerForPanel = \(kind:[\s\S]*const root = inlineAgentRoot\.value[\s\S]*root\.querySelector<HTMLElement>[\s\S]*window\.matchMedia\(mobilePanelQuery\)\.matches/
    )
    expect(inline).toMatch(
      /const closeHistory = \(\): void => \{[\s\S]*const closingKind = compactPanels\.value && historyOpen\.value \? 'history' : null[\s\S]*preparePanelTriggerRestore\(closingKind\)[\s\S]*historyOpen\.value = false/
    )
    expect(inline).toMatch(
      /const closeMemory = \(\): void => \{[\s\S]*const closingKind = compactPanels\.value && memoryOpen\.value \? 'memory' : null[\s\S]*preparePanelTriggerRestore\(closingKind\)[\s\S]*memoryOpen\.value = false/
    )
    expect(inline).toMatch(/const updateMemoryOpen = \(open: boolean\): void => \{[\s\S]*else closeMemory\(\)/)
    expect(inline).toMatch(
      /const closePanels = \(\): void => \{[\s\S]*const closingKind = compactPanels\.value[\s\S]*preparePanelTriggerRestore\(closingKind\)[\s\S]*historyOpen\.value = false[\s\S]*memoryOpen\.value = false/
    )
    expect(inline).toMatch(/const toggleHistory = \(\): void => \{\s*if \(historyOpen\.value\) \{\s*closeHistory\(\)/)
    expect(inline).toMatch(/const toggleMemory = \(\): void => \{\s*if \(memoryOpen\.value\) \{\s*closeMemory\(\)/)
    expect(inline).toMatch(
      /watch\(\[historyOpen, memoryOpen, compactPanels\], async \(\[history, memory, compact\]\) => \{[\s\S]*if \(!kind \|\| !compact\) \{\s*panelFocusScope\?\.deactivate\(\{ restoreFocus: false \}\)[\s\S]*return/
    )
    expect(inline).toMatch(
      /watch\(\[historyOpen, memoryOpen\],[\s\S]*const restoreKind = pendingPanelFocusKind[\s\S]*triggerForPanel\(restoreKind\)\?\.focus\(\{ preventScroll: true \}\)[\s\S]*\{ flush: 'post' \}/
    )
    expect(inline).toMatch(/restoreTarget:\s*\(\) => triggerForPanel\(kind\)/)
    expect(inline).not.toMatch(/panelFocusOpener|restorePanelTriggerAfterClose/)
  })

  test('keeps direct prompts and fresh Search snapshots race-safe', () => {
    expect(search).toMatch(/directPromptHandoffId/)
    expect(search).toMatch(
      /if \(!prompt \|\| this\.directPromptHandoffPending\) return[\s\S]*this\.directPromptHandoffPending = true[\s\S]*const handoffId = \+\+this\.directPromptHandoffId/
    )
    expect(search).toMatch(/if \(!success \|\| handoffId !== this\.directPromptHandoffId\) return/)
    expect(search).toMatch(/finally\s*\{\s*this\.directPromptHandoffPending = false/)
    expect(search).toMatch(/if \(this\.normalizedSearch === prompt\) this\.search = ''/)
    expect(search).toMatch(
      /searchMode\(mode:[\s\S]*this\.searchRequestId \+= 1[\s\S]*window\.clearTimeout\(this\.searchTimer\)[\s\S]*this\.searchIsLoading = false/
    )
    expect(search).toMatch(/this\.responseKey === requestKey && !this\.searchError/)
    expect(search).toMatch(/if \(this\.directPromptHandoffPending\) this\.directPromptHandoffId \+= 1/)
    expect(search).toMatch(/mounted\(\)\s*\{[\s\S]*this\.normalizedSearch\.length >= 2[\s\S]*this\.queueSearch\(this\.search\)/)
  })

  test('keeps empty Search useful and combobox ownership accurate', () => {
    expect(template).toMatch(/\.search-results-suggestion-block\(v-if=['"]suggestions\.length['"]\)/)
    expect(search).toMatch(/this\.results\.length > 0 \? ['"]wiki-search-results['"] : ['"]{2}/)
    expect(search).toMatch(/this\.suggestions\.length > 0 \? ['"]wiki-search-suggestions['"] : ['"]{2}/)
    expect(search).toMatch(/if \(searchVisible && this\.searchListIds\) input\.setAttribute\(['"]aria-controls['"], this\.searchListIds\)/)
    expect(template).toMatch(/:total-visible=['"]\$vuetify\.display\.xs \? 3 : 7['"]/)
    expect(search).toMatch(/setSearchTerm\(term:[\s\S]*this\.\$nextTick\(\(\) => this\.findSearchControl\(\)\?\.focus\(\{ preventScroll: true \}\)\)/)
    expect(search).toMatch(/else input\.removeAttribute\(['"]aria-controls['"]\)/)
    expect(header).toMatch(/event\.defaultPrevented \|\| event\.repeat \|\| event\.isComposing/)
    expect(header).toMatch(/ref=['"]searchField['"][\s\S]*v-model=['"]search['"][\s\S]*clearable/)
    expect(header).toMatch(/\.navHeaderLoading\(v-show=['"]isLoading['"]\)/)
  })

  test('keeps profile and history failures on the surface that issued them', () => {
    expect(inline.match(/if \(sessionChanged\(\)\) return \{ success: true \}/g)).toHaveLength(2)
    expect(inline).not.toMatch(/watch\(error,/)
    expect(inline).toMatch(/const reloadHistory = async[\s\S]*historyLoadError\.value = ''[\s\S]*historyLoadError\.value = value instanceof Error/)
  })

  test('keeps compact transcript follow and composer controls stable', () => {
    expect(inline).toMatch(/new MutationObserver\(scheduleTranscriptReconcile\)/)
    expect(inline).toMatch(/window\.visualViewport\?\.addEventListener\('resize', scheduleTranscriptReconcile\)/)
    expect(inline).toMatch(/grid-column:\s*1 \/ -1/)
    expect(inline).toMatch(/width:\s*22rem/)
    expect(composer).toMatch(/:aria-label="composerInputLabel"/)
    expect(composer).toMatch(/role="group" aria-label="Conversation context controls"/)
    expect(composer).toMatch(/:disabled="disabled \|\| sendInProgress \|\| !draft\.trim\(\)"/)
    expect(composer).toMatch(/const sendInProgress = computed\(\(\) => props\.sending \|\| submissionPending\.value\)/)
    expect(composer).toMatch(/if \(props\.disabled \|\| sendInProgress\.value \|\|/)
  })
})
