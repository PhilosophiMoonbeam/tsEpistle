import fs from 'node:fs'
import path from 'node:path'

describe('ordinary Wiki agent administration integration', () => {
  const read = relativePath => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  const router = read('client/router.ts')
  const navigation = read('client/components/admin.vue')
  const page = read('client/components/admin/admin-agents.vue')
  const isolatedShell = read('client/components/agents/agent-shell.vue')
  const isolatedBootstrap = read('client/agents-app.ts')

  test('registers Agents in the ordinary administration router and sidebar', () => {
    expect(router).toMatch(/path:\s*['"]\/agents['"][^\n]*admin-agents\.vue/)
    expect(navigation).toMatch(/v-list-item\(to=['"]\/agents['"][^\n]*v-if=['"]agentsEnabled['"]/)
    expect(navigation).toMatch(/admin:agents\.title/)
  })

  test('embeds the complete administration console with ordinary session CSRF', () => {
    expect(page).toMatch(/AgentAdmin[^\n]*:csrf-token=['"]csrfToken['"][^\n]*embedded/)
    expect(page).toMatch(/const csrfToken = siteConfig\.agentLaunchCsrfToken/)
  })

  test('removes the obsolete isolated administration destination', () => {
    expect(isolatedShell).not.toMatch(/href=['"]\/admin['"]/)
    expect(isolatedShell).not.toMatch(/AgentAdmin|isAdminPage/)
    expect(isolatedBootstrap).not.toMatch(/isAdmin:\s*z\.boolean/)
  })
})
