import fs from 'node:fs'
import path from 'node:path'

describe('ordinary Wiki agent administration integration', () => {
  const read = relativePath => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  const router = read('client/router.ts')
  const navigation = read('client/components/admin.vue')
  const page = read('client/components/admin/admin-agents.vue')
  const vite = read('vite.config.mts')
  const master = read('server/master.ts')

  test('registers Agents in the ordinary administration router and sidebar', () => {
    expect(router).toMatch(/path:\s*['"]\/agents['"][^\n]*admin-agents\.vue/)
    expect(navigation).toMatch(/v-list-item\(to=['"]\/agents['"][^\n]*v-if=['"]agentsEnabled['"]/)
    expect(navigation).toMatch(/admin:agents\.title/)
  })

  test('embeds the complete administration console with ordinary session CSRF', () => {
    expect(page).toMatch(/AgentAdmin[^\n]*:csrf-token=['"]csrfToken['"][^\n]*embedded/)
    expect(page).toMatch(/const csrfToken = siteConfig\.agentCsrfToken/)
  })

  test('has no isolated agent application or host routing', () => {
    expect(fs.existsSync(path.join(process.cwd(), 'client/agents-app.ts'))).toBe(false)
    expect(fs.existsSync(path.join(process.cwd(), 'client/index-agents.ts'))).toBe(false)
    expect(fs.existsSync(path.join(process.cwd(), 'server/views/agent.pug'))).toBe(false)
    expect(vite).not.toMatch(/index-agents/)
    expect(master).not.toMatch(/agentsPublicOrigin|agentVite|surface:\s*['"]embedded['"]/)
  })
})
