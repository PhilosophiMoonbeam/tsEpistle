import { access, readFile, readdir } from 'node:fs/promises'
import { load as loadYaml } from 'js-yaml'

interface DataFile {
  defaults?: {
    config?: {
      agents?: Record<string, unknown>
    }
  }
}

const requiredVersions = {
  '@ax-llm/ax': '25.4.5',
  '@modelcontextprotocol/server': '2.3.0',
  '@modelcontextprotocol/node': '2.1.0',
  '@modelcontextprotocol/express': '2.0.2',
  'playwright-core': '1.62.1'
} as const
const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}
const failures: string[] = []
for (const [name, version] of Object.entries(requiredVersions)) {
  if (manifest.dependencies?.[name] !== version) {
    failures.push(`${name} must be an exact ${version} runtime dependency, found ${manifest.dependencies?.[name] ?? 'missing'}`)
  }
  if (manifest.devDependencies?.[name] !== undefined || manifest.optionalDependencies?.[name] !== undefined)
    failures.push(`${name} must not be duplicated outside runtime dependencies`)
}
const mcpClient = '@modelcontextprotocol/client'
if (manifest.devDependencies?.[mcpClient] !== '2.1.0') failures.push(`${mcpClient} must remain a test-only exact 2.1.0 dependency`)
if (manifest.dependencies?.[mcpClient] !== undefined || manifest.optionalDependencies?.[mcpClient] !== undefined)
  failures.push(`${mcpClient} must not be a runtime dependency`)

const data = loadYaml(await readFile('server/app/data.yml', 'utf8')) as DataFile
const agents = data.defaults?.config?.agents
if (!agents) failures.push('server/app/data.yml does not define defaults.config.agents')
else {
  const flagPaths = [
    'enabled',
    'provider.enabled',
    'orchestration.enabled',
    'goals.enabled',
    'skills.enabled',
    'browser.enabled',
    'proposals.enabled',
    'writes.enabled',
    'writes.create.enabled',
    'writes.patch.enabled',
    'writes.move.enabled',
    'writes.restore.enabled',
    'writes.delete.enabled',
    'mcp.enabled'
  ]
  for (const path of flagPaths) {
    let value: unknown = agents
    for (const segment of path.split('.')) value = typeof value === 'object' && value !== null ? Reflect.get(value, segment) : undefined
    if (value !== false) failures.push(`default agents.${path} must be false`)
  }
}

const browserDockerfile = await readFile('dev/build/Dockerfile.agent-browser', 'utf8')
const browserRuntime = await readFile('server/agents/browser/runtime.ts', 'utf8')
if (!browserDockerfile.includes('oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d')) {
  failures.push('browser worker base image must retain the reviewed Bun 1.4.4 multi-arch digest')
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
  } catch {
    /* absence is the required clean cutover */
  }
}

const master = await readFile('server/master.ts', 'utf8')
for (const obsolete of ['agentsPublicOrigin', 'agentVite', 'agentLaunchHandoff']) {
  if (master.includes(obsolete)) failures.push(`server/master.ts retains obsolete isolated-agent wiring: ${obsolete}`)
}
// Public checks must be runnable from an unprivileged application checkout.
// Publication policy belongs to the private controller, not a source copy here.
interface PublicStep {
  id?: string
  uses?: string
  run?: string
  if?: string
  shell?: string
  env?: Record<string, unknown>
  with?: Record<string, unknown>
}
interface PublicJob {
  'runs-on'?: unknown
  if?: string
  needs?: string[]
  environment?: string | { name?: string }
  permissions?: Record<string, unknown>
  env?: Record<string, unknown>
  steps?: PublicStep[]
}
interface PublicWorkflow {
  on?: Record<string, unknown>
  permissions?: Record<string, unknown>
  env?: Record<string, unknown>
  jobs?: Record<string, PublicJob>
}
const relayPolicies: Record<string, { job: string; condition: string }> = {
  'build.yml': {
    job: 'full-controller',
    condition: "github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || (github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success'))"
  },
  'packer.yml': {
    job: 'marketplace-controller',
    condition: "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'"
  }
}
const publicWorkflows = (await readdir('.github/workflows')).filter(file => /\.ya?ml$/.test(file))
for (const file of ['build.yml', 'helm.yml', 'scarlett-upstream.yml', 'packer.yml', 'release-request.yml']) {
  if (!publicWorkflows.includes(file)) failures.push(`public workflow is missing: ${file}`)
}
for (const file of publicWorkflows) {
  const workflow = loadYaml(await readFile(`.github/workflows/${file}`, 'utf8')) as PublicWorkflow
  if (!workflow?.jobs || Object.keys(workflow.jobs).length === 0) {
    failures.push(`${file} must define public hosted jobs`)
    continue
  }
  if (!workflow.permissions || workflow.permissions.contents !== 'read' || Object.values(workflow.permissions).some(value => value !== 'read' && value !== 'none'))
    failures.push(`${file} must default to explicit read-only permissions`)
  if (JSON.stringify(workflow.env ?? {}).includes('secrets.CI_CONTROLLER_TOKEN'))
    failures.push(`${file} must not expose the controller credential at workflow scope`)
  if (workflow.on && 'pull_request_target' in workflow.on)
    failures.push(`${file} must not execute through privileged PR triggers`)
  if (workflow.on && 'workflow_run' in workflow.on) {
    const trigger = workflow.on.workflow_run as { workflows?: string[]; types?: string[] }
    if (file !== 'build.yml' || JSON.stringify(trigger.workflows) !== '["Release Request"]' || JSON.stringify(trigger.types) !== '["completed"]')
      failures.push(`${file} must accept only the read-only completed Release Request signal`)
  }
  const relay = relayPolicies[file]
  if (relay && !workflow.jobs[relay.job]) failures.push(`${file} is missing its protected controller relay`)
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (typeof job['runs-on'] !== 'string' || !/^(ubuntu|windows|macos)-(latest|\d+(?:\.\d+)?)(?:-(?:arm|large|xlarge))?$/.test(job['runs-on']))
      failures.push(`${file}/${name} must use a literal GitHub-hosted runner, never a public self-hosted selector`)
    for (const [permission, value] of Object.entries(job.permissions ?? {})) {
      const developmentWrite = file === 'build.yml' && name === 'development' && permission === 'packages'
      const finishWrite = file === 'build.yml' && name === 'release-finish' && ['attestations', 'contents', 'id-token', 'packages'].includes(permission)
      if (value !== 'read' && value !== 'none' && !(value === 'write' && (developmentWrite || finishWrite)))
        failures.push(`${file}/${name} grants unauthorized ${permission}:${String(value)}`)
    }
    if (relay?.job === name) {
      if (JSON.stringify(job.env ?? {}).includes('secrets.CI_CONTROLLER_TOKEN'))
        failures.push(`${file}/${name} must scope the controller credential to dispatch/download steps`)
      const environment = typeof job.environment === 'string' ? job.environment : job.environment?.name
      const condition = typeof job.if === 'string' ? job.if.replace(/^\s*\$\{\{|\}\}\s*$/g, '').replace(/\s+/g, ' ').trim() : ''
      if (environment !== 'trusted-ci-controller' || condition !== relay.condition)
        failures.push(`${file}/${name} must use the trusted environment and main-only implementation boundary`)
      const checkout = job.steps?.find(step => step.uses?.startsWith('actions/checkout@'))
      if (checkout?.with?.ref !== '${{ github.sha }}' || checkout.with['persist-credentials'] !== false || job.steps?.[0] !== checkout)
        failures.push(`${file}/${name} must checkout only its immutable main implementation without persisted credentials`)
      const dispatch = job.steps?.filter(step => step.run === 'bun --no-env-file .github/scripts/controller-relay.mjs')
      if (dispatch?.length !== 1 || dispatch[0]?.env?.GH_TOKEN !== '${{ secrets.CI_CONTROLLER_TOKEN }}')
        failures.push(`${file}/${name} must invoke the exact-run main relay with step-scoped authority`)
      for (const step of job.steps ?? []) {
        if (!JSON.stringify(step).includes('secrets.CI_CONTROLLER_TOKEN')) continue
        const exactDownload = file === 'build.yml' && step.uses?.startsWith('actions/download-artifact@') &&
          step.if === "steps.relay.outputs.INTENT == 'release'" && step.with?.name === 'official-release-candidate' &&
          step.with.repository === 'PhilosophiMoonbeam/tsEpistle-ci' && step.with['run-id'] === '${{ steps.relay.outputs.PRIVATE_RUN_ID }}' &&
          step.with['github-token'] === '${{ secrets.CI_CONTROLLER_TOKEN }}'
        if (step !== dispatch?.[0] && !exactDownload)
          failures.push(`${file}/${name} exposes controller authority outside exact dispatch/artifact transfer`)
      }
    } else if (JSON.stringify(job).includes('secrets.CI_CONTROLLER_TOKEN')) {
      failures.push(`${file}/${name} must not receive the private controller credential`)
    }
    if (file === 'build.yml' && name === 'release-finish') {
      const environment = typeof job.environment === 'string' ? job.environment : job.environment?.name
      if (environment !== 'prod' || JSON.stringify(job.needs) !== '["full-controller"]' ||
        job.if !== "needs.full-controller.result == 'success' && startsWith(needs.full-controller.outputs.APP_REF, 'refs/tags/v')")
        failures.push('public release finishing must depend on the exact successful protected relay')
      const checkout = job.steps?.find(step => step.uses?.startsWith('actions/checkout@'))
      if (checkout?.with?.ref !== '${{ github.sha }}' || checkout.with['persist-credentials'] !== false)
        failures.push('public release signer implementation must remain truthful main, never target-tag checkout')
      if ([job.env, ...(job.steps ?? []).map(step => step.env)].some(env => Object.keys(env ?? {}).some(key => key.startsWith('GITHUB_'))))
        failures.push('public release signer must not spoof GitHub identity')
    }
    if (file === 'release-request.yml' && (job.environment || Object.values(job.permissions ?? {}).some(value => value !== 'read' && value !== 'none') ||
      (job.steps ?? []).some(step => step.uses || JSON.stringify(step).includes('secrets.'))))
      failures.push('release tag signal must remain checkout-free, credential-free and read-only')
  }
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
  try {
    await readFile(file)
  } catch {
    failures.push(`required agent release input is missing: ${file}`)
  }
}

if (failures.length > 0) throw new Error(`Agent release gate failed:\n${failures.map(failure => `- ${failure}`).join('\n')}`)
console.log('Agent release gate valid: dependencies frozen, defaults inert, runtime inputs retained, public CI hosted and controller relays protected')
