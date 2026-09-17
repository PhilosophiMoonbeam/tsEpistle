import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from '../bun-test.mts'

const scriptPath = path.resolve('deploy/compose/upgrade.sh')

describe('Compose upgrade command', () => {
  it('exposes only the guarded plan/apply interface', async () => {
    const help = await readFile(scriptPath, 'utf8')

    expect(help).toStartWith('#!/usr/bin/env bash')
    expect(help).toContain('plan  --profile PATH --revision FULL_40_SHA')
    expect(help).toContain('apply --plan PATH --confirm PLAN_SHA256')
    expect(help).not.toContain('--yes')
    expect(help).not.toMatch(/^\s*--force\)/mu)
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
  })

  it('ships a secret-free operator profile template', async () => {
    const profile = JSON.parse(await readFile(path.resolve('deploy/compose/upgrade-profile.example.json'), 'utf8')) as Record<string, unknown>

    expect(profile.schemaVersion).toBe(1)
    expect(profile.appService).toBe('app')
    expect(profile.databaseService).toBe('database')
    expect(JSON.stringify(profile)).not.toMatch(/password|secret|token|api.?key/iu)
  })

  it('limits the retired-renderer exception to the reduced-motion teardown window', async () => {
    const smoke = await readFile(path.resolve('deploy/compose/login-smoke.cjs'), 'utf8')
    const teardown = smoke.indexOf('reducedMotionTeardownStarted = true')
    const mediaChange = smoke.indexOf("page.emulateMedia({ reducedMotion: 'reduce' })")

    expect(smoke).toContain("message.text().includes('Particle backend lease was retired')")
    expect(teardown).toBeGreaterThan(0)
    expect(mediaChange).toBeGreaterThan(teardown)
  })
})
