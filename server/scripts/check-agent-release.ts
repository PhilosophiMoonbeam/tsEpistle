import { readFile } from 'node:fs/promises'
import { load as loadYaml } from 'js-yaml'

interface DataFile {
  defaults?: {
    config?: {
      agents?: Record<string, unknown>
    }
  }
}

const requiredVersions = {
  '@ax-llm/ax': '23.0.15',
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
    'enabled', 'provider.enabled', 'skills.enabled', 'browser.enabled', 'proposals.enabled', 'writes.enabled',
    'writes.create.enabled', 'writes.patch.enabled', 'writes.move.enabled', 'writes.restore.enabled', 'writes.delete.enabled', 'mcp.enabled'
  ]
  for (const path of flagPaths) {
    let value: unknown = agents
    for (const segment of path.split('.')) value = typeof value === 'object' && value !== null ? Reflect.get(value, segment) : undefined
    if (value !== false) failures.push(`default agents.${path} must be false`)
  }
}

const browserDockerfile = await readFile('dev/build/Dockerfile.agent-browser', 'utf8')
if (!browserDockerfile.includes('mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e')) {
  failures.push('browser worker base image must retain the reviewed Playwright 1.62.1 multi-arch digest')
}
if (!browserDockerfile.includes('USER pwuser')) failures.push('browser worker image must run as pwuser')

const workflowText = await readFile('.github/workflows/build.yml', 'utf8')
const workflow = loadYaml(workflowText) as { jobs?: Record<string, unknown> }
for (const job of ['agent-postgres', 'agent-browser-image', 'publish-amd64', 'arm', 'beta', 'release']) {
  if (!workflow.jobs?.[job]) failures.push(`release workflow is missing required job ${job}`)
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
  'server/db/migrations/2.5.139.ts',
  'server/scripts/agent-maintenance.ts',
  'server/scripts/generate-release-manifest.ts',
  'docs/agents-deployment.md'
]
for (const file of requiredReleaseInputs) {
  try { await readFile(file) } catch { failures.push(`required agent release input is missing: ${file}`) }
}

if (failures.length > 0) throw new Error(`Agent release gate failed:\n${failures.map(failure => `- ${failure}`).join('\n')}`)
console.log('Agent release gate valid: dependencies frozen, defaults inert, PostgreSQL and multi-arch release evidence present')
