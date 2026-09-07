import { describe, expect, it } from 'bun:test'
import { DeveloperFlagsSaveInputSchema, DeveloperFlagsWorkspaceSchema, developerFlagChangedFields } from './developer-flags.ts'

describe('developer flag workspace contract', () => {
  it('accepts only the two grounded diagnostics in a reviewed save', () => {
    const input = {
      policy: { ldapdebug: false, sqllog: true },
      fingerprint: 'a'.repeat(64),
      reason: 'Trace the current database failure'
    }
    expect(DeveloperFlagsSaveInputSchema.safeParse(input).success).toBe(true)
    expect(DeveloperFlagsSaveInputSchema.safeParse({ ...input, policy: { ...input.policy, imaginaryFlag: true } }).success).toBe(false)
    expect(DeveloperFlagsSaveInputSchema.safeParse({ ...input, policy: { ldapdebug: false } }).success).toBe(false)
  })

  it('reports only changed supported diagnostics in a deterministic review', () => {
    expect(developerFlagChangedFields({ ldapdebug: false, sqllog: false }, { ldapdebug: true, sqllog: false })).toEqual(['ldapdebug'])
    expect(developerFlagChangedFields({ ldapdebug: false, sqllog: false }, { ldapdebug: true, sqllog: true })).toEqual(['ldapdebug', 'sqllog'])
  })

  it('rejects incomplete saved-versus-process observations', () => {
    const workspace = {
      observedAt: '2026-09-07T00:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      revision: '',
      saved: { policy: { ldapdebug: false, sqllog: false }, source: 'database', state: 'active' },
      deployment: { defaults: { ldapdebug: false, sqllog: false }, description: 'Defaults' },
      process: {
        instanceId: 'fixture',
        observedAt: '2026-09-07T00:00:00.000Z',
        policy: { ldapdebug: false, sqllog: false },
        sqlQueryLoggingApplied: false,
        settingsCurrent: true,
        state: 'applied'
      },
      history: []
    }
    expect(DeveloperFlagsWorkspaceSchema.safeParse(workspace).success).toBe(true)
    expect(DeveloperFlagsWorkspaceSchema.safeParse({ ...workspace, revision: 'not-a-revision' }).success).toBe(false)
    expect(DeveloperFlagsWorkspaceSchema.safeParse({ ...workspace, process: { ...workspace.process, sqlQueryLoggingApplied: undefined } }).success).toBe(false)
  })
})
