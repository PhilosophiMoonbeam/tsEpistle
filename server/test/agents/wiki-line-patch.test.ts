import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  applyWikiLinePatch,
  issueWikiLineSnapshot,
  validateWikiMarkdownSource,
  WikiLinePatchError,
  type WikiLineSnapshotV1
} from '../../agents/patch/wiki-line-patch.ts'

const secret = Buffer.alloc(32, 7)
const requesterScope = 'user:7:run:00000000-0000-4000-8000-000000000001'
const page = { id: 42, locale: 'en', path: 'docs/start', contentType: 'markdown' as const }

const snapshot = (source = 'alpha\nbeta\ngamma\n', ranges?: Array<{ startLine: number; endLine: number }>) => issueWikiLineSnapshot({
  page,
  sourceRevision: '8',
  source,
  requesterScope,
  signingSecret: secret,
  ...(ranges ? { requestedRanges: ranges } : {})
})

const anchor = (value: WikiLineSnapshotV1, line: number) => {
  const found = value.disclosed.flatMap(range => range.lines).find(item => item.number === line)
  if (!found) throw new Error(`Line ${line} was not disclosed`)
  return { line: found.number, tag: found.tag }
}

const patch = (value: WikiLineSnapshotV1, operations: unknown[], resultFinalNewline = value.finalNewline) => ({
  version: 'wiki-line-patch-v1',
  snapshotToken: value.snapshotToken,
  baseDocumentTag: value.documentTag,
  resultFinalNewline,
  operations
})

const apply = (source: string, value: WikiLineSnapshotV1, operations: unknown[], resultFinalNewline = value.finalNewline) => applyWikiLinePatch({
  pageId: page.id,
  sourceRevision: '8',
  source,
  requesterScope,
  signingSecret: secret,
  patch: patch(value, operations, resultFinalNewline)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Wiki Markdown byte-domain validation', () => {
  it('preserves exact bytes while LF and CRLF share one canonical hash', () => {
    const lf = validateWikiMarkdownSource('one\ntwo\n')
    const crlf = validateWikiMarkdownSource('one\r\ntwo\r\n')
    expect(lf).toMatchObject({ lineEnding: 'lf', finalNewline: true, lines: ['one', 'two'] })
    expect(crlf).toMatchObject({ lineEnding: 'crlf', finalNewline: true, lines: ['one', 'two'], canonicalSha256: lf.canonicalSha256 })
    expect(crlf.rawSha256).not.toBe(lf.rawSha256)
    expect(crlf.text).toBe('one\r\ntwo\r\n')
  })

  it('implements exact empty and terminal-newline line semantics', () => {
    expect(validateWikiMarkdownSource('')).toMatchObject({ lines: [], finalNewline: false })
    expect(validateWikiMarkdownSource('\n')).toMatchObject({ lines: [''], finalNewline: true })
    expect(validateWikiMarkdownSource('a')).toMatchObject({ lines: ['a'], finalNewline: false })
  })

  it('does not normalize Unicode and preserves astral characters', () => {
    const composed = validateWikiMarkdownSource('é 😀\n')
    const decomposed = validateWikiMarkdownSource('é 😀\n')
    expect(composed.canonicalSha256).not.toBe(decomposed.canonicalSha256)
    expect(composed.text).toBe('é 😀\n')
  })

  it.each([
    ['mixed endings', 'one\r\ntwo\n', 'MIXED_LINE_ENDINGS'],
    ['CR-only', 'one\rtwo', 'MIXED_LINE_ENDINGS'],
    ['NUL', 'one\0two', 'SOURCE_CONTAINS_NUL'],
    ['lone high surrogate', `one${String.fromCharCode(0xd800)}two`, 'INVALID_UTF16'],
    ['lone low surrogate', `one${String.fromCharCode(0xdc00)}two`, 'INVALID_UTF16']
  ])('rejects %s', (_label, source, code) => {
    expect(() => validateWikiMarkdownSource(source)).toThrow(expect.objectContaining({ code }))
  })

  it('rejects invalid UTF-8 bytes', () => {
    expect(() => validateWikiMarkdownSource(Buffer.from([0xc3, 0x28]))).toThrow(expect.objectContaining({ code: 'INVALID_UTF8' }))
  })

  it('reports review warnings without mutating the source', () => {
    const source = `safe\u2028${String.fromCodePoint(0x202e)}\u200b\n`
    const validated = validateWikiMarkdownSource(source)
    expect(validated.text).toBe(source)
    expect(validated.warnings.map(warning => warning.reason)).toEqual(['line-separator', 'bidi-control', 'default-ignorable'])
  })
})

describe('signed disclosed snapshots', () => {
  it('creates stable document and line anchors over exact canonical lines', () => {
    const first = snapshot()
    const second = snapshot()
    expect(first.documentTag).toBe(second.documentTag)
    expect(first.disclosed[0]?.lines.map(line => [line.number, line.tag, line.text])).toEqual(second.disclosed[0]?.lines.map(line => [line.number, line.tag, line.text]))
    expect(first.revision).toMatchObject({ sourceRevision: '8', rawSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
  })

  it('unions previously disclosed ranges only for the same exact authority and revision', () => {
    const first = snapshot('a\nb\nc\nd\n', [{ startLine: 1, endLine: 1 }])
    const second = issueWikiLineSnapshot({
      page,
      sourceRevision: '8',
      source: 'a\nb\nc\nd\n',
      requesterScope,
      signingSecret: secret,
      requestedRanges: [{ startLine: 3, endLine: 4 }],
      previousSnapshotToken: first.snapshotToken
    })
    expect(second.disclosed.map(range => [range.startLine, range.endLine])).toEqual([[1, 1], [3, 4]])
    expect(() => issueWikiLineSnapshot({
      page,
      sourceRevision: '9',
      source: 'a\nb\nc\nd\n',
      requesterScope,
      signingSecret: secret,
      requestedRanges: [{ startLine: 2, endLine: 2 }],
      previousSnapshotToken: first.snapshotToken
    })).toThrow(expect.objectContaining({ code: 'STALE_SNAPSHOT' }))
  })

  it('rejects tampered and expired tokens', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const value = issueWikiLineSnapshot({ page, sourceRevision: '8', source: 'a\n', requesterScope, signingSecret: secret, ttlMs: 1_000 })
    const parts = value.snapshotToken.split('.')
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]?.startsWith('A') ? 'B' : 'A'}${parts[2]?.slice(1) ?? ''}`
    const operation = [{ kind: 'replace', range: { start: anchor(value, 1), end: anchor(value, 1) }, lines: ['b'] }]
    expect(() => applyWikiLinePatch({ pageId: 42, sourceRevision: '8', source: 'a\n', requesterScope, signingSecret: secret, patch: { ...patch(value, operation), snapshotToken: tampered } })).toThrow(expect.objectContaining({ code: 'INVALID_SNAPSHOT_TOKEN' }))
    vi.advanceTimersByTime(1_001)
    expect(() => apply('a\n', value, operation)).toThrow(expect.objectContaining({ code: 'INVALID_SNAPSHOT_TOKEN' }))
  })
  it('does not disclose warning positions outside requested line ranges', () => {
    const value = snapshot(`visible\nhidden\u2028\n`, [{ startLine: 1, endLine: 1 }])
    expect(value.warnings).toEqual([])
    const expanded = issueWikiLineSnapshot({
      page,
      sourceRevision: '8',
      source: `visible\nhidden\u2028\n`,
      requesterScope,
      signingSecret: secret,
      requestedRanges: [{ startLine: 2, endLine: 2 }],
      previousSnapshotToken: value.snapshotToken
    })
    expect(expanded.warnings).toEqual([
      expect.objectContaining({ line: 2, codePoint: 'U+2028' })
    ])
  })
})

describe('wiki-line-patch-v1', () => {
  it('applies ordered insert, replace, and delete against immutable original lines', () => {
    const source = 'alpha\nbeta\ngamma\ndelta\n'
    const value = snapshot(source)
    const result = apply(source, value, [

      { kind: 'insert', gap: { after: null, before: anchor(value, 1) }, lines: ['heading'] },
      { kind: 'replace', range: { start: anchor(value, 2), end: anchor(value, 2) }, lines: ['BETA', 'extra'] },
      { kind: 'delete', range: { start: anchor(value, 4), end: anchor(value, 4) } }
    ])
    expect(result.source.text).toBe('heading\nalpha\nBETA\nextra\ngamma\n')
    expect(result).toMatchObject({
      engineVersion: 1,
      diffRendererVersion: 1,
      patchSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      diffSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(result.diff).toContain('-beta')
    expect(result.diff).toContain('+BETA')
  })

  it('preserves CRLF and applies explicit final-newline intent', () => {
    const source = 'one\r\ntwo\r\n'
    const value = snapshot(source)
    const result = apply(source, value, [
      { kind: 'replace', range: { start: anchor(value, 2), end: anchor(value, 2) }, lines: ['second'] }
    ], false)
    expect(result.source.text).toBe('one\r\nsecond')
    expect(result.source).toMatchObject({ lineEnding: 'crlf', finalNewline: false })
  })

  it('inserts into an empty document only with null anchors', () => {
    const value = snapshot('')
    const result = apply('', value, [{ kind: 'insert', gap: { after: null, before: null }, lines: ['first'] }], true)
    expect(result.source.text).toBe('first\n')
    expect(() => apply('', value, [{ kind: 'insert', gap: { after: { line: 1, tag: '000000000000' }, before: null }, lines: ['first'] }])).toThrow('Empty documents')
  })

  it('rejects stale page revision, source bytes, requester, document tag, and line anchors', () => {
    const source = 'alpha\nbeta\n'
    const value = snapshot(source)
    const operation = [{ kind: 'replace', range: { start: anchor(value, 1), end: anchor(value, 1) }, lines: ['ALPHA'] }]
    expect(() => applyWikiLinePatch({ pageId: 42, sourceRevision: '9', source, requesterScope, signingSecret: secret, patch: patch(value, operation) })).toThrow(expect.objectContaining({ code: 'STALE_SNAPSHOT' }))
    expect(() => applyWikiLinePatch({ pageId: 42, sourceRevision: '8', source: 'changed\nbeta\n', requesterScope, signingSecret: secret, patch: patch(value, operation) })).toThrow(expect.objectContaining({ code: 'STALE_SNAPSHOT' }))
    expect(() => applyWikiLinePatch({ pageId: 42, sourceRevision: '8', source, requesterScope: 'user:8', signingSecret: secret, patch: patch(value, operation) })).toThrow(expect.objectContaining({ code: 'STALE_SNAPSHOT' }))
    expect(() => apply(source, value, operation.map(item => ({ ...item, range: { ...item.range, start: { line: 1, tag: '000000000000' } } })))).toThrow(expect.objectContaining({ code: 'STALE_LINE_ANCHOR' }))
    expect(() => applyWikiLinePatch({ pageId: 42, sourceRevision: '8', source, requesterScope, signingSecret: secret, patch: { ...patch(value, operation), baseDocumentTag: '000000000000' } })).toThrow(expect.objectContaining({ code: 'STALE_DOCUMENT_TAG' }))
  })

  it('enforces disclosed ranges and insertion gaps', () => {
    const source = 'one\ntwo\nthree\n'
    const value = snapshot(source, [{ startLine: 1, endLine: 1 }])
    const unseenAnchor = { line: 2, tag: validateWikiMarkdownSource(source).documentTag.slice(0, 12) }
    expect(() => apply(source, value, [{ kind: 'replace', range: { start: unseenAnchor, end: unseenAnchor }, lines: ['TWO'] }])).toThrow(expect.objectContaining({ code: 'UNDISCLOSED_PATCH_RANGE' }))
    expect(() => apply(source, value, [{ kind: 'insert', gap: { after: anchor(value, 1), before: unseenAnchor }, lines: ['between'] }])).toThrow()
  })

  it.each([
    ['out of order', (value: WikiLineSnapshotV1) => [
      { kind: 'replace', range: { start: anchor(value, 3), end: anchor(value, 3) }, lines: ['THREE'] },
      { kind: 'replace', range: { start: anchor(value, 1), end: anchor(value, 1) }, lines: ['ONE'] }
    ]],
    ['overlap', (value: WikiLineSnapshotV1) => [
      { kind: 'replace', range: { start: anchor(value, 1), end: anchor(value, 2) }, lines: ['both'] },
      { kind: 'delete', range: { start: anchor(value, 2), end: anchor(value, 3) } }
    ]],
    ['duplicate gap', (value: WikiLineSnapshotV1) => [
      { kind: 'insert', gap: { after: anchor(value, 1), before: anchor(value, 2) }, lines: ['a'] },
      { kind: 'insert', gap: { after: anchor(value, 1), before: anchor(value, 2) }, lines: ['b'] }
    ]],
    ['incident gap', (value: WikiLineSnapshotV1) => [
      { kind: 'replace', range: { start: anchor(value, 1), end: anchor(value, 1) }, lines: ['ONE'] },
      { kind: 'insert', gap: { after: anchor(value, 1), before: anchor(value, 2) }, lines: ['between'] }
    ]]
  ])('rejects %s conflicts', (_label, operations) => {
    const source = 'one\ntwo\nthree\n'
    const value = snapshot(source)
    expect(() => apply(source, value, operations(value))).toThrow(WikiLinePatchError)
  })

  it('rejects embedded line endings, empty replacement arrays, and canonical no-ops', () => {
    const source = 'one\ntwo\n'
    const value = snapshot(source)
    expect(() => apply(source, value, [{ kind: 'replace', range: { start: anchor(value, 1), end: anchor(value, 1) }, lines: ['bad\nline'] }])).toThrow()
    expect(() => apply(source, value, [{ kind: 'replace', range: { start: anchor(value, 1), end: anchor(value, 1) }, lines: [] }])).toThrow(expect.objectContaining({ code: 'INVALID_PATCH' }))
    expect(() => apply(source, value, [{ kind: 'replace', range: { start: anchor(value, 1), end: anchor(value, 1) }, lines: ['one'] }])).toThrow(expect.objectContaining({ code: 'PATCH_NO_OP' }))
  })

  it('produces deterministic hashes and diffs for identical authority and patch', () => {
    const source = 'one\ntwo\n'
    const value = snapshot(source)
    const operations = [{ kind: 'replace', range: { start: anchor(value, 2), end: anchor(value, 2) }, lines: ['TWO'] }]
    const first = apply(source, value, operations)
    const second = apply(source, value, operations)
    expect(second.patchSha256).toBe(first.patchSha256)
    expect(second.diffSha256).toBe(first.diffSha256)
    expect(second.diff).toBe(first.diff)
  })
})
