import { describe, expect, it } from '../bun-test.mts'
import { parseHedgeDocInput, HEDGEDOC_MAX_ASSET_BYTES, type HedgeDocSourceNote } from '../../../shared/hedgedoc-import.ts'
import { hedgeDocDigest, validateHedgeDocHistory } from '../../operations/hedgedoc-import.ts'

const source = (): HedgeDocSourceNote => ({ id: 'source-note', markdown: '# Final', author: 'unverified source author', timestamp: '2019-01-01T00:00:00Z', historyComplete: false, history: [], assets: [] })
const input = () => ({ snapshot: { format: 'hedgedoc-content-v1', namespace: 'operator-selected-instance', notes: [source()] }, choices: [{ sourceId: 'source-note', ownerId: 7, target: { kind: 'create', key: 'native-note' }, assets: [] }] })
describe('bounded content-only HedgeDoc snapshot adapter', () => {
  it('refuses account, connector, destination path, alias and credential-shaped fields rather than treating them as authority', () => {
    for (const forbidden of ['users', 'credentials', 'sessions', 'connection', 'aliases']) expect(() => parseHedgeDocInput({ ...input(), [forbidden]: 'not imported' })).toThrow()
    const value = input(); Object.assign(value.choices[0]!.target, { path: '../private' })
    expect(() => parseHedgeDocInput(value)).toThrow()
    const emailOwner = input(); Object.assign(emailOwner.choices[0]!, { ownerId: 'person@example.invalid' })
    expect(() => parseHedgeDocInput(emailOwner)).toThrow()
  })
  it('validates every exact patch base/result and never treats a missing segment as verified complete history', () => {
    const note = source()
    note.historyComplete = true
    note.history = [
      { id: 'first', author: 'source only', timestamp: note.timestamp, markdown: '# Draft' },
      { id: 'second', author: 'source only', timestamp: note.timestamp, patch: { start: 2, deleteCount: 5, insert: 'Final', beforeDigest: hedgeDocDigest('# Draft'), afterDigest: hedgeDocDigest('# Final') } }
    ]
    expect(() => validateHedgeDocHistory(note)).not.toThrow()
    const wrongResult = structuredClone(note); if ('patch' in wrongResult.history[1]!) wrongResult.history[1]!.patch.afterDigest = hedgeDocDigest('invented')
    expect(() => validateHedgeDocHistory(wrongResult)).toThrow()
    const wrongBase = structuredClone(note); wrongBase.history.shift()
    expect(() => validateHedgeDocHistory(wrongBase)).toThrow()
    const missing = source(); missing.historyComplete = true
    expect(() => validateHedgeDocHistory(missing)).toThrow()
    missing.historyComplete = false
    expect(() => validateHedgeDocHistory(missing)).not.toThrow()
    expect(note.history[0]).toMatchObject({ markdown: '# Draft', author: 'source only' })
  })
  it('bounds histories, duplicate identities, remote instructions and asset paths without fetching anything', () => {
    const duplicate = input(); duplicate.snapshot.notes.push(source())
    expect(() => parseHedgeDocInput(duplicate)).toThrow()
    const tooMany = input(); tooMany.snapshot.notes[0]!.history = Array.from({ length: 101 }, (_, index) => ({ id: String(index), author: 'source', timestamp: '2019-01-01T00:00:00Z', markdown: '' }))
    expect(() => parseHedgeDocInput(tooMany)).toThrow()
    const remote = input(); Object.assign(remote.snapshot.notes[0]!, { fetch: 'http://127.0.0.1/private' })
    expect(() => parseHedgeDocInput(remote)).toThrow()
    const assetInput = { snapshot: { ...input().snapshot, notes: [{ ...source(), assets: [{ id: 'asset', url: 'https://source.invalid/image', mime: 'text/plain', base64: 'eA==', sha256: hedgeDocDigest('x') }] }] }, choices: [{ ...input().choices[0]!, assets: [{ sourceId: 'asset', action: 'import', filename: '../outside.txt', rewrite: true }] }] }
    expect(() => parseHedgeDocInput(assetInput)).toThrow()
    assetInput.choices[0]!.assets[0]!.filename = 'selected.txt'
    assetInput.snapshot.notes[0]!.assets[0]!.base64 = 'A'.repeat(Math.ceil(HEDGEDOC_MAX_ASSET_BYTES / 3) * 4 + 4)
    expect(() => parseHedgeDocInput(assetInput)).toThrow()
  })
})
