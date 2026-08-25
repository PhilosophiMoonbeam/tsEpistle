import fs from 'node:fs'
import path from 'node:path'

describe('ordinary Wiki agent administration integration', () => {
  const read = relativePath => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  const router = read('client/router.ts')
  const navigation = read('client/components/admin.vue')
  const page = read('client/components/admin/admin-agents.vue')
  const agentAdmin = read('client/components/agents/agent-admin.vue')
  const skillAdmin = read('client/components/agents/skill-admin.vue')
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

  test('derives Agent-only protocol behavior and group-scoped capability access', () => {
    expect(agentAdmin).toMatch(/Protocol-derived behavior/)
    expect(agentAdmin).toMatch(/label="Tool calling"/)
    expect(agentAdmin).toMatch(/Native API tools/)
    expect(agentAdmin).toMatch(/Prompt-emulated tools/)
    expect(agentAdmin).toMatch(/Prompt-emulated; one action per model turn/)
    expect(agentAdmin).toMatch(/agentProviderProtocolExecutionModes\(option\.value\)\.includes\('agent'\)/)
    expect(agentAdmin).toMatch(/policies: \{ allowedModes: \['agent'\]/)
    expect(agentAdmin).toMatch(/Advanced limits and quotas/)
    expect(agentAdmin).toMatch(/request<GroupOption\[]>\('\/_api\/groups'\)/)
    expect(skillAdmin).toMatch(/request\('\/_api\/groups'\)/)
    expect(agentAdmin).not.toMatch(/request<GroupOption\[]>\('\/api\/groups'\)/)
    expect(skillAdmin).not.toMatch(/request\('\/api\/groups'\)/)
    expect(agentAdmin).not.toMatch(/label="(?:Parallel functions|Agent mode|Generation-only mode|Capability revision|Pricing revision|Structured output|Usage reporting)"/)
    expect(sessionSettings).not.toMatch(/generation-only|Text generation|How this session uses the model/)
    expect(sessionSettings).toMatch(/v-if="profiles\.length > 1"/)
    expect(agentAdmin).toMatch(/runtime\?\.providerEnabled !== true/)
    expect(agentAdmin).toMatch(/Provider administration is unavailable while provider inference is disabled/)
    expect(agentAdmin).toMatch(/profileError/)
    expect(agentAdmin).toMatch(/v-model="profileDraft\.secretValue"[^\n]*label="API key"[^\n]*type="password"/)
    expect(agentAdmin).toMatch(/Encrypted with the server-managed provider key and never returned/)
    expect(agentAdmin).toMatch(/secretReference: null, \.\.\.\(profileDraft\.secretValue \? \{ secretValue: profileDraft\.secretValue \} : \{\}\)/)
    expect(agentAdmin).toMatch(/'Test and enable' : 'Test connection'[^]*:disabled="!profile\.secretConfigured"/)
    expect(agentAdmin).toMatch(/Enable" :disabled="!profile\.conformed \|\| !profile\.secretConfigured"/)
    expect(agentAdmin).toMatch(/Saving automatically verifies the connection/)
    expect(agentAdmin).toMatch(/Edit settings[^]*Updates this profile/)
    expect(agentAdmin).toMatch(/v-model="grantDraft\.groupIds"[^]*item-title="name"/)
    expect(agentAdmin).not.toMatch(/Group IDs|immutable profile|immutable version/)
    expect(agentAdmin).toMatch(/server-managed API keys are permanently deleted/)
  })

  test('has no isolated agent application or host routing', () => {
    expect(fs.existsSync(path.join(process.cwd(), 'client/agents-app.ts'))).toBe(false)
    expect(fs.existsSync(path.join(process.cwd(), 'client/index-agents.ts'))).toBe(false)
    expect(fs.existsSync(path.join(process.cwd(), 'server/views/agent.pug'))).toBe(false)
    expect(vite).not.toMatch(/index-agents/)
    expect(master).not.toMatch(/agentsPublicOrigin|agentVite|surface:\s*['"]embedded['"]/)
  })
})
