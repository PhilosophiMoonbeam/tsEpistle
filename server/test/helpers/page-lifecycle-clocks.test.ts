import { createHash, randomUUID } from 'node:crypto'
import { pageLifecycleBodyDigest } from '../../helpers/page-lifecycle-clocks.ts'
import { pageLifecycleDue, type PageLifecycleClock } from '../../../shared/page-lifecycle.ts'
import { describe, expect, it } from '../bun-test.mts'

describe('lifecycle byte and due contracts', () => {
  it('frames UTF8 type byte length as unsigned big endian, without normalizing source', () => {
    const expected = createHash('sha256').update(Buffer.from([0, 0, 0, 0, 0, 0, 0, 2])).update('é').update('body').digest('hex')
    expect(pageLifecycleBodyDigest('body', 'é')).toBe(expected)
    expect(pageLifecycleBodyDigest('bc', 'a')).not.toBe(pageLifecycleBodyDigest('c', 'ab'))
    expect(pageLifecycleBodyDigest('é', 'markdown')).not.toBe(pageLifecycleBodyDigest('e\u0301', 'markdown'))
    expect(pageLifecycleBodyDigest('body', 'html')).not.toBe(pageLifecycleBodyDigest('body', 'markdown'))
  })
  it('never declares unknown, corrupt or future anchors due and includes the exact elapsed boundary', () => {
    const anchor = '2026-01-01T00:00:00.000Z'
    const clock: PageLifecycleClock = { bodyEpoch: randomUUID(), bodyAnchorAt: anchor, bodyAnchorKind: 'known-change', commentEpoch: randomUUID(), commentAnchorAt: null, commentAnchorKind: 'unknown' }
    const condition = { kind: 'body-inactive' as const, days: 1 }
    expect(pageLifecycleDue(condition, clock, new Date('2026-01-01T23:59:59.999Z')).state).toBe('not-due')
    expect(pageLifecycleDue(condition, clock, new Date('2026-01-02T00:00:00.000Z')).state).toBe('due')
    expect(pageLifecycleDue(condition, clock, new Date('2025-12-31T00:00:00.000Z')).state).toBe('unknown-clock')
    expect(pageLifecycleDue(condition, { ...clock, bodyAnchorAt: 'corrupt' }, new Date('2026-01-02')).state).toBe('unknown-clock')
    expect(pageLifecycleDue(condition, { ...clock, bodyAnchorKind: 'unknown' }, new Date('2026-01-02')).state).toBe('unknown-clock')
    expect(pageLifecycleDue({ kind: 'comments-inactive', days: 1 }, clock, new Date('2026-01-02')).state).toBe('unknown-clock')
  })
})
