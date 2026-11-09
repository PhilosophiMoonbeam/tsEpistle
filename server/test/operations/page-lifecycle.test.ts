import { describe, expect, it } from '../bun-test.mts'
import { PageLifecycleRuleDefinitionSchema, PageLifecyclePreviewRequestSchema, PageLifecycleSaveRequestSchema, pageLifecycleDue, pageLifecycleSelectorMatches, pageLifecycleOriginalRelativePath, pageLifecycleMoveDestination } from '../../../shared/page-lifecycle.ts'
import type { PageLifecycleClock } from '../../../shared/page-lifecycle.ts'

const bodyEpoch = '11111111-1111-4111-8111-111111111111', commentEpoch = '22222222-2222-4222-8222-222222222222'
const clock: PageLifecycleClock = { bodyEpoch, bodyAnchorAt: '2026-10-31T23:00:00.000Z', bodyAnchorKind: 'known-change', commentEpoch, commentAnchorAt: '2026-10-31T23:00:00.000Z', commentAnchorKind: 'observed-baseline' }
const page = { id: 42, path: 'docs/start', localeCode: 'en', visibility: 'public', ownerId: null, tagIds: [2, 9] }

describe('bounded page lifecycle language and arithmetic', () => {
  it('uses inclusive elapsed UTC days across DST, and body/comment epochs remain independent', () => {
    expect(pageLifecycleDue({ kind: 'body-inactive', days: 1 }, clock, new Date('2026-11-01T22:59:59.999Z'))).toEqual({ state: 'not-due' })
    expect(pageLifecycleDue({ kind: 'body-inactive', days: 1 }, clock, new Date('2026-11-01T23:00:00.000Z'))).toEqual({ state: 'due', conditionKey: `body-inactive:${bodyEpoch}`, epoch: bodyEpoch, cycleNo: null, dueAt: '2026-11-01T23:00:00.000Z' })
    expect(pageLifecycleDue({ kind: 'comments-inactive', days: 1 }, { ...clock, bodyAnchorAt: '2026-11-01T22:00:00.000Z' }, new Date('2026-11-01T23:00:00.000Z'))).toMatchObject({ state: 'due', conditionKey: `comments-inactive:${commentEpoch}` })
  })
  it('never invents body age from missing, unknown, corrupt or future anchors', () => {
    const now = new Date('2026-11-01T23:00:00.000Z')
    expect(pageLifecycleDue({ kind: 'body-inactive', days: 1 }, null, now)).toEqual({ state: 'unknown-clock' })
    for (const partial of [{ bodyAnchorKind: 'unknown' as const }, { bodyAnchorAt: 'not-a-date' }, { bodyAnchorAt: '2026-11-02T00:00:00.000Z' }, { bodyEpoch: 'not-an-epoch' }]) expect(pageLifecycleDue({ kind: 'body-inactive', days: 1 }, { ...clock, ...partial }, now)).toEqual({ state: 'unknown-clock' })
    expect(pageLifecycleDue({ kind: 'body-inactive', days: 1 }, { ...clock, bodyAnchorKind: 'observed-baseline' }, now)).toMatchObject({ state: 'due', epoch: bodyEpoch })
  })
  it('coalesces downtime to the latest arithmetic interval without restart-time drift', () => {
    const condition = { kind: 'interval' as const, anchorAt: '2026-01-01T00:00:00.000Z', days: 3 }
    expect(pageLifecycleDue(condition, null, new Date('2026-01-10T00:00:00.000Z'))).toEqual({ state: 'due', conditionKey: 'interval:3', epoch: null, cycleNo: 3, dueAt: '2026-01-10T00:00:00.000Z' })
    expect(pageLifecycleDue(condition, null, new Date('2026-01-11T20:00:00.000Z'))).toMatchObject({ cycleNo: 3, dueAt: '2026-01-10T00:00:00.000Z' })
    expect(pageLifecycleDue(condition, null, new Date('2025-12-31T23:59:59.999Z'))).toEqual({ state: 'not-due' })
  })
  it('keeps subtree segment, locale, all-tag and private namespace boundaries', () => {
    const selector = { kind: 'subtree' as const, localeCode: 'en', normalizedRootPath: 'docs', allTagIds: [2, 9] }
    expect(pageLifecycleSelectorMatches(selector, page)).toBe(true)
    expect(pageLifecycleSelectorMatches(selector, { ...page, path: 'docs' })).toBe(true)
    for (const partial of [{ path: 'docs-extra/start' }, { localeCode: 'fr' }, { tagIds: [2] }, { visibility: 'private', ownerId: 7 }]) expect(pageLifecycleSelectorMatches(selector, { ...page, ...partial })).toBe(false)
    expect(pageLifecycleSelectorMatches({ kind: 'ids', pageIds: [42] }, { ...page, visibility: 'private', ownerId: 7 })).toBe(true)
  })
  it('normalizes finite action order but refuses duplication, unbounded targets and timer publication', () => {
    const definition = { version: 1, selector: { kind: 'ids', pageIds: [42] }, condition: { kind: 'body-inactive', days: 1 }, terminalPolicy: 'keep', effects: [{ kind: 'notify', audience: 'watchers' }, { kind: 'set-notice', text: '<b>literal plain text, not trusted HTML</b>' }, { kind: 'add-tags', tagIds: [9, 2] }] }
    expect(PageLifecycleRuleDefinitionSchema.parse(definition).effects.map(effect => effect.kind)).toEqual(['add-tags', 'set-notice', 'notify'])
    expect(PageLifecycleRuleDefinitionSchema.safeParse({ ...definition, effects: [definition.effects[0], definition.effects[0]] }).success).toBe(false)
    expect(PageLifecycleRuleDefinitionSchema.safeParse({ ...definition, effects: [{ kind: 'publish' }] }).success).toBe(false)
    expect(PageLifecycleRuleDefinitionSchema.safeParse({ ...definition, selector: { kind: 'ids', pageIds: Array.from({ length: 101 }, (_, index) => index + 1) } }).success).toBe(false)
    expect(PageLifecycleRuleDefinitionSchema.safeParse({ ...definition, condition: { kind: 'body-inactive', days: 3651 } }).success).toBe(false)
    expect(PageLifecycleRuleDefinitionSchema.safeParse({ ...definition, condition: { kind: 'interval', days: 1, anchorAt: '2026-11-01T00:00:00+01:00' } }).success).toBe(false)
    expect(PageLifecycleSaveRequestSchema.safeParse({ ...PageLifecyclePreviewRequestSchema.parse({ definition }), previewToken: bodyEpoch, unattendedConsent: false, enabled: true }).success).toBe(false)
  })
  it('builds archival destinations from immutable admitted origin, never current archive paths', () => {
    const selector = { kind: 'subtree' as const, localeCode: 'en', normalizedRootPath: 'docs' }
    const origin = pageLifecycleOriginalRelativePath(selector, 'docs/guides/start')
    const effect = { kind: 'propose-move' as const, destinationRootPath: 'archive', destinationLocale: 'same' as const, template: 'original-relative-path' as const }
    expect(pageLifecycleMoveDestination(effect, 42, origin)).toBe('archive/guides/start')
    expect(pageLifecycleMoveDestination({ ...effect, template: 'page-id' }, 42, origin)).toBe('archive/42')
    expect(pageLifecycleOriginalRelativePath(selector, 'docs')).toBe('')
    expect(pageLifecycleMoveDestination(effect, 42, '')).toBe('archive')
    for (const destinationRootPath of ['archive/../private', '/archive', 'archive//nested', '_private/archive', 'archive/%2e%2e']) expect(() => pageLifecycleMoveDestination({ ...effect, destinationRootPath }, 42, origin)).toThrow()
  })
})
