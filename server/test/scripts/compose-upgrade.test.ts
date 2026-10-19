import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from '../bun-test.mts'

const scriptPath = path.resolve('deploy/compose/upgrade.sh')

type SmokeEvent = {
  phase: 'navigation' | 'teardown'
} & (
  | { kind: 'console'; text: string; url?: string; level?: string }
  | { kind: 'pageerror'; text: string }
  | { kind: 'requestfailed'; url: string; error: string | null }
)

type SmokeScenario = {
  events?: SmokeEvent[]
  keepCanvas?: boolean
  loseFocus?: boolean
  disabledLogin?: boolean
}

async function runLoginSmoke(source: string, scenario: SmokeScenario = {}) {
  const events = new EventEmitter()
  const logs: string[] = []
  const errors: string[] = []
  const smokeProcess = { env: { TSEPISTLE_SMOKE_URL: 'https://smoke.example/' }, exitCode: 0 }
  const bounds = { x: 0, y: 0, width: 200, height: 200, top: 0, right: 200, bottom: 200, left: 0 }
  const canvas = {
    getContext: (kind: string) => (kind === 'webgl2' ? {} : null),
    getBoundingClientRect: () => bounds
  }
  const image = {
    complete: true,
    naturalWidth: 200,
    naturalHeight: 200,
    getBoundingClientRect: () => bounds
  }
  let reducedMotion: 'no-preference' | 'reduce' = 'no-preference'
  let canvasPresent = true
  const document = {
    activeElement: null as object | null,
    querySelector: (selector: string) => {
      if (selector !== '.login-particle-logo__image') throw new Error(`Unexpected document selector: ${selector}`)
      return image
    },
    querySelectorAll: (selector: string) => {
      if (selector !== '.login-particle-logo canvas') throw new Error(`Unexpected document selector: ${selector}`)
      return canvasPresent ? [canvas] : []
    }
  }
  const getComputedStyle = (element: typeof image) => {
    if (element !== image) throw new Error('Unexpected computed-style element')
    return {
      display: 'block',
      visibility: 'visible',
      opacity: reducedMotion === 'reduce' ? '1' : '0'
    }
  }
  const window = { document, getComputedStyle }
  const emailElement = {}
  const email = {
    waitFor: async () => {},
    or: () => ({ first: () => ({ waitFor: async () => {} }) }),
    focus: async () => {
      document.activeElement = emailElement
    },
    evaluate: async (callback: (element: object) => unknown) => callback(emailElement)
  }
  const canvasLocator = {
    evaluate: async (callback: (element: typeof canvas) => unknown) => callback(canvas),
    boundingBox: async () => canvas.getBoundingClientRect()
  }
  const fieldElement = {
    querySelectorAll: (selector: string) => {
      if (selector !== 'canvas') throw new Error(`Unexpected field selector: ${selector}`)
      return canvasPresent ? [canvas] : []
    },
    querySelector: (selector: string) => {
      if (selector !== '.login-particle-logo__image') throw new Error(`Unexpected image selector: ${selector}`)
      return image
    }
  }
  const field = {
    count: async () => 1,
    getAttribute: async (name: string) => {
      if (name !== 'aria-hidden') throw new Error(`Unexpected attribute: ${name}`)
      return 'true'
    },
    evaluate: async (callback: (element: typeof fieldElement) => unknown) => callback(fieldElement),
    locator: (selector: string) => {
      if (selector === 'canvas') return canvasLocator
      if (selector === '.login-particle-logo__silhouette') return { count: async () => 0 }
      throw new Error(`Unexpected nested selector: ${selector}`)
    }
  }
  const emit = (phase: SmokeEvent['phase']) => {
    for (const event of scenario.events ?? []) {
      if (event.phase !== phase) continue
      if (event.kind === 'console') {
        events.emit('console', {
          type: () => event.level ?? 'error',
          text: () => event.text,
          location: () => ({ url: event.url ?? 'https://smoke.example/app.js' })
        })
      } else if (event.kind === 'pageerror') {
        events.emit('pageerror', new Error(event.text))
      } else {
        events.emit('requestfailed', {
          url: () => event.url,
          failure: () => (event.error === null ? null : { errorText: event.error })
        })
      }
    }
  }
  const page = Object.assign(events, {
    goto: async () => {
      emit('navigation')
      return { status: () => 200 }
    },
    locator: (selector: string) => {
      if (selector === '#login-site-title') return { waitFor: async () => {} }
      if (selector === '.login-particle-logo') return field
      throw new Error(`Unexpected page selector: ${selector}`)
    },
    getByText: (text: string) => {
      if (text !== 'Select Authentication Provider') throw new Error(`Unexpected text: ${text}`)
      return { isVisible: async () => false }
    },
    getByLabel: (label: string) => {
      if (label === 'Email Address') return email
      if (label === 'Password') return { waitFor: async () => {} }
      throw new Error(`Unexpected label: ${label}`)
    },
    getByRole: (role: string, options: { name: string }) => {
      if (role !== 'button' || options.name !== 'Log In') throw new Error(`Unexpected role: ${role}`)
      return { isEnabled: async () => !scenario.disabledLogin }
    },
    mouse: { move: async () => {}, down: async () => {}, up: async () => {} },
    emulateMedia: async (options: { reducedMotion: 'reduce' }) => {
      if (options.reducedMotion !== 'reduce') throw new Error('Unexpected media transition')
      reducedMotion = options.reducedMotion
      // Deliver cancellation before this promise settles, as an in-flight
      // browser request can fail during the media transition itself.
      emit('teardown')
      canvasPresent = scenario.keepCanvas ?? false
      if (scenario.loseFocus) document.activeElement = null
    },
    waitForFunction: async (callback: () => boolean) => {
      if (!callback()) throw new Error('Reduced-motion canvas removal timed out')
    },
    waitForTimeout: async () => {
      throw new Error('Unexpected renderer polling')
    }
  })
  const browser = {
    newContext: async (options: { reducedMotion: 'no-preference' | 'reduce' }) => {
      reducedMotion = options.reducedMotion
      return { newPage: async () => page }
    },
    close: async () => {}
  }
  await runInNewContext(
    source,
    {
      require: (name: string) => {
        if (name !== '@playwright/test') throw new Error(`Unexpected dependency: ${name}`)
        return { chromium: { launch: async () => browser } }
      },
      process: smokeProcess,
      console: {
        log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
        error: (...args: unknown[]) => errors.push(args.map(String).join(' '))
      },
      URL,
      document,
      window,
      getComputedStyle
    },
    { filename: 'deploy/compose/login-smoke.cjs', timeout: 1000 }
  )
  return { exitCode: smokeProcess.exitCode, logs, errors }
}

describe('Compose upgrade command', () => {
  it('declares recovery and verification for every enforced migration', async () => {
    const registry = JSON.parse(await readFile('server/db/migration-deployment-contracts.json', 'utf8'))
    for (const file of await readdir('server/db/migrations')) {
      const match = /^tsepistle-(\d{6})-.+\.ts$/.exec(file)
      if (!match || Number(match[1]) < registry.enforceFromSequence) continue
      const contract = registry.migrations[file.replace(/\.ts$/, '.js')]
      expect(contract, file).toBeDefined()
      expect(contract.rollback, file).toBe('fix-forward-or-restore')
      expect(contract.recovery, file).toBe('paired')
      expect(contract.rehearsal, file).toBe('required')
      expect(contract.rehearsalPostconditions.length, file).toBeGreaterThan(0)
      expect(contract.runtimePostconditions.length, file).toBeGreaterThan(0)
    }
  })

  it('requires an immutable image and separates apply from browser acceptance before any operational command', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'compose-upgrade-cli-'))
    try {
      const bin = path.join(sandbox, 'bin')
      const transcript = path.join(sandbox, 'commands')
      await mkdir(bin)
      // Admit only the tools needed to locate the script and print help.
      // Operational commands cannot fall through to the host PATH.
      for (const command of ['cat', 'dirname']) await symlink(`/usr/bin/${command}`, path.join(bin, command))
      const denied = path.join(sandbox, 'denied')
      await writeFile(denied, '#!/bin/bash\nprintf "%s\\n" "$0 $*" >> "$UPGRADE_COMMAND_LOG"\nexit 97\n', { mode: 0o700 })
      for (const command of [
        'git',
        'docker',
        'ssh',
        'node',
        'bun',
        'jq',
        'curl',
        'tar',
        'sha256sum',
        'stat',
        'awk',
        'grep',
        'sed',
        'find',
        'install',
        'date',
        'mktemp',
        'diff',
        'id',
        'chmod',
        'unlink',
        'cut',
        'sort',
        'sleep'
      ]) {
        await symlink(denied, path.join(bin, command))
      }
      const run = (args: string[], entrypoint = scriptPath) => {
        const result = spawnSync('/bin/bash', [entrypoint, ...args], {
          encoding: 'utf8',
          timeout: 2000,
          env: { PATH: bin, UPGRADE_COMMAND_LOG: transcript, LC_ALL: 'C' }
        })
        if (result.error) throw result.error
        expect(result.signal).toBeNull()
        return result
      }
      const help = run(['--help'])
      expect(help.status).toBe(0)
      expect(help.stdout).toMatch(/\bplan\b[^\n]*--profile\s+\S+[^\n]*--revision\s+\S+/u)
      expect(help.stdout).toMatch(/\bapply\b[^\n]*--plan\s+\S+[^\n]*--confirm\s+\S+/u)
      expect(help.stdout).toMatch(/\bplan\b[^\n]*--image\s+\S+/u)
      expect(help.stdout).toMatch(/\baccept\b[^\n]*--plan\s+\S+[^\n]*--confirm\s+\S+[^\n]*--browser-smoke-passed/u)

      const profile = path.join(sandbox, 'profile.json')
      const plan = path.join(sandbox, 'plan.json')
      const revision = 'a'.repeat(40)
      const digest = 'b'.repeat(64)
      const image = `ghcr.io/example/wiki@sha256:${'c'.repeat(64)}`
      for (const args of [
        ['plan', '--profile', profile],
        ['plan', '--revision', revision],
        ['plan', '--profile', profile, '--revision', revision],
        ['apply', '--plan', plan],
        ['apply', '--confirm', digest],
        ['accept', '--plan', plan, '--confirm', digest],
        ['accept', '--plan', plan, '--browser-smoke-passed']
      ]) {
        const result = run(args)
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/\brequires\b/u)
      }
      for (const option of ['--yes', '--force']) {
        for (const args of [
          ['plan', '--profile', profile, '--revision', revision, '--image', image, option],
          ['apply', '--plan', plan, '--confirm', digest, option],
          ['accept', '--plan', plan, '--confirm', digest, '--browser-smoke-passed', option]
        ]) {
          const result = run(args)
          expect(result.status).toBe(1)
          expect(result.stderr).toContain(`Unknown option: ${option}`)
        }
      }
      for (const candidate of ['ghcr.io/example/wiki:latest', `ghcr.io/example/wiki@sha256:${'c'.repeat(63)}`, `${image}\nother`]) {
        const result = run(['plan', '--profile', profile, '--revision', revision, '--image', candidate])
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('immutable repository@sha256')
      }
      const bypass = run(['apply', '--plan', plan, '--confirm', digest, '--browser-smoke-passed'])
      expect(bypass.status).toBe(1)
      expect(bypass.stderr).toContain('apply does not accept browser confirmation')
      const remotePath = path.resolve('deploy/compose/upgrade-remote.sh')
      const remoteHelp = run(['--help'], remotePath)
      expect(remoteHelp.status).toBe(0)
      expect(remoteHelp.stdout).toContain('--host SSH_HOST')
      const remoteArgs = ['--repository', '/remote/repo with spaces', '--profile', '/remote/profile.json', '--revision', revision, '--image', image]
      for (const host of ['-oProxyCommand=anything', 'host\nother', 'host with spaces']) {
        const invalidHost = run(['--host', host, ...remoteArgs], remotePath)
        expect(invalidHost.status).toBe(1)
        expect(invalidHost.stderr).toContain('Invalid SSH destination')
      }
      const incompleteRemote = run(['--host', 'reviewed-host'], remotePath)
      expect(incompleteRemote.status).toBe(1)
      expect(incompleteRemote.stderr).toContain('Requires --host, --repository, --profile, --revision and --image')
      await expect(readFile(transcript, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it('rejects changed, expired and unapplied plans without contacting Docker or accepting a candidate', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'compose-upgrade-plan-'))
    try {
      const planPath = path.join(sandbox, 'plan.json')
      const payload = {
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        operatorRevision: 'a'.repeat(40),
        phase: 'planned',
        profile: path.join(sandbox, 'unavailable-profile.json'),
        schemaVersion: 2,
        targetRevision: 'b'.repeat(40)
      }
      // This is the public confirmation format, using real jq, not a simulated
      // successful Docker/browser/deployment boundary.
      const save = async (value: typeof payload) => {
        const canonical = spawnSync('jq', ['-Sc', '.'], { input: JSON.stringify(value), encoding: 'utf8' })
        if (canonical.error) throw canonical.error
        expect(canonical.status).toBe(0)
        const digest = createHash('sha256').update(canonical.stdout).digest('hex')
        await writeFile(planPath, JSON.stringify({ ...value, digest }), { mode: 0o600 })
        return digest
      }
      const run = (command: 'apply' | 'accept', digest: string) =>
        spawnSync('/bin/bash', [scriptPath, command, '--plan', planPath, '--confirm', digest, ...(command === 'accept' ? ['--browser-smoke-passed'] : [])], {
          encoding: 'utf8',
          timeout: 2000
        })
      const digest = await save(payload)
      const unapplied = run('accept', digest)
      expect(unapplied.status).toBe(1)
      expect(unapplied.stderr).toContain('Applied deployment state must be a regular non-symlink file')
      expect(JSON.parse(await readFile(planPath, 'utf8'))).toEqual({ ...payload, digest })

      // A failed attempt is never an accepted deployment; matching confirmation
      // cannot turn it into an externally verified candidate.
      await writeFile(`${planPath}.state.json`, JSON.stringify({ schemaVersion: 1, phase: 'applying', planDigest: digest }), { mode: 0o600 })
      const attempted = run('accept', digest)
      expect(attempted.status).toBe(1)
      expect(attempted.stderr).toContain('not awaiting external browser verification')
      await writeFile(`${planPath}.state.json`, JSON.stringify({
        schemaVersion: 1, phase: 'awaiting-external-browser-verification', planDigest: 'f'.repeat(64)
      }), { mode: 0o600 })
      const wrongState = run('accept', digest)
      expect(wrongState.status).toBe(1)
      expect(wrongState.stderr).toContain('not awaiting external browser verification')

      for (const field of ['operatorRevision', 'targetRevision', 'profile'] as const) {
        await writeFile(planPath, JSON.stringify({ ...payload, [field]: 'changed', digest }), { mode: 0o600 })
        for (const command of ['apply', 'accept'] as const) {
          const changed = run(command, digest)
          expect(changed.status).toBe(1)
          expect(changed.stderr).toContain('Plan digest confirmation does not match')
        }
      }
      const expired = await save({ ...payload, expiresAt: 1 })
      for (const command of ['apply', 'accept'] as const) {
        const result = run(command, expired)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('Deployment plan expired')
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it('ships a secret-free operator profile template', async () => {
    const profile = JSON.parse(await readFile(path.resolve('deploy/compose/upgrade-profile.example.json'), 'utf8')) as Record<string, unknown>

    expect(JSON.stringify(profile)).not.toMatch(/password|secret|token|api.?key/iu)
  })

  it('classifies retired-renderer console errors and teardown-only particle request cancellation', async () => {
    const smoke = await readFile(path.resolve('deploy/compose/login-smoke.cjs'), 'utf8')
    const retired = '[TresJS] Renderer initialization failed: Particle backend lease was retired'
    const particle = 'https://smoke.example/assets/particle.bin?revision=1'
    const cases: { name: string; event: SmokeEvent; accepted: boolean; diagnostic?: string }[] = [
      { name: 'retirement during backend retry', event: { phase: 'navigation', kind: 'console', text: retired }, accepted: true },
      { name: 'retirement during teardown', event: { phase: 'teardown', kind: 'console', text: retired }, accepted: true },
      {
        name: 'retirement without initialization classification',
        event: { phase: 'navigation', kind: 'console', text: 'Particle backend lease was retired' },
        accepted: false,
        diagnostic: 'console:'
      },
      {
        name: 'unrelated renderer initialization error',
        event: { phase: 'teardown', kind: 'console', text: '[TresJS] Renderer initialization failed: GPU unavailable' },
        accepted: false,
        diagnostic: 'console:'
      },
      {
        name: 'unrelated console error',
        event: { phase: 'teardown', kind: 'console', text: 'Application exception' },
        accepted: false,
        diagnostic: 'Application exception'
      },
      {
        name: 'page exceptions are never console exceptions',
        event: { phase: 'teardown', kind: 'pageerror', text: retired },
        accepted: false,
        diagnostic: 'pageerror:'
      },
      {
        name: 'particle cancellation during transition',
        event: { phase: 'teardown', kind: 'requestfailed', url: particle, error: 'net::ERR_ABORTED' },
        accepted: true
      },
      {
        name: 'particle cancellation before transition',
        event: { phase: 'navigation', kind: 'requestfailed', url: particle, error: 'net::ERR_ABORTED' },
        accepted: false,
        diagnostic: 'requestfailed:'
      },
      {
        name: 'other asset cancellation',
        event: { phase: 'teardown', kind: 'requestfailed', url: 'https://smoke.example/assets/app.js', error: 'net::ERR_ABORTED' },
        accepted: false,
        diagnostic: 'requestfailed:'
      },
      {
        name: 'particle non-abort failure',
        event: { phase: 'teardown', kind: 'requestfailed', url: particle, error: 'net::ERR_CONNECTION_RESET' },
        accepted: false,
        diagnostic: 'net::ERR_CONNECTION_RESET'
      },
      {
        name: 'request with absent failure detail',
        event: { phase: 'teardown', kind: 'requestfailed', url: particle, error: null },
        accepted: false,
        diagnostic: 'requestfailed:'
      },
      {
        name: 'historical custom background 404',
        event: { phase: 'navigation', kind: 'console', url: 'https://smoke.example/loginv2.jpg', text: '404 Not Found' },
        accepted: true
      },
      {
        name: 'other background error',
        event: { phase: 'navigation', kind: 'console', url: 'https://smoke.example/loginv2.jpg', text: '500 Internal Server Error' },
        accepted: false,
        diagnostic: '500 Internal Server Error'
      },
      {
        name: '404 on a different resource',
        event: { phase: 'navigation', kind: 'console', url: 'https://smoke.example/app.js', text: '404 Not Found' },
        accepted: false,
        diagnostic: '404 Not Found'
      },
      { name: 'non-error console message', event: { phase: 'navigation', kind: 'console', text: 'Informational message', level: 'warning' }, accepted: true }
    ]
    for (const scenario of cases) {
      const result = await runLoginSmoke(smoke, { events: [scenario.event] })
      expect({ name: scenario.name, exitCode: result.exitCode }).toEqual({ name: scenario.name, exitCode: scenario.accepted ? 0 : 1 })
      if (scenario.accepted) {
        expect(result.errors).toEqual([])
      } else {
        expect(result.errors.join('\n')).toContain(scenario.diagnostic!)
        expect(result.logs).toEqual([])
      }
    }
  })

  it('does not let tolerated retirement conceal unusable login controls or reduced-motion teardown', async () => {
    const smoke = await readFile(path.resolve('deploy/compose/login-smoke.cjs'), 'utf8')
    const event: SmokeEvent = {
      phase: 'navigation',
      kind: 'console',
      text: '[TresJS] Renderer initialization failed: Particle backend lease was retired'
    }
    for (const scenario of [
      { state: { keepCanvas: true }, diagnostic: 'Reduced-motion canvas removal timed out' },
      { state: { loseFocus: true }, diagnostic: 'Reduced-motion teardown disturbed login focus' },
      { state: { disabledLogin: true }, diagnostic: 'Login button is disabled' }
    ]) {
      const result = await runLoginSmoke(smoke, { events: [event], ...scenario.state })
      expect(result.exitCode).toBe(1)
      expect(result.errors.join('\n')).toContain(scenario.diagnostic)
      expect(result.logs).toEqual([])
    }
  })

  it('accepts only the browser-verified process and preserves its applied-state bindings', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'compose-upgrade-accept-'))
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    try {
      const plan = path.join(sandbox, 'plan.json')
      const stateFile = `${plan}.state.json`
      const environment = path.join(sandbox, 'environment')
      const started = path.join(sandbox, 'started')
      const digest = 'a'.repeat(64)
      const imageId = `sha256:${'b'.repeat(64)}`
      const image = `registry.example/wiki@sha256:${'c'.repeat(64)}`
      const revision = 'd'.repeat(40)
      await writeFile(plan, JSON.stringify({ sentinelInventory: [] }), { mode: 0o600 })
      await writeFile(environment, 'environment\n', { mode: 0o600 })
      const awaiting = {
        schemaVersion: 1,
        phase: 'awaiting-external-browser-verification',
        planDigest: digest,
        appContainerId: 'candidate-app',
        databaseContainerId: 'preserved-database',
        candidateImageId: imageId,
        updatedAt: 1,
        recoveryPath: '/retained/recovery-point',
        envSha256: hash('environment\n'),
        privateFilesSha256: hash('private-files\n'),
        appStartedAt: 'browser-verified-start',
        protectedContainers: [],
        appRuntimeContractSha256: hash('runtime-contract\n'),
        migrationLedger: ['migration.js'],
        browserSmokePassed: false,
        browserVerification: null
      }
      const harness = String.raw`
source "$1"
PLAN_FILE="$TEST_PLAN"
ENV_FILE="$TEST_ENVIRONMENT"
CONFIRM_DIGEST="$TEST_DIGEST"
APP_CONTAINER=candidate-app
DB_CONTAINER=preserved-database
CANDIDATE_ID="$TEST_IMAGE_ID"
CANDIDATE_IMAGE="$TEST_IMAGE"
TARGET_REVISION="$TEST_REVISION"
load_bound_plan() { :; }
live_revision() { printf '%s\n' "$TARGET_REVISION"; }
private_files_fingerprints() { printf 'private-files\n'; }
protected_container_state() { printf '[]\n'; }
normalized_app_contract() { printf 'runtime-contract\n'; }
ledger_json() { printf '["migration.js"]\n'; }
ledger_summary() { printf '1|1|migration.js|0\n'; }
verify_postconditions() { :; }
docker() {
  [[ "$1" == inspect && "$2" == candidate-app && "$3" == --format ]] || return 97
  case "$4" in
    '{{.Image}}') printf '%s\n' "$CANDIDATE_ID" ;;
    '{{.Config.Image}}') printf '%s\n' "$CANDIDATE_IMAGE" ;;
    '{{.State.Health.Status}}|{{.RestartCount}}') printf 'healthy|0\n' ;;
    '{{.State.StartedAt}}') cat "$TEST_STARTED" ;;
    *) return 97 ;;
  esac
}
admit_and_check() {
  if [[ "$TEST_MODE" == restarted ]]; then printf 'untested-restart\n' > "$TEST_STARTED"; fi
}
accept_plan
`
      for (const mode of ['stable', 'restarted']) {
        await writeFile(stateFile, JSON.stringify(awaiting), { mode: 0o600 })
        await writeFile(started, 'browser-verified-start\n', { mode: 0o600 })
        const result = spawnSync('/bin/bash', ['-c', harness, 'compose-acceptance', scriptPath], {
          encoding: 'utf8',
          timeout: 5000,
          env: {
            PATH: process.env.PATH,
            LC_ALL: 'C',
            TEST_PLAN: plan,
            TEST_ENVIRONMENT: environment,
            TEST_DIGEST: digest,
            TEST_IMAGE_ID: imageId,
            TEST_IMAGE: image,
            TEST_REVISION: revision,
            TEST_STARTED: started,
            TEST_MODE: mode
          }
        })
        if (result.error) throw result.error
        expect(result.signal).toBeNull()
        const persisted = JSON.parse(await readFile(stateFile, 'utf8'))
        if (mode === 'restarted') {
          expect(result.status).toBe(1)
          expect(result.stderr).toContain('Applied candidate was restarted')
          expect(persisted).toEqual(awaiting)
        } else {
          expect(result.status, result.stderr).toBe(0)
          expect(persisted).toEqual({
            ...awaiting,
            phase: 'accepted',
            updatedAt: expect.any(Number),
            browserSmokePassed: true,
            browserVerification: 'trusted-operator-confirmation'
          })
        }
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })
})
