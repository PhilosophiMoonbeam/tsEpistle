import { describe, expect, it } from '../bun-test.mts'
import { nativePostgresRequired } from '../../scripts/ci-change-risk.ts'

describe('native PostgreSQL risk selection', () => {
  it.each([
    undefined,
    [],
    ['server/core/auth.ts'],
    ['server/db/migrations/change.ts'],
    ['shared/contracts.ts'],
    ['client/shared/types.ts'],
    ['client/auth/session.ts'],
    ['client/schema.json'],
    ['package.json'],
    ['bun.lock'],
    ['client/package.json'],
    ['server/scripts/run-tests.ts'],
    ['.github/workflows/build.yml'],
    ['deploy/compose/upgrade.sh'],
    ['unknown-runtime-input']
  ].map(paths => ({ paths })))(
    'requires native coverage for uncertain or relevant inputs: $paths', ({ paths }) => {
      expect(nativePostgresRequired(paths)).toBe(true)
    }
  )

  it('omits native coverage only for positively identified frontend/documentation changes', () => {
    expect(nativePostgresRequired(['client/components/Login.vue', 'docs/usage.md', 'README.md'])).toBe(false)
    expect(nativePostgresRequired(['client/components/Login.vue', 'server/helpers/auth.ts'])).toBe(true)
  })
})
