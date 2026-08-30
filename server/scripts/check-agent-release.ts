import { access, readFile } from 'node:fs/promises'
import { load as loadYaml } from 'js-yaml'

interface DataFile {
  defaults?: {
    config?: {
      agents?: Record<string, unknown>
    }
  }
}

const requiredVersions = {
  '@ax-llm/ax': '24.0.12',
  '@modelcontextprotocol/server': '2.0.0',
  '@modelcontextprotocol/node': '2.0.0',
  '@modelcontextprotocol/express': '2.0.0',
  'playwright-core': '1.62.1'
} as const
const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
const failures: string[] = []
for (const [name, version] of Object.entries(requiredVersions)) {
  if (dependencies[name] !== version) failures.push(`${name} must be exactly ${version}, found ${dependencies[name] ?? 'missing'}`)
}
if (manifest.devDependencies?.['@modelcontextprotocol/client'] !== '2.0.0') failures.push('@modelcontextprotocol/client must remain a test-only exact 2.0.0 dependency')

const data = loadYaml(await readFile('server/app/data.yml', 'utf8')) as DataFile
const agents = data.defaults?.config?.agents
if (!agents) failures.push('server/app/data.yml does not define defaults.config.agents')
else {
  const flagPaths = [
    'enabled', 'provider.enabled', 'orchestration.enabled', 'goals.enabled', 'skills.enabled', 'browser.enabled', 'proposals.enabled', 'writes.enabled',
    'writes.create.enabled', 'writes.patch.enabled', 'writes.move.enabled', 'writes.restore.enabled', 'writes.delete.enabled', 'mcp.enabled'
  ]
  for (const path of flagPaths) {
    let value: unknown = agents
    for (const segment of path.split('.')) value = typeof value === 'object' && value !== null ? Reflect.get(value, segment) : undefined
    if (value !== false) failures.push(`default agents.${path} must be false`)
  }
}

const browserDockerfile = await readFile('dev/build/Dockerfile.agent-browser', 'utf8')
const browserRuntime = await readFile('server/agents/browser/runtime.ts', 'utf8')
if (!browserDockerfile.includes('oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6')) {
  failures.push('browser worker base image must retain the reviewed Bun 1.4.0 multi-arch digest')
}
if (!browserDockerfile.includes('USER bun')) failures.push('browser worker image must run as bun')
if (!browserRuntime.includes('chromiumSandbox: true')) failures.push('browser worker must launch Chromium with its sandbox enabled')
if (!browserDockerfile.includes('AGENT_BROWSER_MAX_CONTEXTS=8')) failures.push('browser worker image must retain a bounded context default')


const retiredIsolatedSurface = [
  'client/agents-app.ts',
  'client/index-agents.ts',
  'client/components/agents/agent-shell.vue',
  'server/agents/launch-csrf.ts',
  'server/views/agent-login.pug',
  'server/views/agent.pug'
]
for (const file of retiredIsolatedSurface) {
  try {
    await access(file)
    failures.push(`obsolete isolated-agent surface must be removed: ${file}`)
  } catch { /* absence is the required clean cutover */ }
}

const master = await readFile('server/master.ts', 'utf8')
for (const obsolete of ['agentsPublicOrigin', 'agentVite', 'agentLaunchHandoff']) {
  if (master.includes(obsolete)) failures.push(`server/master.ts retains obsolete isolated-agent wiring: ${obsolete}`)
}
const workflowText = await readFile('.github/workflows/build.yml', 'utf8')
const workflow = loadYaml(workflowText) as { jobs?: Record<string, unknown> }
for (const job of ['agent-postgres', 'agent-browser-image', 'publish-amd64', 'arm', 'beta', 'release']) {
  if (!workflow.jobs?.[job]) failures.push(`release workflow is missing required job ${job}`)
}
for (const pgversion of [16, 17]) {
  if (!workflowText.includes(`pgversion: ${pgversion}`)) failures.push(`agent PostgreSQL release matrix must include PostgreSQL ${pgversion}`)
}
for (const evidence of [
  'server/test/db/agents-migration.postgres.integration.test.ts',
  '--platform linux/amd64,linux/arm64',
  'dev/build/Dockerfile.agent-browser',
  'docker.io/tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0',
  'wiki-agent-browser.spdx.json',
  'AGENT_BROWSER_IMAGE_DIGEST'
]) {
  if (!workflowText.includes(evidence)) failures.push(`release workflow is missing agent evidence: ${evidence}`)
}

const requiredReleaseInputs = [
  'client/components/agents/inline-agent-chat.vue',
  'server/agents/config.ts',
  'client/components/agents/agent-goal-status.vue',
  'server/agents/goals.ts',
  'server/agents/providers/openresponses.ts',
  'server/db/migrations/2.5.139.ts',
  'server/db/migrations/2.5.140.ts',
  'server/db/migrations/2.5.157.ts',
  'server/scripts/agent-maintenance.ts',
  'server/scripts/generate-release-manifest.ts',
  'docs/agents-deployment.md'
]
for (const file of requiredReleaseInputs) {
  try { await readFile(file) } catch { failures.push(`required agent release input is missing: ${file}`) }
}

if (failures.length > 0) throw new Error(`Agent release gate failed:\n${failures.map(failure => `- ${failure}`).join('\n')}`)
console.log('Agent release gate valid: dependencies frozen, defaults inert, durable goals guarded, PostgreSQL and multi-arch release evidence present')
