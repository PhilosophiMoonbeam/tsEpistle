import { describe, it, expect } from '../bun-test.mts'
import { storageOperationResult } from '../../repositories/storage-operation-result.ts'
import { StorageOperationResultSchema } from '../../../shared/storage-workspace.ts'
const summary = {
  targetKey: 'disk',
  handler: 'dump',
  outcome: 'succeeded',
  total: 0,
  succeeded: 0,
  failed: 0,
  formats: { okf: 0, legacyV1: 0, legacyWiki: 0, plain: 0, invalid: 0 },
  items: [],
  startedAt: '2026-09-06T00:00:00Z',
  completedAt: '2026-09-06T00:01:00Z',
  message: 'Provider details must not be copied'
}
describe('Storage operation result contract', () => {
  it('distinguishes an uncounted export from an empty successful import', () => {
    const exported = storageOperationResult('dump', summary, [])
    expect(exported).toMatchObject({ outcome: 'succeeded', counts: null, items: [] })
    expect(JSON.stringify(exported)).not.toContain(summary.message)
    expect(storageOperationResult('importAll', summary, []).counts).toMatchObject({ total: 0, succeeded: 0, failed: 0 })
    expect(storageOperationResult('importAll', { ...summary, outcome: 'failed', message: 'https://user:secret@example.test' }, [])).toMatchObject({
      outcome: 'failed',
      counts: null
    })
    expect(JSON.stringify(storageOperationResult('dump', { ...summary, outcome: 'failed', message: 'secret-provider-error' }, []))).not.toContain(
      'secret-provider-error'
    )
  })
  it('preserves format and conflict evidence while removing credentials from bounded import details', () => {
    const secret = 'private credential',
      encoded = encodeURIComponent(secret),
      base64 = Buffer.from(secret).toString('base64')
    const item = {
      kind: 'page',
      path: 'docs/example.md',
      outcome: 'conflict',
      format: 'invalid',
      message: `Invalid ${secret} ${encoded} ${base64} https://user:pass@example.test/path`,
      diagnostics: [`Cannot parse ${secret}`]
    }
    const value = { ...summary, outcome: 'failed', total: 1, failed: 1, formats: { ...summary.formats, invalid: 1 }, items: [item] }
    const result = storageOperationResult('importAll', value, [secret])
    expect(result.counts).toMatchObject({ total: 1, failed: 1, formats: { invalid: 1 } })
    expect(result.items[0]).toMatchObject({ outcome: 'conflict', format: 'invalid', path: 'docs/example.md' })
    for (const value of [secret, encoded, base64, 'user:pass']) expect(JSON.stringify(result)).not.toContain(value)
    expect(result.items[0]!.diagnostics).toEqual(['Cannot parse [redacted]'])
  })
  it('bounds result detail and rejects contradictory totals instead of fabricating progress', () => {
    const item = {
      kind: 'page',
      path: 'a'.repeat(600),
      outcome: 'succeeded',
      format: 'okf',
      message: null,
      diagnostics: Array.from({ length: 12 }, () => 'b'.repeat(600))
    }
    const result = storageOperationResult(
      'importAll',
      { ...summary, total: 100, succeeded: 100, formats: { ...summary.formats, okf: 100 }, items: Array.from({ length: 100 }, () => item) },
      []
    )
    expect(result.items).toHaveLength(50)
    expect(result.items[0]!.path).toHaveLength(512)
    expect(result.items[0]!.diagnostics).toHaveLength(8)
    expect(result.items[0]!.diagnostics[0]).toHaveLength(512)
    expect(storageOperationResult('importAll', { ...summary, total: 2, succeeded: 3 }, [])).toMatchObject({ outcome: 'failed', counts: null })
    expect(StorageOperationResultSchema.safeParse({ ...result, counts: { ...result.counts, total: 101 } }).success).toBe(false)
  })
})
