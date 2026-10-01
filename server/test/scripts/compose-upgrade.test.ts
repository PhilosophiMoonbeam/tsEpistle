import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from '../bun-test.mts'

const scriptPath = path.resolve('deploy/compose/upgrade.sh')

type SmokeEvent = {
  phase: 'navigation' | 'teardown'
} & (
  | { kind: 'console', text: string, url?: string, level?: string }
  | { kind: 'pageerror', text: string }
  | { kind: 'requestfailed', url: string, error: string | null }
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
    getContext: (kind: string) => kind === 'webgl2' ? {} : null,
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
    focus: async () => { document.activeElement = emailElement },
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
          failure: () => event.error === null ? null : { errorText: event.error }
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
    waitForTimeout: async () => { throw new Error('Unexpected renderer polling') }
  })
  const browser = {
    newContext: async (options: { reducedMotion: 'no-preference' | 'reduce' }) => {
      reducedMotion = options.reducedMotion
      return { newPage: async () => page }
    },
    close: async () => {}
  }
  await runInNewContext(source, {
    require: (name: string) => {
      if (name !== 'playwright') throw new Error(`Unexpected dependency: ${name}`)
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
  }, { filename: 'deploy/compose/login-smoke.cjs', timeout: 1000 })
  return { exitCode: smokeProcess.exitCode, logs, errors }
}

describe('Compose upgrade command', () => {
  it('exposes only the guarded plan/apply interface', async () => {
    expect(await readFile(scriptPath, 'utf8')).toStartWith('#!/usr/bin/env bash')
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
      for (const command of ['git', 'docker', 'jq', 'curl', 'tar', 'sha256sum', 'stat', 'awk', 'grep', 'sed', 'find', 'install', 'date', 'mktemp', 'diff', 'id', 'chmod', 'unlink', 'cut', 'sort', 'sleep']) {
        await symlink(denied, path.join(bin, command))
      }
      const run = (args: string[]) => {
        const result = spawnSync('/bin/bash', [scriptPath, ...args], {
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

      const profile = path.join(sandbox, 'profile.json')
      const plan = path.join(sandbox, 'plan.json')
      const revision = 'a'.repeat(40)
      const digest = 'b'.repeat(64)
      for (const args of [
        ['plan', '--profile', profile],
        ['plan', '--revision', revision],
        ['apply', '--plan', plan],
        ['apply', '--confirm', digest]
      ]) {
        const result = run(args)
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/\brequires\b/u)
      }
      for (const option of ['--yes', '--force']) {
        for (const args of [
          ['plan', '--profile', profile, '--revision', revision, option],
          ['apply', '--plan', plan, '--confirm', digest, option]
        ]) {
          const result = run(args)
          expect(result.status).toBe(1)
          expect(result.stderr).toContain(`Unknown option: ${option}`)
        }
      }
      await expect(readFile(transcript, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it('keeps destructive stack and restore operations out of the implementation', async () => {
    const script = await readFile(scriptPath, 'utf8')

    expect(script).not.toMatch(/compose\s+down/u)
    expect(script).not.toContain('volume prune')
    expect(script).not.toContain('--renew-anon-volumes')
    expect(script).not.toMatch(/pg_restore[^\n]*--clean/u)
    expect(script).not.toMatch(/^\s*\(\([^\n]+\)\)\s*&&/mu)
    expect(script).toContain('up -d --no-deps --no-build --force-recreate')
    expect(script).toContain('--volumes-from "$APP_CONTAINER":ro')
    expect(script).toContain('apk add --no-cache docker-cli docker-cli-buildx git')
    expect(script).toContain("A committed migration cannot be rolled back by image alone")
    expect(script).toContain('agent-goal-budget-columns)')
    expect(script).toContain('agent-goal-budget-tier-selection)')
    expect(script).toContain('native-page-ratings-and-recovery-schema)')
    expect(script).toContain('native-page-ratings-and-recovery)')
    expect(script).toContain('verify_native_page_schema "$container" "$user" "$database"')
    expect(script).toContain("to_jsonb(t) - ARRAY['reduceMotion','underlineLinks','contentTextSize','communicationLocale']")
    expect(script).toContain('Healthy candidate was reconnected to the public proxy after verification failed.')
    expect(script).toContain('proxyAliasPresent:(.value.Aliases|index($proxyAlias) != null)')
  })

  it('ships a secret-free operator profile template', async () => {
    const profile = JSON.parse(await readFile(path.resolve('deploy/compose/upgrade-profile.example.json'), 'utf8')) as Record<string, unknown>

    expect(profile.schemaVersion).toBe(1)
    expect(profile.appService).toBe('app')
    expect(profile.databaseService).toBe('database')
    expect(JSON.stringify(profile)).not.toMatch(/password|secret|token|api.?key/iu)
  })

  it('classifies retired-renderer console errors and teardown-only particle request cancellation', async () => {
    const smoke = await readFile(path.resolve('deploy/compose/login-smoke.cjs'), 'utf8')
    const retired = '[TresJS] Renderer initialization failed: Particle backend lease was retired'
    const particle = 'https://smoke.example/assets/particle.bin?revision=1'
    const cases: { name: string, event: SmokeEvent, accepted: boolean, diagnostic?: string }[] = [
      { name: 'retirement during backend retry', event: { phase: 'navigation', kind: 'console', text: retired }, accepted: true },
      { name: 'retirement during teardown', event: { phase: 'teardown', kind: 'console', text: retired }, accepted: true },
      { name: 'retirement without initialization classification', event: { phase: 'navigation', kind: 'console', text: 'Particle backend lease was retired' }, accepted: false, diagnostic: 'console:' },
      { name: 'unrelated renderer initialization error', event: { phase: 'teardown', kind: 'console', text: '[TresJS] Renderer initialization failed: GPU unavailable' }, accepted: false, diagnostic: 'console:' },
      { name: 'unrelated console error', event: { phase: 'teardown', kind: 'console', text: 'Application exception' }, accepted: false, diagnostic: 'Application exception' },
      { name: 'page exceptions are never console exceptions', event: { phase: 'teardown', kind: 'pageerror', text: retired }, accepted: false, diagnostic: 'pageerror:' },
      { name: 'particle cancellation during transition', event: { phase: 'teardown', kind: 'requestfailed', url: particle, error: 'net::ERR_ABORTED' }, accepted: true },
      { name: 'particle cancellation before transition', event: { phase: 'navigation', kind: 'requestfailed', url: particle, error: 'net::ERR_ABORTED' }, accepted: false, diagnostic: 'requestfailed:' },
      { name: 'other asset cancellation', event: { phase: 'teardown', kind: 'requestfailed', url: 'https://smoke.example/assets/app.js', error: 'net::ERR_ABORTED' }, accepted: false, diagnostic: 'requestfailed:' },
      { name: 'particle non-abort failure', event: { phase: 'teardown', kind: 'requestfailed', url: particle, error: 'net::ERR_CONNECTION_RESET' }, accepted: false, diagnostic: 'net::ERR_CONNECTION_RESET' },
      { name: 'request with absent failure detail', event: { phase: 'teardown', kind: 'requestfailed', url: particle, error: null }, accepted: false, diagnostic: 'requestfailed:' },
      { name: 'historical custom background 404', event: { phase: 'navigation', kind: 'console', url: 'https://smoke.example/loginv2.jpg', text: '404 Not Found' }, accepted: true },
      { name: 'other background error', event: { phase: 'navigation', kind: 'console', url: 'https://smoke.example/loginv2.jpg', text: '500 Internal Server Error' }, accepted: false, diagnostic: '500 Internal Server Error' },
      { name: '404 on a different resource', event: { phase: 'navigation', kind: 'console', url: 'https://smoke.example/app.js', text: '404 Not Found' }, accepted: false, diagnostic: '404 Not Found' },
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
})
