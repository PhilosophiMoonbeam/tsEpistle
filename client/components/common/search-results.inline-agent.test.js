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
    expect(template).toMatch(/@return-search=['"]returnToSearch['"]/)
    expect(template).toMatch(/@close=['"]closeSearch['"]/)
    expect(template).toMatch(/role=['"]dialog['"]/)
    expect(template).toMatch(/aria-modal=['"]true['"]/)
    expect(template).toMatch(/:aria-labelledby=['"]isAgentOpen \? `wiki-agent-title` : `wiki-search-title`['"]/)
    expect(search).toMatch(/\.search-results\s*\{[\s\S]*height:\s*100dvh[\s\S]*inset:\s*0/)
    expect(search).toMatch(/&--ask\s*\{[\s\S]*overflow:\s*hidden[\s\S]*z-index:\s*1009/)
    expect(search).toMatch(
      /&--ask\s*\{[\s\S]*color-mix\(in srgb, var\(--wiki-ambient-accent\) 5%, rgb\(var\(--v-theme-background\)\)\)[\s\S]*rgb\(var\(--v-theme-background\)\)[\s\S]*isolation:\s*isolate/
    )
    expect(search).toMatch(/&--ask\s*\{\s*animation:\s*none/)
    expect(search).toMatch(/&--ask\s*\{[\s\S]*animation:\s*agentWorkspaceReveal var\(--wiki-motion-slow\)/)
    expect(search).not.toMatch(/height:\s*calc\(100dvh/)
    expect(header).toMatch(/:extended=['"]searchIsShown && \$vuetify\.display\.smAndDown['"]/)
    expect(search).toMatch(
      /@media #\{map-get\(\$display-breakpoints, ['"]sm-and-down['"]\)\}\s*\{[\s\S]*&:not\(\.search-results--ask\)\s*\{[\s\S]*--search-mobile-app-bar-extension-height:\s*48px;[\s\S]*padding-top:\s*calc\(var\(--v-layout-top,\s*72px\) \+ var\(--search-mobile-app-bar-extension-height\)\);/
    )
    expect(search).toMatch(/&-container--ask\s*\{[\s\S]*padding:\s*0\s+var\(--wiki-space-2\)/)
    expect(inline).toMatch(/inline-agent__mobile-return" icon="mdi-arrow-left"[\s\S]*aria-label="Return to Wiki Search"[\s\S]*@click="emit\('return-search'\)"/)
    expect(inline).toMatch(/inline-agent__mobile-close" icon="mdi-close"[\s\S]*aria-label="Close Wiki Agent"[\s\S]*@click="emit\('close'\)"/)
    expect(inline).toMatch(
      /inline-agent__mobile-panel-menu" icon="mdi-view-dashboard-outline"[\s\S]*aria-label="Open Agent panels: conversation history and memory"/
    )
    expect(inline).toMatch(/inline-agent__new-session"[\s\S]*aria-label="Start a new agent conversation"[\s\S]*inline-agent__new-session-label/)
    expect(inline).not.toMatch(/font-size:\s*0/)
    expect(search).toMatch(/&-agent-nav\s*\{[\s\S]*padding-block-start:\s*max\(0px,\s*env\(safe-area-inset-top\)\)/)
    expect(inline).toMatch(/\.inline-agent__toolbar\s*\{[\s\S]*padding-block-start:\s*0/)
    expect(inline).toMatch(/\.inline-agent__progress\s*\{[\s\S]*var\(--wiki-space-6\) - var\(--wiki-space-1\)/)
    expect(inline).toMatch(
      /@media \(max-width: 639\.98px\)\s*\{[\s\S]*\.inline-agent__toolbar\s*\{[\s\S]*padding-block-start:\s*max\(0px,\s*env\(safe-area-inset-top\)\)[\s\S]*\.inline-agent__progress\s*\{[\s\S]*env\(safe-area-inset-top\)/
    )
    expect(inline).toMatch(/padding-block-end:\s*max\(var\(--wiki-space-1\),\s*env\(safe-area-inset-bottom\)\)/)
    expect(search).toMatch(/@media \(max-width: 639\.98px\)\s*\{[\s\S]*&--ask \.search-results-agent-nav\s*\{\s*display:\s*none;/)
    expect(template).not.toMatch(/action=['"]\/_?api\/agents\/launch['"]/)
    expect(template).not.toMatch(/target=['"]_blank['"]/)
    expect(search).toMatch(/if\s*\(!inlineAgent\)\s*return/)
    expect(search).toMatch(/inlineAgent\.sendPrompt\(prompt\)/)
    expect(search).toMatch(/inlineAgent\.focusConversation\(\)/)
  })

  test('keeps one compact identity and delegates operational status to the composer', () => {
    const toolbar = inline.match(/<v-toolbar[\s\S]*?<\/v-toolbar>/)?.[0] ?? ''
    expect(toolbar).toMatch(/inline-agent__avatar[\s\S]*inline-agent-title">Wiki Agent<\/h2>[\s\S]*inline-agent__session-title/)
    expect(toolbar).not.toMatch(/Knowledge workspace|inline-agent__connection|role="status"/)
    expect(inline).not.toMatch(/\.inline-agent__toolbar::after/)
    expect(inline).toMatch(/<AgentComposer[\s\S]*:status-label="connectionLabel"[\s\S]*:status-tone="connectionTone"/)
    expect(inline).toMatch(
      /const connectionLabel = computed\(\(\) => loading\.value[\s\S]*connection\.value === 'reconnecting'[\s\S]*!providerAvailable\.value[\s\S]*Boolean\(error\.value\)[\s\S]*\? 'Try again'[\s\S]*activeRun\.value\?\.status === 'awaiting_approval'[\s\S]*sending\.value[\s\S]*activeRun\.value[\s\S]*\? 'Working'[\s\S]*: 'Ready'/
    )
    expect(inline).toMatch(
      /const connectionTone = computed<'ready' \| 'error' \| 'busy'>\([\s\S]*!providerAvailable\.value \|\| Boolean\(error\.value\)[\s\S]*\? 'error'[\s\S]*\? 'busy'[\s\S]*: 'ready'/
    )
  })

  test('uses the toolbar atmosphere as the shared translucent workspace surface', () => {
    const cardStyle = inline.match(/\.inline-agent__card\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    const toolbarStyle = inline.match(/\.inline-agent__toolbar\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    const bodyStyle = inline.match(/\.inline-agent__body\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(inline).toMatch(/--inline-agent-workspace-gradient:/)
    expect(cardStyle).toMatch(/background:\s*color-mix\([\s\S]*transparent\)/)
    expect(toolbarStyle).toMatch(/border-bottom:\s*1px solid var\(--wiki-surface-border\)/)
    expect(toolbarStyle).toMatch(/var\(--inline-agent-workspace-gradient\)/)
    expect(bodyStyle).toMatch(/color-mix\(in srgb, var\(--inline-agent-workspace-base\)[\s\S]*transparent\)/)
    expect(inline).toMatch(/\.inline-agent__side :deep\(\.agent-history\),[\s\S]*\.agent-memory[\s\S]*background:\s*color-mix\([\s\S]*transparent\)/)
  })

  test('reuses authenticated sessions without changing the Wiki page route', () => {
    expect(inline).toMatch(/agents\.initialize\(props\.csrfToken,\s*\{[\s\S]*routeSync:\s*false[\s\S]*reuseLatest:\s*true/)
    expect(inline).toMatch(/<AgentThread/)
    expect(inline).toMatch(/<AgentComposer/)
    expect(inline).toMatch(/currentPage:\s*currentPage\.value/)
    expect(inline).not.toMatch(/window\.(?:open|location)/)
  })
  test('uses explicit wide, docked, and modal panel modes', () => {
    expect(inline).toMatch(/inline-agent__side--history/)
    expect(inline).toMatch(/<AgentHistoryPanel/)
    expect(inline).toMatch(/inline-agent__side--memory/)
    expect(inline).toMatch(/<AgentMemoryManager :model-value="memoryOpen"[\s\S]*@update:model-value="updateMemoryOpen"/)
    expect(search).toMatch(/&--ask \.inline-agent\s*\{[\s\S]*max-width:\s*112rem/)
    expect(inline).toMatch(/panelMode = ref<'wide' \| 'docked' \| 'modal'>/)
    expect(inline).toMatch(/panelModeMedia\.forEach\(media => media\.addEventListener\(['"]change['"],\s*reconcilePanelMode\)\)/)
    expect(inline).toMatch(/panelModeMedia\.forEach\(media => media\.removeEventListener\(['"]change['"],\s*reconcilePanelMode\)\)/)
    expect(inline).toMatch(/window\.matchMedia\(['"]\(min-width: 1440px\)['"]\)/)
    expect(inline).toMatch(/window\.matchMedia\(['"]\(min-width: 1024px\)['"]\)/)
    expect(inline).toMatch(/@media \(min-width: 1024px\) and \(max-width: 1439\.98px\)/)
    expect(inline).toMatch(/@media \(max-width: 1023\.98px\)/)
    expect(inline).toMatch(/@media \(max-width: 1023\.98px\)\s*\{[\s\S]*\.inline-agent__card\s*\{[\s\S]*grid-column:\s*1;[\s\S]*grid-row:\s*1;/)
    expect(inline).toMatch(/\.inline-agent__side--history\s*\{[\s\S]*inset-inline-start:\s*0;[\s\S]*inset-inline-end:\s*auto;[\s\S]*justify-self:\s*start;/)
    expect(inline).toMatch(/\.inline-agent__side--memory\s*\{[\s\S]*inset-inline-start:\s*auto;[\s\S]*inset-inline-end:\s*0;[\s\S]*justify-self:\s*end;/)
    expect(inline).not.toMatch(/1711\.98px/)
    expect(inline).not.toMatch(/compactPanels/)
    expect(inline).not.toMatch(/100dvh|100svh/)
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
    expect(historyActions).toMatch(
      /:aria-label="`Actions for \$\{session\.title \|\| 'New conversation'\}`"[\s\S]*title="Delete"[\s\S]*@click="requestRemove"[\s\S]*const requestRemove = \(\): void => emit\('remove', triggerElement\(\)\)/
    )
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
    expect(inline).toMatch(/defineExpose\(\{\s*sendPrompt,\s*focusComposer,\s*focusConversation,\s*scrollToLatest\s*\}\)/)
    expect(composer).toMatch(/defineExpose\(\{\s*focusInput,\s*focusSkillsTrigger\s*\}\)/)
    expect(search).toMatch(/async submitAskPrompt\(\): Promise<void>/)
  })

  test('uses one LIFO focus stack across Search, Ask, and modal panels', () => {
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
    expect(search).toMatch(
      /additionalRoots:\s*this\.searchModalAdditionalRoots[\s\S]*searchModalAdditionalRoots\(\): HTMLElement\[\]\s*\{[\s\S]*document\.querySelectorAll<HTMLElement>\('\.nav-header-search-control input, \[data-search-modal-action\]'\)/
    )
    expect(header).toMatch(/v-btn\.nav-header-browse\([^\n]*data-search-modal-action[\s\S]*v-btn\.nav-header-search-toggle\([\s\S]*?data-search-modal-action/)
    expect(inline).toMatch(/:role="panelMode === 'modal' \? 'dialog' : undefined"/)
    expect(inline).toMatch(/:aria-modal="panelMode === 'modal' \? 'true' : undefined"/)
    expect(inline).toMatch(/triggerForPanel/)
    expect(inline).toMatch(
      /const triggerForPanel = \(kind:[\s\S]*const root = inlineAgentRoot\.value[\s\S]*root\.querySelector<HTMLElement>[\s\S]*window\.matchMedia\(mobilePanelQuery\)\.matches/
    )
    expect(inline).toMatch(
      /const closeHistory = \(\): void => \{[\s\S]*panelMode\.value === 'modal' && historyOpen\.value[\s\S]*preparePanelTriggerRestore\(closingKind\)[\s\S]*historyOpen\.value = false/
    )
    expect(inline).toMatch(
      /const closeMemory = \(\): void => \{[\s\S]*panelMode\.value === 'modal' && memoryOpen\.value[\s\S]*preparePanelTriggerRestore\(closingKind\)[\s\S]*memoryOpen\.value = false/
    )
    expect(inline).toMatch(/const updateMemoryOpen = \(open: boolean\): void => \{[\s\S]*else closeMemory\(\)/)
    expect(inline).toMatch(
      /const closePanels = \(\): void => \{[\s\S]*panelMode\.value === 'modal'[\s\S]*preparePanelTriggerRestore\(closingKind\)[\s\S]*historyOpen\.value = false[\s\S]*memoryOpen\.value = false/
    )
    expect(inline).toMatch(/if \(panelMode\.value !== 'wide'\) memoryOpen\.value = false/)
    expect(inline).toMatch(/if \(panelMode\.value !== 'wide'\) historyOpen\.value = false/)
    expect(inline).toMatch(
      /const reconcilePanelMode = \(\): void => \{[\s\S]*panelMode\.value === 'wide' && nextMode !== 'wide'[\s\S]*document\.activeElement[\s\S]*memoryPanel\.value\?\.contains\(activeElement\)[\s\S]*historyPanel\.value\?\.contains\(activeElement\)[\s\S]*if \(focusedPanel === 'memory'\) historyOpen\.value = false[\s\S]*else memoryOpen\.value = false/
    )
    expect(inline).toMatch(/watch\(\[historyOpen, memoryOpen, panelMode\], async \(\[history, memory, mode\]\) => \{[\s\S]*if \(!kind \|\| mode !== 'modal'\)/)
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
  test('keeps docked rails conditional and conversation measures shared', () => {
    expect(inline).toMatch(/['"]inline-agent--panel-open['"]\s*:\s*historyOpen\s*\|\|\s*memoryOpen/)
    expect(inline).toMatch(/['"]inline-agent--history-open['"]\s*:\s*historyOpen/)
    expect(inline).toMatch(/['"]inline-agent--memory-open['"]\s*:\s*memoryOpen/)
    expect(inline).toMatch(/['"]inline-agent--panels-open['"]\s*:\s*historyOpen\s*&&\s*memoryOpen/)
    expect(inline).toMatch(/--agent-conversation-width:\s*56rem/)
    expect(inline).toMatch(/inline-agent__composer-inner/)
    expect(inline).toMatch(/inline-agent__composer-meta/)
    expect(inline).toMatch(/agent-thread\)\s*\{[\s\S]*?max-width:\s*var\(--agent-conversation-width\)/)
    expect(inline).toMatch(/\.inline-agent__composer-inner\s*\{[\s\S]*?width:\s*min\(100%,\s*var\(--agent-conversation-width\)\)/)
    expect(inline).toMatch(/scrollbar-gutter:\s*stable both-edges/)

    const wideLayout = inline.match(/@media \(min-width:\s*1440px\)([\s\S]*?)(?=@media|<\/style>)/)?.[1] ?? ''
    expect(wideLayout).toMatch(/\.inline-agent\.inline-agent--history-open\s*\{[\s\S]*?minmax\(16rem,\s*22rem\)[\s\S]*?minmax\(0,\s*68rem\)/)
    expect(wideLayout).toMatch(/\.inline-agent\.inline-agent--memory-open\s*\{[\s\S]*?minmax\(0,\s*68rem\)[\s\S]*?minmax\(16rem,\s*22rem\)/)
    expect(wideLayout).toMatch(
      /\.inline-agent\.inline-agent--panels-open\s*\{[\s\S]*?minmax\(16rem,\s*19rem\)[\s\S]*?minmax\(0,\s*68rem\)[\s\S]*?minmax\(16rem,\s*21rem\)/
    )

    const dockedLayout = inline.match(/@media \(min-width:\s*1024px\) and \(max-width:\s*1439\.98px\)([\s\S]*?)(?=@media|<\/style>)/)?.[1] ?? ''
    expect(dockedLayout).toMatch(/\.inline-agent\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*68rem\)[\s\S]*?justify-content:\s*center/)
    expect(dockedLayout).toMatch(/\.inline-agent\.inline-agent--history-open\s*\{[\s\S]*?grid-template-columns:/)
    expect(dockedLayout).toMatch(/\.inline-agent\.inline-agent--memory-open\s*\{[\s\S]*?grid-template-columns:/)
    expect(dockedLayout).toMatch(/\.inline-agent__side--memory\s*\{[\s\S]*?grid-column:\s*2/)
  })

  test('keeps current-page locale and path identity available on narrow phones', () => {
    const pageContext = inline.match(/<div[^>]*class=['"]inline-agent__page-context['"][^>]*>/)?.[0] ?? ''
    expect(pageContext).toMatch(/\brole=['"]note['"]/)
    expect(pageContext).toMatch(/:aria-label="`\$\{currentPage\.locale\}\/\$\{currentPage\.path\} is available to consult`"/)
    expect(inline).toMatch(/<bdi\s+dir=['"]auto['"]>\s*\{\{\s*currentPage\.locale\s*\}\}\s*\/\s*\{\{\s*currentPage\.path\s*\}\}\s*<\/bdi>/)
    expect(inline).toMatch(/:aria-label="`\$\{currentPage\.locale\}\/\$\{currentPage\.path\} is available to consult`"/)
    const narrowPhone = inline.match(/@media \(max-width:\s*380px\)([\s\S]*?)(?=@media|<\/style>)/)?.[1] ?? ''
    expect(narrowPhone).not.toMatch(/\.inline-agent__page-context\s*\{[\s\S]*?display:\s*none/)
  })

  test('reserves a non-message dock for latest-response navigation without outranking approvals', () => {
    expect(inline).toMatch(/const transcriptFollowing\s*=\s*ref\(true\)/)
    expect(inline).toMatch(/const scrollToLatest\s*=\s*async\s*\(\):\s*Promise<void>\s*=>/)
    expect(inline).toMatch(/scrollToLatest[\s\S]*?transcriptFollowing\.value\s*=\s*true/)
    expect(inline).toMatch(/scrollToLatest[\s\S]*?reducedMotion\(\)[\s\S]*?scrollTo\([\s\S]*?behavior/)
    expect(inline).toMatch(/defineExpose\(\{[\s\S]*scrollToLatest[\s\S]*\}\)/)
    expect(inline).toMatch(/const followJumpVisible\s*=\s*computed\(\(\)\s*=>\s*Boolean\([\s\S]*!transcriptFollowing\.value[\s\S]*!approvalJumpVisible\.value/)

    expect(inline).toMatch(
      /v-if="approvalJumpVisible \|\| followJumpVisible"[\s\S]*class="inline-agent__jump-dock"[\s\S]*v-if="approvalJumpVisible"[\s\S]*class="inline-agent__approval-jump"[\s\S]*v-else[\s\S]*class="inline-agent__follow-jump"/
    )
    expect(inline).toMatch(/class="inline-agent__follow-jump"[\s\S]*@click="scrollToLatest"/)
    const jumpDockStyle = inline.match(/\.inline-agent__jump-dock\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    const jumpControlsStyle = inline.match(/\.inline-agent__approval-jump,[\s\S]*?\.inline-agent__follow-jump\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(jumpDockStyle).toMatch(/display:\s*flex/)
    expect(jumpDockStyle).toMatch(/flex:\s*0 0 auto/)
    expect(jumpDockStyle).not.toMatch(/position:\s*absolute/)
    expect(jumpControlsStyle).not.toMatch(/position:\s*absolute/)
    expect(inline).not.toMatch(/inline-agent__transcript--approval-jump|inline-agent__jump--goal/)

    const transcriptStart = inline.indexOf('class="inline-agent__transcript"')
    const jumpDockStart = inline.indexOf('class="inline-agent__jump-dock"', transcriptStart)
    const composerStart = inline.indexOf('<footer class="inline-agent__composer">', jumpDockStart)
    expect(transcriptStart).toBeGreaterThanOrEqual(0)
    expect(jumpDockStart).toBeGreaterThan(transcriptStart)
    expect(composerStart).toBeGreaterThan(jumpDockStart)
  })

  test('keeps the expandable goal sticky with half its former vertical dock spacing', () => {
    const goalDockStyle = inline.match(/\.inline-agent__goal-dock\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(goalDockStyle).toMatch(/position:\s*sticky/)
    expect(goalDockStyle).toMatch(/inset-block-end:\s*0/)
    expect(goalDockStyle).toMatch(/margin:\s*calc\(var\(--wiki-space-3\) \/ 2\) auto 0/)
    expect(goalDockStyle).toMatch(/padding-block:\s*var\(--wiki-space-1\) calc\(var\(--wiki-space-3\) \/ 2\)/)
    expect(inline).toMatch(/@update:expanded="handleGoalExpanded"/)
  })
  test('keeps welcome content flat and starters as text rows', () => {
    const welcomeStyle = inline.match(/\.inline-agent__welcome\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(welcomeStyle).not.toMatch(/border\s*:|background\s*:|box-shadow\s*:/)
    expect(inline).toMatch(/class="inline-agent__starter"[\s\S]*variant=['"]text['"]/)
    expect(inline).toMatch(/\.inline-agent__starters\s*\{[\s\S]*?grid-template-columns:\s*1fr[\s\S]*?gap:\s*0/)
    expect(inline).toMatch(/\.inline-agent__starter\s*\{[\s\S]*?border-block-end:\s*1px[\s\S]*?border-radius:\s*0/)
    const welcomeSpine = inline.match(/\.inline-agent__welcome::before\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(welcomeSpine).not.toMatch(/border-radius\s*:/)
    expect(welcomeSpine).toMatch(/border-start-start-radius:\s*0/)
    expect(welcomeSpine).toMatch(/border-start-end-radius:\s*var\(--wiki-radius-pill\)/)
    expect(welcomeSpine).toMatch(/border-end-end-radius:\s*var\(--wiki-radius-pill\)/)
    expect(welcomeSpine).toMatch(/border-end-start-radius:\s*0/)
  })

  test('keeps the wand, product, and session identity vertically intact at every toolbar density', () => {
    const tablet = inline.match(/@media \(min-width:\s*640px\) and \(max-width:\s*1023\.98px\)([\s\S]*?)(?=@media|<\/style>)/)?.[1] ?? ''
    const mobile = inline.match(/@media \(max-width:\s*639\.98px\)([\s\S]*?)(?=@media|<\/style>)/)?.[1] ?? ''
    const shortViewport = inline.match(/@media \(max-height:\s*500px\)([\s\S]*?)(?=@media|<\/style>)/)?.[1] ?? ''
    expect(tablet).toMatch(/\.inline-agent__toolbar\s*\{[\s\S]*?min-height:/)
    expect(tablet).not.toMatch(/\.inline-agent__(?:avatar|session-title)[\s\S]*?display:\s*none/)
    expect(mobile).not.toMatch(/\.inline-agent__(?:avatar|session-title)[\s\S]*?display:\s*none/)
    expect(shortViewport).not.toMatch(/\.inline-agent__(?:avatar|session-title)[\s\S]*?display:\s*none/)
    expect(inline).toMatch(/\.inline-agent__identity\s*\{\s*display:\s*flex[\s\S]*align-items:\s*center/)
  })

  test('makes autocomplete semantics conditional on the skills popup feature', () => {
    expect(composer).toMatch(/:role="skillsEnabled\s*\?\s*['"]combobox['"]\s*:\s*undefined"/)
    expect(composer).toMatch(/:aria-autocomplete="skillsEnabled\s*\?\s*['"]list['"]\s*:\s*undefined"/)
    expect(composer).toMatch(/:aria-haspopup="skillsEnabled\s*\?\s*['"]listbox['"]\s*:\s*undefined"/)
    expect(composer).toMatch(/:aria-expanded="skillsEnabled\s*\?\s*skillCommandOpen\s*:\s*undefined"/)
    expect(composer).toMatch(/:aria-controls="skillsEnabled\s*&&\s*skillCommandOpen\s*\?[\s\S]*?:\s*undefined"/)
    expect(composer).toMatch(/:aria-activedescendant="skillsEnabled\s*&&\s*skillCommandOpen\s*&&\s*activeCommandSkill\s*\?[\s\S]*?:\s*undefined"/)
  })

  test('keeps command autocomplete listbox semantics separate from the manual Skills list', () => {
    const commandList = composer.match(/<v-list\s+id=['"]agent-skill-command-results['"][\s\S]*?<\/v-list>/)?.[0] ?? ''
    expect(commandList).toMatch(/\brole=['"]listbox['"]/)
    expect(commandList).toMatch(/\brole=['"]option['"]/)

    const manualList = composer.match(/<v-list\s+v-if=['"]skillMenuItems\.length > 0['"][\s\S]*?<\/v-list>/)?.[0] ?? ''
    expect(manualList).toMatch(/aria-label=['"]Available skills['"]/)
    expect(manualList).not.toMatch(/\brole=['"]listbox['"]|\brole=['"]option['"]/)
    expect(manualList).not.toMatch(/aria-multiselectable|aria-selected/)

    const manualCheckbox = manualList.match(/<v-checkbox-btn[\s\S]*?\/>/)?.[0] ?? ''
    expect(manualCheckbox).toMatch(/:aria-label=/)
    expect(manualCheckbox).not.toMatch(/tabindex=['"]-1['"]/)
    expect(manualCheckbox).toMatch(/@click\.stop=['"]toggleSkill\(skill\.versionId\)['"]/)
    expect(manualList).toMatch(/@click\.stop=['"]togglePreference\(skill\.versionId\)['"]/)
    expect(composer).not.toMatch(/\.agent-composer__skill-menu\s*:deep\(\.v-selection-control\)\s*\{[\s\S]*?pointer-events:\s*none/)
  })

  test('bounds the aggregate composer while allowing its content to yield', () => {
    const composerRootStyle = composer.match(/\.agent-composer\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    const editorStyle = composer.match(/\.agent-composer__editor\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    const attachmentsStyle = composer.match(/\.agent-composer__attachments\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    const actionsStyle = composer.match(/\.agent-composer__actions\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    const hintStyle = composer.match(/\.agent-composer__hint\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''

    expect(composerRootStyle).toMatch(/display:\s*flex/)
    expect(composerRootStyle).toMatch(/flex-direction:\s*column/)
    expect(composerRootStyle).toMatch(/max-height:\s*min\(\s*calc\(\s*var\(--wiki-space-12\)\s*\*\s*7\s*\)\s*,\s*44dvh\s*\)/)
    expect(editorStyle).toMatch(/min-height:\s*0/)
    expect(editorStyle).toMatch(/flex:\s*\d+\s+1\s+auto/)
    expect(editorStyle).toMatch(/overflow:\s*hidden/)
    expect(attachmentsStyle).toMatch(/min-height:\s*0/)
    expect(attachmentsStyle).toMatch(/flex:\s*0\s+1\s+auto/)
    expect(attachmentsStyle).toMatch(/overflow-y:\s*auto/)
    expect(actionsStyle).toMatch(/flex:\s*0\s+0\s+auto/)
    expect(hintStyle).toMatch(/position:\s*absolute/)
    expect(hintStyle).toMatch(/width:\s*1px/)
    expect(hintStyle).toMatch(/clip:\s*rect\(0,\s*0,\s*0,\s*0\)/)
    expect(composer).toMatch(/class="agent-composer__primary-actions"[\s\S]*?agent-composer__stop[\s\S]*?agent-composer__submit/)
    expect(composer.match(/class="agent-composer__primary-actions"/g)).toHaveLength(1)
    expect(composer).toMatch(/\.agent-composer__primary-actions\s*\{[\s\S]*?min-width:/)
    expect(composer).toMatch(
      /\.agent-composer__primary-actions\s*>\s*\.agent-composer__submit,[\s\S]*?\.agent-composer__primary-actions\s*>\s*\.agent-composer__stop[\s\S]*?width:\s*100%/
    )
    const shortViewport = composer.match(/@media \(max-width:\s*740px\) and \(max-height:\s*500px\)([\s\S]*?)(?=@media|<\/style>)/)?.[1] ?? ''
    expect(shortViewport).toMatch(/\.agent-composer__attachments\s*\{[\s\S]*?max-height:/)
    expect(shortViewport).toMatch(/\.agent-composer__skills\s*\{[\s\S]*?flex-wrap:\s*nowrap[\s\S]*?overflow-x:\s*auto/)
    const mobile = composer.match(/@media \(max-width:\s*740px\)([\s\S]*?)(?=@media|<\/style>)/)?.[1] ?? ''
    expect(composer).toMatch(/class="agent-composer__state"[\s\S]*role="status"[\s\S]*\{\{\s*statusLabel\s*\}\}/)
    expect(mobile).not.toMatch(/\.agent-composer__state\s*\{[\s\S]*?(?:display:\s*none|position:\s*absolute|clip:)/)
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
