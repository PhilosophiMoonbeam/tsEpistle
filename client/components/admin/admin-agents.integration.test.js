import fs from 'node:fs'
import path from 'node:path'

describe('ordinary Wiki agent administration integration', () => {
  const read = relativePath => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  const router = read('client/router.ts')
  const navigation = read('client/components/admin.vue')
  const page = read('client/components/admin/admin-agents.vue')
  const agentAdmin = read('client/components/agents/agent-admin.vue')
  const sessionSettings = read('client/components/agents/agent-session-settings.vue')
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

  test('derives protocol behavior and explains the session execution boundary', () => {
    expect(agentAdmin).toMatch(/Protocol-derived behavior/)
    expect(agentAdmin).toMatch(/Multiple calls per model turn; Wiki executes them in order/)
    expect(agentAdmin).toMatch(/agentProviderProtocolExecutionModes\(profileDraft\.transportKind\)/)
    expect(agentAdmin).toMatch(/Advanced limits and quotas/)
    expect(agentAdmin).not.toMatch(/label="(?:Parallel functions|Agent mode|Generation-only mode|Capability revision|Pricing revision|Structured output|Usage reporting)"/)
    expect(sessionSettings).toMatch(/Agent — Wiki actions available/)
    expect(sessionSettings).toMatch(/Text generation — no Wiki actions/)
    expect(sessionSettings).toMatch(/does not receive or call Wiki actions/)
    expect(agentAdmin).toMatch(/runtime\?\.providerEnabled !== true/)
    expect(agentAdmin).toMatch(/Provider administration is unavailable while provider inference is disabled/)
    expect(agentAdmin).toMatch(/profileError/)
    expect(agentAdmin).toMatch(/v-model="profileDraft\.secretValue"[^\n]*label="API key"[^\n]*type="password"/)
    expect(agentAdmin).toMatch(/Encrypted with the server-managed provider key and never returned/)
    expect(agentAdmin).toMatch(/secretReference: null, secretValue: profileDraft\.secretValue/)
    expect(agentAdmin).toMatch(/Run conformance" :disabled="!profile\.secretConfigured"/)
    expect(agentAdmin).toMatch(/Enable" :disabled="!profile\.conformed \|\| !profile\.secretConfigured"/)
  })

  test('has no isolated agent application or host routing', () => {
    expect(fs.existsSync(path.join(process.cwd(), 'client/agents-app.ts'))).toBe(false)
    expect(fs.existsSync(path.join(process.cwd(), 'client/index-agents.ts'))).toBe(false)
    expect(fs.existsSync(path.join(process.cwd(), 'server/views/agent.pug'))).toBe(false)
    expect(vite).not.toMatch(/index-agents/)
    expect(master).not.toMatch(/agentsPublicOrigin|agentVite|surface:\s*['"]embedded['"]/)
  })
})
