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
  const settingsPath = path.join(process.cwd(), 'client/components/agents/agent-session-settings.vue')
  const search = fs.readFileSync(searchPath, 'utf8')
  const inline = fs.readFileSync(inlinePath, 'utf8')
  const history = fs.readFileSync(historyPath, 'utf8')
  const historyActions = fs.readFileSync(historyActionsPath, 'utf8')
  const memory = fs.readFileSync(memoryPath, 'utf8')
  const composer = fs.readFileSync(composerPath, 'utf8')
  const settings = fs.readFileSync(settingsPath, 'utf8')
  const header = fs.readFileSync(headerPath, 'utf8')
  const template = search.match(/<template[^>]*>\s*([\s\S]*?)\s*<\/template>/)?.[1] ?? ''

  test('renders Ask as an immersive conversation instead of launching another application', () => {
    expect(template).toMatch(/InlineAgentChat\s*\(/)
    expect(template).toMatch(/v-if=['"]isAgentOpen['"]/)
    expect(template).toMatch(/search-results-agent-nav/)
    expect(template).toMatch(/:aria-modal=['"]isAgentOpen \? `true` : undefined['"]/)
    expect(search).toMatch(/&--ask\s*\{[\s\S]*z-index:\s*1009/)
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
    expect(inline).toMatch(/<AgentMemoryManager v-model="memoryOpen"/)
    expect(inline).toMatch(/max-width:\s*112rem/)
    expect(inline).toMatch(/@media \(max-width:\s*1199\.98px\)/)
    expect(inline).not.toMatch(/<v-menu location="bottom end">[\s\S]*Open agent conversation history/)
    expect(memory).not.toMatch(/<v-dialog v-model="open"/)
  })

  test('offers durable folders, explicit unfiling, and individual deletion in history', () => {
    expect(history).toMatch(/New folder/)
    expect(history).toMatch(/Conversations here never expire/)
    expect(historyActions).toMatch(/Move to Recent/)
    expect(historyActions).toMatch(/Delete conversation/)
    expect(history).toMatch(/fresh 90-day timer/)
    expect(history).toMatch(/agents\.moveSessionToFolder/)
    expect(history).toMatch(/agents\.removeSession/)
  })


  test('passes the skills feature flag and exposes one-shot personal skill controls', () => {
    expect(search).toMatch(/:skills-enabled=['"]agentSkillsEnabled['"]/)
    expect(inline).toMatch(/<AgentPersonalSkills/)
    expect(inline).toMatch(/:invocation-limit="invocationLimit"/)
    expect(inline).toMatch(/agents\.send\(prompt, invokedSkillVersionIds\)/)
  })

  test('keeps cross-conversation skill preferences in the composer and hides empty configuration', () => {
    expect(settings).not.toMatch(/Pinned skills/)
    expect(inline).toMatch(/v-if="thread && profiles\.length > 1"/)
    expect(inline).toMatch(/@update-skill-preferences="agents\.setSkillPreferences"/)
    expect(composer).toMatch(/@click\.stop="togglePreference\(skill\.versionId\)"/)
    expect(composer).toMatch(/always load in conversations/)
    expect(composer).toMatch(/candidate\.id === skill\.skillId/)
    expect(composer).toMatch(/preferredSkillIds\.value\.has\(skillId\)/)
    expect(composer).not.toMatch(/pin(?:ned)? to this session/i)
  })

  test('keeps the overlay mounted through the Search-to-Agent handoff', () => {
    expect(header).not.toMatch(/@blur=['"]searchBlur['"]/)
    expect(header).not.toMatch(/searchBlur\s*\(/)
    expect(template).toMatch(/v-if=['"]isAgentOpen \|\| searchIsFocused \|\| normalizedSearch\.length > 1['"]/)
    expect(search).toMatch(/openAsk\(\): void\s*\{[\s\S]*this\.searchIsFocused\s*=\s*true[\s\S]*this\.searchMode\s*=\s*['"]ask['"]/)
    expect(search).toMatch(/closeSearch\(\): void\s*\{[\s\S]*this\.searchMode\s*=\s*['"]search['"]/)
  })

  test('focuses the full Agent composer for direct mode switching', () => {
    expect(header).toMatch(/event\.key\.toLowerCase\(\)\s*!==\s*['"]a['"]/)
    expect(header).toMatch(/this\.searchIsFocused\s*=\s*true[\s\S]*this\.searchMode\s*=\s*['"]ask['"]/)
    expect(header).toMatch(/event\.ctrlKey\s*\|\|\s*event\.metaKey/)
    expect(search).toMatch(/focusComposer\(\)/)
    expect(inline).toMatch(/defineExpose\(\{\s*sendPrompt,\s*focusComposer,\s*focusConversation\s*\}\)/)
    expect(composer).toMatch(/defineExpose\(\{\s*focusInput\s*\}\)/)
    expect(search).toMatch(/async submitAskPrompt\(\): Promise<void>/)
  })
})
