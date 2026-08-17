import fs from 'node:fs'
import path from 'node:path'

describe('inline Ask mode contract', () => {
  const searchPath = path.join(process.cwd(), 'client/components/common/search-results.vue')
  const inlinePath = path.join(process.cwd(), 'client/components/agents/inline-agent-chat.vue')
  const headerPath = path.join(process.cwd(), 'client/components/common/nav-header.vue')
  const search = fs.readFileSync(searchPath, 'utf8')
  const inline = fs.readFileSync(inlinePath, 'utf8')
  const header = fs.readFileSync(headerPath, 'utf8')
  const template = search.match(/<template[^>]*>\s*([\s\S]*?)\s*<\/template>/)?.[1] ?? ''

  test('renders Ask as an inline conversation instead of launching another application', () => {
    expect(template).toMatch(/InlineAgentChat\s*\(/)
    expect(template).toMatch(/v-if=['"]canAsk && searchMode === `ask`['"]/)
    expect(template).not.toMatch(/action=['"]\/_?api\/agents\/launch['"]/)
    expect(template).not.toMatch(/target=['"]_blank['"]/)
    expect(search).toMatch(/inlineAgent\?\.sendPrompt\(prompt\)/)
  })

  test('reuses authenticated sessions without changing the Wiki page route', () => {
    expect(inline).toMatch(/agents\.initialize\(props\.csrfToken,\s*\{[\s\S]*routeSync:\s*false[\s\S]*reuseLatest:\s*true/)
    expect(inline).toMatch(/<AgentThread/)
    expect(inline).toMatch(/<AgentComposer/)
    expect(inline).toMatch(/currentPage:\s*currentPage\.value/)
    expect(inline).not.toMatch(/window\.(?:open|location)/)
  })

  test('supports direct mode switching and submission from the Wiki search field', () => {
    expect(header).toMatch(/event\.key\.toLowerCase\(\)\s*!==\s*['"]a['"]/)
    expect(header).toMatch(/this\.searchMode\s*=\s*this\.searchMode\s*===\s*['"]ask['"]\s*\?\s*['"]search['"]\s*:\s*['"]ask['"]/)
    expect(header).toMatch(/event\.ctrlKey\s*\|\|\s*event\.metaKey/)
    expect(search).toMatch(/async submitAskPrompt\(\): Promise<void>/)
  })
})
