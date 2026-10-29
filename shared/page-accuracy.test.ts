import { describe, expect, it } from '../server/test/bun-test.mts'
import { classifyPageAccuracy, PAGE_ACCURACY_DAY_MS, PageAccuracyViewSchema, VerifyPageAccuracyInputSchema } from './page-accuracy.ts'

const now = Date.parse('2026-10-29T12:00:00.000Z')
const attestation = (age: number, sourceRevision = '7') => ({
  id: '11111111-1111-4111-8111-111111111111',
  pageId: 11,
  sourceRevision,
  verifiedBy: null,
  verifiedByName: null,
  verifiedAt: new Date(now - age).toISOString()
})

describe('revision-bound human accuracy', () => {
  it.each([
    [30 * PAGE_ACCURACY_DAY_MS - 1, 'verified-fresh'],
    [30 * PAGE_ACCURACY_DAY_MS, 'review-soon'],
    [90 * PAGE_ACCURACY_DAY_MS, 'review-soon'],
    [90 * PAGE_ACCURACY_DAY_MS + 1, 'needs-verification'],
    [-1, 'needs-verification']
  ] as const)('classifies an exact elapsed age of %s milliseconds as %s', (age, status) => {
    expect(classifyPageAccuracy('7', attestation(age), now)).toBe(status)
  })

  it('never promotes missing, invalid or different-revision evidence to verification', () => {
    for (const stamp of [null, { ...attestation(0), verifiedAt: 'not-a-date' }, attestation(0, '6')]) {
      expect(classifyPageAccuracy('7', stamp, now)).toBe('needs-verification')
    }
    expect(classifyPageAccuracy('7', attestation(0), Number.NaN)).toBe('needs-verification')
  })

  it('rejects spoofed authority/time and noncanonical or overflowing revision input', () => {
    for (const input of [
      { expectedSourceRevision: '7', verifiedBy: 1 },
      { expectedSourceRevision: '7', verifiedAt: new Date(now).toISOString() },
      ...['0', '07', '-1', '7.0', '9223372036854775808'].map(expectedSourceRevision => ({ expectedSourceRevision }))
    ]) {
      expect(VerifyPageAccuracyInputSchema.safeParse(input).success).toBe(false)
    }
  })

  it('rejects a view that claims freshness contrary to its actual revision or server assessment time', () => {
    const view = {
      sourceRevision: '7', updatedAt: new Date(now).toISOString(), author: null,
      latestAttestation: attestation(91 * PAGE_ACCURACY_DAY_MS), canVerify: false,
      asOf: new Date(now).toISOString(), status: 'verified-fresh'
    }
    expect(PageAccuracyViewSchema.safeParse(view).success).toBe(false)
    expect(PageAccuracyViewSchema.safeParse({ ...view, latestAttestation: attestation(0, '6') }).success).toBe(false)
  })
})
